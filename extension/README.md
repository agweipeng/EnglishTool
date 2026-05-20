# English Trainer Quick-Capture (Chrome Extension)

Highlight any English word on any webpage → right-click → **"Send to English Trainer"**. A new tab opens in the trainer with the word and surrounding sentence pre-filled.

## Install (developer mode)

1. Make sure the English Trainer is running (e.g. `python3 -m http.server 8000` in the project root, visit `http://localhost:8000`).
2. Open `chrome://extensions` in Chrome / Edge / Brave.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** → select this `extension/` folder.
5. Pin the extension to the toolbar (optional). Click its icon if you want to point it at a different URL than `http://localhost:8000/`.

## Usage

1. On any web page, select a word (or a short phrase — the first token becomes the word, the whole selection becomes the example sentence).
2. Right-click → **Send "..." to English Trainer**.
3. A new tab opens in the trainer, jumps to the Add view, pre-fills the word + sentence. Click **✨ Auto-fill** for translation, then **💾 Save Word**.

## Notes

- The extension only opens URLs — it does not read or write your trainer's data directly.
- The trainer URL is stored in `chrome.storage.sync` (per Google account), so it follows you across browsers signed into the same account.
