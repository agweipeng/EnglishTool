const $ = id => document.getElementById(id);

(async () => {
  const { trainerUrl } = await chrome.storage.sync.get('trainerUrl');
  $('urlInput').value = trainerUrl || 'http://localhost:8000/';
})();

$('saveBtn').addEventListener('click', async () => {
  const url = $('urlInput').value.trim();
  await chrome.storage.sync.set({ trainerUrl: url });
  $('okMsg').textContent = '✓ Saved';
  setTimeout(() => { $('okMsg').textContent = ''; }, 1500);
});
