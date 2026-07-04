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
    handleBookmarkTabs(message.groups, message.tabData).then(sendResponse).catch(err => {
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

async function handleBookmarkTabs(groups, tabData) {
  const tabMap = new Map(tabData.map(t => [t.id, t]));
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const parentFolder = await chrome.bookmarks.create({ title: `Tab Organizer — ${dateStr}` });

  for (const group of groups) {
    if (group.tabs.length === 0) continue;
    const folder = await chrome.bookmarks.create({
      parentId: parentFolder.id,
      title: `${group.name} (${group.relevance})`
    });
    for (const tabId of group.tabs) {
      const tab = tabMap.get(tabId);
      if (tab) {
        await chrome.bookmarks.create({
          parentId: folder.id,
          title: tab.title,
          url: tab.url
        });
      }
    }
  }

  return { success: true };
}

async function handleCloseTabs(idsToClose) {
  const validIds = idsToClose.filter(id => typeof id === 'number');
  if (validIds.length > 0) {
    await chrome.tabs.remove(validIds);
  }
  return { success: true, closed: validIds.length };
}
