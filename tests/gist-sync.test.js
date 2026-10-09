'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TextCore = require('../text-core.js');
const AnalysisStore = require('../analysis-store.js');
const MaterialStore = require('../material-store.js');

const word = (id, text, updatedAt) => ({ id, text, updatedAt });
// Same shape as defaultState() in app.js
const data = (words, known = []) => ({ words, settings: { voiceURI: null, rate: 1, theme: 'light' }, activity: {},
  streak: { current: 0, lastDay: null }, journal: {}, known, knownLog: {}, analyses: [], materials: [] });

// A fake gist server: GET returns the stored file, PATCH replaces it. `gate` lets a test hold a GET open.
function gistServer(initial) {
  const server = { content: JSON.stringify(initial), gets: 0, patches: 0, active: 0, maxActive: 0, failGet: false, gate: null };
  server.fetch = async (url, options = {}) => {
    server.active++;
    server.maxActive = Math.max(server.maxActive, server.active);
    try {
      if ((options.method || 'GET') === 'GET') {
        server.gets++;
        if (server.gate) await server.gate;
        if (server.failGet) return { ok: false, status: 500 };
        return { ok: true, json: async () => ({ files: { 'english-trainer-data.json': { content: server.content, truncated: false } } }) };
      }
      server.patches++;
      server.content = JSON.parse(options.body).files['english-trainer-data.json'].content;
      return { ok: true };
    } finally {
      server.active--;
    }
  };
  return server;
}

function harness(localState, server) {
  const memory = new Map([['englishTrainerSync_v1', JSON.stringify({ token: 't', gistId: 'g1' })]]);
  const timers = [];
  const calls = { refresh: 0 };
  const context = vm.createContext({
    state: localState, TextCore, AnalysisStore, MaterialStore, JSON, Date, Math, Map, Object, Array, Promise, Error,
    STORAGE_KEY: 'englishTrainerData_v1', SYNC_KEY: 'englishTrainerSync_v1', GIST_FILE: 'english-trainer-data.json', PUSH_DEBOUNCE_MS: 2500,
    localStorage: { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: k => memory.delete(k) },
    document: { getElementById: () => null },
    fetch: (...args) => server.fetch(...args),
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    refreshActiveView: () => { calls.refresh++; },
  });
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  vm.runInContext(app.slice(app.indexOf('// ============ Sync config'), app.indexOf('// Re-render whichever view')), context);
  // Runs the debounced push the way the browser would, and waits for it to finish
  const firePush = async () => { const fn = timers.pop(); await fn(); };
  return { context, memory, calls, firePush, run: code => vm.runInContext(code, context) };
}

test('auto-push merges the other device’s changes before pushing, so nothing is overwritten', async () => {
  const server = gistServer(data([word('w2', 'phone word', '2026-10-09T02:00:00Z')]));
  const h = harness(data([word('w1', 'mac word', '2026-10-09T01:00:00Z')]), server);
  h.run('schedulePush()');
  await h.firePush();
  const pushed = JSON.parse(server.content).words.map(w => w.text).sort();
  assert.deepEqual(pushed, ['mac word', 'phone word'], 'The gist keeps both devices’ words');
  assert.deepEqual(Array.from(h.context.state.words, w => w.text).sort(), ['mac word', 'phone word'], 'This device gets the phone’s word too');
  assert.equal(server.gets, 1);
  assert.equal(server.patches, 1);
  assert.equal(h.calls.refresh, 1, 'The screen refreshes because new data arrived');
});

test('a failed read never pushes, so it cannot overwrite the other devices', async () => {
  const server = gistServer(data([word('w2', 'phone word', '2026-10-09T02:00:00Z')]));
  server.failGet = true;
  const h = harness(data([word('w1', 'mac word', '2026-10-09T01:00:00Z')]), server);
  h.run('schedulePush()');
  await h.firePush();
  assert.equal(server.patches, 0);
  assert.match(server.content, /phone word/);
});

test('nothing is uploaded or redrawn when the gist already matches', async () => {
  const same = data([word('w1', 'walk', '2026-10-09T01:00:00Z')], ['walked', 'run', 'apple']);
  const server = gistServer(same);
  const h = harness(JSON.parse(JSON.stringify(same)), server);
  assert.equal(await h.run('syncNow()'), true);
  assert.equal(server.patches, 0);
  assert.equal(h.calls.refresh, 0);
});

test('a save during a running sync waits for it and then syncs once more, never two at a time', async () => {
  const server = gistServer(data([]));
  let release;
  server.gate = new Promise(resolve => { release = resolve; });
  const h = harness(data([word('w1', 'first', '2026-10-09T01:00:00Z')]), server);
  const first = h.run('syncNow()');
  await new Promise(resolve => setImmediate(resolve));
  h.run(`state = { ...state, words: [...state.words, { id: 'w2', text: 'second', updatedAt: '2026-10-09T03:00:00Z' }] }`);
  const second = h.run('syncNow()');
  server.gate = null;
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(server.maxActive, 1, 'Requests never overlap');
  assert.equal(server.gets, 2, 'The save during the sync caused exactly one more round');
  assert.deepEqual(JSON.parse(server.content).words.map(w => w.text), ['first', 'second']);
});
