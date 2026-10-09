'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const ArticleImportCore = require('../article-import-core.js');
const MaterialStore = require('../material-store.js');

const articleText = 'Over the past two and a half years, we have reported on many attempts to misuse AI models. '.repeat(4).trim();
const reply = (content = articleText) => ({ code: 200, data: { title: 'Disrupting false front operations', url: 'https://openai.com/index/b/', content } });

function harness({ fetchResult = { ok: true, status: 200, json: async () => reply() } } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, { id, value: id === 'readerMaterialType' ? 'book' : '', textContent: '', disabled: false, open: false, addEventListener() {} });
    }
    return elements.get(id);
  };
  const calls = { fetches: [], cleared: 0, analyzed: [], saved: [], views: [], toasts: [], confirms: [], confirmAnswer: true };
  const sandbox = vm.createContext({
    ArticleImportCore, MaterialStore, console, URL, AbortController, setTimeout, clearTimeout,
    document: { readyState: 'loading', addEventListener() {}, getElementById: element },
    readerBookId: '', state: { materials: [] },
    fetch: async (url, options) => {
      calls.fetches.push({ url, accept: options?.headers?.Accept });
      if (fetchResult instanceof Error) throw fetchResult;
      return fetchResult;
    },
    showView: name => calls.views.push(name),
    clearReader() {
      calls.cleared++;
      ['readerInput', 'readerTitle', 'readerMaterialSource'].forEach(id => { element(id).value = ''; });
      element('readerMaterialType').value = 'book';
      element('readerPaste').open = true;
    },
    analyzeReaderText() { calls.analyzed.push(element('readerInput').value); },
    saveCurrentReadingMaterial() {
      calls.saved.push({ title: element('readerTitle').value, type: element('readerMaterialType').value, source: element('readerMaterialSource').value });
      return true;
    },
    toast: message => calls.toasts.push(message),
    confirm: message => { calls.confirms.push(message); return calls.confirmAnswer; },
  });
  const run = code => vm.runInContext(code, sandbox);
  run(fs.readFileSync(require.resolve('../article-import.js'), 'utf8'));
  return { sandbox, run, element, calls };
}

test('a pasted link is fetched as text, opened in the reader as news and saved to the materials shelf', async () => {
  const h = harness();
  h.element('readerImportUrl').value = 'https://openai.com/index/b/';
  assert.equal(await h.run('importArticleFromForm()'), true);
  assert.deepEqual(h.calls.fetches, [{ url: 'https://r.jina.ai/https://openai.com/index/b/', accept: 'application/json' }]);
  assert.equal(h.calls.cleared, 1);
  assert.deepEqual(h.calls.analyzed, [articleText]);
  assert.deepEqual(h.calls.saved, [{ title: 'Disrupting false front operations', type: 'news', source: 'https://openai.com/index/b/' }]);
  assert.equal(h.element('readerPaste').open, false, 'The article is shown, not the paste form');
  assert.equal(h.element('readerImportUrl').value, '', 'The link box is ready for the next one');
  assert.match(h.element('readerImportStatus').textContent, /saved/i);
  assert.equal(h.element('readerImportBtn').disabled, false);
  assert.deepEqual(h.calls.views, [], 'The reader is already open');
});

test('a News headline is always read as news, while a pasted link keeps a type you chose', async () => {
  const h = harness();
  h.element('readerMaterialType').value = 'conversation';
  assert.equal(await h.run(`importArticleFromLink('https://openai.com/index/b/', { openReader: true })`), true);
  assert.deepEqual(h.calls.views, ['reader']);
  assert.equal(h.calls.saved[0].type, 'news');
  const pasted = harness();
  pasted.element('readerMaterialType').value = 'conversation';
  await pasted.run(`importArticleFromLink('https://openai.com/index/b/')`);
  assert.equal(pasted.calls.saved[0].type, 'conversation');
});

test('an article whose title is already on the shelf from another page gets the site name added', async () => {
  const h = harness();
  h.sandbox.state.materials = MaterialStore.upsert([], MaterialStore.createEntry(
    { title: 'Disrupting false front operations', type: 'conversation', sourceUrl: 'https://other.example/x', text: 'My own transcript.' }, '2026-10-09T01:00:00Z', 'm1'));
  await h.run(`importArticleFromLink('https://openai.com/index/b/')`);
  assert.equal(h.calls.saved[0].title, 'Disrupting false front operations — openai.com');
  const same = harness();
  same.sandbox.state.materials = MaterialStore.upsert([], MaterialStore.createEntry(
    { title: 'Disrupting false front operations', type: 'news', sourceUrl: 'https://openai.com/index/b/', text: 'Older copy.' }, '2026-10-09T01:00:00Z', 'm1'));
  await same.run(`importArticleFromLink('https://openai.com/index/b/')`);
  assert.equal(same.calls.saved[0].title, 'Disrupting false front operations', 'Importing the same page again updates it');
});

test('when saving fails, the status says the article was not saved', async () => {
  const h = harness();
  h.sandbox.saveCurrentReadingMaterial = () => false;
  assert.equal(await h.run(`importArticleFromLink('https://openai.com/index/b/')`), true);
  assert.match(h.element('readerImportStatus').textContent, /not saved/i);
});

test('text you paste while an import is loading is not replaced without asking', async () => {
  let release;
  const h = harness({ fetchResult: { ok: true, status: 200, json: () => new Promise(resolve => { release = () => resolve(reply()); }) } });
  const importing = h.run(`importArticleFromLink('https://openai.com/index/b/')`);
  await new Promise(resolve => setImmediate(resolve));
  h.element('readerInput').value = 'Pasted while waiting';
  h.calls.confirmAnswer = false;
  release();
  assert.equal(await importing, false);
  assert.equal(h.calls.confirms.length, 1);
  assert.equal(h.element('readerInput').value, 'Pasted while waiting');
  assert.equal(h.element('readerImportBtn').disabled, false);
});

test('bad links, refusals and failures leave the reader untouched and explain why', async () => {
  const h = harness();
  h.element('readerImportUrl').value = 'not a link';
  assert.equal(await h.run('importArticleFromForm()'), false);
  assert.equal(h.calls.fetches.length, 0);
  assert.match(h.calls.toasts.at(-1), /link/);

  const busy = harness({ fetchResult: { ok: false, status: 429, json: async () => ({}) } });
  assert.equal(await busy.run(`importArticleFromLink('https://openai.com/index/b/')`), false);
  assert.match(busy.element('readerImportStatus').textContent, /too many/i);
  assert.equal(busy.calls.cleared, 0);

  const offline = harness({ fetchResult: new TypeError('Failed to fetch') });
  assert.equal(await offline.run(`importArticleFromLink('https://openai.com/index/b/')`), false);
  assert.match(offline.element('readerImportStatus').textContent, /connection/i);

  const html = harness({ fetchResult: { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token '<'"); } } });
  assert.equal(await html.run(`importArticleFromLink('https://openai.com/index/b/')`), false);
  assert.match(html.element('readerImportStatus').textContent, /could not read/i, 'A web page instead of the reply gets a plain explanation');

  const empty = harness({ fetchResult: { ok: true, status: 200, json: async () => reply('Please sign in.') } });
  assert.equal(await empty.run(`importArticleFromLink('https://openai.com/index/b/')`), false);
  assert.match(empty.element('readerImportStatus').textContent, /copy and paste/i);
  assert.equal(empty.calls.cleared, 0);
});

test('your own pasted text is only replaced after you agree', async () => {
  const h = harness();
  h.element('readerInput').value = 'My unsaved notes';
  h.calls.confirmAnswer = false;
  assert.equal(await h.run(`importArticleFromLink('https://openai.com/index/b/')`), false);
  assert.equal(h.calls.confirms.length, 1);
  assert.equal(h.calls.fetches.length, 0);
  assert.equal(h.element('readerInput').value, 'My unsaved notes');
  assert.match(h.element('readerImportStatus').textContent, /cancelled/i);

  const book = harness();
  book.sandbox.readerBookId = 'wizard-of-oz';
  book.element('readerInput').value = 'Chapter text from a bundled book';
  assert.equal(await book.run(`importArticleFromLink('https://openai.com/index/b/')`), true);
  assert.equal(book.calls.confirms.length, 0, 'A book chapter is not your own text, so no question');

  const saved = harness();
  saved.sandbox.state.materials = MaterialStore.upsert([], MaterialStore.createEntry(
    { title: 'Earlier import', type: 'news', text: 'An article already on the shelf.' }, '2026-10-09T01:00:00Z', 'm1'));
  saved.element('readerInput').value = 'An article already on the shelf.';
  assert.equal(await saved.run(`importArticleFromLink('https://openai.com/index/b/')`), true);
  assert.equal(saved.calls.confirms.length, 0, 'Text already saved to your materials is not lost, so no question');
});

test('an article too long for the shelf is still opened, with a note that it was not saved', async () => {
  const long = 'A long sentence about policy and research. '.repeat(Math.ceil(MaterialStore.MAX_MATERIAL_CHARS / 40) + 10);
  const h = harness({ fetchResult: { ok: true, status: 200, json: async () => reply(long) } });
  assert.equal(await h.run(`importArticleFromLink('https://openai.com/index/b/')`), true);
  assert.equal(h.calls.analyzed.length, 1);
  assert.equal(h.calls.saved.length, 0);
  assert.match(h.element('readerImportStatus').textContent, /too long to save/i);
});
