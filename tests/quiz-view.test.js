'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const TextCore = require('../text-core.js');
const AnalysisStore = require('../analysis-store.js');
const QuizCore = require('../quiz-core.js');
const QuizStore = require('../quiz-store.js');

const words = ['carry on', 'reluctant', 'gaze', 'wander', 'eager', 'fond of', 'linger']
  .map((text, i) => ({ id: `w${i}`, text, defEN: `meaning ${i}`, defCN: '意思', examples: [], createdAt: `2026-10-0${i + 1}T00:00:00Z` }));

function harness({ memory = new Map(), state = { words, analyses: [], quizzes: [] } } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { id, value: id === 'quizSource' ? 'mix' : '', innerHTML: '', textContent: '', className: '', disabled: false,
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
          toggle(c, force) { if (force) classes.add(c); else classes.delete(c); } },
        addEventListener() {}, scrollIntoView() {} });
    }
    return elements.get(id);
  };
  const timers = [];
  const calls = { toasts: [], read: [], settings: 0, prompts: [] };
  const context = vm.createContext({
    TextCore, AnalysisStore, QuizCore, QuizStore, console, Date, JSON, AbortController,
    state, saveState() {}, uid: (() => { let n = 0; return () => `quiz${++n}`; })(),
    toast: message => calls.toasts.push(message), confirm: () => true, speak() {},
    escapeHTML: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    openReadAloud: text => calls.read.push(text), openLocalAISettings: () => { calls.settings++; },
    isLeech: () => false, localModelName: () => 'qwen3.5:4b',
    copyChatPrompt: (service, prompt) => calls.prompts.push({ service, prompt }), AI_CHATS: { claude: { name: 'Claude' }, chatgpt: { name: 'ChatGPT' } },
    localStorage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) },
    document: { readyState: 'loading', addEventListener() {}, getElementById: element, querySelectorAll: () => [] },
    window: { addEventListener() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
  });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync(require.resolve('../quiz-view.js'), 'utf8'));
  run('initQuizView()');
  const runTimers = ms => timers.filter(timer => timer.ms === ms).forEach(timer => timer.fn());
  return { run, element, memory, calls, context, runTimers };
}

const feedbackFor = items => JSON.stringify({ items: items.map((item, i) => ({ word: item.text, verdict: i === 0 ? 'natural' : 'understandable',
  sentences: [{ yours: item.answer || 'x', better: i === 0 ? item.answer : '<b>Better</b> sentence.', note: { en: 'Note.', cn: '说明。' } }],
  model: `A model with ${item.text}.` })), tip: { en: 'Keep going.', cn: '继续加油。' } });

test('a new quiz picks 5 words, and the written draft survives a reload', () => {
  const h = harness();
  h.run('startNewQuiz()');
  assert.equal(h.run('quizDraft.items.length'), 5);
  h.run('setQuizAnswer("I carried on reading.")');
  h.runTimers(600);
  assert.equal(JSON.parse(h.memory.get('englishTrainerQuizDraft_v1')).items[0].answer, 'I carried on reading.');
  const again = harness({ memory: h.memory });
  again.run('renderQuizView()');
  assert.equal(again.run('quizDraft.items[0].answer'), 'I carried on reading.');
  assert.match(again.element('quizTest').innerHTML, /I carried on reading\./);
  assert.equal(again.element('quizCheck').classList.contains('hidden'), false, 'The check buttons appear once an answer is written');
});

test('swapping replaces the current word with one not already in the quiz', () => {
  const h = harness();
  h.run('startNewQuiz()');
  const before = h.run('quizDraft.items.map(item => item.text)');
  h.run('setQuizAnswer("Some text."); swapQuizItem()');
  const after = h.run('quizDraft.items[0]');
  assert.ok(!before.includes(after.text));
  assert.equal(after.answer, '');
  assert.deepEqual([...h.run('quizDraft.swapped')], [before[0]], 'Copied out of the vm realm so deepEqual compares values');
});

test('without a local AI connection, checking opens the Local AI settings', async () => {
  const h = harness();
  h.run('startNewQuiz(); setQuizAnswer("We carried on.")');
  await h.run('checkQuizWithLocalAI()');
  assert.equal(h.calls.settings, 1);
});

test('checking with local AI saves the quiz with its feedback and clears the draft', async () => {
  const h = harness();
  const asked = [];
  h.context.window.requestParagraphAI = async request => { asked.push(request); return feedbackFor(h.run('quizDraft.items')); };
  h.run('startNewQuiz(); setQuizAnswer("We carried on.")');
  await h.run('checkQuizWithLocalAI()');
  assert.equal(asked[0].schemaName, 'quiz_feedback');
  assert.match(asked[0].prompt, /We carried on\./);
  const [saved] = QuizStore.visible(h.context.state.quizzes);
  assert.equal(saved.checkedWith, 'local');
  assert.equal(saved.model, 'qwen3.5:4b');
  assert.equal(saved.feedback.items[0].verdict, 'natural');
  assert.equal(h.run('quizDraft'), null);
  assert.equal(h.memory.has('englishTrainerQuizDraft_v1'), false);
  const html = h.element('quizResults').innerHTML;
  assert.match(html, /1\/5 natural/);
  assert.match(html, /&lt;b&gt;Better&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>Better/);
  assert.match(html, /data-quiz-read="A model with/);
  assert.match(h.element('quizHistory').innerHTML, /1\/5 natural/);
});

test('a cancelled local check keeps the answers and saves nothing', async () => {
  const h = harness();
  h.context.window.requestParagraphAI = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  h.run('startNewQuiz(); setQuizAnswer("We carried on.")');
  const checking = h.run('checkQuizWithLocalAI()');
  h.run('quizRequest.abort()');
  await checking;
  assert.match(h.element('quizStatus').textContent, /cancelled/);
  assert.equal(h.run('quizDraft.items[0].answer'), 'We carried on.');
  assert.deepEqual(QuizStore.visible(h.context.state.quizzes), []);
});

test('a pasted reply that is not JSON is saved as text', () => {
  const h = harness();
  h.run('startNewQuiz(); setQuizAnswer("We carried on."); quizReplyService = "chatgpt"');
  h.element('quizReply').value = 'Great work! Everything sounds natural.';
  h.run('saveQuizReply()');
  const [saved] = QuizStore.visible(h.context.state.quizzes);
  assert.equal(saved.feedback, null);
  assert.equal(saved.feedbackText, 'Great work! Everything sounds natural.');
  assert.equal(saved.checkedWith, 'chatgpt');
  assert.match(h.element('quizStatus').textContent, /Saved as text/);
  assert.match(h.element('quizResults').innerHTML, /Everything sounds natural/);
});

test('if storage is full the quiz is not saved and the answers stay', () => {
  const h = harness();
  h.context.saveState = () => { throw new Error('QuotaExceededError'); };
  h.run('startNewQuiz(); setQuizAnswer("We carried on.")');
  h.element('quizReply').value = 'Fine.';
  h.run('saveQuizReply()');
  assert.deepEqual(h.context.state.quizzes, []);
  assert.equal(h.run('quizDraft.items[0].answer'), 'We carried on.');
  assert.match(h.calls.toasts.at(-1), /storage may be full/);
});

test('past quizzes reopen and delete, and read-aloud buttons open the challenge', () => {
  const h = harness();
  h.run('startNewQuiz(); setQuizAnswer("We carried on.")');
  h.element('quizReply').value = feedbackFor(h.run('quizDraft.items'));
  h.run('saveQuizReply(); quizShownId = ""; renderQuizResults()');
  assert.equal(h.element('quizResults').innerHTML, '');
  const id = QuizStore.visible(h.context.state.quizzes)[0].id;
  const click = (attributes, row) => h.run(`onQuizClick({ target: { closest: selector => {
    const found = ${JSON.stringify(attributes)}[selector];
    return found ? { dataset: found, closest: () => (${JSON.stringify(row)} ? { dataset: ${JSON.stringify(row)} } : null) } : null; } } })`);
  click({ '[data-quiz-act]': { quizAct: 'open' } }, { id });
  assert.match(h.element('quizResults').innerHTML, /Keep going\./);
  click({ '[data-quiz-read]': { quizRead: 'Read me.' } }, null);
  assert.deepEqual(h.calls.read, ['Read me.']);
  click({ '[data-quiz-act]': { quizAct: 'delete' } }, { id });
  assert.deepEqual(QuizStore.visible(h.context.state.quizzes), []);
  assert.equal(h.element('quizResults').innerHTML, '');
});
