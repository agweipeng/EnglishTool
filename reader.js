/* ============================================================
   Book Reader — paste a novel chapter, see how much of it you
   already know, and turn unknown words or phrases into cards
   with the book's own sentence as the example.
   Depends on text-core.js (TextCore) and app.js globals:
   state, saveState, speak, toast, escapeHTML, knownWordSet,
   learningWordSet, markKnown, unmarkKnown, newWordEntry,
   lookupWordFields, fetchDictionary, translateToCN,
   findWordByText, MAX_LEVEL, MAX_EXAMPLES.
   ============================================================ */

'use strict';

const READER_STORAGE_KEY = 'englishTrainerReader_v1';   // per-device draft: { text, title }
const READER_BOOKMARK_KEY = 'englishTrainerBookmarks_v1'; // bundled book positions, per device
const MAX_READER_CHARS = 200000;
const MAX_PHRASE_WORDS = 8;
const MAX_HEADWORD_LOOKUPS = 4;     // dictionary attempts per word (walked → walk …)
const CALIBRATION_MIN_KNOWN = 200;  // below this, coverage is mostly uncalibrated
const SELECTION_DEBOUNCE_MS = 400;
const COVERAGE_COMFORTABLE = 98;
const COVERAGE_READABLE = 95;

let reader = null;   // { text, title, analysis } for the current passage
let selectionTimer = null;
let readerBookId = '';
let readerChapterIndex = 0;
let readerBookmarkTimer = null;
let restoringReaderBookmark = false;

function readerBooks() { return window.BookLibrary || []; }
function readerBookById(id) { return readerBooks().find(book => book.id === id); }

function loadBookBookmarks() {
  try {
    const saved = JSON.parse(localStorage.getItem(READER_BOOKMARK_KEY));
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch { return {}; }
}

function bookBookmark(book) {
  const saved = loadBookBookmarks()[book.id] || {};
  const chapterIndex = Number.isInteger(saved.chapterIndex)
    ? Math.max(0, Math.min(book.chapters.length - 1, saved.chapterIndex)) : 0;
  const scrollRatio = Number.isFinite(saved.scrollRatio)
    ? Math.max(0, Math.min(1, saved.scrollRatio)) : 0;
  return { chapterIndex, scrollRatio };
}

function writeBookBookmark(bookId, chapterIndex, scrollRatio) {
  try {
    const bookmarks = loadBookBookmarks();
    bookmarks[bookId] = { chapterIndex, scrollRatio, updatedAt: new Date().toISOString() };
    localStorage.setItem(READER_BOOKMARK_KEY, JSON.stringify(bookmarks));
    return true;
  } catch (e) {
    console.warn('Book bookmark not saved', e);
    return false;
  }
}

function readerScrollGeometry() {
  const passage = document.getElementById('readerPassage');
  const top = (document.querySelector('.topbar')?.getBoundingClientRect().height || 0) + 12;
  const rect = passage.getBoundingClientRect();
  const distance = Math.max(0, rect.height - Math.max(1, window.innerHeight - top));
  return { top, rect, distance };
}

function saveBookPosition() {
  if (!readerBookId || !reader || restoringReaderBookmark
    || !document.getElementById('view-reader').classList.contains('active')) return;
  const { top, rect, distance } = readerScrollGeometry();
  // Only record while reading inside the chapter text. Above it sit the bookshelf,
  // chapter list and paste box — looking at those must not reset the bookmark.
  if (rect.top > top) return;
  const ratio = distance ? Math.max(0, Math.min(1, (top - rect.top) / distance)) : 0;
  const saved = writeBookBookmark(readerBookId, readerChapterIndex, ratio);
  updateBookProgress(saved);
}

function updateBookProgress(saved = true) {
  const book = readerBookById(readerBookId);
  if (!book) return;
  const chapter = book.chapters[readerChapterIndex];
  const words = chapter.text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)?.length || 0;
  const progress = document.getElementById('readerBookProgress');
  const text =
    `Chapter ${chapter.number} of ${book.chapters.length} · ${words.toLocaleString()} words · `
    + (saved ? 'Bookmark saved in this browser' : 'Bookmark could not be saved in this browser');
  if (progress.textContent !== text) progress.textContent = text;
}

function renderBookControls() {
  const book = readerBookById(readerBookId);
  const controls = document.getElementById('readerBookControls');
  const heading = document.getElementById('readerChapterHeading');
  controls.classList.toggle('hidden', !book);
  heading.classList.toggle('hidden', !book);
  document.getElementById('readerChapterEnd').classList.toggle('hidden', !book);
  document.getElementById('readerBook').value = book?.id || '';
  document.getElementById('readerResumeBtn').textContent = book ? '📖 Resume reading' : '📖 Read recommended book';
  if (!book) return;
  document.getElementById('readerBookAdvice').textContent = `${book.title} (${book.titleCN}) — ${book.author}. ${book.recommendation}`;
  const chapterSelect = document.getElementById('readerChapter');
  chapterSelect.innerHTML = book.chapters.map((chapter, index) =>
    `<option value="${index}">${chapter.number}. ${escapeHTML(chapter.title)}</option>`).join('');
  chapterSelect.value = String(readerChapterIndex);
  heading.textContent = `Chapter ${book.chapters[readerChapterIndex].number}: ${book.chapters[readerChapterIndex].title}`;
  document.getElementById('readerPrevChapter').disabled = readerChapterIndex === 0;
  document.getElementById('readerNextChapter').disabled = readerChapterIndex === book.chapters.length - 1;
  const next = book.chapters[readerChapterIndex + 1];
  const endBtn = document.getElementById('readerNextChapterEnd');
  endBtn.disabled = !next;
  endBtn.textContent = next ? `Next: Chapter ${next.number} — ${next.title} →` : '🎉 You finished the book!';
  document.getElementById('readerBookIntro').textContent = book.introduction;
  document.getElementById('readerBookSource').href = book.sourceUrl;
  document.getElementById('readerBookFullText').href = book.sourceFile;
}

function openBookChapter(bookId, chapterIndex, restore = false) {
  const book = readerBookById(bookId);
  if (!book) { toast('This book is not in the bookshelf'); return; }
  // Preserve the previous location before changing the chapter or book.
  clearTimeout(readerBookmarkTimer);
  saveBookPosition();
  const bookmark = bookBookmark(book);
  const index = chapterIndex === undefined ? bookmark.chapterIndex : chapterIndex;
  if (!Number.isInteger(index) || index < 0 || index >= book.chapters.length) return;
  const ratio = restore && index === bookmark.chapterIndex ? bookmark.scrollRatio : 0;
  readerBookId = book.id;
  readerChapterIndex = index;
  restoringReaderBookmark = true;
  document.getElementById('readerInput').value = book.chapters[index].text;
  document.getElementById('readerTitle').value = book.title;
  document.getElementById('readerPaste').open = false;
  analyzeReaderText();
  renderBookControls();
  updateBookProgress(writeBookBookmark(book.id, index, ratio));
  requestAnimationFrame(() => {
    try {
      const { top, rect, distance } = readerScrollGeometry();
      // Default scroll behaviour jumps instantly (the stylesheet sets no smooth scrolling)
      window.scrollTo({ top: ratio > 0 ? window.scrollY + rect.top - top + ratio * distance : 0 });
    } catch (e) {
      console.warn('Could not restore the reading position', e);
    } finally {
      restoringReaderBookmark = false;   // never leave bookmark saving switched off
    }
  });
}

// ---------- Draft persistence (per device, never synced) ----------

function loadReaderDraft() {
  try {
    return JSON.parse(localStorage.getItem(READER_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveReaderDraft(text, title) {
  try {
    localStorage.setItem(READER_STORAGE_KEY, JSON.stringify({ text, title, bookId: readerBookId, chapterIndex: readerChapterIndex }));
  } catch (e) {
    console.warn('Reader draft not saved', e);
  }
}

// ---------- Analyse and render ----------

function analyzeWithVocabulary(text) {
  return TextCore.analyzeText(text, { known: knownWordSet(), learning: learningWordSet() });
}

function renderReader() {
  const input = document.getElementById('readerInput');
  if (!input.value) {
    const draft = loadReaderDraft();
    const book = readerBookById(draft.bookId);
    if (book && Number.isInteger(draft.chapterIndex)
      && book.chapters[draft.chapterIndex]?.text === draft.text) {
      openBookChapter(book.id, draft.chapterIndex, true);
      return;
    }
    input.value = draft.text || '';
    document.getElementById('readerTitle').value = draft.title || '';
    document.getElementById('readerPaste').open = !!draft.text;
    if (!input.value && readerBooks().length) {
      openBookChapter(readerBooks()[0].id, undefined, true);
      return;
    }
  }
  if (reader && reader.text === input.value) refreshReaderStatuses();   // keeps an open panel
  else if (input.value.trim()) analyzeReaderText();
}

function analyzeReaderText() {
  const text = document.getElementById('readerInput').value;
  const title = document.getElementById('readerTitle').value.trim();
  if (!text.trim()) { toast('Paste a chapter or page first'); return; }
  if (text.length > MAX_READER_CHARS) {
    toast(`Too long — paste up to ${MAX_READER_CHARS.toLocaleString()} characters at a time`, 3000);
    return;
  }
  const book = readerBookById(readerBookId);
  if (book && book.chapters[readerChapterIndex]?.text !== text) {
    saveBookPosition();
    readerBookId = '';
    renderBookControls();
  }
  saveReaderDraft(text, title);
  reader = { text, title, analysis: analyzeWithVocabulary(text) };
  renderReaderPassage();
  renderReaderSummary();
  closeReaderPanel();
}

// Re-classify after the vocabulary changed, without rebuilding the passage DOM
function refreshReaderStatuses() {
  if (!reader) return;
  reader.analysis = analyzeWithVocabulary(reader.text);
  document.querySelectorAll('#readerPassage .rw').forEach(span => {
    span.className = `rw rw-${reader.analysis.pieces[span.dataset.i].status}`;
  });
  renderReaderSummary();
}

function renderReaderPassage() {
  const wrap = document.getElementById('readerPassage');
  wrap.innerHTML = reader.analysis.pieces.map((p, i) => (p.isWord
    ? `<span class="rw rw-${p.status}" data-i="${i}">${escapeHTML(p.text)}</span>`
    : escapeHTML(p.text))).join('');
  wrap.classList.remove('hidden');
}

function coverageAdvice(coveragePct) {
  if ((state.known || []).length < CALIBRATION_MIN_KNOWN) {
    return 'First time? Click <b>Learn</b> on the words you really don\'t know, then <b>I know all the rest</b> — after that the coverage figure becomes accurate.';
  }
  if (coveragePct >= COVERAGE_COMFORTABLE) return 'Comfortable reading level — read for pleasure and add only the words that matter.';
  if (coveragePct >= COVERAGE_READABLE) return 'Readable with some effort — learn the most frequent unknown words first.';
  return 'Hard going — learn the most frequent unknown words first, or try an easier book.';
}

function renderReaderSummary() {
  const a = reader.analysis;
  document.getElementById('readerStats').innerHTML = `
    <div class="coverage-bar" title="known / learning / unknown">
      <div class="cov-known" style="width:${a.coveragePct}%"></div>
      <div class="cov-learning" style="width:${a.learningPct}%"></div>
    </div>
    <div class="coverage-text">
      <b>${a.coveragePct}%</b> known · ${a.learningPct}% learning · ${a.unknownPct}% unknown
      <span class="hint">— ${a.counts.total.toLocaleString()} words (names excluded)</span>
    </div>
    <p class="hint">${coverageAdvice(a.coveragePct)}</p>`;
  renderUnknownList();
}

function renderUnknownList() {
  const wrap = document.getElementById('readerUnknown');
  const list = reader.analysis.unknown;
  if (list.length === 0) {
    wrap.innerHTML = '<p class="hint">No unknown words left in this text 🎉</p>';
    return;
  }
  wrap.innerHTML = `
    <div class="reader-unknown-head">
      <h3>Unknown words (${list.length})</h3>
      <button class="btn-ghost" data-act="know-rest">✓ I know all the rest</button>
    </div>
    <div class="reader-unknown-list">
      ${list.map(u => `
        <div class="reader-unknown-row">
          <button class="ru-word" data-act="say" data-text="${escapeHTML(u.word)}" title="Hear it">${escapeHTML(u.word)}</button>
          <span class="ru-count">×${u.count}</span>
          <button class="btn-ghost ru-btn" data-act="learn" data-text="${escapeHTML(u.word)}">➕ Learn</button>
          <button class="btn-ghost ru-btn" data-act="know" data-text="${escapeHTML(u.word)}">✓ Know</button>
        </div>`).join('')}
    </div>`;
}

// ---------- Word / phrase panel ----------

function firstSentenceFor(key) {
  const piece = reader.analysis.pieces.find(p => p.key === key);
  return piece ? TextCore.sentenceAt(reader.text, piece.start) : '';
}

function libraryEntryFor(key) {
  const forms = TextCore.baseForms(key);
  return state.words.find(w => forms.includes(w.text.toLowerCase())) || null;
}

function statusLine(status, key) {
  if (status === 'stop') return 'Common function word — always counted as known.';
  if (status === 'proper') return 'Looks like a name — not counted in coverage.';
  if (status === 'unknown') return 'New to you.';
  const entry = libraryEntryFor(key);
  if (status === 'learning' && entry) return `In your library — Level ${entry.level || 0}/${MAX_LEVEL}.`;
  if (entry && entry.archivedAt) return 'Mastered in your library ⭐';
  return 'Marked as known.';
}

function panelButtons(status, key, sentence) {
  const text = escapeHTML(key);
  const sent = escapeHTML(sentence);
  if (status === 'unknown' || status === 'proper') {
    return `<button class="btn-primary" data-act="learn" data-text="${text}" data-sentence="${sent}">➕ Learn</button>
      ${status === 'unknown' ? `<button class="btn-ghost" data-act="know" data-text="${text}">✓ I know it</button>` : ''}`;
  }
  const entry = libraryEntryFor(key);
  if (status === 'known' && !(entry && entry.archivedAt)) {
    return `<button class="btn-ghost" data-act="unknow" data-text="${text}">↺ Not known</button>`;
  }
  return '';
}

// ---------- Word definitions ----------

// Each lookup is a few network calls, so remember results for the session.
// Failed lookups are not cached: the reader may just have been offline.
const definitionCache = new Map();
// Bumped whenever the panel changes, so a slow lookup can't overwrite a newer panel
let panelLookupSeq = 0;

function lookupDefinition(surface) {
  const key = surface.toLowerCase();
  if (!definitionCache.has(key)) {
    const pending = resolveHeadword(surface)
      .catch(() => ({ text: surface, dict: null }))
      .then(result => {
        if (!result.dict) definitionCache.delete(key);
        return result;
      });
    definitionCache.set(key, pending);
  }
  return definitionCache.get(key);
}

function definitionHtml({ headword, phonetic, defEN, defCN }) {
  return `<div class="rp-def">
      ${headword || phonetic ? `<div class="rp-headword">${escapeHTML(headword || '')} ${escapeHTML(phonetic || '')}</div>` : ''}
      ${defEN ? `<div class="rp-def-en">${escapeHTML(defEN)}</div>` : ''}
      ${defCN ? `<div class="rp-def-cn">${escapeHTML(defCN)}</div>` : ''}
    </div>`;
}

function showPanel({ title, sentence, status, actionsHtml, definition = '' }) {
  const panel = document.getElementById('readerPanel');
  panel.innerHTML = `
    <div class="rp-head">
      <b class="rp-title">${escapeHTML(title)}</b>
      <button class="icon-btn" data-act="say" data-text="${escapeHTML(title)}" title="Hear it">🔊</button>
      <button class="icon-btn rp-close" data-act="close" title="Close">✕</button>
    </div>
    ${definition}
    ${sentence ? `<div class="rp-sentence">${escapeHTML(sentence)}
      <button class="icon-btn" data-act="say" data-text="${escapeHTML(sentence)}" title="Hear the sentence">🔊</button></div>` : ''}
    <div class="hint">${escapeHTML(status)}</div>
    <div class="form-actions rp-actions">${actionsHtml}</div>`;
  panel.classList.remove('hidden');
}

function openWordPanel(pieceIndex) {
  const p = reader.analysis.pieces[pieceIndex];
  if (!p || !p.isWord) return;
  const sentence = TextCore.sentenceAt(reader.text, p.start);
  const seq = ++panelLookupSeq;
  const render = definition => showPanel({
    title: p.text,
    sentence,
    status: statusLine(p.status, p.key),
    actionsHtml: panelButtons(p.status, p.key, sentence),
    definition,
  });

  const entry = libraryEntryFor(p.key);
  if (entry && (entry.defEN || entry.defCN)) {
    return render(definitionHtml({
      headword: entry.text !== p.key ? entry.text : '',
      phonetic: entry.phonetic,
      defEN: entry.defEN,
      defCN: entry.defCN,
    }));
  }
  if (p.status === 'stop' || p.status === 'proper') return render('');

  render('<div class="rp-def hint">Looking up the meaning…</div>');
  lookupDefinition(p.text).then(({ text, dict }) => {
    const panel = document.getElementById('readerPanel');
    if (seq !== panelLookupSeq || panel.classList.contains('hidden')) return;
    render(dict && dict.defEN
      ? definitionHtml({
        headword: text !== p.key ? text : '',
        phonetic: dict.phonetic,
        defEN: dict.defEN,
      })
      : '<div class="rp-def hint">No dictionary entry found — it may be offline, or a rare/old word.</div>');
  });
}

function openPhrasePanel(phrase, offset) {
  panelLookupSeq++;
  const sentence = offset >= 0 ? TextCore.sentenceAt(reader.text, offset) : '';
  const inLibrary = findWordByText(phrase);
  showPanel({
    title: phrase,
    sentence,
    status: inLibrary ? 'This phrase is already in your library.' : 'Phrase — great for conversation and reading fluency.',
    actionsHtml: inLibrary ? '' : `<button class="btn-primary" data-act="learn" data-text="${escapeHTML(phrase)}" data-sentence="${escapeHTML(sentence)}">➕ Learn phrase</button>`,
  });
}

function closeReaderPanel() {
  panelLookupSeq++;
  document.getElementById('readerPanel').classList.add('hidden');
}

// ---------- Actions ----------

// Headword to save: the word as written if the dictionary knows it, otherwise the
// first base form it knows ("glimmered" → "glimmer"). Base forms are tried after the
// surface form because candidates like "hop" (from "hoping") can be real but wrong words.
async function resolveHeadword(surface) {
  if (TextCore.isPhrase(surface)) return { text: surface.trim(), dict: undefined };
  const forms = TextCore.baseForms(surface).slice(0, MAX_HEADWORD_LOOKUPS);
  for (const form of forms) {
    const dict = await fetchDictionary(form);
    if (dict) return { text: form, dict };
  }
  return { text: forms[0], dict: null };
}

async function learnFromReader(surface, sentence, btn) {
  if (btn) btn.disabled = true;
  toast(`Looking up "${surface}"…`);
  try {
    const { text, dict } = await lookupDefinition(surface);
    if (findWordByText(text)) { toast(`"${text}" is already in your library`); return; }
    const fields = await lookupWordFields(text, dict);
    const bookExample = sentence ? [{ en: sentence, cn: await translateToCN(sentence) }] : [];
    const tags = reader && reader.title ? [reader.title] : [];
    // Re-check: the same word may have been added while the lookups were running
    if (findWordByText(text)) { toast(`"${text}" is already in your library`); return; }
    state.words.push(newWordEntry({
      text,
      ...fields,
      examples: [...bookExample, ...fields.examples].slice(0, MAX_EXAMPLES),
      tags,
    }));
    saveState();
    toast(fields.defEN || fields.defCN
      ? `✓ Added "${text}" with the book's sentence`
      : `Added "${text}", but the dictionary lookup failed — add its meaning in the Library`, 3500);
    closeReaderPanel();
    refreshReaderStatuses();
  } catch (e) {
    console.warn('Reader add failed', e);
    toast('Could not add it — check your connection and try again');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function knowAllRemaining() {
  const words = reader.analysis.unknown.map(u => u.word);
  if (!confirm(`Mark ${words.length} remaining unknown words as known?`)) return;
  markKnown(words);
  toast(`✓ ${words.length} words marked as known`);
  refreshReaderStatuses();
}

function handleReaderAction(btn) {
  const act = btn.dataset.act;
  const text = btn.dataset.text || '';
  if (act === 'close') return closeReaderPanel();
  if (act === 'say') return speak(text);
  if (act === 'know-rest') return knowAllRemaining();
  if (act === 'learn') {
    const sentence = btn.dataset.sentence !== undefined ? btn.dataset.sentence : firstSentenceFor(text);
    return learnFromReader(text, sentence, btn);
  }
  if (act === 'know') { markKnown([text]); closeReaderPanel(); return refreshReaderStatuses(); }
  if (act === 'unknow') { unmarkKnown(TextCore.relatedKnownWords(text, state.known)); closeReaderPanel(); return refreshReaderStatuses(); }
}

// ---------- Phrase selection (mouse drag or touch long-press) ----------

function selectedPhrase() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !reader) return null;
  const passage = document.getElementById('readerPassage');
  if (!passage.contains(sel.anchorNode)) return null;
  const phrase = sel.toString().replace(/\s+/g, ' ').replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
  const wordCount = phrase ? phrase.split(' ').length : 0;
  if (wordCount < 2 || wordCount > MAX_PHRASE_WORDS) return null;
  const node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
  const span = node && node.closest('.rw');
  const offset = span ? reader.analysis.pieces[span.dataset.i].start : reader.text.indexOf(phrase);
  return { phrase, offset };
}

function onSelectionChange() {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const picked = selectedPhrase();
    if (picked) openPhrasePanel(picked.phrase, picked.offset);
  }, SELECTION_DEBOUNCE_MS);
}

function onPassageClick(e) {
  if (selectedPhrase()) return;   // a phrase selection is handled by onSelectionChange
  const span = e.target.closest('.rw');
  if (span) openWordPanel(Number(span.dataset.i));
}

function clearReader() {
  saveBookPosition();
  readerBookId = '';
  renderBookControls();
  document.getElementById('readerPaste').open = true;
  document.getElementById('readerInput').value = '';
  document.getElementById('readerTitle').value = '';
  document.getElementById('readerPassage').innerHTML = '';
  document.getElementById('readerPassage').classList.add('hidden');
  document.getElementById('readerStats').innerHTML = '';
  document.getElementById('readerUnknown').innerHTML = '';
  closeReaderPanel();
  saveReaderDraft('', '');
  reader = null;
}

function initReader() {
  const bookSelect = document.getElementById('readerBook');
  bookSelect.innerHTML += readerBooks().map(book =>
    `<option value="${escapeHTML(book.id)}">${escapeHTML(book.title)} (${escapeHTML(book.titleCN)})</option>`).join('');
  bookSelect.addEventListener('change', () => {
    if (bookSelect.value) openBookChapter(bookSelect.value, undefined, true);
  });
  document.getElementById('readerResumeBtn').addEventListener('click', () => {
    const id = readerBookId || readerBooks()[0]?.id;
    if (id) openBookChapter(id, undefined, true);
  });
  document.getElementById('readerChapter').addEventListener('change', e => openBookChapter(readerBookId, Number(e.target.value)));
  document.getElementById('readerPrevChapter').addEventListener('click', () => openBookChapter(readerBookId, readerChapterIndex - 1));
  document.getElementById('readerNextChapter').addEventListener('click', () => openBookChapter(readerBookId, readerChapterIndex + 1));
  document.getElementById('readerNextChapterEnd').addEventListener('click', () => openBookChapter(readerBookId, readerChapterIndex + 1));
  window.addEventListener('scroll', () => {
    clearTimeout(readerBookmarkTimer);
    readerBookmarkTimer = setTimeout(saveBookPosition, 180);
  }, { passive: true });
  window.addEventListener('pagehide', saveBookPosition);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveBookPosition(); });
  document.addEventListener('click', e => {
    if (e.target.closest('.tab[data-view]')) saveBookPosition();
  }, true);
  document.getElementById('readerAnalyzeBtn').addEventListener('click', analyzeReaderText);
  document.getElementById('readerClearBtn').addEventListener('click', clearReader);
  document.getElementById('readerPassage').addEventListener('click', onPassageClick);
  ['readerUnknown', 'readerPanel'].forEach(id => {
    document.getElementById(id).addEventListener('click', e => {
      const btn = e.target.closest('[data-act]');
      if (btn) handleReaderAction(btn);
    });
  });
  document.addEventListener('selectionchange', onSelectionChange);
  const bookId = new URLSearchParams(location.search).get('book');
  if (readerBookById(bookId)) {
    // Route after app.js has finished its normal initialization.
    showView('reader');
    if (readerBookId !== bookId) openBookChapter(bookId, undefined, true);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initReader);
} else {
  initReader();
}
