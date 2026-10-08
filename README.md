# English Vocabulary & Listening Trainer

A HTML/JS vocabulary trainer focused on building vocabulary and improving listening skills. Core features run entirely in the browser. Optional local AI uses a small Python server to connect Ollama or LM Studio.

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

Learning data stays in the browser's `localStorage`. For true automatic cross-device sync you would need a backend with auth. Two reasonable paths if you want to add it:

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

## Paragraph explanations · 段落解析

Select a complete sentence or paragraph in the Book Reader (up to 6,000 characters; local AI analyzes up to 1,200 characters, because a small local model needs about 1–2 minutes per 1,000 characters — use Claude for longer passages). A short selection such as "Aunt Em." or "Mrs. Rachel" still opens the phrase popup. The analysis panel has three views: **Simpler English**, **Key expressions**, and **Sentence structure**, with English followed by corresponding Chinese. It also offers passage read-aloud, a speaking prompt, and **Learn** buttons that save a word or phrase with its contextual meaning and original example into your existing review library. Short phrase selections retain the existing phrase popup.

The current working flow uses **Analyze with Claude**: it copies a structured tutoring prompt and opens Claude. Paste the prompt there, then copy Claude's complete reply into **Bring the AI response back → Show analysis**. The tool checks the response format and source quotations before displaying it. Explanations stay open for the current selection and are not saved; vocabulary cards are saved normally.

For automatic analysis with **Ollama**:

1. Start Ollama with an installed local chat model (`ollama list` shows your models; `ollama serve` starts the service if it is not already running). The default port is **11434**. [Official chat API](https://docs.ollama.com/api/chat) · [Structured output support](https://docs.ollama.com/capabilities/structured-outputs).
2. From the EnglishTool folder, run `python3 scripts/serve-local-ai.py` (Python 3.9+), then open `http://127.0.0.1:8000`.
3. In **Book Reader → Local AI · 本地 AI**, select **Ollama**, click **Check connection**, choose an installed chat model, then click **Use this model**.
4. With **Analyze when I select a passage** enabled, select a sentence or paragraph to start analysis automatically. Uncheck it for manual analysis.

Ollama requests use its native streaming `/api/chat` endpoint with a JSON schema, thinking disabled, a 16K requested context, and an 8K output limit; an answer may take up to 5 minutes, and the panel shows the elapsed time. The analysis covers up to 10 sentences with up to 4 grammar notes each, to keep local answers fast. Only installed local chat models are listed and allowed for inference; cloud and embedding-only models are excluded. The reader supplies learning-card examples directly from the selected source sentences, preserving the book's exact wording; definitions and explanations come from the model. Small models often shorten a sentence or add "…"; such quotes are matched back to the book's exact text, and anything that can't be found in the passage is left out instead of discarding the whole analysis. No model download or Ollama configuration changes are performed by EnglishTool. Custom Ollama port: `python3 scripts/serve-local-ai.py --ollama-port 11435`.

For automatic analysis with **LM Studio**:

1. Load a chat/instruction model in LM Studio that supports structured JSON output. In its **Developer** tab, start the local server on port **1234**. [Official server guide](https://lmstudio.ai/docs/developer/core/server) · [Structured output support](https://lmstudio.ai/docs/developer/openai-compat/structured-output).
2. From the EnglishTool folder, run `python3 scripts/serve-local-ai.py` (Python 3.9+), then open `http://127.0.0.1:8000`. This replaces the plain static server for local AI use.
3. In **Book Reader → Local AI · 本地 AI**, select **LM Studio**, click **Check connection**, choose your chat model, and click **Use this model**.
4. Select a sentence or paragraph. With **Analyze when I select a passage** enabled, analysis starts automatically. Uncheck it to use **Analyze here** manually.

The local server serves the app and forwards only model-list and chat requests to the selected service on this computer. It binds to `127.0.0.1`, requires the app's own origin, and does not require CORS or network-sharing changes. Prompts go to your local model; the provider, model choice and automatic-analysis preference are saved in this browser. Existing LM Studio settings migrate automatically. If LM Studio authentication is enabled, set `LM_STUDIO_API_TOKEN` in the server's environment; tokens are never stored in the browser or sent to Ollama. Custom ports: `python3 scripts/serve-local-ai.py --port 8001 --lmstudio-port 1235`.

Opening `index.html` directly, using the plain static server, or using the hosted static site retains the Claude workflow; automatic local AI requires the local server above. Loading a model may take time. Missing servers, authentication problems, unsupported structured output, incomplete replies and outdated responses are handled without displaying partial analysis. Closing the panel cancels the request, and for Ollama the local server also stops the model's current answer.

在 Book Reader 中选中完整句子或段落（最多 6,000 个字符；本地 AI 最多解析 1,200 个字符，因为小型本地模型每 1,000 个字符约需 1–2 分钟，更长的段落请使用 Claude），即可打开解析面板。面板包含**简化版**、**重点**和**结构拆解**，英文后附对应中文，还提供原文听读、口语练习问题，以及**加入学习**按钮，用于把词汇或短语的语境释义和原文例句保存到现有复习词库中。较短的短语选择仍使用原有短语弹窗。

Claude 流程仍可使用：点击**使用 Claude 解析**，复制提示词并打开 Claude；把提示词粘贴到 Claude，再将其完整回复粘贴到**粘贴 AI 回复 → 显示解析**。工具会检查回复格式及原文引用。解析只保留在当前选段的面板中，不会持久保存；词汇卡片会正常保存。

使用 **Ollama 自动解析**：启动 Ollama 并准备好已安装的本地聊天模型（默认端口 11434）；在 EnglishTool 文件夹运行 `python3 scripts/serve-local-ai.py`，打开 `http://127.0.0.1:8000`；点击 **Book Reader → 本地 AI**，选择 **Ollama → 检查连接 → 选择模型 → 使用此模型**。启用**选中段落后自动解析**后，选中句子或段落即可开始解析。工具只允许使用已安装的本地聊天模型，排除云端和仅用于嵌入的模型。词汇卡片的例句直接取自所选原文，模型负责释义和解析。小模型常会截短句子或加上“…”，工具会把这些引用对应回原文的准确文字，无法在段落中找到的内容会被略去，而不是丢弃整份解析。解析面板会显示已用时间。工具不会下载模型或更改 Ollama 配置。

使用 **LM Studio 自动解析**：先加载支持结构化 JSON 输出的聊天模型，在 Developer 页面启动本地服务器（默认端口 1234）；使用相同的 EnglishTool 启动命令和地址；点击 **Book Reader → 本地 AI**，选择 **LM Studio → 检查连接 → 选择模型 → 使用此模型**。关闭自动解析选项后，可点击**在工具内解析**手动开始。

本地服务器只监听本机地址，并只向所选本地服务转发模型列表和聊天请求，不需要修改 CORS 或网络共享设置。提示词发送给本地模型；浏览器仅保存服务选择、模型选择和自动解析偏好。已有 LM Studio 设置会自动迁移。若 LM Studio 启用了认证，请在服务器环境中设置 `LM_STUDIO_API_TOKEN`，令牌不会保存在浏览器中，也不会发送给 Ollama。直接打开 HTML、普通静态服务器和静态托管网站仍可使用 Claude 流程；自动本地解析需要上述本地服务器。关闭面板会取消请求；使用 Ollama 时，本地服务器也会停止模型当前的生成。

## Files

- `index.html` — UI shell
- `style.css` — theme tokens and layout
- `text-core.js` — pure text logic (word forms, coverage analysis, sentence splitting, dictation scoring, speech matching, role-play prompt); no DOM, shared with the tests
- `app.js` — SRS engine, TTS, views, API calls
- `reader.js` — Book Reader view and known-word actions
- `paragraph-core.js` / `paragraph-reader.js` — bilingual passage prompts, response validation and analysis panel
- `local-ai.js` / `local-ai-settings.js` — local AI transport, provider/model selection and automatic-analysis preferences
- `scripts/serve-local-ai.py` — loopback-only app server and Ollama/LM Studio proxy
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
python3 -m unittest discover -s tests -p 'test_local_ai_server.py'
```
