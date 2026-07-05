const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 16000;      // headroom to emit hundreds of tab IDs + summary
const TIMEOUT_MS = 240000;     // 4 min; fail loudly instead of hanging forever

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

export async function analyzeTabs(apiKey, tabs, goal) {
  const tabList = tabs
    .map(t => `- ID ${t.id}: "${t.title}" — ${t.url}`)
    .join('\n');

  const userMessage = `Goal for today: ${goal}

Open tabs (${tabs.length} total):
${tabList}

Please organize these tabs into topic groups, identify the top 10 most important ones for my goal, and write a markdown summary I can save for reference.`;

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
        // Required for direct calls to the Anthropic API from a browser/extension
        // context, which the API otherwise rejects to protect against leaking keys
        // from web pages. Safe here: the key lives in the extension's own storage,
        // not on a public web page.
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: 'You are a focused productivity assistant. Analyze browser tabs and help the user end their day with clarity. Be practical and concise.',
        tools: [ORGANIZE_TOOL],
        tool_choice: { type: 'tool', name: 'organize_tabs' },
        messages: [{ role: 'user', content: userMessage }]
      })
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${TIMEOUT_MS / 1000}s. With very large tab counts this can happen — try again, or close some tabs first.`);
    }
    throw new Error(`Network error contacting Claude: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) {
    throw new Error('Invalid API key. Please check your key in Settings.');
  }
  if (response.status === 429) {
    throw new Error('Rate limit reached. Please wait a moment and try again.');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Claude API error (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = await response.json();

  // Truncated output: the model ran out of room mid-answer, so the tool JSON is
  // incomplete (missing top10 / summary). Fail clearly instead of returning a
  // broken result that crashes the review page.
  if (data.stop_reason === 'max_tokens') {
    throw new Error(`Too many tabs to analyze at once (${tabs.length}). Claude's response was cut off before it finished. Close some tabs and try again.`);
  }

  const toolUse = data.content?.find(block => block.type === 'tool_use' && block.name === 'organize_tabs');
  if (!toolUse || !toolUse.input) {
    throw new Error('Unexpected response from Claude. Please try again.');
  }

  const result = toolUse.input;
  if (!Array.isArray(result.groups) || !Array.isArray(result.top10) || typeof result.summary_markdown !== 'string') {
    throw new Error('Claude returned an incomplete result. Please try again.');
  }

  return result;
}
