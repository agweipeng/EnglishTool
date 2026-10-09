'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const MaterialStore = require('../material-store.js');

function harness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, innerHTML: '', value: '', open: false, focus() {}, addEventListener() {} });
    return elements.get(id);
  };
  const calls = { saveState: 0, toasts: [], analyzed: [], cleared: 0, confirm: true };
  let ids = 0;
  const sandbox = vm.createContext({
    MaterialStore, console, Date, URL,
    state: { materials: [] },
    document: { readyState: 'loading', addEventListener() {}, getElementById: element },
    escapeHTML: text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    uid: () => `id${++ids}`, toast: message => calls.toasts.push(message), confirm: () => calls.confirm,
    saveState() { calls.saveState++; },
    clearReader() { calls.cleared++; },
    analyzeReaderText() { calls.analyzed.push(element('readerInput').value); },
  });
  const run = code => vm.runInContext(code, sandbox);
  run(fs.readFileSync(require.resolve('../materials-view.js'), 'utf8'));
  const fill = (title, text, { type = 'conversation', source = '' } = {}) => {
    element('readerTitle').value = title;
    element('readerInput').value = text;
    element('readerMaterialType').value = type;
    element('readerMaterialSource').value = source;
  };
  const click = (act, id) => run(`onMaterialsClick({ target: { closest: () => ({ dataset: { materialAct: '${act}' }, closest: () => ({ dataset: { materialId: '${id}' } }) }) } })`);
  return { sandbox, run, element, calls, fill, click };
}

test('a pasted BBC transcript is saved to the synced shelf and listed safely', () => {
  const h = harness();
  h.fill('<b>6 Minute English</b>', 'Neil: Hello. Beth: Hi.', { source: 'https://www.bbc.co.uk/learningenglish/english/features/6-minute-english' });
  h.run('saveCurrentReadingMaterial()');
  const [saved] = MaterialStore.visible(h.sandbox.state.materials);
  assert.equal(saved.type, 'conversation');
  assert.equal(h.calls.saveState, 1);
  assert.equal(h.calls.toasts.at(-1), 'Reading material saved');
  const html = h.element('readerMaterialsList').innerHTML;
  assert.match(html, /&lt;b&gt;6 Minute English/);
  assert.doesNotMatch(html, /<b>6 Minute/);
  assert.match(html, /Source ↗/);
  h.fill('<B>6 minute english</B>', 'Corrected.');
  h.run('saveCurrentReadingMaterial()');
  assert.equal(MaterialStore.visible(h.sandbox.state.materials).length, 1);
  assert.equal(h.calls.toasts.at(-1), 'Reading material updated');
});

test('the form refuses missing titles, unsafe links and oversized text without saving', () => {
  const h = harness();
  h.fill('', 'Some text');
  h.run('saveCurrentReadingMaterial()');
  h.fill('Title', 'Some text', { source: 'javascript:alert(1)' });
  h.run('saveCurrentReadingMaterial()');
  h.fill('Title', 'x'.repeat(MaterialStore.MAX_MATERIAL_CHARS + 1));
  h.run('saveCurrentReadingMaterial()');
  assert.equal(h.calls.saveState, 0);
  assert.deepEqual(h.sandbox.state.materials, []);
  assert.equal(h.calls.toasts.length, 3);
});

test('a full shelf says so instead of dropping old materials, and a storage error rolls back', () => {
  const h = harness();
  for (let i = 0; i < MaterialStore.MAX_MATERIALS; i++) { h.fill(`Episode ${i}`, 'Text.'); h.run('saveCurrentReadingMaterial()'); }
  h.fill('One more', 'Text.');
  h.run('saveCurrentReadingMaterial()');
  assert.equal(MaterialStore.visible(h.sandbox.state.materials).length, MaterialStore.MAX_MATERIALS);
  assert.match(h.calls.toasts.at(-1), /shelf is full/);
  const before = h.sandbox.state.materials;
  h.sandbox.saveState = () => { throw new Error('QuotaExceededError'); };
  h.fill('Episode 1', 'Changed.');
  h.run('saveCurrentReadingMaterial()');
  assert.equal(h.sandbox.state.materials, before);
  assert.match(h.calls.toasts.at(-1), /Could not save/);
});

test('cards open the material in the reader or delete it with a sync tombstone', () => {
  const h = harness();
  h.fill('The English We Speak', 'Feifei: Hello. Rob: Hi.', { type: 'conversation' });
  h.run('saveCurrentReadingMaterial()');
  const id = h.sandbox.state.materials[0].id;
  h.element('readerInput').value = '';
  h.click('open', id);
  assert.equal(h.calls.cleared, 1);
  assert.deepEqual(h.calls.analyzed, ['Feifei: Hello. Rob: Hi.']);
  h.calls.confirm = false;
  h.click('delete', id);
  assert.equal(MaterialStore.visible(h.sandbox.state.materials).length, 1, 'Cancelled delete keeps it');
  h.calls.confirm = true;
  h.click('delete', id);
  assert.deepEqual(MaterialStore.visible(h.sandbox.state.materials), []);
  assert.equal(h.sandbox.state.materials[0].deleted, true);
  assert.match(h.element('readerMaterialsList').innerHTML, /No saved materials yet/);
});
