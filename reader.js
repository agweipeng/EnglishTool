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

const readerProgress = ReaderProgress.createStore(localStorage);
let activeReaderBook = null;
let activeReaderChapter = null;
let readerOpenSequence = 0;
let readerLoading = false;
let readerFailedRequest = null;

function readerBooks() { return window.BookRepository.listBooks(); }
function readerBookById(id) { return readerBooks().find(book => book.id === id); }
function availableReaderBookId(preferred) {
  return readerBookById(preferred)?.id || readerBookById(window.BookCatalog.recommendedBookId)?.id || readerBooks()[0]?.id || '';
}
function readerViewActive() {
  return document.getElementById('view-reader').classList.contains('active');
}
// The book link stays in the address only while the Reader tab is open, so reloading
// on another tab stays on that tab.
function updateReaderURL(bookId) {
  if (!window.history?.replaceState || !location.href) return;
  try {
    const url = new URL(location.href);
    if (bookId && readerViewActive()) url.searchParams.set('book', bookId);
    else url.searchParams.delete('book');
    window.history.replaceState(window.history.state, '', url.href);
  } catch (error) { console.warn('Could not update the reader URL', error); }
}
// Called on every tab change. On the Reader tab with no book open yet, the address
// is left alone: renderReader may still be opening the book it names.
function syncReaderURL() {
  if (!readerViewActive()) updateReaderURL('');
  else if (readerBookId) updateReaderURL(readerBookId);
}
function loadBookBookmarks() { return readerProgress.bookmarks(); }
function bookBookmark(book) { return readerProgress.get(book); }

function writeBookBookmark(bookId, chapterIndex, scrollRatio, anchor = {}) {
  const chapter = activeReaderBook?.id === bookId ? activeReaderBook.chapters[chapterIndex] : null;
  return readerProgress.write(bookId, {
    characterOffset: anchor.characterOffset, anchor: anchor.anchor,
    chapterId: chapter?.id || '', chapterIndex, scrollRatio,
    chapterVersion: chapter?.version || '', updatedAt: new Date().toISOString(),
  });
}

function readerScrollGeometry() {
  const passage = document.getElementById('readerPassage');
  const top = (document.querySelector('.topbar')?.getBoundingClientRect().height || 0) + 12;
  const rect = passage.getBoundingClientRect();
  const distance = Math.max(0, rect.height - Math.max(1, window.innerHeight - top));
  return { top, rect, distance };
}

function visibleReaderAnchor(top) {
  const spans = document.querySelectorAll('#readerPassage .rw');
  let low = 0, high = spans.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (spans[middle].getBoundingClientRect().bottom <= top) low = middle + 1;
    else high = middle;
  }
  const piece = spans[low] && reader.analysis.pieces[spans[low].dataset.i];
  return piece ? { characterOffset: piece.start, anchor: reader.text.slice(piece.start, piece.start + 80) } : {};
}

function saveBookPosition() {
  if (!readerBookId || !reader || restoringReaderBookmark || readerLoading
    || !document.getElementById('view-reader').classList.contains('active')) return;
  const { top, rect, distance } = readerScrollGeometry();
  // Browsing controls above the passage must not reset a reading bookmark.
  if (rect.top > top) return;
  const ratio = distance ? Math.max(0, Math.min(1, (top - rect.top) / distance)) : 0;
  updateBookProgress(writeBookBookmark(readerBookId, readerChapterIndex, ratio, visibleReaderAnchor(top)));
}

// Books have chapters or stories; news packages (The Conversation, VOA) have articles
function sectionNames(book) {
  if (book.sectionType === 'article') return { one: 'Article', many: 'articles' };
  return book.sectionType === 'story' ? { one: 'Story', many: 'stories' } : { one: 'Chapter', many: 'chapters' };
}
const isNewsPackage = book => book?.kind === 'news';

// What kind of text is in the reader, so the AI analysis can focus on what matters for it.
// Pasted text uses the Type chosen on the paste form (set automatically when a saved material opens).
function currentReadingKind() {
  if (readerBookId) return isNewsPackage(activeReaderBook) ? 'news' : 'book';
  return document.getElementById('readerMaterialType')?.value || 'other';
}

// The reader's audio player, for listening and shadowing: VOA articles and saved transcripts with an audio link.
// readerAudioText is the text the audio belongs to, so pasting something new hides it.
let readerAudioText = '';
function setReaderAudio(url, text = '') {
  const player = document.getElementById('readerAudioPlayer');
  const src = /^https:\/\//.test(url || '') ? url : '';
  readerAudioText = src ? text.trim() : '';
  if ((player.getAttribute('src') || '') !== src) {
    player.pause();
    if (src) player.setAttribute('src', src);
    else player.removeAttribute('src');
    player.load();
  }
  const rate = Number(document.getElementById('readerAudioRate').value) || 1;
  player.defaultPlaybackRate = rate;
  player.playbackRate = rate;
  document.getElementById('readerAudio').classList.toggle('hidden', !src);
}
const safeLink = url => (/^https:\/\//.test(url || '') ? escapeHTML(url) : '');

// Untitled chapters (The Great Gatsby) are called "Chapter 1"; don't repeat that as a title
const namesChapter = (label, number, title) => !!title && title !== `${label} ${number}`;

function formatArticleDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Author, date and the credit the source's license asks for, with links to the original and its audio
function articleCreditHtml(book, chapter) {
  const details = [chapter.author && `By ${chapter.author}`, chapter.category, formatArticleDate(chapter.published)]
    .filter(Boolean).map(escapeHTML).join(' · ');
  const link = (url, text) => (safeLink(url) ? ` <a href="${safeLink(url)}" target="_blank" rel="noopener">${text}</a>` : '');
  return `${details}<br>${escapeHTML(book.credit || '')}${link(chapter.url, 'Read the original ↗')}`
    + `${link(book.licenseUrl, '· License ↗')}`;
}

function updateBookProgress(saved = true) {
  const book = activeReaderBook;
  if (!book || !readerBookId) return;
  const chapter = book.chapters[readerChapterIndex];
  const label = sectionNames(book).one;
  const progress = document.getElementById('readerBookProgress');
  const text = `${label} ${readerChapterIndex + 1} of ${book.chapters.length} · ${chapter.wordCount.toLocaleString()} words · `
    + (saved ? 'Bookmark saved in this browser' : 'Bookmark could not be saved in this browser');
  if (progress.textContent !== text) progress.textContent = text;
}

function shelfCard(book, saved) {
  const latest = isNewsPackage(book) && book.latestArticle ? ` · latest ${formatArticleDate(book.latestArticle)}` : '';
  const position = saved ? 'Resume reading' : 'Start reading';
  return `<article class="reader-shelf-card"><b>${escapeHTML(book.title)}</b>
    <span>${escapeHTML(book.titleCN)} · ${escapeHTML(book.author)}</span>
    <span class="hint">${escapeHTML(book.readingStage)} · ${escapeHTML(book.genre)} · ${book.sectionCount} ${sectionNames(book).many}${escapeHTML(latest)}</span>
    <p class="hint">${escapeHTML(book.recommendation)}</p>
    <button class="btn-ghost" data-book-id="${escapeHTML(book.id)}">${position} →</button></article>`;
}

function renderBookshelf() {
  const bookmarks = loadBookBookmarks();
  const cards = books => books.map(book => shelfCard(book, bookmarks[book.id])).join('');
  document.getElementById('readerShelf').innerHTML = cards(readerBooks().filter(book => !isNewsPackage(book)));
  document.getElementById('readerNewsShelf').innerHTML = cards(readerBooks().filter(isNewsPackage));
}

function setReaderLoading(loading) {
  readerLoading = loading;
  document.getElementById('readerPassage').setAttribute('aria-busy', String(loading));
  ['readerPrevChapter', 'readerNextChapter', 'readerNextChapterEnd', 'readerChapter'].forEach(id => {
    document.getElementById(id).disabled = loading;
  });
  if (!loading) renderBookControls();
}

function renderBookControls() {
  const book = readerBookId ? activeReaderBook : null;
  const controls = document.getElementById('readerBookControls');
  const heading = document.getElementById('readerChapterHeading');
  controls.classList.toggle('hidden', !book);
  heading.classList.toggle('hidden', !book);
  document.getElementById('readerChapterEnd').classList.toggle('hidden', !book);
  document.getElementById('readerBook').value = book?.id || '';
  const last = readerBookById(readerProgress.lastBook().id)?.id;
  document.getElementById('readerResumeBtn').textContent = last ? '📖 Resume last book' : '📖 Read recommended book';
  if (!book) return;
  const label = sectionNames(book).one;
  const news = isNewsPackage(book);
  document.getElementById('readerBookAdvice').textContent = `${book.title} (${book.titleCN}) — ${book.author}. ${book.recommendation}`;
  document.getElementById('readerChapterLabel').textContent = label;
  const chapterSelect = document.getElementById('readerChapter');
  chapterSelect.innerHTML = book.chapters.map(chapter =>
    `<option value="${escapeHTML(chapter.id)}">${escapeHTML(namesChapter(label, chapter.number, chapter.title) ? `${chapter.number}. ${chapter.title}` : `${label} ${chapter.number}`)}</option>`).join('');
  chapterSelect.value = book.chapters[readerChapterIndex].id;
  const current = book.chapters[readerChapterIndex];
  heading.textContent = `${label} ${readerChapterIndex + 1}${namesChapter(label, readerChapterIndex + 1, current.title) ? `: ${current.title}` : ''}`;
  document.getElementById('readerPrevChapter').disabled = readerLoading || readerChapterIndex === 0;
  document.getElementById('readerNextChapter').disabled = readerLoading || readerChapterIndex === book.chapters.length - 1;
  chapterSelect.disabled = readerLoading;
  const next = book.chapters[readerChapterIndex + 1];
  const endBtn = document.getElementById('readerNextChapterEnd');
  endBtn.disabled = readerLoading || !next;
  const nextTitle = next && namesChapter(label, readerChapterIndex + 2, next.title) ? ` — ${next.title}` : '';
  endBtn.textContent = next ? `Next: ${label} ${readerChapterIndex + 2}${nextTitle} →`
    : news ? '🎉 You have read every article here!' : '🎉 You finished the book!';
  document.getElementById('readerBookIntro').textContent = book.introduction;
  document.getElementById('readerBookIntroDetails').classList.toggle('hidden', !book.introduction);
  document.getElementById('readerRetellHint').textContent = news
    ? 'Read for the main idea. Afterward, explain it in your own words for 90 seconds, and say whether you agree.'
    : 'Read for the story. Afterward, retell what happened in your own words for 90 seconds.';
  document.getElementById('readerBookLinks').classList.toggle('hidden', news);
  const credit = document.getElementById('readerArticleCredit');
  credit.classList.toggle('hidden', !news);
  credit.innerHTML = news ? articleCreditHtml(book, book.chapters[readerChapterIndex]) : '';
  setReaderAudio(news ? book.chapters[readerChapterIndex].audioUrl : '');
  if (news) return;
  document.getElementById('readerBookSource').href = book.sourceUrl;
  document.getElementById('readerBookFullText').href = book.sourceFile;
}

function restoreReadingPosition(bookmark, ratio) {
  const { top, rect, distance } = readerScrollGeometry();
  let offset = bookmark.characterOffset;
  if (bookmark.chapterVersion !== activeReaderChapter.version) {
    offset = bookmark.anchor ? reader.text.indexOf(bookmark.anchor) : -1;
  }
  if (Number.isInteger(offset) && offset >= 0) {
    const span = [...document.querySelectorAll('#readerPassage .rw')]
      .find(span => reader.analysis.pieces[span.dataset.i].start >= offset);
    if (span) { window.scrollTo({ top: window.scrollY + span.getBoundingClientRect().top - top }); return; }
  }
  window.scrollTo({ top: ratio > 0 ? window.scrollY + rect.top - top + ratio * distance : 0 });
}

async function openBookChapter(bookId, chapterIdOrIndex, restore = false) {
  if (!readerBookById(bookId)) { toast('This book is not in the bookshelf'); return; }
  clearTimeout(readerBookmarkTimer);
  saveBookPosition();
  const sequence = ++readerOpenSequence;
  closeReaderPanel();
  setReaderLoading(true);
  document.getElementById('readerBook').value = bookId;
  const status = document.getElementById('readerLoadStatus');
  status.textContent = 'Loading your chapter…';
  document.getElementById('readerRetryBtn').classList.add('hidden');
  try {
    const book = await window.BookRepository.getBook(bookId);
    if (sequence !== readerOpenSequence) return;
    const bookmark = bookBookmark(book);
    const index = chapterIdOrIndex === undefined ? bookmark.chapterIndex :
      typeof chapterIdOrIndex === 'string' ? book.chapters.findIndex(c => c.id === chapterIdOrIndex) : chapterIdOrIndex;
    if (!Number.isInteger(index) || index < 0 || index >= book.chapters.length) throw new Error('This chapter is not in the book');
    const chapter = await window.BookRepository.getChapter(bookId, book.chapters[index].id);
    if (sequence !== readerOpenSequence) return;
    const shouldRestore = restore && chapter.id === bookmark.chapterId;
    const ratio = shouldRestore ? bookmark.scrollRatio : 0;
    readerBookId = book.id;
    readerChapterIndex = index;
    activeReaderBook = book;
    activeReaderChapter = chapter;
    restoringReaderBookmark = true;
    document.getElementById('readerInput').value = chapter.text;
    document.getElementById('readerTitle').value = book.title;
    document.getElementById('readerPaste').open = false;
    analyzeReaderText(true);
    readerProgress.remember(book.id);
    updateReaderURL(book.id);
    setReaderLoading(false);
    const restoredAnchor = shouldRestore ? { ...bookmark } : {};
    if (shouldRestore && bookmark.chapterVersion !== chapter.version) {
      const offset = bookmark.anchor ? chapter.text.indexOf(bookmark.anchor) : -1;
      restoredAnchor.characterOffset = offset < 0 ? null : offset;
    }
    updateBookProgress(writeBookBookmark(book.id, index, ratio, restoredAnchor));
    renderBookshelf();
    status.textContent = '';
    readerFailedRequest = null;
    requestAnimationFrame(() => {
      if (sequence !== readerOpenSequence) return;
      try {
        if (document.getElementById('view-reader').classList.contains('active')) {
          restoreReadingPosition(shouldRestore ? bookmark : {}, ratio);
        }
      }
      catch (error) { console.warn('Could not restore the reading position', error); }
      finally { restoringReaderBookmark = false; }
    });
  } catch (error) {
    if (sequence !== readerOpenSequence) return;
    restoringReaderBookmark = false;
    setReaderLoading(false);
    readerFailedRequest = { bookId, chapterIdOrIndex, restore };
    status.textContent = 'Could not load this chapter. Check the local book files and try again.';
    document.getElementById('readerRetryBtn').classList.remove('hidden');
    console.warn('Book loading failed', error);
  }
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
    localStorage.setItem(READER_STORAGE_KEY, JSON.stringify(readerBookId
      ? { bookId: readerBookId, chapterId: activeReaderChapter.id, chapterIndex: readerChapterIndex }
      : { text, title }));
  } catch (e) {
    console.warn('Reader draft not saved', e);
  }
}

// ---------- Analyse and render ----------

function analyzeWithVocabulary(text) {
  return TextCore.analyzeText(text, { known: knownWordSet(), learning: learningWordSet() });
}

async function renderReader() {
  renderBookshelf();
  // state may have been replaced (Sync Code, reset), so redraw the saved materials too
  if (typeof renderReadingMaterials === 'function') renderReadingMaterials();
  const input = document.getElementById('readerInput');
  if (!input.value && !readerLoading) {
    const draft = loadReaderDraft();
    const queryBook = readerBookById(new URLSearchParams(location.search).get('book'))?.id;
    const bookId = queryBook || readerBookById(draft.bookId)?.id
      || availableReaderBookId(readerProgress.lastBook().id);
    if (!queryBook && !draft.bookId && draft.text) {
      input.value = draft.text;
      document.getElementById('readerTitle').value = draft.title || '';
      document.getElementById('readerPaste').open = true;
    } else if (bookId) {
      const legacyIndex = draft.bookId === bookId && !loadBookBookmarks()[bookId]
        && Number.isInteger(draft.chapterIndex)
        ? Math.max(0, Math.min(readerBookById(bookId).sectionCount - 1, draft.chapterIndex)) : undefined;
      await openBookChapter(bookId, legacyIndex, true);
      return;
    }
  }
  if (reader && reader.text === input.value) refreshReaderStatuses();
  else if (input.value.trim() && !readerLoading) analyzeReaderText();
}

function analyzeReaderText(fromBook = false) {
  if (fromBook !== true) {
    ++readerOpenSequence;
    restoringReaderBookmark = false;
    setReaderLoading(false);
    document.getElementById('readerLoadStatus').textContent = '';
    document.getElementById('readerRetryBtn').classList.add('hidden');
    readerFailedRequest = null;
  }
  const text = document.getElementById('readerInput').value;
  const title = document.getElementById('readerTitle').value.trim();
  if (fromBook !== true && text.trim() !== readerAudioText) setReaderAudio('');
  if (!text.trim()) { toast('Paste a chapter or page first'); return; }
  if (text.length > MAX_READER_CHARS) {
    toast(`Too long — paste up to ${MAX_READER_CHARS.toLocaleString()} characters at a time`, 3000);
    return;
  }
  const book = activeReaderBook;
  if (readerBookId && book && activeReaderChapter?.text !== text) {
    saveBookPosition();
    readerBookId = '';
    renderBookControls();
  }
  if (!readerBookId) updateReaderURL('');
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
  if (typeof closeParagraphAnalysis === 'function') closeParagraphAnalysis();
}

// ---------- Actions ----------

// Headword to save: the word as written if the dictionary knows it, otherwise the
// first base form it knows ("glimmered" → "glimmer"). Base forms are tried after the
// surface form because candidates like "hop" (from "hoping") can be real but wrong words.
// All forms are requested at once; checking them in order keeps that priority.
async function resolveHeadword(surface) {
  if (TextCore.isPhrase(surface)) return { text: surface.trim(), dict: undefined };
  const forms = TextCore.baseForms(surface).slice(0, MAX_HEADWORD_LOOKUPS);
  const lookups = forms.map(form => fetchDictionary(form));
  for (let i = 0; i < forms.length; i++) {
    const dict = await lookups[i];
    if (dict) return { text: forms[i], dict };
  }
  return { text: forms[0], dict: null };
}

async function learnFromReader(surface, sentence, btn) {
  const sourceTitle = reader?.title;
  const sourceReader = reader;
  if (btn) btn.disabled = true;
  toast(`Looking up "${surface}"…`);
  try {
    const { text, dict } = await lookupDefinition(surface);
    if (findWordByText(text)) { toast(`"${text}" is already in your library`); return; }
    const fields = await lookupWordFields(text, dict);
    const bookExample = sentence ? [{ en: sentence, cn: await translateToCN(sentence) }] : [];
    const tags = sourceTitle ? [sourceTitle] : [];
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
    if (reader === sourceReader) closeReaderPanel();
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

function selectedReadingText() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !reader) return null;
  const passage = document.getElementById('readerPassage');
  const range = sel.getRangeAt(0);
  if (!passage.contains(range.startContainer) || !passage.contains(range.endContainer)) return null;
  const text = sel.toString().trim();
  const count = (text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || []).length;
  if (count < 2) return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(passage);
  prefix.setEnd(range.startContainer, range.startOffset);
  const offset = prefix.toString().length;
  const isParagraph = count > MAX_PHRASE_WORDS || (count >= MIN_SENTENCE_WORDS && endsASentence(text));
  return { text, offset, kind: isParagraph ? 'paragraph' : 'phrase' };
}

// "Aunt Em." or "Mrs. Rachel" are phrases; "Toto was not gray." is a sentence
const MIN_SENTENCE_WORDS = 4;
const TITLE_ABBREVIATION = /^(?:Mr|Mrs|Ms|Dr|St|Mt|Jr|Sr)\.$/i;
function endsASentence(text) {
  return text.split(/\s+/).some(token => /[.!?]["”’')]*$/.test(token)
    && !TITLE_ABBREVIATION.test(token.replace(/^["“‘'(]+/, '')));
}

function selectedPhrase() {
  const picked = selectedReadingText();
  if (!picked || picked.kind !== 'phrase') return null;
  return { phrase: picked.text.replace(/\s+/g, ' ').replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ''), offset: picked.offset };
}

function onSelectionChange() {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    if (document.getElementById('readerAnalysisDialog')?.open) return;
    const picked = selectedReadingText();
    if (picked?.kind === 'paragraph' && typeof openParagraphAnalysis === 'function') openParagraphAnalysis(picked.text);
    else if (picked?.kind === 'phrase') {
      const phrase = selectedPhrase();
      openPhrasePanel(phrase.phrase, phrase.offset);
    }
  }, SELECTION_DEBOUNCE_MS);
}

function onPassageClick(e) {
  if (selectedReadingText()) return;   // selections are handled by onSelectionChange
  const span = e.target.closest('.rw');
  if (span) openWordPanel(Number(span.dataset.i));
}

function clearReader() {
  saveBookPosition();
  ++readerOpenSequence;
  restoringReaderBookmark = false;
  setReaderLoading(false);
  document.getElementById('readerLoadStatus').textContent = '';
  document.getElementById('readerRetryBtn').classList.add('hidden');
  readerBookId = '';
  updateReaderURL('');
  renderBookControls();
  document.getElementById('readerPaste').open = true;
  document.getElementById('readerInput').value = '';
  document.getElementById('readerTitle').value = '';
  document.getElementById('readerMaterialType').value = 'book';
  document.getElementById('readerMaterialSource').value = '';
  document.getElementById('readerMaterialAudio').value = '';
  setReaderAudio('');
  document.getElementById('readerPassage').innerHTML = '';
  document.getElementById('readerPassage').classList.add('hidden');
  document.getElementById('readerStats').innerHTML = '';
  document.getElementById('readerUnknown').innerHTML = '';
  closeReaderPanel();
  saveReaderDraft('', '');
  reader = null;
}

// Discard stale bundled text after a backup merge, without saving it over the
// imported bookmark. Keep personal pasted text and cancel older asynchronous loads.
function onReaderProgressImported() {
  const bundled = readerBookId || loadReaderDraft().bookId;
  clearTimeout(readerBookmarkTimer);
  ++readerOpenSequence;
  restoringReaderBookmark = false;
  readerFailedRequest = null;
  if (bundled) {
    readerBookId = '';
    activeReaderBook = null;
    activeReaderChapter = null;
    reader = null;
    document.getElementById('readerInput').value = '';
    document.getElementById('readerTitle').value = '';
    document.getElementById('readerPassage').innerHTML = '';
    document.getElementById('readerPassage').classList.add('hidden');
    document.getElementById('readerStats').innerHTML = '';
    document.getElementById('readerUnknown').innerHTML = '';
    saveReaderDraft('', '');
    updateReaderURL(availableReaderBookId(readerProgress.lastBook().id));
  }
  setReaderLoading(false);
  document.getElementById('readerLoadStatus').textContent = '';
  document.getElementById('readerRetryBtn').classList.add('hidden');
  closeReaderPanel();
  renderBookshelf();
}

function initReader() {
  renderBookshelf();
  ['readerShelf', 'readerNewsShelf'].forEach(id => document.getElementById(id).addEventListener('click', e => {
    const button = e.target.closest('[data-book-id]');
    if (button) openBookChapter(button.dataset.bookId, undefined, true);
  }));
  document.getElementById('readerRetryBtn').addEventListener('click', () => {
    if (readerFailedRequest) {
      const { bookId, chapterIdOrIndex, restore } = readerFailedRequest;
      openBookChapter(bookId, chapterIdOrIndex, restore);
    }
  });
  const bookSelect = document.getElementById('readerBook');
  const options = books => books.map(book =>
    `<option value="${escapeHTML(book.id)}">${escapeHTML(book.title)} (${escapeHTML(book.titleCN)})</option>`).join('');
  bookSelect.innerHTML += `<optgroup label="Books">${options(readerBooks().filter(book => !isNewsPackage(book)))}</optgroup>`
    + `<optgroup label="News &amp; articles">${options(readerBooks().filter(isNewsPackage))}</optgroup>`;
  bookSelect.addEventListener('change', () => {
    if (bookSelect.value) openBookChapter(bookSelect.value, undefined, true);
  });
  document.getElementById('readerResumeBtn').addEventListener('click', () => {
    const id = availableReaderBookId(readerProgress.lastBook().id);
    if (id) return openBookChapter(id, undefined, true);
  });
  document.getElementById('readerAudioRate').addEventListener('change', () => {
    const player = document.getElementById('readerAudioPlayer');
    player.defaultPlaybackRate = player.playbackRate = Number(document.getElementById('readerAudioRate').value) || 1;
  });
  document.getElementById('readerChapter').addEventListener('change', e => openBookChapter(readerBookId, e.target.value));
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
  // The word card closes on a click elsewhere; clicks on words, word buttons and fresh selections open or update it instead
  closeOnClickAway(document.getElementById('readerPanel'), closeReaderPanel,
    event => !!event.target.closest?.('.rw, [data-act]') || !!selectedReadingText());
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
    // renderReader handles the requested book without launching a second load.
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initReader);
} else {
  initReader();
}
