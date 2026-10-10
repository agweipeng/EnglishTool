'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../quiz-core.js');

const keepOrder = () => 0.999999;   // Fisher–Yates with this "random" leaves every list in order
const word = (text, createdAt = '2026-10-01T00:00:00Z', extra = {}) => ({ id: `w-${text}`, text, defEN: `meaning of ${text}`, defCN: '中文',
  examples: [{ en: '', cn: '只有中文' }, { en: `An example with ${text}.`, cn: '' }], createdAt, ...extra });
const analysis = (id, words, phrases = []) => ({ id, result: {
  words: words.map(text => ({ text, meaning: { en: `${text} means`, cn: '意思' }, example: `Book line with ${text}.` })),
  phrases: phrases.map(text => ({ text, meaning: { en: `${text} means`, cn: '意思' }, example: `Book line with ${text}.` })) } });
const texts = items => items.map(item => item.text);

test('Library candidates: stubborn words, then phrases, then the newest; archived words are skipped', () => {
  const words = [word('a', '2026-10-02T00:00:00Z'), word('carry on', '2026-10-03T00:00:00Z'), word('b', '2026-10-05T00:00:00Z'),
    word('c', '2026-10-06T00:00:00Z', { archivedAt: '2026-10-07T00:00:00Z' }), word('d', '2026-10-01T00:00:00Z')];
  const list = Q.libraryCandidates(words, w => w.text === 'd');
  assert.deepEqual(texts(list), ['d', 'carry on', 'b', 'a']);
  assert.deepEqual(list[1], { text: 'carry on', meaning: { en: 'meaning of carry on', cn: '中文' },
    example: 'An example with carry on.', from: { type: 'word', id: 'w-carry on' } });
});

test('Analyses candidates: words then phrases of each analysis, in the order given', () => {
  const list = Q.analysisCandidates([analysis('a2', ['x'], ['set off']), analysis('a1', ['y'])]);
  assert.deepEqual(texts(list), ['x', 'set off', 'y']);
  assert.deepEqual(list[1].from, { type: 'analysis', id: 'a2' });
  assert.equal(list[1].example, 'Book line with set off.');
});

test('Mix alternates Library and Analyses, starting with Library, and fills from the other list', () => {
  const library = Q.libraryCandidates([word('l1', '2026-10-02T00:00:00Z'), word('l2')]);
  const analyses = Q.analysisCandidates([analysis('a', ['a1', 'a2', 'a3', 'a4', 'a5'])]);
  assert.deepEqual(texts(Q.pickQuizItems({ library, analyses, random: keepOrder })), ['l1', 'a1', 'l2', 'a2', 'a3']);
  assert.deepEqual(texts(Q.pickQuizItems({ library, analyses, source: 'library', random: keepOrder })), ['l1', 'l2']);
  assert.deepEqual(texts(Q.pickQuizItems({ library, analyses, source: 'analyses', random: keepOrder })), ['a1', 'a2', 'a3', 'a4', 'a5']);
});

test('duplicates across sources and excluded words are skipped', () => {
  const library = Q.libraryCandidates([word('run', '2026-10-02T00:00:00Z'), word('walk')]);
  const analyses = Q.analysisCandidates([analysis('a', ['Run ', 'jump'])]);
  assert.deepEqual(texts(Q.pickQuizItems({ library, analyses, exclude: ['walk'], random: keepOrder })), ['run', 'jump']);
});

test('recently practised words are held back unless there would be too few', () => {
  const recent = Q.recentKeys([{ items: [{ text: 'w1' }, { text: 'W2' }] }]);
  const many = Array.from({ length: 8 }, (_, i) => ({ text: `w${i + 1}` }));
  const picked = texts(Q.pickQuizItems({ library: many, source: 'library', recent, random: keepOrder }));
  assert.deepEqual(picked, ['w3', 'w4', 'w5', 'w6', 'w7']);
  const few = texts(Q.pickQuizItems({ library: many.slice(0, 6), source: 'library', recent, random: keepOrder }));
  assert.deepEqual(few, ['w3', 'w4', 'w5', 'w6', 'w1'], 'Fresh words come first, then one held-back word');
});

test('only the latest 3 quizzes count as recent', () => {
  const quiz = text => ({ items: [{ text }] });
  assert.deepEqual([...Q.recentKeys([quiz('a'), quiz('b'), quiz('c'), quiz('d')])], ['a', 'b', 'c']);
});

test('the 5 are drawn at random from the 20 best candidates', () => {
  const list = Array.from({ length: 30 }, (_, i) => ({ text: `w${i}` }));
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  for (let run = 0; run < 20; run++) {
    const picked = Q.pickQuizItems({ library: list, source: 'library', random });
    assert.equal(picked.length, 5);
    assert.ok(picked.every(item => Number(item.text.slice(1)) < 20));
  }
});

test('usesTarget accepts word forms of a word or phrase', () => {
  assert.equal(Q.usesTarget('He carried on working.', 'carry on'), true);
  assert.equal(Q.usesTarget('I kept going.', 'carry on'), false);
  assert.equal(Q.usesTarget('', 'carry on'), false);
});

test('the prompt lists every item with its meaning and sentences, and marks empty answers as skipped', () => {
  const prompt = Q.buildQuizPrompt([
    { text: 'carry on', meaning: { en: 'continue', cn: '继续' }, answer: 'We carried on.\nShe carries on.' },
    { text: 'reluctant', meaning: { en: '', cn: '' }, answer: '  ' },
  ]);
  assert.match(prompt, /1\. Target: "carry on" — meaning: continue \/ 继续\nLearner's sentences:\nWe carried on\.\nShe carries on\./);
  assert.match(prompt, /2\. Target: "reluctant"\nLearner's sentences:\n\(skipped\)/);
  assert.match(prompt, /JSON only/);
  assert.match(prompt, /"verdict":"natural\|understandable\|wrong"/);
});

const items = [{ text: 'carry on', answer: 'We carried on.' }, { text: 'reluctant', answer: 'I am reluctant.' }];

test('clean JSON feedback is matched to the items by position', () => {
  const reply = JSON.stringify({ items: [
    { word: 'carry on', verdict: 'natural', sentences: [{ yours: 'We carried on.', better: 'We carried on.', note: { en: 'Good.', cn: '很好。' } }], model: 'Let’s carry on.' },
    { word: 'something else', verdict: 'understandable', sentences: [{ yours: 'I am reluctant.', better: 'I’m reluctant to go.', note: { en: 'Add what.', cn: '补充内容。' } }], model: 'She was reluctant to leave.' },
  ], tip: { en: 'Nice work.', cn: '做得好。' } });
  const { feedback, feedbackText } = Q.parseQuizFeedback(reply, items);
  assert.equal(feedbackText, '');
  assert.deepEqual(feedback.items.map(item => item.verdict), ['natural', 'understandable']);
  assert.equal(feedback.items[1].sentences[0].better, 'I’m reluctant to go.');
  assert.deepEqual(feedback.tip, { en: 'Nice work.', cn: '做得好。' });
});

test('a messy ChatGPT reply with prose, curly quotes and a wrapper is still read', () => {
  const reply = 'Here you go!\n{“feedback”: {“items”: [{“verdict”: “Natural”, “sentences”: [], “model”: “Let’s carry on.”}]}}\nHope it helps.';
  const { feedback } = Q.parseQuizFeedback(reply, items);
  assert.equal(feedback.items[0].verdict, 'natural');
  assert.equal(feedback.items[0].model, 'Let’s carry on.');
  assert.deepEqual(feedback.items[1], { verdict: 'unchecked', sentences: [], model: '' }, 'A missing result is unchecked');
});

test('unknown verdicts, missing notes and extra sentences or results are tidied', () => {
  const sentence = n => ({ yours: `S${n}.`, better: `S${n}!` });
  const reply = JSON.stringify({ items: [
    { verdict: 'great', sentences: [1, 2, 3, 4, 5, 6].map(sentence) }, { verdict: 'WRONG', sentences: [{ note: 'only a note' }] }, { verdict: 'natural' },
  ] });
  const { feedback } = Q.parseQuizFeedback(reply, items);
  assert.equal(feedback.items.length, 2);
  assert.equal(feedback.items[0].verdict, 'unchecked');
  assert.equal(feedback.items[0].sentences.length, 5);
  assert.deepEqual(feedback.items[0].sentences[0].note, { en: '', cn: '' });
  assert.equal(feedback.items[1].verdict, 'wrong');
  assert.deepEqual(feedback.items[1].sentences, [], 'A sentence with no text is dropped');
  assert.deepEqual(feedback.tip, { en: '', cn: '' });
});

test('a reply without usable JSON is kept as text, cut to 30,000 characters', () => {
  assert.deepEqual(Q.parseQuizFeedback('  Great job! All natural.  ', items), { feedback: null, feedbackText: 'Great job! All natural.' });
  assert.equal(Q.parseQuizFeedback('x'.repeat(40000), items).feedbackText.length, Q.MAX_REPLY_CHARS);
});

test('the score counts natural verdicts', () => {
  assert.deepEqual(Q.quizScore({ items: [{ verdict: 'natural' }, { verdict: 'wrong' }, { verdict: 'natural' }] }), { natural: 2, total: 3 });
  assert.equal(Q.quizScore(null), null);
});

test('the local-model schema matches the requested shape', () => {
  assert.deepEqual(Q.FEEDBACK_SCHEMA.required, ['items', 'tip']);
  assert.deepEqual(Q.FEEDBACK_SCHEMA.properties.items.items.properties.verdict.enum, ['natural', 'understandable', 'wrong']);
  assert.equal(Q.FEEDBACK_SCHEMA.properties.items.maxItems, Q.QUIZ_SIZE);
});
