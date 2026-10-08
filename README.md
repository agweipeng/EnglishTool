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
- **Auto-fill** from [Wiktionary](https://en.wiktionary.org) and the [Free Dictionary API](https://dictionaryapi.dev) (both asked at once, first answer wins, with a 5-second timeout), Chinese translation via [MyMemory](https://mymemory.translated.net), and **synonyms / antonyms / word family / collocations** from [Datamuse](https://www.datamuse.com/api/) — all free, no API key
- **Bulk import** — paste a list of words, auto-fill + enrichment runs for each
- **Transcript extraction** — paste a podcast transcript / article paragraph, the tool picks the uncommon vocabulary you don't already have (skipping words you've marked known, including inflected forms)
- **Book Reader 📕** — includes the complete original *The Wonderful Wizard of Oz* (绿野仙踪) by L. Frank Baum: 24 chapters, chapter navigation (including a Next-chapter button at the end of each chapter), the author's introduction, and a bookmark that resumes your chapter and position in this browser — scrolling back up to the chapter controls doesn't reset it. You can also paste your own text and see your **coverage %** (an estimate based on your known-word list). Unknown words are underlined; click any word to see its **English definition** (looked up from the dictionary, or your own meaning if it's in your library), then add it with **the book's own sentence** as its example (tagged with the book title), or mark it known. Marking one form known covers the whole word family: knowing "walked" also counts "walk", "walking" and "walks". Select several words to add a **phrase**. "I know all the rest" calibrates your known-word list in one click. Names are detected and excluded.
- **7 learn modes** powered by a modified SM-2 spaced-repetition algorithm:
  - 📖 Meaning Recall — see word, recall meaning, self-rate
  - 👂 Listening MCQ — hear sentence, pick correct meaning
  - 🔤 Spelling (Dictation) — hear word, type it
  - 🎯 Sentence Cloze — fill the blank in an example
  - 🧠 Context Card — pick which sentence the word fits in
  - ✍️ Sentence Dictation — hear a whole sentence (no text shown), type it, get a word-by-word diff and accuracy %
  - 🗣️ Say it in English — see the Chinese meaning, **say** the English word or phrase (speech recognition) or type it
  - 🎲 Mixed mode (recommended) — randomly picks one per card
- **Phrase cards 💬** — click a collocation chip (shown after revealing a meaning) to turn it into its own card; filter phrases in the Library
- **Conversation Practice 🗣️** (Journal tab) — copies a role-play prompt for claude.ai built from your newest, stubborn and phrase cards; use claude.ai voice mode to speak, type `END` for corrections
- **Auto-archive at level 5** — pass a word 5 times and it's moved out of active review
- **Unknown-first + Leech-first selection** — low-level / new / overdue / often-wrong words get more chances; "stubborn words" (4+ wrong or >40% miss rate) get a big priority boost and are surfaced separately
- **Spaced Reading 📖** — a paragraph view built from your recent words' example sentences with click-to-hear highlights and Play-All
- **Listening Drill 🎧** — back-to-back TTS playback with adjustable speed, pause, repeat count
- **Shadowing 🎙️** — record your voice via mic, compare to native TTS
- **Stats** — heatmap, streak, mastery distribution chart, leech count
- **Export / Import** — JSON backup + Anki-compatible CSV
- **Sync Code** — encode all your data into a copy-paste string for cross-device transfer (no account / backend needed)
- **Dark / light theme**, keyboard shortcuts (`1` Again, `2` Hard, `3` Good, `4` Easy)
- **Chrome extension** in `extension/` — highlight any word on any webpage → right-click → it lands in your trainer with the sentence as context

## Cloud sync

This project is fully client-side and stores data in `localStorage`. For true automatic cross-device sync you would need a backend with auth. Two reasonable paths if you want to add it:

1. **Firebase** — create a free Firebase project, enable Email or Google sign-in + Firestore. Replace the `loadState/saveState` functions in `app.js` with calls to `firestore.collection('users/{uid}/data').doc('state')`. Adds ~5 KB of SDK; one config object you'd paste into a new `firebase-config.js`.
2. **Supabase** — same idea, Postgres-based, generous free tier. Replace storage layer with `supabase.from('state').upsert(...)`.

For now, use **Settings → Sync Code** to move data between devices manually (or **Export JSON** for full backups).

## Data

Learning data lives in `localStorage` under the key `englishTrainerData_v1` (words, activity, streak, journal, and `known` — your known-word list). The Book Reader keeps its current text per device under `englishTrainerReader_v1` and book positions under `englishTrainerBookmarks_v1`. Reader drafts and bookmarks are not synced or included in learning-data exports. The included book is bundled locally, so reading it requires no external request. Use **Settings → Export JSON** to back up learning data.

## Start reading

Open **Book Reader 📕** → **Read recommended book**, or visit `http://localhost:8000/?book=wizard-of-oz` after starting the local server. New readers start at Chapter 1; returning readers resume their saved position. Try 10–15 minutes, save a few useful expressions, then retell the events in your own words for 90 seconds.

The source is [Project Gutenberg eBook #55](https://www.gutenberg.org/ebooks/55). The full downloaded text, including its license, is retained in `books/wizard-of-oz-source.txt`. The reader preserves the original wording and joins the source's hard-wrapped lines into paragraphs. To rebuild the chapter asset after changing the source, run `node scripts/build-book-library.mjs`.

## Files

- `index.html` — UI shell
- `style.css` — theme tokens and layout
- `text-core.js` — pure text logic (word forms, coverage analysis, sentence splitting, dictation scoring, speech matching, role-play prompt); no DOM, shared with the tests
- `app.js` — SRS engine, TTS, views, API calls
- `reader.js` — Book Reader view and known-word actions
- `books/library.js` — bundled original book chapters; works even when opening `index.html` directly
- `scripts/build-book-library.mjs` — reproducible conversion from the retained Gutenberg source
- `practice-modes.js` — Sentence Dictation, Say-it-in-English, phrase cards, Conversation Practice
- `tests/` — unit tests for `text-core.js`

## Tests

```bash
node --test
```
