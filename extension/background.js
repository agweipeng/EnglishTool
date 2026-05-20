// Quick-Capture for English Trainer
// Adds a right-click menu: "Send selection to English Trainer"
// Opens a new tab to <trainerUrl>?add=<word>&sentence=<context>

const DEFAULT_URL = 'http://localhost:8000/';

async function getTrainerUrl() {
  const { trainerUrl } = await chrome.storage.sync.get('trainerUrl');
  return trainerUrl || DEFAULT_URL;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'send-to-trainer',
    title: 'Send "%s" to English Trainer',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'send-to-trainer') return;
  const word = (info.selectionText || '').trim().split(/\s+/)[0].replace(/[^a-zA-Z'-]/g, '');
  if (!word) return;
  // Use the full selection as the example sentence if it's longer than one word
  const sentence = (info.selectionText || '').trim();
  const base = await getTrainerUrl();
  const url = new URL(base);
  url.searchParams.set('add', word.toLowerCase());
  if (sentence && sentence !== word) url.searchParams.set('sentence', sentence);
  chrome.tabs.create({ url: url.toString() });
});
