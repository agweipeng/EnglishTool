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
const data = words => ({ words, deletedWords: {}, settings: { voiceURI: null, rate: 1, theme: 'light' }, activity: {},
  streak: { current: 0, lastDay: null }, journal: {}, journalLog: {}, journalFeedback: {}, known: [], knownLog: {}, analyses: [], materials: [], quizzes: [] });

// The merge and other-tab code of app.js; `saved` records what this tab writes to storage
function harness(localState) {
  const saved = [];
  const context = vm.createContext({
    state: localState, TextCore, AnalysisStore, MaterialStore, JournalFeedbackStore, QuizStore, LearningMerge, JSON, Object, Array, Date, Math, Map, Set,
    localStorage: { getItem: () => null, setItem: (k, v) => saved.push(v), removeItem() {} },
    document: { getElementById: () => null, querySelector: () => null },
  });
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  vm.runInContext(app.slice(app.indexOf('// ============ Merge logic'), app.indexOf('// ============ Sync orchestration')), context);
  vm.runInContext(app.slice(app.indexOf('// ============ Other tabs'), app.indexOf('// ============ Helpers')), context);
  return { context, saved, run: code => vm.runInContext(code, context) };
}

test('a change saved in another tab is merged in, so this tab never saves its older copy over it', () => {
  const h = harness(data([word('w1', 'walk', '2026-10-09T05:00:00Z')]));
  const other = { ...data([word('w1', 'walk', '2026-10-09T01:00:00Z'), word('w2', 'run', '2026-10-09T02:00:00Z')]),
    settings: { voiceURI: null, rate: 1, theme: 'dark' }, activity: { '2026-10-09': 4 }, streak: { current: 3, lastDay: '2026-10-09' } };
  assert.equal(h.run(`onOtherTabSaved(${JSON.stringify(JSON.stringify(other))})`), true);
  const state = h.context.state;
  assert.deepEqual(Array.from(state.words, w => [w.id, w.updatedAt]), [['w1', '2026-10-09T05:00:00Z'], ['w2', '2026-10-09T02:00:00Z']],
    'This tab’s newer edit stays, and the other tab’s new word arrives');
  assert.equal(state.settings.theme, 'dark', 'Settings changed in the other tab apply here too');
  assert.deepEqual({ ...state.activity }, { '2026-10-09': 4 });
  assert.equal(state.streak.current, 3);
  assert.equal(h.saved.length, 0, 'Nothing is written back, so two tabs never echo each other');
});

test('replacing the data (Sync Code) keeps the later Reset All, so the pasted progress counts in full', () => {
  const h = harness({ ...data([]), resetAt: '2026-10-05T10:00:00.000Z' });
  const pasted = { ...data([]), activity: { '2026-10-01': 7 } };
  const replaced = h.run(`replaceState(state, ${JSON.stringify(pasted)}, '2026-10-08T00:00:00.000Z')`);
  assert.equal(replaced.resetAt, '2026-10-05T10:00:00.000Z');
  assert.deepEqual({ ...LearningMerge.mergeProgress(replaced, { activity: { '2026-10-02': 4 } }).activity }, { '2026-10-01': 7 },
    'The pasted day stays; the older gist day does not come back');
  assert.equal(h.run(`replaceState(${JSON.stringify(data([]))}, ${JSON.stringify(pasted)}, 'x')`).resetAt, undefined, 'No reset, no marker');
});

test('a change from another tab that cannot be read is ignored', () => {
  const h = harness(data([word('w1', 'walk', '2026-10-09T05:00:00Z')]));
  const before = JSON.stringify(h.context.state);
  assert.equal(h.run('onOtherTabSaved("not json")'), false);
  assert.equal(h.run('onOtherTabSaved("{\\"words\\":5}")'), false);
  assert.equal(JSON.stringify(h.context.state), before);
});
