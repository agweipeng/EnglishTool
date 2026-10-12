/* Vocabulary test in the Reader: a few short steps of "tick the words you know" (vocab-size-core.js does the
   counting, word-ranks.js holds the words). The result is kept on this device; marking words as known goes
   into the learning data like any other "I know this". */
'use strict';

const VOCAB_TEST_KEY = 'englishTrainerVocabTest_v1';
let vocabRun = null;     // { steps, answers, index } while a test is running
let vocabResult = null;  // the result just shown, with the words left unticked
let vocabMarked = null;  // the words the last "Mark as known" added, so it can be undone
let vocabUndone = null;  // the words Undo just un-marked: offered again, though they now count as un-marked
let vocabStepShownAt = 0; // a second click of a double-click on Next must not answer the next step unseen
const VOCAB_STEP_GUARD_MS = 400;

const isShare = value => Number.isFinite(value) && value >= 0 && value <= 1;
function loadVocabResult() {
  try {
    const result = JSON.parse(localStorage.getItem(VOCAB_TEST_KEY));
    const isValid = !!result && typeof result.date === 'string' && Number.isFinite(result.estimate)
      && Array.isArray(result.bands) && result.bands.every(isShare);
    return isValid ? result : null;
  } catch (error) {
    console.warn('Vocabulary test result could not be read', error);
    return null;
  }
}
function saveVocabResult(result) {
  try {
    localStorage.setItem(VOCAB_TEST_KEY, JSON.stringify(result));
    return true;
  } catch (error) {
    console.error('Vocabulary test result not saved', error);
    return false;
  }
}

// "≈ 95% of the words known to you" for a shelf card, or '' before a test
function vocabBookCoverageText(bookId) {
  const result = loadVocabResult();
  const spread = typeof WordRanks !== 'undefined' && Object.hasOwn(WordRanks.books, bookId) ? WordRanks.books[bookId] : null;
  const percent = result && spread ? VocabTestCore.bookCoverage(spread, result.bands) : null;
  return percent === null ? '' : `≈ ${percent}% of the words known to you`;
}

const bandLabel = band => {
  const from = band * WordRanks.bandSize + 1;
  const to = Math.min((band + 1) * WordRanks.bandSize, WordRanks.words.length);
  return `${from.toLocaleString()}–${to.toLocaleString()}`;
};

function vocabIntroHTML(saved) {
  const last = saved
    ? `<p>Last result (${escapeHTML(saved.date)}): about <b>${saved.estimate.toLocaleString()}</b> of ${WordRanks.words.length.toLocaleString()} word families.</p>` : '';
  return `${last}
    <p class="hint">Tick every word whose meaning you know. A few words are made up — leave those unticked, so the
      estimate stays honest. Up to ${Math.ceil(WordRanks.words.length / WordRanks.bandSize)} short steps, about 2–3 minutes. /
      勾选你认识的单词；其中有些是编造的词，请不要勾选。</p>
    <button class="btn-primary" data-vt="start">${saved ? 'Take the test again' : 'Start the test'}</button>`;
}

function vocabStepHTML() {
  const step = vocabRun.steps[vocabRun.index];
  const boxes = step.order.map(word => `<label class="vocab-word"><input type="checkbox" value="${escapeHTML(word)}"> ${escapeHTML(word)}</label>`).join('');
  return `<p class="hint">Step ${vocabRun.index + 1} of up to ${vocabRun.steps.length} · words ranked ${bandLabel(step.band)} in the app's novels</p>
    <div class="vocab-grid">${boxes}</div>
    <div class="form-actions">
      <button class="btn-primary" data-vt="next">Next →</button>
      <button class="btn-ghost" data-vt="cancel">Cancel</button>
    </div>`;
}

// Whole word families are skipped: knowing "walked" already covers "walk" (TextCore.expandForms)
function vocabMarkCandidates(result) {
  const undone = new Set(vocabUndone || []);
  const unmarked = Object.entries(state.knownLog || {})
    .filter(([word, entry]) => entry && entry.known === false && !undone.has(word)).map(([word]) => word);
  const skip = TextCore.expandForms([...(state.known || []), ...learningWordSet(), ...unmarked]);
  return VocabTestCore.wordsToMark(WordRanks, result, [...skip]);
}

function vocabMarkHTML(result) {
  if (vocabMarked) {
    return `<p>✓ Marked ${vocabMarked.length.toLocaleString()} words as known.</p>
      <button class="btn-ghost" data-vt="undo">Undo</button>`;
  }
  const words = vocabMarkCandidates(result);
  if (!words.length) return '';
  const intro = vocabUndone ? 'Undone — those words are no longer marked as known.'
    : 'Marking the common words you surely know makes the Reader\'s coverage and highlights right from the start. Words you left unticked are not marked. / 把肯定认识的常用词标为已认识。';
  return `<p class="hint">${intro}</p>
    <button class="btn-primary" data-vt="mark">✓ Mark ${words.length.toLocaleString()} common words as known${vocabUndone ? ' again' : ''}</button>`;
}

function vocabResultHTML(result) {
  const bars = result.bands.map((share, band) => `<div class="vocab-band"><span>${bandLabel(band)}</span>
    <div class="vocab-band-bar"><div style="width:${Math.round(share * 100)}%"></div></div><span>${Math.round(share * 100)}%</span></div>`).join('');
  const guessing = result.falseAlarms > 0
    ? '<p class="hint">You ticked some made-up words, so the estimate allows for guessing.</p>' : '';
  const unknown = result.unknown.length
    ? `<p class="hint">Words you left unticked: ${result.unknown.map(escapeHTML).join(', ')}</p>` : '';
  return `<p>You know about <b>${result.estimate.toLocaleString()}</b> of the ${result.listSize.toLocaleString()} word families
    used in the app's novels. / 你大约认识应用小说所用 ${result.listSize.toLocaleString()} 个词族中的 ${result.estimate.toLocaleString()} 个。</p>
    <div class="vocab-bands">${bars}</div>${guessing}${unknown}
    <div id="vocabMarkArea">${vocabMarkHTML(result)}</div>
    <p class="hint">Each book on the shelf now shows about how much of it you know. Kept on this device.</p>
    <button class="btn-ghost" data-vt="start">Take the test again</button>`;
}

function renderVocabTest() {
  const box = document.getElementById('vocabTest');
  if (!box) return;
  const saved = loadVocabResult();
  document.getElementById('vocabTestSummary').textContent = saved ? ` — about ${saved.estimate.toLocaleString()} words` : '';
  if (vocabRun) { box.innerHTML = vocabStepHTML(); vocabStepShownAt = Date.now(); }
  else box.innerHTML = vocabResult ? vocabResultHTML(vocabResult) : vocabIntroHTML(saved);
}

function startVocabTest() {
  const steps = VocabTestCore.planTest(WordRanks).map(step => ({ ...step, order: shuffle([...step.real, ...step.fake]) }));
  vocabRun = { steps, answers: [], index: 0 };
  vocabResult = null;
  vocabMarked = null;
  vocabUndone = null;
  renderVocabTest();
}

function nextVocabStep() {
  const ticked = [...document.querySelectorAll('#vocabTest .vocab-word input:checked')].map(input => input.value);
  const { order, ...step } = vocabRun.steps[vocabRun.index];
  const answers = [...vocabRun.answers, { ...step, ticked }];
  if (!VocabTestCore.isFinished(answers, vocabRun.steps)) {
    vocabRun = { ...vocabRun, answers, index: vocabRun.index + 1 };
    renderVocabTest();
    return;
  }
  vocabRun = null;
  vocabResult = VocabTestCore.scoreTest(answers, WordRanks);
  const isSaved = saveVocabResult({ date: todayKey(), estimate: vocabResult.estimate, listSize: vocabResult.listSize,
    bands: vocabResult.bands, falseAlarms: vocabResult.falseAlarms });
  if (!isSaved) toast('Result not kept — browser storage is full (see Settings → Storage)', 4000);
  renderVocabTest();
  if (typeof renderBookshelf === 'function') renderBookshelf();
}

// Marks (or, for Undo, un-marks) the words; nothing changes on screen when it could not be saved
function changeVocabMarks(isMarking) {
  const words = isMarking ? vocabMarkCandidates(vocabResult) : vocabMarked;
  if (!words || !words.length) return;
  if (!(isMarking ? markKnown(words) : unmarkKnown(words))) return;
  vocabMarked = isMarking ? words : null;
  vocabUndone = isMarking ? null : words;
  document.getElementById('vocabMarkArea').innerHTML = vocabMarkHTML(vocabResult);
  if (typeof refreshReaderStatuses === 'function') refreshReaderStatuses();
}

function initVocabTest() {
  const box = document.getElementById('vocabTest');
  if (!box || typeof WordRanks === 'undefined') return;
  box.addEventListener('click', event => {
    const action = event.target.closest('[data-vt]')?.dataset.vt;
    if (action === 'start') startVocabTest();
    else if (action === 'next' && vocabRun && Date.now() - vocabStepShownAt >= VOCAB_STEP_GUARD_MS) nextVocabStep();
    else if (action === 'cancel') { vocabRun = null; renderVocabTest(); }
    else if ((action === 'mark' || action === 'undo') && vocabResult) changeVocabMarks(action === 'mark');
  });
  renderVocabTest();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initVocabTest);
else initVocabTest();
