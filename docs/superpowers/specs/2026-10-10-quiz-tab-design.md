# Quiz tab — design

Date: 2026-10-10 · Status: approved in conversation, awaiting written-spec review

## Purpose

Reading and the Learn tab train *recognising* words. The Quiz tab trains *using* them: the app picks
5 words or phrases the learner is studying, the learner writes 2–3 sentences with each, and an AI
checks all 5 together. This serves the learner's goals of talking with native speakers and reading
novels in the original.

## Decisions (from the conversation)

| Question | Decision |
|---|---|
| One quiz | 5 tests, checked together at the end |
| One test | 1 word or phrase; write 2–3 sentences using it |
| Where words come from | Mix of Library words and saved-Analyses words/phrases (default); can switch to one source |
| Checking | Chosen each time: local AI, Claude or ChatGPT — never automatic |
| Feedback format | Structured JSON, with the raw reply kept as text when it can't be read |
| History | Every checked quiz is saved with its feedback, with **no limit**; syncs and backs up |

## 1. What the learner sees

New tab **Quiz 🧩**, placed after **Analyses 📝**.

1. **Start.** Source selector: *Mix (default) / Library only / Analyses only*. **New quiz** picks 5 items.
2. **The 5 tests**, one at a time, with a 1/5…5/5 progress bar and Back / Next.
   - The word or phrase, a 🔊 button (existing `speak`), its meaning in English and Chinese, and its saved
     example sentence with its own 🔊 (or a note that none is saved yet).
   - A text box: "Write 2–3 sentences using it in different ways".
   - A live hint under the box: "✓ *carry on* used" or "Not used yet". It uses
     `TextCore.containsSpokenTarget`, so word forms count (*carried on*). It is only a hint; it never
     blocks moving on or checking.
   - **Swap word** replaces the item with the next unused candidate (the typed text for it is discarded).
   - Typing is saved as a draft a moment after typing stops.
3. **Check all 5**, shown after the last test (and reachable from any test once at least one answer
   is written): **Check with local AI / Claude / ChatGPT**, the same choice as passage analysis.
   - Local AI: shows progress and a **Cancel** button.
   - Claude / ChatGPT: real `<a data-chat>` links (so the ChatGPT app opens on iPhone) that copy the
     prompt. The paste box, with a *Reply from: Claude / ChatGPT* choice remembered in the draft, is always
     shown under the check buttons (a phone may reload the page while the chat app is open), then **Save
     reply**. Pasting the copied prompt itself is refused, and the answers stay.
4. **Results**: one card per test with the verdict ✓ natural / ~ understandable / ✗ wrong, each of the
   learner's sentences with its better version and a short English + Chinese note, one model sentence,
   and the item's original example to compare. Every better and model sentence has a 🎙️ Read aloud
   button (`openReadAloud`). An overall score ("4/5 natural") and tip appear at the top.
5. **Past quizzes**: a list below (date, score, the 5 words), newest first. Tapping one reopens its
   results; each has **Delete**.

## 2. Data, sync and code structure

### Saved quizzes — `state.quizzes`

```js
{
  id, createdAt, updatedAt, deleted?,          // ISO strings; deleted marks a synced deletion
  source: 'mix' | 'library' | 'analyses',
  items: [{                                    // 1–5 items
    text,                                      // the word or phrase
    meaning: { en, cn },                       // either may be ''
    example,                                   // original example sentence, may be ''
    from: { type: 'word' | 'analysis', id },   // Library word id or analysis id
    answer,                                    // the learner's sentences, ≤ 1,000 chars
  }],
  feedback: null | {                           // structured result
    items: [{ verdict: 'natural' | 'understandable' | 'wrong' | 'unchecked',
              sentences: [{ yours, better, note: { en, cn } }],   // ≤ 5 per item
              model }],
    tip: { en, cn },
  },
  feedbackText: '',                            // raw reply, kept only when it couldn't be read
  checkedWith: 'local' | 'claude' | 'chatgpt',
  model: '',                                   // local model name, if any
}
```

- A quiz is added to `state.quizzes` only once it has been checked (structured or text feedback).
- **No limit** on how many are kept. If saving fails because storage is full, the previous state is
  restored and the same "storage may be full" toast as Analyses is shown; the draft is kept.
- Merge across devices by `id`; the newer `updatedAt` wins; deletions are tombstones (same pattern as
  `AnalysisStore`). Included in `mergeStates`, Export/Import JSON, Sync Code and cloud sync.
- Long text is capped when saved: answers 1,000 chars, raw replies 30,000 chars (as Journal replies).

### Draft — this device only

`localStorage['englishTrainerQuizDraft_v1'] = { source, items, index, updatedAt }`. Restored when the
tab opens; cleared when the quiz is checked and saved, or when **New quiz** is confirmed.

### Picking the 5 items

- **Library candidates:** active (not archived) words, in the role-play order — stubborn words
  (`isLeech`) first, then phrases, then newest. Meaning from `defEN` / `defCN`, example from the first
  example with English text.
- **Analyses candidates:** `result.words` and `result.phrases` of visible analyses, newest analysis first.
- Items used in the last 3 saved quizzes are held back, unless there would otherwise be fewer than 5.
- Duplicates (same text, ignoring case and spacing) are removed.
- For variety, each source's ordered list is cut to its top 20 and shuffled (random source injectable
  for tests). **Library only / Analyses only** take the first 5 of that shuffled list. **Mix** takes
  alternately from the two shuffled lists, starting with Library, and fills from the other list if one
  runs out. **Swap word** draws one more item the same way, leaving out the quiz's current items and any
  item already swapped out.
- With fewer than 5 candidates the quiz uses what exists (at least 1) and says why; with none it explains
  how to add words or save an analysis.

### Files

| File | Kind | Job |
|---|---|---|
| `reply-json.js` | new, UMD | The "find JSON in an AI reply" helpers moved out of `paragraph-core.js` (invisible-character cleanup, balanced `{…}`, repair, candidate search). Exposes `findReplyJSON(reply, accept)`. Passage analysis behaviour is unchanged. |
| `quiz-core.js` | new, UMD, no DOM | `pickQuizItems`, `usesTarget`, `buildQuizPrompt`, `parseQuizFeedback`, `quizScore`. |
| `quiz-store.js` | new, UMD | `createEntry`, `upsert`, `remove`, `merge`, `visible`, modelled on `analysis-store.js`. |
| `quiz-view.js` | new, classic script | The tab: draft, tests, check buttons, results, history. |
| `paragraph-core.js` | changed | Uses `ReplyJSON.findReplyJSON` instead of its private copies. |
| `index.html`, `style.css`, `app.js`, `README.md` | changed | Tab and section; styles; `state.quizzes` default, merge, import/export, `showView('quiz')`; docs. |

Script order: `reply-json.js` before `paragraph-core.js`; `quiz-core.js` and `quiz-store.js` with the
other stores before `app.js`; `quiz-view.js` after `analyses-view.js`. Run `node scripts/stamp-assets.cjs`.

## 3. AI checking, errors and testing

### Prompt (`buildQuizPrompt(items)`)

Sends the 5 items (text, meaning, the learner's sentences; an empty answer is sent as "(skipped)") and
asks for natural, conversational English feedback as JSON only:

```json
{"items":[{"word":"...","verdict":"natural|understandable|wrong",
  "sentences":[{"yours":"...","better":"...","note":{"en":"...","cn":"..."}}],
  "model":"..."}],
 "tip":{"en":"...","cn":"..."}}
```

`better` repeats the sentence when it is already fine. Items are answered in the given order.

### Reading the reply (`parseQuizFeedback(reply, items)`)

- `findReplyJSON` with an `accept` test of "has an `items` array".
- Results are matched to items by position; a `word` that doesn't match is ignored (position wins).
- Unknown verdicts become `unchecked`; missing notes become empty; more than 5 sentences are cut to 5.
- Fewer results than items: the missing ones become `unchecked`.
- No usable JSON: returns `{ feedback: null, feedbackText: reply }`; the UI says
  "Saved as text: the reply wasn't in the expected format."
- Score = number of `natural` verdicts out of the number of items.

### Errors and safety

- Local AI uses the saved connection (`window.requestParagraphAI`) with a 3-minute timeout and Cancel;
  errors appear in the panel and the answers stay in the draft.
- Without a local AI connection, its button opens the existing Local AI settings.
- All learner and AI text is escaped before display. Replies over 30,000 chars are cut.
- Only the prompt text the learner chooses to copy leaves the device; nothing is sent automatically.

### Tests (written first)

- `quiz-core`: picking (each source, mix alternation, holding back recent items, duplicates, fewer than
  5, none), `usesTarget` with word forms, prompt contains every item and "(skipped)", feedback parsing
  (clean JSON, messy ChatGPT reply with curly quotes and prose around it, missing fields, extra results,
  text fallback), score.
- `quiz-store`: create, upsert, delete tombstone, merge newer-wins, no limit on count.
- `reply-json`: the existing `paragraph-analysis` tests pass unchanged.
- `quiz-view` (vm harness): draft survives reload; swap; local-AI and pasted-reply checks save a quiz;
  storage-full keeps the draft; past quiz reopens and deletes.
- App wiring: `mergeStates` and JSON import include quizzes; asset fingerprints up to date.
- Manual check in the browser preview, then release with the usual workflow.

## Out of scope

Feeding verdicts back into review scheduling, timed quizzes, speaking (rather than writing) the
sentences, and quizzes shared between users.
