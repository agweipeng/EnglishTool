'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TextCore = require('../text-core.js');
const ReaderProgress = require('../reader-progress.js');
const AnalysisStore = require('../analysis-store.js');
const MaterialStore = require('../material-store.js');

function harness(initialWords = []) {
  const memory = new Map();
  const messages = [];
  const saved = [];
  let blob;
  const context = vm.createContext({
    state: { words: initialWords, known: [], activity: {} }, TextCore, ReaderProgress, AnalysisStore, MaterialStore, Blob,
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
