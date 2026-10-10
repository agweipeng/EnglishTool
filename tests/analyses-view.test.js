'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const AnalysisStore = require('../analysis-store.js');
const fixture = require('./fixtures/paragraph-analysis.json');

const context = { text: fixture.passage, title: 'The Golden Bird', chapter: 'Chapter 1', bookId: 'wizard-of-oz', chapterId: 'the-cyclone' };

function harness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: '', addEventListener() {} });
    return elements.get(id);
  };
  const calls = { saveState: 0, shown: [], opened: [], views: [], readAloud: [] };
  let ids = 0;
  const sandbox = vm.createContext({
    AnalysisStore, console, Date,
    state: { analyses: [] },
    document: { readyState: 'loading', addEventListener() {}, getElementById: element },
    escapeHTML: text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    uid: () => `id${++ids}`, toast() {}, confirm: () => true,
    saveState() { calls.saveState++; },
    showSavedAnalysis: entry => calls.shown.push(entry),
    openReadAloud: text => calls.readAloud.push(text),
    readerBookById: id => (id === 'wizard-of-oz' ? { id } : undefined),
    showView: name => calls.views.push(name),
    openBookChapter: async (...args) => { calls.opened.push(args); },
    requestAnimationFrame: fn => fn(),
  });
  const run = code => vm.runInContext(code, sandbox);
  run(fs.readFileSync(require.resolve('../analyses-view.js'), 'utf8'));
  const click = (act, id) => run(`onAnalysesClick({ target: { closest: () => ({ dataset: { analysisAct: '${act}' }, closest: () => ({ dataset: { id: '${id}' } }) }) } })`);
  return { sandbox, run, element, calls, click };
}

test('a finished analysis is saved with its book position and model', () => {
  const h = harness();
  h.sandbox.ctx = context;
  h.sandbox.result = fixture.analysis;
  assert.equal(h.run('saveAnalysis(ctx, result, "qwen3.5:4b")'), true);
  const [saved] = h.sandbox.state.analyses;
  assert.equal(saved.bookId, 'wizard-of-oz');
  assert.equal(saved.chapterId, 'the-cyclone');
  assert.equal(saved.model, 'qwen3.5:4b');
  assert.equal(h.calls.saveState, 1);
  h.run('saveAnalysis(ctx, result, "Gemma4:12b")');
  assert.equal(h.sandbox.state.analyses.length, 1, 'Re-analysing the same passage replaces it');
});

test('if storage is full the analysis is not half-saved', () => {
  const h = harness();
  h.sandbox.saveState = () => { throw new Error('QuotaExceededError'); };
  h.sandbox.ctx = context;
  h.sandbox.result = fixture.analysis;
  assert.equal(h.run('saveAnalysis(ctx, result, "")'), false);
  assert.deepEqual(h.sandbox.state.analyses, []);
});

test('the Analyses tab lists saved analyses safely, newest first, and can be searched', () => {
  const h = harness();
  h.run('renderAnalysesView()');
  assert.match(h.element('analysesList').innerHTML, /No saved analyses yet/);
  h.sandbox.ctx = context;
  h.sandbox.result = fixture.analysis;
  h.run('saveAnalysis(ctx, result, "")');
  h.sandbox.other = { text: '<b>Toto</b> was a little black dog.', title: '' };
  h.sandbox.dog = { ...fixture.analysis, simplified: { en: 'Toto is small.', cn: '托托很小。' }, mainPoint: { en: 'A dog.', cn: '一只狗。' }, words: [], phrases: [] };
  h.run('saveAnalysis(other, dog, "")');
  h.run('renderAnalysesView()');
  const html = h.element('analysesList').innerHTML;
  assert.ok(html.indexOf('Toto') < html.indexOf('golden apples'), 'Newest first');
  assert.match(html, /&lt;b&gt;Toto/);
  assert.doesNotMatch(html, /<b>Toto/);
  assert.match(html, /Your own text/);
  assert.match(html, /Open in book/, 'Book passages can jump back to the chapter');
  assert.equal((html.match(/data-analysis-act="read"/g) || []).length, 2, 'Every original text has a Read aloud button');
  h.run('analysesQuery = "golden"; renderAnalysesView()');
  assert.doesNotMatch(h.element('analysesList').innerHTML, /Toto/);
});

test('cards open the saved analysis, jump to the book, or delete it', async () => {
  const h = harness();
  h.sandbox.ctx = context;
  h.sandbox.result = fixture.analysis;
  h.run('saveAnalysis(ctx, result, "")');
  const id = h.sandbox.state.analyses[0].id;
  h.click('open', id);
  assert.equal(h.calls.shown[0].id, id);
  h.click('read', id);
  assert.deepEqual(h.calls.readAloud, [fixture.passage], 'Read aloud uses the whole original text, not the card preview');
  await h.click('book', id);
  assert.deepEqual(h.calls.views, ['reader']);
  assert.deepEqual(h.calls.opened[0], ['wizard-of-oz', 'the-cyclone']);
  h.click('delete', id);
  assert.deepEqual(AnalysisStore.visible(h.sandbox.state.analyses), []);
  assert.equal(h.sandbox.state.analyses[0].deleted, true);
  assert.match(h.element('analysesList').innerHTML, /No saved analyses yet/);
});
