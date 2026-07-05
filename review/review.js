let tabData = [];
let analysisResult = null;
let keepSet = new Set();
let bookmarkExcluded = new Set(); // tab IDs the user has removed from bookmarking
let groupedTabCount = 0;          // total tabs across groups (for the bookmark count)

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

  groupedTabCount = analysisResult.groups.reduce(
    (n, g) => n + g.tabs.filter(id => tabMap.has(id)).length, 0);

  renderTop10(analysisResult.top10, tabMap);
  renderGroups(analysisResult.groups, tabMap);
  renderSummary(analysisResult.summary_markdown);
  updateStats();
  enableButtons();
  updateBookmarkCount();

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
    `;

    // "Skip all / Include all" toggles this whole group in/out of bookmarking.
    const groupIds = group.tabs.filter(id => tabMap.has(id));
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'group-skip';
    skip.textContent = 'Skip all';
    skip.addEventListener('click', (e) => {
      e.stopPropagation(); // don't collapse the group
      const allExcluded = groupIds.length > 0 && groupIds.every(id => bookmarkExcluded.has(id));
      groupIds.forEach(id => allExcluded ? bookmarkExcluded.delete(id) : bookmarkExcluded.add(id));
      refreshAllBmVisuals(); // one DOM pass instead of one query per tab
      skip.textContent = allExcluded ? 'Skip all' : 'Include all';
      updateBookmarkCount();
    });
    header.appendChild(skip);

    const chevron = document.createElement('span');
    chevron.className = 'chevron open';
    chevron.innerHTML = '&#9656;';
    header.appendChild(chevron);

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
  card.dataset.cardId = tab.id;
  if (!keepSet.has(tab.id)) card.classList.add('dimmed');
  if (bookmarkExcluded.has(tab.id)) card.classList.add('bm-excluded');

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
  } else {
    // Group cards get a bookmark toggle; click to remove/restore from bookmarking.
    const bm = document.createElement('button');
    bm.type = 'button';
    bm.className = 'bm-toggle';
    bm.textContent = '\u{1F516}'; // 🔖
    bm.title = bookmarkExcluded.has(tab.id) ? 'Add back to bookmarks' : 'Exclude from bookmarks';
    bm.addEventListener('click', () => toggleBookmark(tab.id));
    card.appendChild(bm);
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

// ── Bookmark selection ─────────────────────────────────────────────

function setBookmarkExcluded(id, excluded) {
  if (excluded) bookmarkExcluded.add(id);
  else bookmarkExcluded.delete(id);
  updateBmVisual(id);
}

function toggleBookmark(id) {
  setBookmarkExcluded(id, !bookmarkExcluded.has(id));
  updateBookmarkCount();
}

// Reflect a tab's bookmark state on every card that shows it (a top-10 tab also
// appears in its group), striking through the title when excluded.
function updateBmVisual(id) {
  const excluded = bookmarkExcluded.has(id);
  document.querySelectorAll(`.tab-card[data-card-id="${id}"]`).forEach(card => {
    card.classList.toggle('bm-excluded', excluded);
    const bm = card.querySelector('.bm-toggle');
    if (bm) bm.title = excluded ? 'Add back to bookmarks' : 'Exclude from bookmarks';
  });
}

// Re-sync every card's bookmark visual from the set in a single pass — used for
// bulk group toggles where updating per-tab would query the DOM repeatedly.
function refreshAllBmVisuals() {
  document.querySelectorAll('.tab-card[data-card-id]').forEach(card => {
    const excluded = bookmarkExcluded.has(parseInt(card.dataset.cardId, 10));
    card.classList.toggle('bm-excluded', excluded);
    const bm = card.querySelector('.bm-toggle');
    if (bm) bm.title = excluded ? 'Add back to bookmarks' : 'Exclude from bookmarks';
  });
}

function updateBookmarkCount() {
  const count = groupedTabCount - bookmarkExcluded.size;
  const btn = document.getElementById('btn-bookmark');
  btn.textContent = count > 0
    ? `\u{1F516} Bookmark ${count} tab${count === 1 ? '' : 's'}`
    : '\u{1F516} Bookmark (none selected)';
  btn.disabled = count === 0;
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
  const willBookmark = groupedTabCount - bookmarkExcluded.size;
  if (willBookmark <= 0) {
    showActionStatus('No tabs selected to bookmark.', 'info');
    return;
  }

  document.getElementById('btn-bookmark').disabled = true;
  showActionStatus('Bookmarking...', 'info');
  // The worker reads groups + tab data from session storage; only the (usually
  // small) list of excluded tab IDs is sent across the message channel.
  const response = await chrome.runtime.sendMessage({
    action: 'bookmarkTabs',
    excludedIds: [...bookmarkExcluded]
  });
  if (!response || response.error) {
    showActionStatus('Bookmark error: ' + (response?.error ?? 'Extension error — try again.'), 'error');
  } else {
    const n = response.count ?? willBookmark;
    showActionStatus(`Bookmarked ${n} tab${n === 1 ? '' : 's'} in Chrome Bookmarks.`, 'success');
  }
  updateBookmarkCount(); // restore button label + enabled state
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
