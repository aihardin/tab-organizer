import { analyzeTabs } from '../lib/claude-client.js';

const SKIPPED_SCHEMES = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'data:'];

function isSkippable(tab) {
  if (!tab.url || !tab.title) return true;
  if (tab.title === 'New Tab' || tab.title === '') return true;
  return SKIPPED_SCHEMES.some(scheme => tab.url.startsWith(scheme));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'analyzeTabs') {
    handleAnalyzeTabs(message.goal).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true; // keep channel open for async response
  }

  if (message.action === 'bookmarkTabs') {
    handleBookmarkTabs(message.excludedIds).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.action === 'closeTabs') {
    handleCloseTabs(message.idsToClose).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleAnalyzeTabs(goal) {
  const { anthropicApiKey } = await chrome.storage.local.get('anthropicApiKey');
  if (!anthropicApiKey) {
    return { error: 'No API key set. Please open Settings and enter your Anthropic API key.' };
  }

  const allTabs = await chrome.tabs.query({});
  const tabs = allTabs.filter(t => !isSkippable(t)).map(t => ({
    id: t.id,
    title: t.title,
    url: t.url,
    windowId: t.windowId
  }));

  if (tabs.length === 0) {
    return { error: 'No organizable tabs found. Open some tabs first!' };
  }

  const result = await analyzeTabs(anthropicApiKey, tabs, goal);

  await chrome.storage.session.set({
    analysisResult: result,
    tabData: tabs,
    goal
  });

  await chrome.tabs.create({ url: chrome.runtime.getURL('review/review.html') });

  return { success: true, tabCount: tabs.length };
}

async function handleBookmarkTabs(excludedIds) {
  // Read the tab data and groups from session storage rather than the message —
  // avoids serializing the whole tab array across the message channel.
  const { analysisResult, tabData } = await chrome.storage.session.get(['analysisResult', 'tabData']);
  if (!analysisResult || !tabData) {
    return { error: 'Session data expired. Please re-run the analysis from the toolbar.' };
  }

  const excluded = new Set(Array.isArray(excludedIds) ? excludedIds : []);
  const groups = Array.isArray(analysisResult.groups) ? analysisResult.groups : [];
  const tabMap = new Map(tabData.map(t => [t.id, t]));
  // Include the time so re-running on the same day (e.g. tabs from another
  // machine) creates a distinct, clearly-labeled folder instead of a second
  // folder with an identical name.
  const stamp = new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });

  const parentFolder = await chrome.bookmarks.create({ title: `Tab Organizer — ${stamp}` });

  // Folders are created sequentially (there are only a handful), but each
  // folder's bookmarks are created in parallel — this collapses the wall-clock
  // time from O(total tabs) sequential round-trips to O(number of groups).
  // Order within a folder is not guaranteed, which is fine for topic groups.
  let count = 0;
  for (const group of groups) {
    const validTabs = group.tabs
      .map(id => tabMap.get(id))
      .filter(tab => tab && !excluded.has(tab.id));
    if (validTabs.length === 0) continue;

    const folder = await chrome.bookmarks.create({
      parentId: parentFolder.id,
      title: `${group.name} (${group.relevance})`
    });

    await Promise.all(validTabs.map(tab =>
      chrome.bookmarks.create({ parentId: folder.id, title: tab.title, url: tab.url })
    ));
    count += validTabs.length;
  }

  // If every tab was excluded, don't leave an empty parent folder behind.
  if (count === 0) {
    await chrome.bookmarks.remove(parentFolder.id).catch(() => {});
  }

  return { success: true, count };
}

async function handleCloseTabs(idsToClose) {
  const validIds = idsToClose.filter(id => typeof id === 'number');
  if (validIds.length > 0) {
    await chrome.tabs.remove(validIds);
  }
  return { success: true, closed: validIds.length };
}
