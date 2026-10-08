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
    localStorage.setItem(READER_STORAGE_KEY, JSON.stringify({ text, title }));
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
    input.value = draft.text || '';
    document.getElementById('readerTitle').value = draft.title || '';
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

function showPanel({ title, sentence, status, actionsHtml }) {
  const panel = document.getElementById('readerPanel');
  panel.innerHTML = `
    <div class="rp-head">
      <b class="rp-title">${escapeHTML(title)}</b>
      <button class="icon-btn" data-act="say" data-text="${escapeHTML(title)}" title="Hear it">🔊</button>
      <button class="icon-btn rp-close" data-act="close" title="Close">✕</button>
    </div>
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
  showPanel({
    title: p.text,
    sentence,
    status: statusLine(p.status, p.key),
    actionsHtml: panelButtons(p.status, p.key, sentence),
  });
}

function openPhrasePanel(phrase, offset) {
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
    const { text, dict } = await resolveHeadword(surface);
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
  if (act === 'unknow') { unmarkKnown(TextCore.baseForms(text)); closeReaderPanel(); return refreshReaderStatuses(); }
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initReader);
} else {
  initReader();
}
