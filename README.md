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
- **Book Reader 📕** — includes five complete original books (115 chapters and stories), a browsable shelf with reading guidance, chapter navigation, and separate bookmarks that resume each book at your saved chapter and text position in this browser — scrolling back up to the chapter controls doesn't reset it. You can also paste your own text and see your **coverage %** (an estimate based on your known-word list). Unknown words are underlined; click any word to see its **English definition** (looked up from the dictionary, or your own meaning if it's in your library), then add it with **the book's own sentence** as its example (tagged with the book title), or mark it known. Marking one form known covers the whole word family: knowing "walked" also counts "walk", "walking" and "walks". Select several words to add a **phrase**. "I know all the rest" calibrates your known-word list in one click. Names are detected and excluded.
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

Learning data lives in `localStorage` under the key `englishTrainerData_v1` (words, activity, streak, journal, and `known` — your known-word list). The Book Reader keeps a pasted-text draft or bundled-book reference under `englishTrainerReader_v1`, per-book positions under `englishTrainerBookmarks_v1`, and the last opened book under `englishTrainerLastBook_v1`. Bookmarks use stable chapter IDs, a text offset/excerpt, chapter version, and a scroll-percentage fallback. Legacy Wizard of Oz bookmarks migrate automatically. **Settings → Export JSON** includes reading progress alongside learning data; importing merges bookmarks using their timestamps and accepts older backups without reader data. After restoring a backup, the reader discards outdated bundled text and resumes the merged bookmark; personal pasted text is preserved. Pasted drafts and book content are not included in backups. Reader progress remains per-device and is not included in Sync Code or cloud sync. All book files are bundled locally; HTTP loads only the selected manifest and chapter. Opening `index.html` directly loads only the selected book’s compatibility package.

## Start reading

Open **Book Reader 📕** → **Read recommended book**, or visit `http://localhost:8000/?book=wizard-of-oz` after starting the local server. New readers start at Chapter 1; returning readers resume their saved position. Selecting a book updates the URL so a reload keeps that book. Analyzing pasted text removes the book route and preserves the personal draft. Try 10–15 minutes, save a few useful expressions, then retell the events in your own words for 90 seconds.

The shelf contains complete Project Gutenberg editions, with full source text and license retained in each book package:

| Book | Sections | Suggested order |
| --- | --- | --- |
| [The Wonderful Wizard of Oz](https://www.gutenberg.org/ebooks/55) · 绿野仙踪 | 24 chapters | Start here |
| [The Railway Children](https://www.gutenberg.org/ebooks/1874) · 铁路少年 | 14 chapters | Try next |
| [The Secret Garden](https://www.gutenberg.org/ebooks/113) · 秘密花园 | 27 chapters | Early choice; some dialect |
| [Anne of Green Gables](https://www.gutenberg.org/ebooks/45) · 绿山墙的安妮 | 38 chapters | Later step |
| [The Adventures of Sherlock Holmes](https://www.gutenberg.org/ebooks/1661) · 福尔摩斯冒险史 | 12 stories | Later challenge |

These are qualitative reading suggestions, not measured CEFR levels. Try a chapter and judge whether you can follow the story. The reader preserves the source wording and joins hard-wrapped lines into paragraphs, removing standalone illustration markers.

## Add future books

The reader is independent of the titles in the catalog. To add a curated Gutenberg TXT edition:

1. Save the complete TXT source, including its license.
2. Create a metadata JSON file using an existing `books/<book-id>/metadata.json` as a template. Give it a permanent unique `id`, title, author, Chinese title, source link, license, reading guidance, and expected section count.
3. Set `parser.headingPattern` to a multiline regular expression with two capture groups: the section number (Roman or decimal), then the title. Choose `sectionType: "chapter"` or `"story"`. An optional `introductionPattern` captures an author’s introduction.
4. Run the import command and review the first and last sections. Missing sections, duplicate IDs, unexpected lengths, and invalid metadata fail validation before assets are written.

```bash
node scripts/import-book.mjs --source /path/to/book.txt --metadata /path/to/metadata.json
node --test
```

The importer generates `books/<book-id>/manifest.json`, separate `chapters/<chapter-id>.json` files, `source.txt`, an on-demand `file-data.js` fallback, and the metadata-only catalog. It also pins `sectionIds` in the metadata. Keep those IDs when correcting titles; assign a new permanent ID when adding a section. On subsequent source updates, rebuild all packages with:

```bash
node scripts/import-book.mjs --all
# Existing entry point also rebuilds all books:
node scripts/build-book-library.mjs
```

HTTP reading fetches a manifest and one chapter at a time. Successful requests are cached for the browser session; failures can be retried. The direct-file fallback loads one complete selected book because browsers restrict local JSON requests. Book and chapter loading is protected against stale responses during fast navigation.

This release supports curated Gutenberg TXT imports through the command above. Personal TXT/EPUB upload, IndexedDB storage, and service-worker offline caching remain future work. The paste-text reader is still available.

## Files

- `index.html` — UI shell
- `style.css` — theme tokens and layout
- `text-core.js` — pure text logic (word forms, coverage analysis, sentence splitting, dictation scoring, speech matching, role-play prompt); no DOM, shared with the tests
- `app.js` — SRS engine, TTS, views, API calls
- `reader.js` — Book Reader view and known-word actions
- `books/catalog.json` / `catalog.js` — metadata-only bookshelf
- `books/<book-id>/` — source, metadata, manifest, chapter files, direct-file fallback
- `book-repository.js` — generic chapter loader, validation and session cache
- `reader-progress.js` — bookmark migration and JSON backup merge
- `scripts/import-book.mjs` / `book-import-core.mjs` — reusable source conversion
- `scripts/build-book-library.mjs` — compatibility entry point to rebuild all packages
- `practice-modes.js` — Sentence Dictation, Say-it-in-English, phrase cards, Conversation Practice
- `tests/` — text logic, complete-source verification, lazy loading, bookmark migration/backup, and reader navigation tests

## Tests

```bash
node --test
```
