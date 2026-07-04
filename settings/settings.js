const input = document.getElementById('api-key-input');
const statusEl = document.getElementById('status-msg');

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
  statusEl.classList.remove('hidden');
  setTimeout(() => statusEl.classList.add('hidden'), 3000);
}

async function loadKey() {
  const { anthropicApiKey } = await chrome.storage.local.get('anthropicApiKey');
  if (anthropicApiKey) {
    input.value = anthropicApiKey;
    showStatus('API key is set.', 'success');
    setTimeout(() => statusEl.classList.add('hidden'), 2000);
  }
}

document.getElementById('toggle-visibility').addEventListener('click', () => {
  input.type = input.type === 'password' ? 'text' : 'password';
});

document.getElementById('save-btn').addEventListener('click', async () => {
  const key = input.value.trim();
  if (!key) {
    showStatus('Please enter an API key.', 'error');
    return;
  }
  if (!key.startsWith('sk-ant-')) {
    showStatus('Key should start with "sk-ant-". Double-check and try again.', 'error');
    return;
  }
  await chrome.storage.local.set({ anthropicApiKey: key });
  showStatus('API key saved.', 'success');
});

document.getElementById('clear-btn').addEventListener('click', async () => {
  await chrome.storage.local.remove('anthropicApiKey');
  input.value = '';
  showStatus('API key cleared.', 'success');
});

loadKey();
