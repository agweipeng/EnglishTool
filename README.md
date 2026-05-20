# English Vocabulary & Listening Trainer

A pure HTML/JS vocabulary trainer focused on building vocabulary and improving listening skills. Runs entirely in the browser — no install, no backend.

## Quick start

Just open `index.html` in a modern browser (Chrome / Edge / Safari).

For best results (especially the Free Dictionary API and microphone access), serve locally:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Features

- **Add words** with phonetic, EN definition, CN meaning (中文释义), example sentences (EN + CN), tags
- **Auto-fill** from [Free Dictionary API](https://dictionaryapi.dev) and Chinese translation via [MyMemory](https://mymemory.translated.net) — no API key needed
- **Bulk import** — paste a list of words, auto-fill runs for each
- **4 learn modes** powered by a modified SM-2 spaced-repetition algorithm:
  - 📖 Meaning Recall — see word, recall meaning, self-rate
  - 👂 Listening MCQ — hear sentence, pick correct meaning
  - 🔤 Spelling (Dictation) — hear word, type it
  - 🎯 Sentence Cloze — fill the blank in an example
  - 🎲 Mixed mode (recommended) — randomly picks one per card
- **Auto-archive at level 5** — pass a word 5 times and it's moved out of active review
- **Unknown-first selection** — low-level / new / overdue / often-wrong words get more chances
- **Listening Drill** — back-to-back TTS playback with adjustable speed, pause, repeat count
- **Shadowing** — record your voice via mic, compare to native TTS
- **Stats** — heatmap, streak, mastery distribution chart
- **Export/Import** — JSON backup + Anki-compatible CSV
- **Dark / light theme**, keyboard shortcuts (`1` Again, `2` Hard, `3` Good, `4` Easy)

## Data

All data lives in `localStorage` under the key `englishTrainerData_v1`. Use **Settings → Export JSON** to back up.

## Files

- `index.html` — UI shell
- `style.css` — theme tokens and layout
- `app.js` — SRS engine, TTS, views, API calls
