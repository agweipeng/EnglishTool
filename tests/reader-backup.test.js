'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TextCore = require('../text-core.js');
const ReaderProgress = require('../reader-progress.js');
const AnalysisStore = require('../analysis-store.js');
const MaterialStore = require('../material-store.js');
const JournalFeedbackStore = require('../journal-feedback-store.js');
const QuizStore = require('../quiz-store.js');
const LearningMerge = require('../learning-merge.js');

function harness(initialWords = []) {
  const memory = new Map();
  const messages = [];
  const saved = [];
  let blob;
  const context = vm.createContext({
    state: { words: initialWords, known: [], activity: {} }, TextCore, ReaderProgress, AnalysisStore, MaterialStore, JournalFeedbackStore, QuizStore, LearningMerge, Blob,
    localStorage: { getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v) },
    URL: { createObjectURL: value => { blob = value; return 'blob:backup'; } },
    document: { createElement: () => ({ click() {} }) },
    todayKey: () => '2026-10-08', saveState: () => saved.push(true),
    saveBookPosition() {}, renderBookshelf() {}, renderLibrary() {}, confirm: () => true,
    toast: message => messages.push(message),
    FileReader: class { readAsText(file) { this.result = file; this.onload(); } },
  });
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  vm.runInContext(app.slice(app.indexOf('function exportJSON()'), app.indexOf('// ============ Settings ============')), context);
  return { context, memory, messages, saved, run: code => vm.runInContext(code, context), blob: () => blob };
}

test('actual JSON export and import restore vocabulary and reading progress together', async () => {
  const first = harness([{ text: 'prairie', defEN: 'Open grassland' }]);
  const progress = ReaderProgress.createStore(first.context.localStorage);
  progress.write('wizard-of-oz', { chapterId: 'the-cyclone', chapterIndex: 0, characterOffset: 320, anchor: 'Dorothy looked', scrollRatio: .25, updatedAt: '2026-10-08T01:00:00Z' });
  progress.remember('wizard-of-oz');
  first.run('exportJSON()');
  const json = await first.blob().text();
  const second = harness();
  second.context.backupFile = json;
  second.run('importJSON(backupFile)');
  assert.equal(second.context.state.words[0].text, 'prairie');
  const restored = ReaderProgress.createStore(second.context.localStorage);
  assert.equal(restored.bookmarks()['wizard-of-oz'].characterOffset, 320);
  assert.equal(restored.lastBook().id, 'wizard-of-oz');
  assert.equal(second.saved.length, 1);
});

test('old learning backups still import; malformed progress fails before any learning data changes', () => {
  const h = harness([{ text: 'existing' }]);
  h.context.backupFile = JSON.stringify({ words: [{ text: 'new' }, { text: 'new' }], known: [] });
  h.run('importJSON(backupFile)');
  assert.deepEqual(Array.from(h.context.state.words, w => w.text), ['existing', 'new']);
  const before = JSON.stringify(h.context.state);
  h.context.backupFile = JSON.stringify({ words: [{ text: 'bad-backup-word' }], readingProgress: { version: 2, bookmarks: [], lastBook: {} } });
  h.run('importJSON(backupFile)');
  assert.equal(JSON.stringify(h.context.state), before);
  assert.match(h.messages.at(-1), /Import failed/);
});

test('saved AI analyses travel in JSON backups, and a malformed list is rejected', async () => {
  const fixture = require('./fixtures/paragraph-analysis.json');
  const first = harness([{ text: 'bore', defEN: 'carried' }]);
  first.context.state.analyses = [AnalysisStore.createEntry({ text: fixture.passage, title: 'The Golden Bird', result: fixture.analysis },
    '2026-10-09T01:00:00.000Z', 'a1')];
  first.run('exportJSON()');
  const json = await first.blob().text();
  const second = harness();
  second.context.state.analyses = [];
  second.context.backupFile = json;
  second.run('importJSON(backupFile)');
  assert.deepEqual(AnalysisStore.visible(second.context.state.analyses).map(e => e.id), ['a1']);
  const third = harness();
  third.context.state.analyses = [];
  third.context.backupFile = JSON.stringify({ words: [], analyses: 'not a list' });
  third.run('importJSON(backupFile)');
  assert.deepEqual(third.context.state.analyses, []);
  assert.match(third.messages.at(-1), /invalid file/);
});

test('saved reading materials such as BBC transcripts travel in JSON backups', async () => {
  const first = harness();
  first.context.state.materials = [MaterialStore.createEntry({ title: '6 Minute English: Sleep', type: 'conversation',
    sourceUrl: 'https://www.bbc.co.uk/learningenglish/english/features/6-minute-english', text: 'Neil: Hello. Beth: Hi.' }, '2026-10-09T01:00:00.000Z', 'm1')];
  first.run('exportJSON()');
  const second = harness();
  second.context.state.materials = [];
  second.context.backupFile = await first.blob().text();
  second.run('importJSON(backupFile)');
  assert.deepEqual(MaterialStore.visible(second.context.state.materials).map(m => m.title), ['6 Minute English: Sleep']);
  const third = harness();
  third.context.state.materials = [];
  third.context.backupFile = JSON.stringify({ words: [], materials: { title: 'not a list' } });
  third.run('importJSON(backupFile)');
  assert.deepEqual(third.context.state.materials, []);
  assert.match(third.messages.at(-1), /invalid file/);
});

const savedQuiz = (id, at) => QuizStore.createEntry({ source: 'mix', items: [{ text: 'carry on', answer: 'We carried on.' }],
  feedbackText: 'Good!', checkedWith: 'claude' }, at, id);

test('saved quizzes are part of JSON backups, and a damaged quiz list is refused', () => {
  const h = harness();
  h.context.backupFile = JSON.stringify({ words: [], quizzes: [savedQuiz('q1', '2026-10-10T01:00:00Z')] });
  h.run('importJSON(backupFile)');
  assert.deepEqual(QuizStore.visible(h.context.state.quizzes).map(quiz => quiz.id), ['q1']);
  h.context.backupFile = JSON.stringify({ words: [], quizzes: 'not a list' });
  h.run('importJSON(backupFile)');
  assert.match(h.messages.at(-1), /Import failed/);
});

// The merge functions of app.js on their own
function mergeContext() {
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const context = vm.createContext({ TextCore, AnalysisStore, MaterialStore, JournalFeedbackStore, QuizStore, LearningMerge });
  vm.runInContext(app.slice(app.indexOf('// ============ Merge logic'), app.indexOf('// ============ Sync orchestration')), context);
  return { context, run: code => vm.runInContext(code, context) };
}

test('sync keeps the quizzes of both devices', () => {
  const { context, run } = mergeContext();
  context.local = { words: [], quizzes: [savedQuiz('q1', '2026-10-10T01:00:00Z')] };
  context.remote = { words: [], quizzes: [savedQuiz('q2', '2026-10-10T02:00:00Z')] };
  assert.deepEqual(QuizStore.visible(run('mergeStates(local, remote)').quizzes).map(quiz => quiz.id), ['q2', 'q1']);
});

const emptyState = () => ({ words: [], deletedWords: {}, journal: {}, journalLog: {}, journalFeedback: {}, known: [], knownLog: {},
  analyses: [], materials: [], quizzes: [], activity: {}, streak: { current: 0, lastDay: null } });
const fullState = () => ({ ...emptyState(),
  words: [{ id: 'w1', text: 'prairie', updatedAt: '2026-10-09T01:00:00Z' }],
  journal: { '2026-10-09': 'Dear diary.' }, known: ['walk'],
  journalFeedback: { '2026-10-09': { text: 'Nice.', source: 'claude', updatedAt: '2026-10-09T01:00:00Z' } },
  quizzes: [savedQuiz('q1', '2026-10-09T01:00:00Z')] });

test('Reset All stays reset after a sync with a device (or gist) that still has the old data', () => {
  const { context, run } = mergeContext();
  context.old = fullState();
  context.fresh = emptyState();
  const merged = run('mergeStates(replaceState(old, fresh, "2026-10-10T00:00:00Z"), old)');
  assert.deepEqual([...merged.words], []);
  assert.deepEqual({ ...merged.journal }, {});
  assert.deepEqual([...merged.known], []);
  assert.equal(JournalFeedbackStore.get(merged.journalFeedback, '2026-10-09'), null);
  assert.deepEqual(QuizStore.visible(merged.quizzes), []);
});

test('a Sync Code replace drops what the code does not have, even after a later sync', () => {
  const { context, run } = mergeContext();
  context.old = fullState();
  context.code = { ...emptyState(), words: [{ id: 'w2', text: 'meadow', updatedAt: '2026-10-08T01:00:00Z' }],
    journal: { '2026-10-08': 'From the phone.' } };
  const merged = run('mergeStates(replaceState(old, code, "2026-10-10T00:00:00Z"), old)');
  assert.deepEqual(Array.from(merged.words, w => w.text), ['meadow']);
  assert.deepEqual({ ...merged.journal }, { '2026-10-08': 'From the phone.' });
});

test('importing a backup brings back its journal and streak, and restored words are no longer marked deleted', () => {
  const h = harness();
  Object.assign(h.context.state, { deletedWords: { w1: '2026-10-09T00:00:00Z' }, journal: { '2026-10-06': 'Newer here.' },
    journalLog: { '2026-10-05': '2026-10-09T00:00:00Z', '2026-10-06': '2026-10-09T00:00:00Z' }, streak: { current: 1, lastDay: '2026-10-01' } });
  h.context.backupFile = JSON.stringify({ words: [{ id: 'w1', text: 'prairie', updatedAt: '2026-10-01T00:00:00Z' }],
    journal: { '2026-10-05': 'Deleted here, kept in the backup.', '2026-10-06': 'Older.' }, streak: { current: 4, lastDay: '2026-10-05' } });
  h.run('importJSON(backupFile)');
  assert.deepEqual({ ...h.context.state.journal }, { '2026-10-05': 'Deleted here, kept in the backup.', '2026-10-06': 'Newer here.' });
  assert.deepEqual({ ...h.context.state.streak }, { current: 4, lastDay: '2026-10-05' });
  assert.deepEqual({ ...h.context.state.deletedWords }, {});
  const synced = LearningMerge.mergeWords(h.context.state, { words: [], deletedWords: { w1: '2026-10-09T00:00:00Z' } });
  assert.deepEqual(synced.words.map(w => w.text), ['prairie'], 'The restored word survives a sync with the old deletion');
});

test('an import that cannot be saved leaves the data as it was', () => {
  const h = harness([{ id: 'w0', text: 'existing' }]);
  h.context.saveState = () => { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; };
  h.context.backupFile = JSON.stringify({ words: [{ id: 'w1', text: 'new' }] });
  h.run('importJSON(backupFile)');
  assert.deepEqual(Array.from(h.context.state.words, w => w.text), ['existing']);
  assert.match(h.messages.at(-1), /storage is full/);
});
