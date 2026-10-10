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
- **Reader 📖** — includes seven complete original books (137 chapters and stories, from *The Wonderful Wizard of Oz* to early 20th-century English in *The Great Gatsby* and Agatha Christie's first Poirot mystery), a browsable shelf with reading guidance, chapter navigation, and separate bookmarks. **Modern English news**: fresh articles from *The Conversation* every day and easier *VOA Learning English* lessons with a built-in audio player (0.75×–1× speed) for listening and shadowing, read in the same reader. Save up to 50 of your own transcripts or articles (for example **BBC Learning English** episodes) on the **My reading materials** shelf, with an optional source link and an optional https audio link (such as the episode's MP3) that plays above the text, or **import an article from any link** in one click; they sync and back up with your learning data. See your **coverage %** (an estimate based on your known-word list). Unknown words are underlined; click any word to see its **English definition** (looked up from the dictionary, or your own meaning if it's in your library), then add it with its original sentence as the example or mark it known. Marking one form known covers the whole word family. Select several words to add a **phrase**. Names are detected and excluded. Every paragraph ends with a **🎙️ Read aloud** button that opens the Read Aloud Challenge for that paragraph.
- **Analyses 📝** — every AI passage analysis from the Reader is saved here so you can search it, reopen it, read the original aloud, or jump back to the passage later
- **Quiz 🧩** — use your words actively: write 2–3 sentences with each of 5 words or phrases from your Library and saved analyses, then check all 5 with local AI, Claude or ChatGPT
- Pop-up windows (word cards, AI analysis, Local AI settings, Read Aloud) close when you click outside them
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
- **Journal ✍️** — write a few sentences each day, then **Grade with Claude** or **Grade with ChatGPT** (the prompt is copied and the site opens). Paste the reply into **AI feedback** under the entry: it is saved with that day, marked in Recent Entries, and syncs and backs up with your learning data
- **Conversation Practice 🗣️** (Journal tab) — copies a role-play prompt for Claude or ChatGPT built from your newest, stubborn and phrase cards; use voice mode to speak, type `END` for corrections
- **Auto-archive at level 5** — pass a word 5 times and it's moved out of active review
- **Unknown-first + Leech-first selection** — low-level / new / overdue / often-wrong words get more chances; "stubborn words" (4+ wrong or >40% miss rate) get a big priority boost and are surfaced separately
- **9 tabs**: Learn, Words, Practice, Reader, Analyses, Quiz, Journal, News, Settings. **Words** is the library with **➕ Add a word · Bulk import** at the top (opened by itself while the library is empty); **Practice** holds Spaced Reading and Listening Drill; Learn shows **📊 Your progress** above the cards. The Digests pages are still at `digests/`, just no longer linked from the top bar. / 共 9 个标签页：Words（词库，顶部可添加单词）、Practice（间隔阅读 + 听力训练）、Learn 顶部显示学习进度。
- **Spaced Reading 📖** (Practice) — a paragraph view built from your recent words' example sentences with click-to-hear highlights and Play-All
- **Listening Drill 🎧** (Practice) — back-to-back TTS playback with adjustable speed, pause, repeat count
- **Shadowing 🎙️** — record your voice via mic, compare to native TTS
- **📊 Your progress** (top of Learn) — due today, streak and today's reviews at a glance; open it for word counts, the heatmap and the mastery chart
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

Learning data lives in `localStorage` under the key `englishTrainerData_v1` (words, activity, streak, journal, `known` — your known-word list, `analyses` — saved passage analyses, `materials` — saved transcripts and articles, and `journalFeedback` — pasted Claude/ChatGPT replies to journal entries, newest edit winning per day when devices sync; deleted analyses and materials leave a small marker so sync doesn't bring them back). Words and journal entries work the same way: `deletedWords` and `journalLog` record when a word was deleted and when each day's entry was last saved or deleted, so for each word or day the newest change wins on every device — a deleted word or entry stays deleted, and a shortened entry is not replaced by an older, longer one. **Reset All** and replacing data with a **Sync Code** also leave these markers, so the old data doesn't come back from the gist. Importing a JSON backup merges its journal and streak too, and words it brings back are no longer marked deleted. When browser storage is full, a review, a new or edited word, a deletion or a journal entry is not half-saved: the change is undone and a message says why. 单词和日记也会记录删除及保存时间，因此同步时每个单词或每天的日记都以最新的修改为准：删除的内容不会被同步恢复，缩短的日记也不会被旧的长版本覆盖；**Reset All** 和用 Sync Code 替换数据后，旧数据也不会从云端回来。导入 JSON 备份会一并合并日记和连续天数。浏览器存储已满时，修改会被撤销并显示原因，不会只保存一半。 Saved materials are included in Export/Import JSON, Sync Code and cloud sync; each is limited to 60,000 characters to keep sync small. Browsers allow about 5 MB of `localStorage` per site, and the cloud-sync file is the same data: **Settings → Storage** shows how much is used, split into words and progress, saved analyses and reading materials, and warns from about 3 MB. Gist files over 1 MB are read in full through their `raw_url`. Every sync, including the automatic one a few seconds after each save, reads and merges the gist before pushing, so devices never overwrite each other's changes; a failed read stops the sync instead of pushing. The Reader keeps the current pasted-text draft under `englishTrainerReader_v1`, per-book positions under `englishTrainerBookmarks_v1`, and the last opened book under `englishTrainerLastBook_v1`; reader progress stays in this browser and is not included in Sync Code or cloud sync. Bookmarks use stable chapter IDs, a text offset/excerpt, chapter version, and a scroll-percentage fallback. Legacy Wizard of Oz bookmarks migrate automatically. **Settings → Export JSON** includes reading progress alongside learning data; importing merges bookmarks using their timestamps and accepts older backups without reader data. All book files are bundled locally; HTTP loads only the selected manifest and chapter. Opening `index.html` directly loads only the selected book’s compatibility package.

## Start reading

Open **Reader 📖** → **Read recommended book**, or visit `http://localhost:8000/?book=wizard-of-oz` after starting the local server. New readers start at Chapter 1; returning readers resume their saved position. For current English, open **Modern English: news & articles** and choose *The Conversation* or *VOA Learning English*. To keep a transcript such as a BBC Learning English episode, open **Or paste your own text**, enter its title, type and source link, then choose **Save to materials**. Open it later from **My reading materials**. Try 10–15 minutes, save a few useful expressions, then retell the content in your own words for 90 seconds.

The shelf contains complete Project Gutenberg editions, with full source text and license retained in each book package:

| Book | Sections | Suggested order |
| --- | --- | --- |
| [The Wonderful Wizard of Oz](https://www.gutenberg.org/ebooks/55) · 绿野仙踪 | 24 chapters | Start here |
| [The Railway Children](https://www.gutenberg.org/ebooks/1874) · 铁路少年 | 14 chapters | Try next |
| [The Secret Garden](https://www.gutenberg.org/ebooks/113) · 秘密花园 | 27 chapters | Early choice; some dialect |
| [Anne of Green Gables](https://www.gutenberg.org/ebooks/45) · 绿山墙的安妮 | 38 chapters | Later step |
| [The Adventures of Sherlock Holmes](https://www.gutenberg.org/ebooks/1661) · 福尔摩斯冒险史 | 12 stories | Later challenge |
| [The Great Gatsby](https://www.gutenberg.org/ebooks/64317) · 了不起的盖茨比 | 9 chapters | Early 20th-century English (1925) |
| [The Mysterious Affair at Styles](https://www.gutenberg.org/ebooks/863) · 斯泰尔斯庄园奇案 | 13 chapters | Early 20th-century English (1920); lots of dialogue |

*The Mysterious Affair at Styles* is public domain in the USA, where this site is hosted; it may still be under copyright in countries with life-plus-70-year terms.

These are qualitative reading suggestions, not measured CEFR levels. Try a chapter and judge whether you can follow the story. The reader preserves the source wording and joins hard-wrapped lines into paragraphs, removing standalone illustration markers.

## Modern English news

Two openly licensed news sources are bundled as Reader packages (one article per section), so word lookups, coverage, bookmarks and AI passage analysis all work on them:

| Source | Articles | License |
| --- | --- | --- |
| [The Conversation](https://theconversation.com/global) | Newest 30, refreshed daily by the **Daily News** GitHub Action | [CC BY-ND 4.0](https://creativecommons.org/licenses/by-nd/4.0/): article text republished unchanged with author credit and a link; images and embedded media are left out, and articles with tables or sidebars are skipped so no text is dropped |
| [VOA Learning English](https://learningenglish.voanews.com) | 41 lessons and articles from early 2025, with audio links | Public domain (U.S. government work). VOA stopped publishing new lessons in March 2025. Only articles with a VOA Learning English byline are kept; stories adapted from AP, Reuters or AFP reports are skipped, because only VOA's own writing is public domain |

Each article shows its author, date, credit line and a link to the original; VOA lessons play their audio in the reader's player. To refresh them by hand:

```bash
node scripts/import-news.mjs conversation
node scripts/import-news.mjs voa
```

The importer keeps the newest articles, removes old article files, leaves the package unchanged if a feed fails, and only rewrites it when something changed.

**Import an article from a link** (Reader): paste any article link and choose **📥 Import**. Because a static site can't download other websites' pages, the page is read through the free [Jina Reader](https://jina.ai/reader/) service (`https://r.jina.ai/<link>`); only the article link (including anything after `?` in it) is sent, never your learning data or any name or password in the link. Links typed without `https://` work too. The Markdown it returns is turned into plain text, opened in the Reader as *News* (or the type you chose), and saved to **My reading materials**, so it stays private to you, syncs, and gets word lookups and news-style AI analysis. Importing the same page again updates it; a different page with the same title gets its site name added, so nothing on your shelf is replaced. Pages behind a login or paywall, or with very little text, are refused with a message — copy and paste those instead. Articles over 60,000 characters open but aren't saved.

**News tab 📰** lists daily headlines from Anthropic, OpenAI and Google AI plus trending AI repositories, from `news.json` written by the same GitHub Action (`scripts/fetch-news.mjs`). These articles are copyrighted, so the repository only stores links; **📥 Import to Reader** on a headline imports it as above.

**现代英语阅读**：在 Reader 中打开 **Modern English: news & articles**，可以阅读每天更新的 *The Conversation* 文章（大学学者为大众撰写的地道英语，CC BY-ND 4.0 授权，正文文字原样转载并注明作者和出处，不含图片和嵌入媒体），以及较简单、带音频的 *VOA Learning English* 课程（公有领域；VOA 自 2025 年 3 月起停止更新）。VOA 课程可在阅读器内的播放器中收听（可调 0.75×–1× 语速），适合边听边读和跟读；保存的材料也可附上 https 音频链接（如 BBC 节目的 MP3）。**从链接导入文章**：在 Reader 中粘贴文章链接并点击 **📥 Import**，正文会通过免费的 Jina Reader 服务读取（只发送链接，不发送学习数据），以新闻类型打开，并私下保存到“我的阅读材料”，可查词并做 AI 解析；需要登录或付费的网页请复制粘贴。**News 📰** 标签页列出 Anthropic、OpenAI、Google 的每日新闻标题，点击 **📥 Import to Reader** 即可导入阅读。BBC Learning English 的文字稿受 BBC 版权保护，不能放进公开网站：请复制文字稿，粘贴到 **My reading materials**（我的阅读材料）保存，这些材料只属于你自己，并会随学习数据一起同步和备份。

## Add future books

The reader is independent of the titles in the catalog. To add a curated Gutenberg TXT edition:

1. Save the complete TXT source, including its license.
2. Create a metadata JSON file using an existing `books/<book-id>/metadata.json` as a template. Give it a permanent unique `id`, title, author, Chinese title, source link, license, reading guidance, and expected section count.
3. Set `parser.headingPattern` to a multiline regular expression with two capture groups: the section number (Roman or decimal), then the title. For books whose chapters have only numbers (such as *The Great Gatsby*), use one capture group and set `parser.untitledSections: true`. Choose `sectionType: "chapter"` or `"story"`. An optional `introductionPattern` captures an author’s introduction.
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

Select a complete sentence or paragraph in the Reader (up to 6,000 characters; local AI analyzes up to 1,200 characters, because a small local model needs about 1–2 minutes per 1,000 characters — use Claude or ChatGPT for longer passages). A short selection such as "Aunt Em." or "Mrs. Rachel" still opens the phrase popup. The analysis panel has three views: **Simpler English**, **Key expressions**, and **Sentence structure**, with English followed by corresponding Chinese. It also offers passage read-aloud, a speaking prompt with **📋 Copy role-play → ChatGPT** (a conversation that opens with the question, knows the passage and steers you to its key words and phrases; type `END` for feedback — 与 ChatGPT 围绕该问题进行角色扮演对话), and **Learn** buttons that save a word or phrase with its contextual meaning and original example into your existing review library. Short phrase selections retain the existing phrase popup.

Without local AI, use **Analyze with Claude** or **Analyze with ChatGPT**: it copies a structured tutoring prompt and opens claude.ai or chatgpt.com. On iPhone and iPad the ChatGPT links open the ChatGPT app when it is installed (they use `chatgpt.com/#native`, the address the app claims, in the same tab, because iOS only hands real link taps to apps); without the app, chatgpt.com opens in Safari — use Back to return. Paste the prompt there, then copy the complete reply into **Bring the AI response back → Show analysis**. A reply with a sentence or code block around the JSON is accepted, and so are the usual slips in replies copied from a chat app (invisible characters from the phone, unescaped quotes or line breaks, trailing commas, curly quotes, a wrapper object or other key names such as `main_point`). Sentences are matched to the passage even when the passage abbreviates ("U.S.", "D.C.") or the reply writes "-" for "—". If a reply still can't be used, the panel says why (no JSON found, a missing section, or sentences from another passage). The tool checks the response format and source quotations before displaying it. Vocabulary cards are saved normally.

**Type-aware analysis** — the prompt adapts to what you are reading. Books avoid spoilers and end with a retelling question. News explains the writer's main claim, key details and stance without adding facts, and asks you to sum it up or give your view. Conversations (such as BBC transcripts) favour natural spoken expressions, idioms and phrasal verbs, explain what the speakers mean and their tone, and ask you to reply as you would in a real conversation. Bundled news uses the news guide automatically; pasted text uses the **Type** you choose; saved analyses show their type. / 解析会按材料类型调整：小说不剧透，新闻提炼作者观点，对话侧重口语表达，并给出相应的练习问题。

**Analyses tab 📝** — every finished analysis (from Ollama, LM Studio or a pasted Claude or ChatGPT reply) is saved automatically in the **Analyses** tab, newest first, with its book, chapter, date and model. Search by passage, book, chapter or explanation; **Open** shows the full analysis again without asking the model, **🎙️ Read aloud** opens the Read Aloud Challenge with the whole original passage, **Open in book** jumps back to the passage in its chapter, and **Delete** removes it. Analysing the same passage again replaces the older analysis. Saved analyses are part of your learning data, so they are included in Export/Import JSON, Sync Code and cloud sync; a deletion also syncs to your other devices.

**Quiz tab 🧩** — **New quiz** picks 5 words or phrases: by default a mix of Library words (stubborn words and phrases first) and words or phrases from saved analyses, or only one source. Words from your last 3 quizzes are held back. For each one you see its meaning and an example sentence (🔊 to hear it), then write 2–3 sentences using it in different ways; a hint shows when the word (in any form) is used, and **Swap word** picks another. Your writing is kept as a draft on this device. When you are ready, check all answers together with **local AI**, **Claude** or **ChatGPT** (paste the reply back) — nothing is sent automatically. Each answer gets a verdict (✓ natural / ~ understandable / ✗ needs work), a corrected version with a short English and Chinese note, and a model sentence, each with a 🎙️ Read aloud button; a reply that isn’t in the expected format is still saved as text. Every checked quiz is kept under **Past quizzes** and is part of Export/Import JSON, Sync Code and cloud sync.

For analysis with **Ollama**:

1. Start Ollama with an installed local chat model (`ollama list` shows your models; `ollama serve` starts the service if it is not already running). The default port is **11434**. [Official chat API](https://docs.ollama.com/api/chat) · [Structured output support](https://docs.ollama.com/capabilities/structured-outputs).
2. From the EnglishTool folder, run `python3 scripts/serve-local-ai.py` (Python 3.9+), then open `http://127.0.0.1:8000`.
3. In **Reader → Local AI · 本地 AI**, select **Ollama**, click **Check connection**, choose an installed chat model, then click **Use this model**.
4. Select a sentence or paragraph, then choose **Analyze with local AI** in the analysis panel. Local AI never starts by itself: each time you pick local AI, Claude or ChatGPT.

Ollama requests use its native streaming `/api/chat` endpoint with a JSON schema, thinking disabled, a 16K requested context, and an 8K output limit; an answer may take up to 5 minutes, and the panel shows the elapsed time. The analysis covers up to 10 sentences with up to 4 grammar notes each, to keep local answers fast. Only installed local chat models are listed and allowed for inference; cloud and embedding-only models are excluded. The reader supplies learning-card examples directly from the selected source sentences, preserving the book's exact wording; definitions and explanations come from the model. Small models often shorten a sentence or add "…"; such quotes are matched back to the book's exact text, and anything that can't be found in the passage is left out instead of discarding the whole analysis. No model download or Ollama configuration changes are performed by EnglishTool. Custom Ollama port: `python3 scripts/serve-local-ai.py --ollama-port 11435`.

For analysis with **LM Studio**:

1. Load a chat/instruction model in LM Studio that supports structured JSON output. In its **Developer** tab, start the local server on port **1234**. [Official server guide](https://lmstudio.ai/docs/developer/core/server) · [Structured output support](https://lmstudio.ai/docs/developer/openai-compat/structured-output).
2. From the EnglishTool folder, run `python3 scripts/serve-local-ai.py` (Python 3.9+), then open `http://127.0.0.1:8000`. This replaces the plain static server for local AI use.
3. In **Reader → Local AI · 本地 AI**, select **LM Studio**, click **Check connection**, choose your chat model, and click **Use this model**.
4. Select a sentence or paragraph, then choose **Analyze with local AI** in the analysis panel (or Claude / ChatGPT).

The local server serves the app and forwards only model-list and chat requests to the selected service on this computer. It binds to `127.0.0.1`, requires the app's own origin, and does not require CORS or network-sharing changes. Prompts go to your local model; the provider and model choice are saved in this browser. Existing LM Studio settings migrate automatically. If LM Studio authentication is enabled, set `LM_STUDIO_API_TOKEN` in the server's environment; tokens are never stored in the browser or sent to Ollama. Custom ports: `python3 scripts/serve-local-ai.py --port 8001 --lmstudio-port 1235`.

Opening `index.html` directly or using the plain static server retains the Claude and ChatGPT workflow; automatic local AI there requires the local server above.

**Ollama on the hosted site** (https://agweipeng.github.io/EnglishTool/): the page connects straight to Ollama on the same computer, so no Python server is needed. Allow the site once in Terminal, then quit and reopen Ollama:

```bash
launchctl setenv OLLAMA_ORIGINS "https://agweipeng.github.io"
```

Use Chrome or Edge on that computer and allow local network access if the browser asks. Never set `OLLAMA_ORIGINS` to `*`, which would let any website use your Ollama. `launchctl setenv` lasts until you restart the Mac. This does not work on a phone, because Ollama only listens on the computer itself; LM Studio still needs the local server. Loading a model may take time. Missing servers, authentication problems, unsupported structured output, incomplete replies and outdated responses are handled without displaying partial analysis. Closing the panel cancels the request, and for Ollama the local server also stops the model's current answer.

在 Reader 中选中完整句子或段落（最多 6,000 个字符；本地 AI 最多解析 1,200 个字符，因为小型本地模型每 1,000 个字符约需 1–2 分钟，更长的段落请使用 Claude 或 ChatGPT），即可打开解析面板。面板包含**简化版**、**重点**和**结构拆解**，英文后附对应中文，还提供原文听读、口语练习问题，以及**加入学习**按钮，用于把词汇或短语的语境释义和原文例句保存到现有复习词库中。较短的短语选择仍使用原有短语弹窗。

没有本地 AI 时，可点击**使用 Claude 解析**或**使用 ChatGPT 解析**，复制提示词并打开 claude.ai 或 chatgpt.com；把提示词粘贴过去，再将其完整回复粘贴到**粘贴 AI 回复 → 显示解析**。工具会检查回复格式及原文引用。词汇卡片会正常保存。

**解析标签页 📝**：每次完成的解析（来自 Ollama、LM Studio 或粘贴的 Claude / ChatGPT 回复）都会自动保存在 **Analyses** 标签页中，按时间从新到旧排列，并记录书名、章节、日期和模型。可按原文、书名、章节或解析内容搜索；**查看**会重新显示完整解析而无需再次调用模型，**🎙️ Read aloud** 会用完整原文打开朗读挑战，**回到原书**会跳转到该段落所在章节，**删除**可移除解析。再次解析同一段落会替换旧的解析。已保存的解析属于学习数据，会包含在 JSON 导出/导入、Sync Code 和云同步中；删除操作也会同步到其他设备。

**测验标签页 🧩**：**新测验**会挑选 5 个词或短语：默认混合词库中的单词（优先难记的词和短语）与已保存解析中的词语，也可只用其中一种来源；最近 3 次测验用过的词会暂缓出现。每个词都会显示释义和例句（可点 🔊 收听），然后用不同方式写 2–3 个句子；用到该词（任何词形）时会有提示，**换一个词**可以换词。你写的内容会作为草稿保存在本设备上。准备好后，用**本地 AI**、**Claude** 或 **ChatGPT**（把回复粘贴回来）一起检查所有答案，不会自动发送。每题都有判定（✓ 自然 / ~ 能懂但不地道 / ✗ 需要修改）、修改后的句子及简短的中英文说明，以及示范句，并都带有 🎙️ Read aloud 按钮；格式不符的回复也会以文本形式保存。每次检查过的测验都会保存在**历史测验**中，并包含在 JSON 导出/导入、Sync Code 和云同步里。

使用 **Ollama 解析**：启动 Ollama 并准备好已安装的本地聊天模型（默认端口 11434）；在 EnglishTool 文件夹运行 `python3 scripts/serve-local-ai.py`，打开 `http://127.0.0.1:8000`；点击 **Reader → 本地 AI**，选择 **Ollama → 检查连接 → 选择模型 → 使用此模型**。选中句子或段落后，在解析面板中点击**使用本地 AI 解析**；本地 AI 不会自动开始，每次都由你选择本地 AI、Claude 或 ChatGPT。工具只允许使用已安装的本地聊天模型，排除云端和仅用于嵌入的模型。词汇卡片的例句直接取自所选原文，模型负责释义和解析。小模型常会截短句子或加上“…”，工具会把这些引用对应回原文的准确文字，无法在段落中找到的内容会被略去，而不是丢弃整份解析。解析面板会显示已用时间。工具不会下载模型或更改 Ollama 配置。

使用 **LM Studio 解析**：先加载支持结构化 JSON 输出的聊天模型，在 Developer 页面启动本地服务器（默认端口 1234）；使用相同的 EnglishTool 启动命令和地址；点击 **Reader → 本地 AI**，选择 **LM Studio → 检查连接 → 选择模型 → 使用此模型**。选中段落后点击**使用本地 AI 解析**即可开始。

本地服务器只监听本机地址，并只向所选本地服务转发模型列表和聊天请求，不需要修改 CORS 或网络共享设置。提示词发送给本地模型；浏览器仅保存服务选择和模型选择。已有 LM Studio 设置会自动迁移。若 LM Studio 启用了认证，请在服务器环境中设置 `LM_STUDIO_API_TOKEN`，令牌不会保存在浏览器中，也不会发送给 Ollama。直接打开 HTML 和普通静态服务器仍可使用 Claude 流程；在这些方式下，本地 AI 解析需要上述本地服务器。**在线网站使用 Ollama**：页面会直接连接同一台电脑上的 Ollama，不需要 Python 服务器。请在终端中运行一次 `launchctl setenv OLLAMA_ORIGINS "https://agweipeng.github.io"`，然后退出并重新打开 Ollama；请在这台电脑上使用 Chrome 或 Edge，如有提示请允许访问本地网络。不要把 `OLLAMA_ORIGINS` 设为 `*`，否则任何网站都能使用你的 Ollama。该设置在重启 Mac 前有效。手机上无法使用，因为 Ollama 只在电脑本机上监听；LM Studio 仍需使用本地服务器。关闭面板会取消请求；使用 Ollama 时，本地服务器也会停止模型当前的生成。

## Files

- `index.html` — UI shell
- `style.css` — theme tokens and layout
- `text-core.js` — pure text logic (word forms, coverage analysis, sentence splitting, dictation scoring, speech matching, role-play prompt); no DOM, shared with the tests
- `app.js` — SRS engine, TTS, views, API calls
- `reader.js` — Reader view, book and news shelves, and known-word actions
- `synced-list.js` — shared rules for lists that sync between devices (newer change wins, deletions leave a marker)
- `learning-merge.js` — the same rules for words and journal entries (deletion times, newest change wins per word or day)
- `material-store.js` / `materials-view.js` — saved transcripts and articles (My reading materials)
- `ai-news.js` — News tab (headlines from `news.json`, Import to Reader)
- `article-import-core.js` / `article-import.js` — import an article from a link through Jina Reader (Markdown to text, errors, saving to materials)
- `journal-feedback-store.js` — pasted Claude/ChatGPT replies to journal entries (save, clear, device merge)
- `outside-click.js` — closing pop-ups by clicking outside them
- `scripts/stamp-assets.cjs` — content fingerprints on the app's script and stylesheet links (see Releasing changes)
- `chat-links.js` — the Claude/ChatGPT links: copy the prompt, open the site (or the ChatGPT app on iPhone/iPad)
- `storage-meter.js` — Settings → Storage: how much browser space the learning data uses
- `paragraph-core.js` / `paragraph-reader.js` — bilingual passage prompts, response validation and analysis panel
- `analysis-store.js` / `analyses-view.js` — saved analyses (save, replace, delete, device merge, search) and the Analyses tab
- `reply-json.js` — finds the JSON in an AI reply (repairs curly quotes, Markdown backslashes such as \\[ from the ChatGPT app, and other copy slips); shared by passage analysis and the Quiz
- `quiz-core.js` / `quiz-store.js` / `quiz-view.js` — Quiz tab: picking words, prompt and feedback parsing, saved quizzes (save, delete, device merge) and the tab itself
- `local-ai.js` / `local-ai-settings.js` — local AI transport, provider/model selection (each feature can ask for its own JSON shape)
- `scripts/serve-local-ai.py` — loopback-only app server and Ollama/LM Studio proxy
- `books/catalog.json` / `catalog.js` — metadata-only bookshelf
- `books/<book-id>/` — source, metadata, manifest, chapter files, direct-file fallback
- `book-repository.js` — generic chapter loader, validation and session cache
- `reader-progress.js` — bookmark migration and JSON backup merge
- `scripts/import-book.mjs` / `book-import-core.mjs` — reusable source conversion
- `scripts/build-book-library.mjs` — compatibility entry point to rebuild all packages
- `scripts/import-news.mjs` / `news-import-core.mjs` — The Conversation and VOA Learning English article packages
- `practice-modes.js` — Sentence Dictation, Say-it-in-English, phrase cards, Conversation Practice
- `tests/` — text logic, complete-source verification, lazy loading, bookmark migration/backup, and reader navigation tests

## Tests

```bash
node --test
python3 -m unittest discover -s tests -p 'test_local_ai_server.py'
```

## Releasing changes

Every app script and stylesheet link in `index.html` carries a fingerprint of its content (`reader.js?v=1a2b3c4d`). GitHub Pages lets browsers reuse files for 10 minutes, so without it a release could run a mix of old and new scripts. After changing any app file, run:

```bash
node scripts/stamp-assets.cjs
```

`node --test` fails if a fingerprint is out of date. `books/catalog.js` stays unversioned because the daily news job rewrites it.
