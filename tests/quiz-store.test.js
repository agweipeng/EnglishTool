'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const QuizStore = require('../quiz-store.js');

const items = [{ text: 'carry on', meaning: { en: 'continue', cn: '继续' }, example: 'They carried on.', from: { type: 'word', id: 'w1' }, answer: 'We carried on.' }];
const feedback = { items: [{ verdict: 'natural', sentences: [], model: 'Let’s carry on.' }], tip: { en: '', cn: '' } };
const quiz = (id, at, extra = {}) => QuizStore.createEntry({ source: 'mix', items, feedback, checkedWith: 'local', model: 'qwen', ...extra }, at, id);

test('a checked quiz is saved with long text capped and unknown values made safe', () => {
  const entry = QuizStore.createEntry({ source: 'everything', items: [{ ...items[0], answer: 'x'.repeat(1500) }],
    feedbackText: 'y'.repeat(40000), checkedWith: 'somebot' }, '2026-10-10T01:00:00Z', 'q1');
  assert.equal(entry.source, 'mix');
  assert.equal(entry.items[0].answer.length, 1000);
  assert.equal(entry.feedbackText.length, 30000);
  assert.equal(entry.feedback, null);
  assert.equal(entry.checkedWith, 'claude');
  assert.equal(entry.createdAt, entry.updatedAt);
});

test('every quiz is kept, newest first', () => {
  let list = [];
  for (let i = 0; i < 150; i++) list = QuizStore.upsert(list, quiz(`q${i}`, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString()));
  const shown = QuizStore.visible(list);
  assert.equal(shown.length, 150);
  assert.equal(shown[0].id, 'q149');
});

test('a deleted quiz stays deleted when the other device still has it', () => {
  const live = [quiz('q1', '2026-10-10T01:00:00Z')];
  const deleted = QuizStore.remove(live, 'q1', '2026-10-10T02:00:00Z');
  assert.deepEqual(QuizStore.visible(deleted), []);
  assert.deepEqual(QuizStore.visible(QuizStore.merge(live, deleted)), []);
  const merged = QuizStore.merge(deleted, [quiz('q2', '2026-10-10T03:00:00Z')]);
  assert.deepEqual(QuizStore.visible(merged).map(entry => entry.id), ['q2']);
});

test('damaged quizzes from a backup are dropped', () => {
  const noFeedback = { ...quiz('q1', '2026-10-10T01:00:00Z'), feedback: null, feedbackText: ' ' };
  const noItems = { ...quiz('q2', '2026-10-10T01:00:00Z'), items: [] };
  assert.deepEqual(QuizStore.visible([noFeedback, noItems, null, 'quiz']), []);
});
