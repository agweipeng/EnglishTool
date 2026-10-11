const $ = id => document.getElementById(id);

(async () => {
  const { trainerUrl } = await chrome.storage.sync.get('trainerUrl');
  $('urlInput').value = trainerUrl || 'http://localhost:8000/';
})();

$('saveBtn').addEventListener('click', async () => {
  const url = $('urlInput').value.trim();
  let valid = false;
  try {
    const parsed = new URL(url);
    valid = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname));
  } catch { /* not a URL */ }
  if (!valid) {
    $('okMsg').textContent = 'Use an https:// address (or http://localhost)';
    return;
  }
  await chrome.storage.sync.set({ trainerUrl: url });
  $('okMsg').textContent = '✓ Saved';
  setTimeout(() => { $('okMsg').textContent = ''; }, 1500);
});
