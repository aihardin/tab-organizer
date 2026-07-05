const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 16000;      // headroom to emit hundreds of tab IDs + summary
const TIMEOUT_MS = 240000;     // 4 min per request; fail loudly instead of hanging
const MAX_RETRIES = 4;         // retry 429 / 5xx with backoff

// Scaling knobs. At or below the single-call limit we make one high-quality call
// (best grouping, cheapest). Above it we switch to the batched pipeline below.
const SINGLE_CALL_LIMIT = 300;
const BATCH_SIZE = 200;              // tabs per assignment call
const MAX_CONCURRENCY = 4;           // parallel assignment calls in flight
const HIGHLIGHT_CANDIDATE_CAP = 400; // tabs considered when picking the top 10
const OTHER = 'Other';

// ── Tool schemas ───────────────────────────────────────────────────

const ORGANIZE_TOOL = {
  name: 'organize_tabs',
  description: 'Organize browser tabs into topic groups and identify the most important ones relative to the user\'s goal.',
  input_schema: {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
        description: 'All tabs organized into named topic groups',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short descriptive group name (2-5 words)' },
            relevance: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Relevance to the user\'s stated goal' },
            tabs: { type: 'array', items: { type: 'integer' }, description: 'Tab IDs in this group' }
          },
          required: ['name', 'relevance', 'tabs'],
          additionalProperties: false
        }
      },
      top10: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Up to 10 tab IDs ordered most to least important for the user\'s goal',
        maxItems: 10
      },
      summary_markdown: {
        type: 'string',
        description: 'A markdown summary including the goal, top tabs with URLs and descriptions, and group overview'
      }
    },
    required: ['groups', 'top10', 'summary_markdown'],
    additionalProperties: false
  }
};

const TAXONOMY_TOOL = {
  name: 'define_categories',
  description: 'Define a set of topic categories that all of the user\'s tabs can be sorted into, based on their titles and the user\'s goal.',
  input_schema: {
    type: 'object',
    properties: {
      categories: {
        type: 'array',
        description: 'Between 5 and 15 distinct, non-overlapping topic categories covering the tabs',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short descriptive category name (2-5 words)' },
            relevance: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Relevance to the user\'s goal' }
          },
          required: ['name', 'relevance'],
          additionalProperties: false
        }
      }
    },
    required: ['categories'],
    additionalProperties: false
  }
};

const ASSIGN_TOOL = {
  name: 'assign_tabs',
  description: 'Assign each tab to exactly one of the provided categories.',
  input_schema: {
    type: 'object',
    properties: {
      assignments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: 'The tab ID' },
            category: { type: 'string', description: 'The exact name of one of the provided categories, or "Other"' }
          },
          required: ['id', 'category'],
          additionalProperties: false
        }
      }
    },
    required: ['assignments'],
    additionalProperties: false
  }
};

const HIGHLIGHTS_TOOL = {
  name: 'select_highlights',
  description: 'Pick the 10 most important tabs for the user\'s goal and write a markdown summary.',
  input_schema: {
    type: 'object',
    properties: {
      top10: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Up to 10 tab IDs ordered most to least important',
        maxItems: 10
      },
      summary_markdown: {
        type: 'string',
        description: 'A markdown summary including the goal, top tabs, and a group overview'
      }
    },
    required: ['top10', 'summary_markdown'],
    additionalProperties: false
  }
};

// ── Public entry point ─────────────────────────────────────────────

export async function analyzeTabs(apiKey, tabs, goal) {
  if (tabs.length <= SINGLE_CALL_LIMIT) {
    return analyzeTabsSingle(apiKey, tabs, goal);
  }
  return analyzeTabsBatched(apiKey, tabs, goal);
}

// ── Single-call path (small tab counts) ────────────────────────────

async function analyzeTabsSingle(apiKey, tabs, goal) {
  const userMessage = `Goal for today: ${goal}

Open tabs (${tabs.length} total):
${tabs.map(tabLine).join('\n')}

Please organize these tabs into topic groups, identify the top 10 most important ones for my goal, and write a markdown summary I can save for reference.`;

  const result = await callClaude(apiKey, {
    system: SYSTEM,
    tools: [ORGANIZE_TOOL],
    toolName: 'organize_tabs',
    userMessage
  });

  if (!Array.isArray(result.groups) || !Array.isArray(result.top10) || typeof result.summary_markdown !== 'string') {
    throw new Error('Claude returned an incomplete result. Please try again.');
  }
  return result;
}

// ── Batched path (large tab counts) ────────────────────────────────

async function analyzeTabsBatched(apiKey, tabs, goal) {
  // Phase 1 — taxonomy: derive a fixed category list from titles only (cheap).
  const categories = await defineCategories(apiKey, tabs, goal);
  const categoryNames = categories.map(c => c.name);

  // Phase 2 — assignment: sort each batch into the fixed categories, in
  // parallel (capped). A batch that fails after retries falls back to "Other"
  // so no tabs are lost.
  const batches = chunk(tabs, BATCH_SIZE);
  const perBatch = await runWithConcurrency(batches, MAX_CONCURRENCY, async (batch) => {
    try {
      return await assignBatch(apiKey, batch, categoryNames, goal);
    } catch {
      return batch.map(t => ({ id: t.id, category: OTHER }));
    }
  });
  const assignments = perBatch.flat();

  const groups = buildGroups(categories, assignments, tabs);

  // Phase 3 — highlights: top 10 + summary from the strongest candidates.
  let highlights;
  try {
    highlights = await selectHighlights(apiKey, groups, tabs, goal);
  } catch {
    highlights = fallbackHighlights(groups, tabs, goal);
  }

  return {
    groups,
    top10: highlights.top10,
    summary_markdown: highlights.summary_markdown
  };
}

async function defineCategories(apiKey, tabs, goal) {
  const titles = tabs.map(t => `- ${truncate(t.title, 120)}`).join('\n');
  const userMessage = `Goal for today: ${goal}

I have ${tabs.length} open tabs. Here are their titles:
${titles}

Define a concise set of topic categories (5-15) that all of these tabs can be sorted into. Make categories distinct and non-overlapping, and mark how relevant each is to my goal.`;

  const result = await callClaude(apiKey, {
    system: SYSTEM,
    tools: [TAXONOMY_TOOL],
    toolName: 'define_categories',
    userMessage,
    maxTokens: 2000
  });

  const categories = Array.isArray(result.categories) ? result.categories.filter(c => c && c.name) : [];
  if (categories.length === 0) {
    throw new Error('Could not derive tab categories. Please try again.');
  }
  return categories;
}

async function assignBatch(apiKey, batch, categoryNames, goal) {
  const list = categoryNames.map(n => `- ${n}`).join('\n');
  const userMessage = `Goal for today: ${goal}

Assign each of the following tabs to exactly one of these categories (use the exact name, or "Other" if none fit):
${list}

Tabs:
${batch.map(tabLine).join('\n')}`;

  const result = await callClaude(apiKey, {
    system: SYSTEM,
    tools: [ASSIGN_TOOL],
    toolName: 'assign_tabs',
    userMessage
  });

  return Array.isArray(result.assignments) ? result.assignments : [];
}

async function selectHighlights(apiKey, groups, tabs, goal) {
  const tabMap = new Map(tabs.map(t => [t.id, t]));

  // Prefer tabs in high/medium-relevance groups as candidates; fall back to all.
  let candidateIds = [];
  for (const g of groups) {
    if (g.relevance === 'low') continue;
    candidateIds.push(...g.tabs);
  }
  if (candidateIds.length === 0) candidateIds = tabs.map(t => t.id);
  candidateIds = candidateIds.slice(0, HIGHLIGHT_CANDIDATE_CAP);

  const candidateLines = candidateIds
    .map(id => tabMap.get(id))
    .filter(Boolean)
    .map(tabLine)
    .join('\n');

  const groupOverview = groups
    .map(g => `- ${g.name} (${g.relevance}): ${g.tabs.length} tabs`)
    .join('\n');

  const userMessage = `Goal for today: ${goal}

I have ${tabs.length} tabs sorted into these groups:
${groupOverview}

Here are the most relevant candidate tabs:
${candidateLines}

Pick the 10 most important tabs for my goal (return their IDs, most important first) and write a markdown summary I can save — include the goal, the top tabs, and a short overview of the groups.`;

  const result = await callClaude(apiKey, {
    system: SYSTEM,
    tools: [HIGHLIGHTS_TOOL],
    toolName: 'select_highlights',
    userMessage
  });

  const validIds = new Set(tabs.map(t => t.id));
  const top10 = (Array.isArray(result.top10) ? result.top10 : []).filter(id => validIds.has(id)).slice(0, 10);
  const summary_markdown = typeof result.summary_markdown === 'string' ? result.summary_markdown : '';
  if (top10.length === 0 || !summary_markdown) {
    throw new Error('Incomplete highlights.');
  }
  return { top10, summary_markdown };
}

// Deterministic fallback if the highlights call fails — the run still succeeds.
function fallbackHighlights(groups, tabs, goal) {
  const rank = { high: 0, medium: 1, low: 2 };
  const sorted = [...groups].sort((a, b) => (rank[a.relevance] ?? 1) - (rank[b.relevance] ?? 1));
  const top10 = [];
  for (const g of sorted) {
    for (const id of g.tabs) {
      if (top10.length < 10) top10.push(id);
    }
  }
  const summary_markdown =
    `# Tab Summary\n\n**Goal:** ${goal}\n\n**Total tabs:** ${tabs.length}\n\n## Groups\n\n` +
    groups.map(g => `- **${g.name}** (${g.relevance}) — ${g.tabs.length} tabs`).join('\n');
  return { top10, summary_markdown };
}

// Turn assignments into the { name, relevance, tabs } group shape, preserving
// category order, folding unknown categories and unassigned tabs into "Other".
function buildGroups(categories, assignments, tabs) {
  const validIds = new Set(tabs.map(t => t.id));
  const known = new Map(categories.map(c => [c.name, c]));
  const byCat = new Map();
  const seen = new Set();

  for (const a of assignments) {
    if (!a || !validIds.has(a.id) || seen.has(a.id)) continue;
    seen.add(a.id);
    const cat = known.has(a.category) ? a.category : OTHER;
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(a.id);
  }

  // Any tab that never got an assignment goes to Other.
  for (const t of tabs) {
    if (!seen.has(t.id)) {
      if (!byCat.has(OTHER)) byCat.set(OTHER, []);
      byCat.get(OTHER).push(t.id);
    }
  }

  const groups = [];
  for (const c of categories) {
    const ids = byCat.get(c.name);
    if (ids && ids.length) groups.push({ name: c.name, relevance: c.relevance || 'medium', tabs: ids });
  }
  const otherIds = byCat.get(OTHER);
  if (otherIds && otherIds.length) groups.push({ name: OTHER, relevance: 'low', tabs: otherIds });
  return groups;
}

// ── Low-level API call (timeout + retry + validation) ──────────────

async function callClaude(apiKey, { system, tools, toolName, userMessage, maxTokens = MAX_TOKENS }) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    tools,
    tool_choice: { type: 'tool', name: toolName },
    messages: [{ role: 'user', content: userMessage }]
  });

  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response;
    try {
      response = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          // Required for direct calls from a browser/extension context. Safe
          // here: the key lives in extension storage, not on a web page.
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new Error(`Request timed out after ${TIMEOUT_MS / 1000}s. Try again, or close some tabs first.`);
      }
      lastError = new Error(`Network error contacting Claude: ${err.message}`);
      await sleep(backoff(attempt));
      continue;
    }
    clearTimeout(timeout);

    if (response.status === 401) {
      throw new Error('Invalid API key. Please check your key in Settings.');
    }
    // Transient: retry with backoff (honoring Retry-After when present).
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '', 10);
      lastError = new Error(`Claude API is busy (HTTP ${response.status}).`);
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : backoff(attempt));
      continue;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Claude API error (${response.status}): ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    if (data.stop_reason === 'max_tokens') {
      throw new Error('Claude\'s response was cut off (too large). Try again with fewer tabs.');
    }
    const toolUse = data.content?.find(block => block.type === 'tool_use' && block.name === toolName);
    if (!toolUse || !toolUse.input) {
      throw new Error('Unexpected response from Claude. Please try again.');
    }
    return toolUse.input;
  }

  throw lastError || new Error('Claude API request failed after several retries.');
}

// ── Helpers ────────────────────────────────────────────────────────

const SYSTEM = 'You are a focused productivity assistant. Analyze browser tabs and help the user end their day with clarity. Be practical and concise.';

function tabLine(t) {
  return `- ID ${t.id}: "${truncate(t.title, 160)}" — ${truncate(t.url, 200)}`;
}

function truncate(str, n) {
  const s = String(str ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Run `fn` over `items` with at most `limit` in flight; results preserve order.
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function backoff(attempt) {
  return Math.min(1000 * 2 ** attempt, 15000) + Math.random() * 500;
}
