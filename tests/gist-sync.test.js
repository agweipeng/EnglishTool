'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TextCore = require('../text-core.js');
const AnalysisStore = require('../analysis-store.js');
const MaterialStore = require('../material-store.js');
const JournalFeedbackStore = require('../journal-feedback-store.js');
const QuizStore = require('../quiz-store.js');
const LearningMerge = require('../learning-merge.js');

const word = (id, text, updatedAt) => ({ id, text, updatedAt });
// Same shape as defaultState() in app.js
const data = (words, known = []) => ({ words, deletedWords: {}, settings: { voiceURI: null, rate: 1, theme: 'light' }, activity: {},
  streak: { current: 0, lastDay: null }, journal: {}, journalLog: {}, journalFeedback: {}, known, knownLog: {}, analyses: [], materials: [], quizzes: [] });

// A fake gist server: GET returns the stored file, PATCH replaces it. `gate` lets a test hold a GET open.
function gistServer(initial) {
  const server = { content: JSON.stringify(initial), gets: 0, patches: 0, active: 0, maxActive: 0, failGet: false, gate: null, urls: [] };
  server.fetch = async (url, options = {}) => {
    server.urls.push(url);
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
    state: localState, TextCore, AnalysisStore, MaterialStore, JournalFeedbackStore, QuizStore, LearningMerge, JSON, console: { error() {} }, Date, Math, Map, Object, Array, Promise, Error,
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

test('journal replies from Claude or ChatGPT sync too, newest edit winning for each day', async () => {
  const phone = { ...data([]), journalFeedback: {
    '2026-10-08': { text: 'Phone reply', source: 'chatgpt', updatedAt: '2026-10-09T02:00:00Z' },
    '2026-10-09': { text: 'Only on phone', source: 'claude', updatedAt: '2026-10-09T01:00:00Z' } } };
  const mac = { ...data([]), journalFeedback: { '2026-10-08': { text: 'Older mac reply', source: 'claude', updatedAt: '2026-10-09T01:00:00Z' } } };
  const server = gistServer(phone);
  const h = harness(mac, server);
  assert.equal(await h.run('syncNow()'), true);
  const merged = h.context.state.journalFeedback;
  assert.deepEqual(Object.keys(merged).sort(), ['2026-10-08', '2026-10-09']);
  assert.equal(merged['2026-10-08'].text, 'Phone reply');
});

test('a word deleted on this device stays deleted after syncing with a gist that still has it', async () => {
  const server = gistServer(data([word('w1', 'old', '2026-10-09T01:00:00Z'), word('w2', 'kept', '2026-10-09T01:00:00Z')]));
  const mac = data([word('w2', 'kept', '2026-10-09T01:00:00Z')]);
  mac.deletedWords = { w1: '2026-10-09T05:00:00Z' };
  const h = harness(mac, server);
  assert.equal(await h.run('syncNow()'), true);
  assert.deepEqual(Array.from(h.context.state.words, w => w.text), ['kept']);
  assert.deepEqual(JSON.parse(server.content).words.map(w => w.text), ['kept'], 'The gist drops it too');
});

test('after Reset All, a sync does not bring back the old streak and review history', async () => {
  const server = gistServer({ ...data([word('w1', 'old', '2026-10-01T00:00:00Z')]),
    activity: { '2026-10-01': 9 }, streak: { current: 6, lastDay: '2026-10-04' } });
  const reset = { ...data([]), deletedWords: { w1: '2026-10-05T10:00:00Z' }, resetAt: '2026-10-05T10:00:00Z' };
  const h = harness(reset, server);
  assert.equal(await h.run('syncNow()'), true);
  const state = h.context.state;
  assert.deepEqual([state.words.length, { ...state.activity }, { ...state.streak }], [0, {}, { current: 0, lastDay: null }]);
  assert.equal(JSON.parse(server.content).resetAt, '2026-10-05T10:00:00Z', 'Other devices learn about the reset');
});

test('disconnecting during a sync stays disconnected when the sync finishes', async () => {
  const server = gistServer(data([]));
  let release;
  server.gate = new Promise(resolve => { release = resolve; });
  const h = harness(data([word('w1', 'first', '2026-10-09T01:00:00Z')]), server);
  const running = h.run('syncNow()');
  await new Promise(resolve => setImmediate(resolve));
  h.run('disconnectSync()');
  release();
  assert.equal(await running, false);
  assert.equal(h.memory.has('englishTrainerSync_v1'), false, 'The token is not saved again');
});

test('when the merged data cannot be stored (storage full), the sync reports an error and pushes nothing', async () => {
  const server = gistServer(data([word('w2', 'phone word', '2026-10-09T02:00:00Z')]));
  const h = harness(data([word('w1', 'mac word', '2026-10-09T01:00:00Z')]), server);
  h.context.localStorage.setItem = (key, value) => {
    if (key === 'englishTrainerData_v1') { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; }
    h.memory.set(key, value);
  };
  assert.equal(await h.run('syncNow()'), false);
  assert.equal(server.patches, 0, 'Nothing this device could not keep is pushed');
  assert.deepEqual(Array.from(h.context.state.words, w => w.text), ['mac word'], 'This device keeps what it has stored');
});

test('connecting to another gist while a sync runs syncs the new gist once the old sync stops', async () => {
  const server = gistServer(data([]));
  let release;
  server.gate = new Promise(resolve => { release = resolve; });
  const h = harness(data([word('w1', 'first', '2026-10-09T01:00:00Z')]), server);
  const first = h.run('syncNow()');
  await new Promise(resolve => setImmediate(resolve));
  h.memory.set('englishTrainerSync_v1', JSON.stringify({ token: 't2', gistId: 'g2' }));
  const second = h.run('syncNow()');
  server.gate = null;
  release();
  assert.equal(await first, false, 'The old sync stops');
  assert.equal(await second, true);
  assert.ok(server.urls.some(url => url.endsWith('/gists/g2')), 'The new gist is read and synced');
});

// A GitHub API stand-in for connecting: the user check passes, the gist list answers with `listStatus`;
// `failRead` makes reading the gist fail, so the first sync after connecting fails
function connectServer({ listStatus = 200, offline = false, failRead = false } = {}) {
  const server = { posts: 0 };
  server.fetch = async (url, options = {}) => {
    if (offline) throw new TypeError('Failed to fetch');
    if (url.endsWith('/user')) return { ok: true, json: async () => ({ login: 'me' }) };
    if (options.method === 'POST') { server.posts++; return { ok: true, json: async () => ({ id: 'new' }) }; }
    if (url.includes('/gists?')) return { ok: listStatus === 200, status: listStatus, json: async () => [] };
    if (failRead && (options.method || 'GET') === 'GET') return { ok: false, status: 500 };
    return { ok: true, json: async () => ({ files: {} }) };
  };
  return server;
}

test('connecting says whether the first sync worked', async () => {
  const ok = harness(data([]), connectServer());
  ok.memory.delete('englishTrainerSync_v1');
  assert.deepEqual({ ...(await ok.run('connectSync("token")')) }, { ok: true, user: 'me', gistId: 'new', synced: true });
  const failing = harness(data([]), connectServer({ failRead: true }));
  failing.memory.delete('englishTrainerSync_v1');
  const result = await failing.run('connectSync("token")');
  assert.equal(result.ok, true, 'Still connected');
  assert.equal(result.synced, false, 'but the page can tell the user the first sync failed');
});

test('connecting never creates a second gist when the gist list cannot be read', async () => {
  const server = connectServer({ listStatus: 502 });
  const h = harness(data([]), server);
  h.memory.delete('englishTrainerSync_v1');
  const result = await h.run('connectSync("token")');
  assert.ok(result.error, 'Connecting reports an error');
  assert.equal(server.posts, 0, 'No new gist was created');
  assert.equal(h.memory.has('englishTrainerSync_v1'), false);
});

test('connecting while offline reports an error instead of failing silently', async () => {
  const h = harness(data([]), connectServer({ offline: true }));
  h.memory.delete('englishTrainerSync_v1');
  const result = await h.run('connectSync("token")');
  assert.match(result.error, /GitHub/);
});
