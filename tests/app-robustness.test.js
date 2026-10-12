'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const LearningMerge = require('../learning-merge.js');
const TextCore = require('../text-core.js');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const section = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));

// A fake page: every id gets an element; `messages` collects toasts
function page(values = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, { id, value: values[id] ?? '', checked: false, textContent: '', innerHTML: '', disabled: false, dataset: {},
        classList: { add() {}, remove() {}, contains: () => false }, select() {}, scrollIntoView() {}, addEventListener() {} });
    }
    return elements.get(id);
  };
  return { element, document: { getElementById: element, querySelector: () => null, documentElement: { setAttribute() {} } } };
}

// Runs the given sections of app.js in a sandbox; `globals` are the stand-ins for the rest of the page
function load(sections, globals) {
  const messages = [];
  const context = vm.createContext({ console: { error() {}, warn() {} }, JSON, Object, Array, Date, Math, String, Number, Promise, Error, Map, Set,
    LearningMerge, TextCore, STORAGE_KEY: 'englishTrainerData_v1', DEFAULT_EASE: 2.5, ...globals });
  sections.forEach(([from, to]) => vm.runInContext(section(from, to), context));
  vm.runInContext('toast = (message) => MESSAGES.push(message)', Object.assign(context, { MESSAGES: messages }));
  return { context, messages, run: code => vm.runInContext(code, context) };
}
const HELPERS = ['// ============ Helpers', '// ============ Activity'];
const quotaError = () => { const error = new Error('full'); error.name = 'QuotaExceededError'; return error; };

test('saved data that cannot be read is kept aside instead of being overwritten by the next save', () => {
  const memory = new Map([['englishTrainerData_v1', '{"words": [broken']]);
  const { document } = page();
  // The State and Storage sections run in page order, as at start-up (the load happens right away)
  const h = load([['// ============ State', '// ============ Sync config'], HELPERS], {
    document, schedulePush() {},
    localStorage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) },
  });
  assert.deepEqual(Array.from(h.run('state').words), [], 'The app starts, empty');
  assert.equal(memory.get('englishTrainerData_v1_corrupt'), '{"words": [broken', 'A copy is kept for recovery');
  assert.equal(h.run('storageLoadProblem'), true, 'so the page can tell the user');
});

test('pressing Import All twice does not add the same words twice', async () => {
  const { document, element } = page({ bulkInput: 'linger\ndwell' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const state = { words: [] };
  const h = load([['// ============ Add View', '// ============ Learn Session'], HELPERS], {
    document, state, saveState() {},
    findWordByText: text => state.words.find(w => w.text === text) || null,
    newWordEntry: fields => ({ id: fields.text, ...fields }),
    lookupWordFields: async () => { await gate; return { defEN: 'x' }; },
  });
  const first = h.run('bulkImport()');
  const second = h.run('bulkImport()');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(Array.from(h.context.state.words, w => w.text), ['linger', 'dwell']);
  assert.match(element('bulkStatus').textContent, /Imported 2/);
});

// Drill and Play all with instant speech; `spoken` lists everything said
function playback() {
  const spoken = [];
  const { document } = page({ drillSource: 'all', drillSpeed: '1', drillPause: '0', drillRepeat: '1', readingSpeed: '1' });
  const words = ['one', 'two', 'three'].map(text => ({ id: text, text, examples: [{ en: `Say ${text}.`, cn: '' }] }));
  const h = load([['// ============ Drill', '// ============ Stats'], HELPERS], {
    document, state: { words }, drill: null, speechSynthesis: { cancel() {} },
    speak: async text => { spoken.push(text); },
    setTimeout: fn => { queueMicrotask(fn); return 0; },
    isLeech: () => false, markWordHTML: () => null, openReadAloud() {},
  });
  h.run('shuffle = list => [...list]');
  return { h, spoken, words };
}

test('Stop then Start during a drill runs one drill, not two at once', async () => {
  const { h, spoken } = playback();
  const first = h.run('startDrill()');
  h.run('stopDrill()');
  const second = h.run('startDrill()');
  await Promise.all([first, second]);
  assert.deepEqual(spoken, ['Say one.', 'Say one.', 'Say two.', 'Say three.'], 'The stopped drill said only its first sentence');
});

test('Stop then Play all runs the passage once, and a passage rebuilt mid-play does not crash the old one', async () => {
  const { h, spoken, words } = playback();
  h.context.WORDS = words;
  h.run('readingState = { words: WORDS }');
  const first = h.run('readingPlayAll()');
  h.run('readingStop()');
  const second = h.run('readingPlayAll()');
  await Promise.all([first, second]);
  assert.deepEqual(spoken, ['Say one.', 'Say one.', 'Say two.', 'Say three.']);
  spoken.length = 0;
  const third = h.run('readingPlayAll()');
  h.run('readingState = null');
  await third;
  assert.deepEqual(spoken, ['Say one.'], 'It stops quietly when the passage is gone');
});

test('when storage is full, theme, voice speed and Reset progress are undone and the user is told', () => {
  const { document } = page();
  const word = { id: 'w1', text: 'walk', level: 3, interval: 9, ease: 2.7, rightCount: 5, wrongCount: 1, nextReview: 1, archivedAt: null };
  const state = { words: [word], settings: { theme: 'light', rate: 1, voiceURI: null } };
  const h = load([['// ============ Library', '// ============ Drill'], ['// ============ Settings', '// ============ Sync Code'], HELPERS], {
    document, state, confirm: () => true, renderLibrary() {}, nowMs: () => 0,
    saveState: () => { throw quotaError(); },
  });
  h.run('toggleTheme()');
  assert.equal(h.context.state.settings.theme, 'light');
  h.run('setSpeechRate(1.5)');
  assert.equal(h.context.state.settings.rate, 1);
  h.run('handleLibAction("w1", "reset")');
  assert.equal(h.context.state.words[0].level, 3, 'The word keeps its progress');
  assert.equal(h.messages.filter(m => /storage is full/.test(m)).length, 3);
});

test('a Sync Code that could not be copied says so instead of claiming it was copied', async () => {
  const { document } = page();
  const h = load([['// ============ Sync Code', '// ============ Gist sync UI'], HELPERS], {
    document, state: { words: [] }, btoa, unescape, encodeURIComponent,
    navigator: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } },
  });
  h.run('generateSyncCode()');
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(h.messages.at(-1), /copied/);
  assert.match(h.messages.at(-1), /select/i);
});

test('Ctrl/Cmd/Alt + a number, typing, or a held key never rate a Learn card', () => {
  const { document, element } = page();
  element('view-learn').classList.contains = () => true;
  const h = load([['// ============ Learn Session', '// ============ Library']], { document });
  const key = extra => h.context.isLearnShortcut({ key: '3', target: { tagName: 'BODY' }, ...extra });
  assert.equal(key({}), true);
  assert.equal(key({ metaKey: true }), false, 'Cmd+3 switches browser tabs');
  assert.equal(key({ ctrlKey: true }), false);
  assert.equal(key({ altKey: true }), false);
  assert.equal(key({ repeat: true }), false);
  assert.equal(key({ target: { tagName: 'SELECT' } }), false);
  assert.equal(key({ target: { tagName: 'DIV', isContentEditable: true } }), false);
});

test('changing a word’s spelling with Edit updates that word and keeps its progress', () => {
  const { document, element } = page();
  const colour = { id: 'w1', text: 'colour', level: 3, rightCount: 5, updatedAt: '2026-10-01T00:00:00Z', srsUpdatedAt: '2026-10-01T00:00:00Z' };
  const state = { words: [colour, { id: 'w2', text: 'walk' }] };
  const h = load([['// ============ Add View', '// ============ Learn Session'], HELPERS], {
    document, state, saveState() {}, confirm: () => true,
    collectEnrichment: () => ({}), collectExamples: () => [], renderExamples() {},
    newWordEntry: fields => ({ id: 'new', ...fields }),
  });
  h.run("collectEnrichment = () => ({}); collectExamples = () => []; renderExamples = () => {}; editingWordId = 'w1'");
  element('newWord').value = 'color';
  h.run('saveWord()');
  assert.deepEqual(Array.from(h.context.state.words, w => w.text), ['color', 'walk'], 'No second card');
  assert.equal(h.context.state.words[0].level, 3);
  assert.equal(h.context.state.words[0].srsUpdatedAt, '2026-10-01T00:00:00Z', 'The review time stays');
  assert.equal(h.run('editingWordId'), null, 'The form is cleared after saving');
});

test('marking words as known when storage is full is undone and reported, so the page does not pretend', () => {
  const marker = '// True when saved; when storage is full the change is undone';
  const code = app.slice(app.indexOf(marker), app.indexOf('function unmarkKnown'));
  const state = { known: ['walk'], knownLog: {} };
  const messages = [];
  const context = vm.createContext({ state, TextCore, console: { error() {} },
    saveState: () => { throw quotaError(); }, storageErrorMessage: () => 'Not saved — browser storage is full',
    toast: message => messages.push(message) });
  vm.runInContext(section('function saveOrRollback', '// ============ Activity') + code, context);
  assert.equal(vm.runInContext("markKnown(['linger'])", context), false);
  assert.deepEqual(Array.from(context.state.known), ['walk']);
  assert.match(messages.at(-1), /storage is full/);
});

test('the streak shows 0 after a missed day, until the next review', () => {
  const h = load([['// ============ Activity', '// ============ SRS Engine'], HELPERS], { document: page().document, DAY_MS: 86400000 });
  h.run('todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`');
  const key = offset => { const d = new Date(); d.setDate(d.getDate() - offset); return h.context.todayKey(d); };
  h.context.state = { streak: { current: 5, lastDay: key(1) } };
  assert.equal(h.run('displayStreak()'), 5, 'Yesterday counts: today can still continue it');
  h.context.state = { streak: { current: 5, lastDay: key(10) } };
  assert.equal(h.run('displayStreak()'), 0);
  h.context.state = { streak: null };
  assert.equal(h.run('displayStreak()'), 0);
});

test('saved data or a Sync Code with odd parts still starts the app', () => {
  const h = load([['// ============ State', '// ============ Sync config'], HELPERS], {
    document: page().document, schedulePush() {},
    localStorage: { getItem: () => JSON.stringify({ words: [], streak: null, settings: null, activity: [], journal: 'x', known: [1, 'walk'] }), setItem() {}, removeItem() {} },
  });
  const state = h.run('state');
  assert.deepEqual({ ...state.settings }, { voiceURI: null, rate: 1, theme: 'light' });
  assert.deepEqual({ ...state.streak }, { current: 0, lastDay: null });
  assert.deepEqual({ ...state.activity }, {});
  assert.deepEqual({ ...state.journal }, {});
  assert.deepEqual(Array.from(state.known), ['walk']);
  assert.deepEqual({ ...h.run("normalizeState({ settings: { theme: 'dark', rate: 1.2, voiceURI: 'v' } })").settings }, { theme: 'dark', rate: 1.2, voiceURI: 'v' });
  assert.equal(h.run('normalizeState(null)').words.length, 0);
});

test('the Anki export escapes word fields and defuses spreadsheet formulas', () => {
  const h = load([['// ============ Export / Import', '// ============ Settings'], HELPERS], { document: page().document });
  assert.equal(h.run('ankiCell(\'<img src=x onerror=alert(1)>\')'), '"&lt;img src=x onerror=alert(1)&gt;"');
  assert.equal(h.run("ankiCell('=HYPERLINK(\"x\")')"), '"\'=HYPERLINK(&quot;x&quot;)"');
  assert.equal(h.run("ankiCell('a<br>b', true)"), '"a<br>b"', 'The export’s own line breaks stay');
});

test('a word list entry like "-ness" is not mistaken for a formula in the Anki export', () => {
  const h = load([['// ============ Export / Import', '// ============ Settings'], HELPERS], { document: page().document });
  assert.equal(h.run("ankiCell('-ness')"), '"-ness"');
  assert.equal(h.run("ankiCell('-1+2')"), '"\'-1+2"');
});
