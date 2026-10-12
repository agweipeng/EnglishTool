'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 12, 9);

// The review engine and Learn session of app.js with a fake page and a fixed clock
function harness(words) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      const handlers = {};
      elements.set(id, {
        id, innerHTML: '', textContent: '', value: id === 'learnMode' ? 'meaning' : '',
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle() {} },
        addEventListener: (type, fn) => { handlers[type] = fn; },
        click: () => handlers.click?.({}),
        querySelector: selector => element(`${id} ${selector}`),
      });
    }
    return elements.get(id);
  };
  const shown = [];
  const context = vm.createContext({
    state: { words, activity: {}, streak: { current: 0, lastDay: null } },
    Math, Date, Set, Map, Object, Array, String, Number, Infinity, console: { error() {} },
    document: { getElementById: element, querySelector: selector => element(selector) },
    speechSynthesis: { cancel() {} },
    escapeHTML: text => String(text), toast() {}, renderStats() {}, recordReview() {}, showView() {},
    storageErrorMessage: () => 'full', isLeech: () => false,
    SESSION_SIZE: 15, DAY_MS: DAY, MAX_LEVEL: 5, DEFAULT_EASE: 2.5, MIN_EASE: 1.3,
  });
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  const section = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));
  vm.runInContext(section('// ============ SRS Engine', '// ============ View routing'), context);
  vm.runInContext(section('// ============ Learn Session', '// --- Meaning recall'), context);
  vm.runInContext('nowMs = () => NOW_MS; renderCard = word => SHOWN.push(word.id);', Object.assign(context, { NOW_MS: NOW, SHOWN: shown }));
  const run = code => vm.runInContext(code, context);
  // Clicks a rating button for the card on screen, the way the page does
  const rate = (word, rating) => {
    let click;
    run('attachRating')({ querySelectorAll: () => [{ dataset: { r: rating }, addEventListener: (type, fn) => { click = fn; } }] }, word);
    click();
  };
  return { context, element, shown, run, rate };
}

const word = (id, nextReview, extra = {}) => ({ id, text: id, level: 0, ease: 2.5, interval: 1, rightCount: 1, wrongCount: 0, nextReview, ...extra });

test('a session only has the words that are due; a word not due yet waits for its day', () => {
  const h = harness([word('due', NOW - DAY), word('later', NOW + 3 * DAY), word('new', NOW, { rightCount: 0 }),
    word('done', NOW - DAY, { archivedAt: '2026-10-01T00:00:00Z' })]);
  assert.deepEqual(Array.from(h.run('pickSessionWords()'), w => w.id).sort(), ['due', 'new']);
});

test('Good on time moves a word up; Good again the same day does not, so a word is never mastered in one day', () => {
  const live = word('walk', NOW - DAY);
  const h = harness([live]);
  h.run('applyRating(state.words[0], "good")');
  assert.equal(live.level, 1);
  assert.ok(live.nextReview > NOW, 'The next review is in the future');
  const scheduled = live.nextReview;
  for (let i = 0; i < 4; i++) h.run('applyRating(state.words[0], "good")');
  assert.equal(live.level, 1, 'Early answers do not move the word up');
  assert.equal(live.nextReview, scheduled, 'and do not change its review day');
  assert.equal(live.archivedAt, undefined);
  assert.equal(live.rightCount, 6, 'The right answers are still counted');
  h.run('applyRating(state.words[0], "again")');
  assert.equal(live.level, 0, 'Forgetting it still counts, even early');
});

test('when nothing is due, Learn says when the next review is and offers practice that keeps the schedule', () => {
  const h = harness([word('a', NOW + DAY), word('b', NOW + 2 * DAY)]);
  h.run('startSession()');
  const empty = h.element('emptyLearn');
  assert.match(empty.innerHTML, /Nothing to review/);
  assert.match(empty.innerHTML, /id="practiceEarlyBtn"/);
  assert.equal(h.run('session'), null);
  h.element('emptyLearn #practiceEarlyBtn').click();
  assert.deepEqual(Array.from(h.run('session.queue'), w => w.id).sort(), ['a', 'b']);
  const before = h.run('JSON.stringify(state.words.map(w => [w.level, w.nextReview]))');
  h.rate(h.run('session.queue[0]'), 'easy');
  assert.equal(h.run('JSON.stringify(state.words.map(w => [w.level, w.nextReview]))'), before);
});

test('Again shows the word once more at the end of the session', () => {
  const h = harness([word('a', NOW - DAY), word('b', NOW - DAY)]);
  h.run('startSession()');
  const first = h.run('session.queue[0]');
  h.rate(first, 'again');
  assert.deepEqual(Array.from(h.run('session.queue'), w => w.id), [first.id, first.id === 'a' ? 'b' : 'a', first.id]);
  assert.equal(h.run('session.total'), 3);
  h.rate(h.run('session.queue[1]'), 'good');
  const wrongBefore = first.wrongCount;
  h.rate(h.run('session.queue[2]'), 'again');
  assert.equal(h.run('session.queue.length'), 3, 'Only once per session, so a hard word cannot loop forever');
  assert.equal(first.wrongCount, wrongBefore, 'Again on the second look is not counted twice');
  assert.doesNotMatch(h.run('ratingButtons(state.words[0])'), /&lt; 1 day/, 'The button no longer promises less than a day');
});
