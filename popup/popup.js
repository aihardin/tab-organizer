const views = {
  main: document.getElementById('main-view'),
  loading: document.getElementById('loading-view'),
  done: document.getElementById('done-view'),
  error: document.getElementById('error-view')
};

function showView(name) {
  Object.entries(views).forEach(([key, el]) => el.classList.toggle('hidden', key !== name));
}

async function checkApiKey() {
  const { anthropicApiKey } = await chrome.storage.local.get('anthropicApiKey');
  if (!anthropicApiKey) {
    document.getElementById('no-key-banner').classList.remove('hidden');
  }
}

document.getElementById('open-settings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById('settings-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById('analyze-btn').addEventListener('click', async () => {
  const goal = document.getElementById('goal-input').value.trim();
  if (!goal) {
    document.getElementById('goal-input').focus();
    return;
  }

  showView('loading');
  document.getElementById('loading-text').textContent = 'Gathering tabs...';

  const response = await chrome.runtime.sendMessage({ action: 'analyzeTabs', goal });

  if (!response || response.error) {
    document.getElementById('error-text').textContent =
      response?.error ?? 'Extension error — try reloading the extension and retrying.';
    showView('error');
  } else {
    showView('done');
  }
});

document.getElementById('retry-btn').addEventListener('click', () => {
  showView('main');
});

document.getElementById('reopen-btn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('review/review.html') });
  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { active: true });
  } else {
    await chrome.tabs.create({ url: chrome.runtime.getURL('review/review.html') });
  }
});

checkApiKey();
