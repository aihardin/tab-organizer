let tabData = [];
let analysisResult = null;
let keepSet = new Set();

// ── Load & render ──────────────────────────────────────────────────

async function init() {
  const stored = await chrome.storage.session.get(['analysisResult', 'tabData', 'goal']);

  if (!stored.analysisResult || !stored.tabData) {
    showError('No analysis data found. Please run Tab Organizer from the toolbar icon.');
    return;
  }

  tabData = stored.tabData;
  analysisResult = stored.analysisResult;

  // Normalize against a partial/malformed result so rendering can never crash.
  analysisResult.groups = Array.isArray(analysisResult.groups) ? analysisResult.groups : [];
  analysisResult.top10 = Array.isArray(analysisResult.top10) ? analysisResult.top10 : [];
  analysisResult.summary_markdown =
    typeof analysisResult.summary_markdown === 'string' ? analysisResult.summary_markdown : '';

  const tabMap = new Map(tabData.map(t => [t.id, t]));

  // Pre-select top10 as "keep"
  keepSet = new Set(analysisResult.top10);

  if (stored.goal) {
    document.getElementById('goal-text').textContent = stored.goal;
    document.getElementById('goal-display').classList.remove('hidden');
  }

  renderTop10(analysisResult.top10, tabMap);
  renderGroups(analysisResult.groups, tabMap);
  renderSummary(analysisResult.summary_markdown);
  updateStats();
  enableButtons();

  document.getElementById('loading-state').classList.add('hidden');
  document.getElementById('content').classList.remove('hidden');
  document.getElementById('stats-row').classList.remove('hidden');
}

function renderTop10(top10Ids, tabMap) {
  const container = document.getElementById('top10-list');
  const hint = document.getElementById('top10-hint');
  const valid = top10Ids.filter(id => tabMap.has(id));
  hint.textContent = `(${valid.length} tabs)`;

  // Build off-DOM in a fragment and append once, so hundreds of cards cause a
  // single reflow instead of one per card.
  const frag = document.createDocumentFragment();
  valid.forEach((id, i) => {
    frag.appendChild(makeTabCard(tabMap.get(id), i + 1));
  });
  container.appendChild(frag);
}

function renderGroups(groups, tabMap) {
  const container = document.getElementById('groups-list');

  // Accumulate every section off-DOM and append once at the end — a single
  // reflow for the whole list rather than one per group/card.
  const outer = document.createDocumentFragment();

  groups.forEach(group => {
    const section = document.createElement('div');
    section.className = 'group-section';

    const header = document.createElement('div');
    header.className = 'group-header';

    const relClass = { high: 'rel-high', medium: 'rel-medium', low: 'rel-low' }[group.relevance] || 'rel-low';
    header.innerHTML = `
      <span class="group-name">${escHtml(group.name)}</span>
      <span class="relevance-badge ${relClass}">${group.relevance}</span>
      <span class="group-count">${group.tabs.length} tabs</span>
      <span class="chevron open">&#9656;</span>
    `;

    const tabsDiv = document.createElement('div');
    tabsDiv.className = 'group-tabs';

    const cards = document.createDocumentFragment();
    group.tabs.forEach(id => {
      const tab = tabMap.get(id);
      if (tab) cards.appendChild(makeTabCard(tab, null));
    });
    tabsDiv.appendChild(cards);

    header.addEventListener('click', () => {
      const chevron = header.querySelector('.chevron');
      const isOpen = tabsDiv.style.display !== 'none';
      tabsDiv.style.display = isOpen ? 'none' : 'block';
      chevron.classList.toggle('open', !isOpen);
    });

    section.appendChild(header);
    section.appendChild(tabsDiv);
    outer.appendChild(section);
  });

  container.appendChild(outer);
}

function renderSummary(markdown) {
  document.getElementById('summary-content').textContent = markdown;
}

// ── Tab card ──────────────────────────────────────────────────────

function makeTabCard(tab, rank) {
  const card = document.createElement('div');
  card.className = 'tab-card';
  if (!keepSet.has(tab.id)) card.classList.add('dimmed');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = keepSet.has(tab.id);
  checkbox.dataset.tabId = tab.id;
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) {
      keepSet.add(tab.id);
      card.classList.remove('dimmed');
    } else {
      keepSet.delete(tab.id);
      card.classList.add('dimmed');
    }
    updateStats();
  });

  const info = document.createElement('div');
  info.className = 'tab-info';

  const domain = getDomain(tab.url);
  info.innerHTML = `
    <div class="tab-title" title="${escHtml(tab.title)}">${escHtml(tab.title)}</div>
    <div class="tab-url" title="${escHtml(tab.url)}">${escHtml(domain)}</div>
  `;

  card.appendChild(checkbox);
  card.appendChild(info);

  if (rank) {
    const badge = document.createElement('span');
    badge.className = 'tab-rank';
    badge.textContent = `#${rank}`;
    card.appendChild(badge);
  }

  return card;
}

// ── Stats ─────────────────────────────────────────────────────────

function updateStats() {
  const total = tabData.length;
  const keep = keepSet.size;
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-keep').textContent = keep;
  document.getElementById('stat-close').textContent = total - keep;
}

// ── Buttons ───────────────────────────────────────────────────────

function enableButtons() {
  ['btn-download', 'btn-bookmark', 'btn-close',
   'btn-select-top10', 'btn-select-all', 'btn-select-none'].forEach(id => {
    document.getElementById(id).disabled = false;
  });
}

function showActionStatus(msg, type = 'info') {
  const el = document.getElementById('action-status');
  el.textContent = msg;
  el.className = `action-status ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

document.getElementById('btn-download').addEventListener('click', () => {
  const markdown = analysisResult.summary_markdown;
  const blob = new Blob([markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  chrome.downloads.download({ url, filename: `tab-summary-${date}.md` }, (downloadId) => {
    // Defer revoke so Chrome has finished reading the blob off the object URL
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (chrome.runtime.lastError || !downloadId) {
      showActionStatus('Download failed: ' + (chrome.runtime.lastError?.message ?? 'unknown error'), 'error');
    } else {
      showActionStatus('Summary downloaded.', 'success');
    }
  });
});

document.getElementById('btn-bookmark').addEventListener('click', async () => {
  document.getElementById('btn-bookmark').disabled = true;
  showActionStatus('Bookmarking...', 'info');
  // The worker reads groups + tab data from session storage, so no payload
  // needs to be serialized across the message channel.
  const response = await chrome.runtime.sendMessage({ action: 'bookmarkTabs' });
  if (!response || response.error) {
    showActionStatus('Bookmark error: ' + (response?.error ?? 'Extension error — try again.'), 'error');
    document.getElementById('btn-bookmark').disabled = false;
  } else {
    showActionStatus('All tabs bookmarked in Chrome Bookmarks.', 'success');
  }
});

document.getElementById('btn-close').addEventListener('click', async () => {
  const idsToClose = tabData.map(t => t.id).filter(id => !keepSet.has(id));
  if (idsToClose.length === 0) {
    showActionStatus('No tabs to close — all are selected to keep.', 'info');
    return;
  }

  const confirmed = confirm(
    `Close ${idsToClose.length} tab${idsToClose.length === 1 ? '' : 's'}?\n\n` +
    `${keepSet.size} tab${keepSet.size === 1 ? '' : 's'} will remain open.`
  );
  if (!confirmed) return;

  document.getElementById('btn-close').disabled = true;
  const response = await chrome.runtime.sendMessage({ action: 'closeTabs', idsToClose });
  if (!response || response.error) {
    showActionStatus('Error closing tabs: ' + (response?.error ?? 'Extension error — try again.'), 'error');
    document.getElementById('btn-close').disabled = false;
  } else {
    showActionStatus(`Closed ${response.closed} tabs. Enjoy your clean slate.`, 'success');
  }
});

document.getElementById('btn-select-top10').addEventListener('click', () => {
  keepSet = new Set(analysisResult.top10);
  syncCheckboxes();
  updateStats();
});

document.getElementById('btn-select-all').addEventListener('click', () => {
  keepSet = new Set(tabData.map(t => t.id));
  syncCheckboxes();
  updateStats();
});

document.getElementById('btn-select-none').addEventListener('click', () => {
  keepSet = new Set();
  syncCheckboxes();
  updateStats();
});

function syncCheckboxes() {
  document.querySelectorAll('input[type="checkbox"][data-tab-id]').forEach(cb => {
    const id = parseInt(cb.dataset.tabId, 10);
    cb.checked = keepSet.has(id);
    cb.closest('.tab-card').classList.toggle('dimmed', !cb.checked);
  });
}

// ── Helpers ───────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function showError(msg) {
  document.getElementById('loading-state').classList.add('hidden');
  document.getElementById('error-msg').textContent = msg;
  document.getElementById('error-state').classList.remove('hidden');
}

// ── Start ─────────────────────────────────────────────────────────
init();
