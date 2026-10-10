'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const JournalFeedbackStore = require('../journal-feedback-store.js');
const LearningMerge = require('../learning-merge.js');

// The Journal section of app.js with a fake page; `failSave` makes saveState throw like a full browser storage
function harness(initial = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', innerHTML: '', querySelectorAll: () => [] });
    return elements.get(id);
  };
  const timers = [];
  const messages = [];
  const saves = { count: 0, failSave: false };
  const context = vm.createContext({
    state: { journal: {}, journalLog: {}, journalFeedback: {}, ...initial },
    JournalFeedbackStore, LearningMerge, Object, Date, String, console: { error() {} },
    document: { getElementById: element },
    AI_CHATS: {}, todayKey: () => '2026-10-10', escapeHTML: s => String(s), confirm: () => true,
    toast: message => messages.push(message), copyChatPrompt() {},
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    storageErrorMessage: () => 'Not saved — browser storage is full',
    saveState: () => {
      if (saves.failSave) { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; }
      saves.count++;
    },
  });
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  vm.runInContext(app.slice(app.indexOf('// ============ Journal ============'), app.indexOf('// ============ Read Aloud Challenge')), context);
  const type = text => { element('journalText').value = text; vm.runInContext('scheduleJournalSave()', context); };
  return { context, element, timers, messages, saves, type, run: code => vm.runInContext(code, context) };
}

test('an entry is saved to the day it was typed on, even when the date changes before the autosave', () => {
  const h = harness();
  h.element('journalDate').value = '2026-10-09';
  h.type('Yesterday I walked.');
  h.element('journalDate').value = '2026-10-10';
  h.run('renderJournal()');
  assert.deepEqual({ ...h.context.state.journal }, { '2026-10-09': 'Yesterday I walked.' });
  assert.equal(h.element('journalText').value, '', 'The new day starts empty');
  assert.ok(h.context.state.journalLog['2026-10-09'], 'The save time is recorded for syncing');
});

test('leaving the page saves what is waiting', () => {
  const h = harness();
  h.element('journalDate').value = '2026-10-10';
  h.type('Draft');
  h.run('commitJournal()');
  assert.equal(h.context.state.journal['2026-10-10'], 'Draft');
  assert.equal(h.saves.count, 1);
  h.run('commitJournal()');
  assert.equal(h.saves.count, 1, 'Nothing left to save');
});

test('deleting an entry records the deletion, so a sync does not bring it back', () => {
  const h = harness({ journal: { '2026-10-10': 'Old text' }, journalLog: { '2026-10-10': '2026-10-01T00:00:00Z' } });
  h.element('journalDate').value = '2026-10-10';
  h.run('deleteCurrentJournal()');
  assert.deepEqual({ ...h.context.state.journal }, {});
  assert.notEqual(h.context.state.journalLog['2026-10-10'], '2026-10-01T00:00:00Z', 'The deletion time is recorded');
  const merged = LearningMerge.mergeJournal(h.context.state, { journal: { '2026-10-10': 'Old text' }, journalLog: { '2026-10-10': '2026-10-05T00:00:00Z' } });
  assert.deepEqual(merged.journal, {});
});

test('when storage is full, the saved entry is unchanged and the user is told', () => {
  const h = harness({ journal: { '2026-10-10': 'Saved' } });
  h.element('journalDate').value = '2026-10-10';
  h.saves.failSave = true;
  h.type('Saved and more');
  assert.equal(h.run('commitJournal()'), false);
  assert.equal(h.context.state.journal['2026-10-10'], 'Saved');
  assert.match(h.messages.at(-1), /storage is full/);
});

test('when the save fails on a day switch, the typed text and its day stay on screen', () => {
  const h = harness();
  h.element('journalDate').value = '2026-10-09';
  h.saves.failSave = true;
  h.type('Not saved yet');
  h.element('journalDate').value = '2026-10-10';
  h.run('renderJournal()');
  assert.equal(h.element('journalDate').value, '2026-10-09');
  assert.equal(h.element('journalText').value, 'Not saved yet');
  h.saves.failSave = false;
  h.run('commitJournal()');
  assert.equal(h.context.state.journal['2026-10-09'], 'Not saved yet', 'It is saved once there is room');
});

test('a delete that cannot be saved leaves the entry in place', () => {
  const h = harness({ journal: { '2026-10-10': 'Keep me' } });
  h.element('journalDate').value = '2026-10-10';
  h.element('journalText').value = 'Keep me';
  h.saves.failSave = true;
  h.run('deleteCurrentJournal()');
  assert.equal(h.context.state.journal['2026-10-10'], 'Keep me');
  assert.equal(h.element('journalText').value, 'Keep me');
  assert.match(h.messages.at(-1), /storage is full/);
});
