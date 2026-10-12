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
      elements.set(id, { id, value: values[id] ?? '', checked: false, textContent: '', innerHTML: '', disabled: false,
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
