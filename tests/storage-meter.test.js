'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness(state) {
  const meter = { innerHTML: '' };
  const sandbox = vm.createContext({
    state, console,
    document: { getElementById: id => (id === 'storageMeter' ? meter : null) },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../storage-meter.js'), 'utf8'), sandbox);
  return { sandbox, meter, run: code => vm.runInContext(code, sandbox) };
}

const text = chars => 'x'.repeat(chars);

test('sizes are measured as saved, split into learning data, analyses and reading materials', () => {
  const state = {
    words: [{ text: 'walk' }, { text: 'run' }],
    analyses: [{ id: 'a1', text: text(1000) }, { id: 'a2', updatedAt: 'x', deleted: true }],
    materials: [{ id: 'm1', text: text(5000) }],
  };
  const h = harness(state);
  h.sandbox.probe = state;
  const usage = h.run('measureStorage(probe)');
  assert.equal(usage.total, JSON.stringify(state).length);
  assert.equal(usage.analyses.size, JSON.stringify(state.analyses).length);
  assert.equal(usage.materials.size, JSON.stringify(state.materials).length);
  assert.equal(usage.learning.size, usage.total - usage.analyses.size - usage.materials.size);
  assert.deepEqual([usage.learning.count, usage.analyses.count, usage.materials.count], [2, 1, 1], 'Deleted entries are not counted');
  assert.equal(usage.level, 'ok');
});

test('the level warns from about 3 MB and becomes urgent near the 5 MB browser limit', () => {
  const h = harness({ words: [] });
  const level = chars => { h.sandbox.probe = { words: [], materials: [{ text: text(chars) }] }; return h.run('measureStorage(probe).level'); };
  assert.equal(level(2_900_000), 'ok');
  assert.equal(level(3_100_000), 'warn');
  assert.equal(level(4_600_000), 'high');
});

test('sizes read naturally', () => {
  const h = harness({ words: [] });
  assert.deepEqual(['formatSize(0)', 'formatSize(420)', 'formatSize(81_500)', 'formatSize(1_234_567)'].map(h.run),
    ['0 KB', '1 KB', '82 KB', '1.2 MB']);
});

test('the Settings meter shows the total, the breakdown and advice only when it is getting full', () => {
  const small = harness({ words: [{ text: 'walk' }], analyses: [], materials: [{ id: 'm1', title: '<b>BBC</b>', text: 'Hello.' }] });
  small.run('renderStorageMeter()');
  assert.match(small.meter.innerHTML, /of about 5 MB/);
  assert.match(small.meter.innerHTML, /1 word/);
  assert.match(small.meter.innerHTML, /1 reading material/);
  assert.doesNotMatch(small.meter.innerHTML, /<b>BBC/, 'Saved text never reaches the page as HTML');
  assert.doesNotMatch(small.meter.innerHTML, /Getting full/);
  const big = harness({ words: [], materials: [{ id: 'm1', text: text(3_500_000) }] });
  big.run('renderStorageMeter()');
  assert.match(big.meter.innerHTML, /Getting full/);
  assert.match(big.meter.innerHTML, /aria-valuenow="70"/);
});
