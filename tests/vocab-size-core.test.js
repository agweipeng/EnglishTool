'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../vocab-size-core.js');
const WordRanks = require('../word-ranks.js');
const catalog = require('../books/catalog.js');

const ROOT = path.join(__dirname, '..');
// 25 words in bands of 10: w0 … w24
const ranks = { bandSize: 10, words: Array.from({ length: 25 }, (_, i) => `w${i}`) };
const seeded = () => { let x = 7; return () => (x = (x * 9301 + 49297) % 233280) / 233280; };
// Answers that tick every real word of the first `knownBands` bands, and `fakeTicks` made-up words in all
const answer = (steps, knownBands, fakeTicks = 0) => steps.map(step => ({
  ...step, ticked: [...(step.band < knownBands ? step.real : []), ...step.fake.slice(0, fakeTicks)],
}));

test('a test has one step per band, with real words from that band and different made-up words', () => {
  const steps = V.planTest(ranks, seeded());
  assert.equal(steps.length, 3);
  steps.forEach(step => {
    assert.ok(step.real.every(word => Number(word.slice(1)) >= step.band * 10 && Number(word.slice(1)) < (step.band + 1) * 10));
    assert.equal(new Set(step.real).size, step.real.length);
  });
  assert.equal(steps[2].real.length, 5, 'The last band is shorter');
  const fakes = steps.flatMap(step => step.fake);
  assert.equal(new Set(fakes).size, fakes.length);
});

test('knowing every word gives the whole list, knowing nothing gives zero', () => {
  const steps = V.planTest(ranks, seeded());
  assert.equal(V.scoreTest(answer(steps, 3), ranks).estimate, 30, 'Rounded to tens: 25 → 30');
  assert.deepEqual(V.scoreTest(answer(steps, 3), ranks).bands, [1, 1, 1]);
  assert.equal(V.scoreTest(answer(steps, 0), ranks).estimate, 0);
});

test('ticking made-up words lowers the estimate, and ticking everything counts as knowing nothing', () => {
  const steps = V.planTest(ranks, seeded());
  // Half the real words of each band ticked: with no made-up word ticked that is half known, with half of
  // them ticked it is no better than guessing
  const half = fakeTicks => steps.map(step => ({ ...step, ticked: [...step.real.slice(0, step.real.length / 2), ...step.fake.slice(0, fakeTicks)] }));
  assert.deepEqual(V.scoreTest(half(0), ranks).bands.slice(0, 2), [0.5, 0.5]);
  const guessing = V.scoreTest(half(1), ranks);
  assert.equal(guessing.falseAlarms, 0.5);
  assert.deepEqual(guessing.bands.slice(0, 2), [0, 0]);
  const everything = steps.map(step => ({ ...step, ticked: [...step.real, ...step.fake] }));
  assert.equal(V.scoreTest(everything, ranks).estimate, 0);
});

test('the test stops once the words become too hard, and untested bands count as unknown', () => {
  const steps = V.planTest(ranks, seeded());
  const answers = answer(steps, 1).slice(0, 2);
  assert.equal(V.isFinished(answers.slice(0, 1), steps), false);
  assert.equal(V.isFinished(answers, steps), true, 'Nothing known in band 2');
  assert.deepEqual(V.scoreTest(answers, ranks).bands, [1, 0, 0]);
});

test('only the well-known leading bands are marked, minus words left unticked and words to skip', () => {
  const result = { bands: [1, 0.9, 0.5], unknown: ['w3'] };
  const words = V.wordsToMark(ranks, result, ['w0', 'w1', 'w2']);
  assert.deepEqual(words, ['w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10', 'w11', 'w12', 'w13', 'w14', 'w15', 'w16', 'w17', 'w18', 'w19']);
  assert.deepEqual(V.wordsToMark(ranks, { bands: [0.6, 1, 1], unknown: [] }), [], 'A weak first band marks nothing');
});

test('a book’s coverage is its function words plus each band times how well it is known', () => {
  assert.equal(V.bookCoverage({ stop: 550, bands: [350, 50, 20], rare: 30 }, [1, 0.5, 0]), 92.5);
  assert.equal(V.bookCoverage(undefined, [1]), null);
});

test('the word list is the app’s novels, most common first, without names or function words', () => {
  assert.ok(WordRanks.words.length > 4000);
  assert.equal(WordRanks.bandSize, 1000);
  assert.equal(new Set(WordRanks.words).size, WordRanks.words.length);
  ['say', 'think', 'look'].forEach(word => assert.ok(WordRanks.words.indexOf(word) < 50, word));
  ['the', 'and', 'dorothy', 'gatsby', 'holmes', 'anne', 'vous', 'mon', 'pas', 'fianc'].forEach(word => assert.ok(!WordRanks.words.includes(word), word));
  ['walk', 'pass'].forEach(word => assert.ok(WordRanks.words.includes(word), `${word} heads its family`));
  assert.ok(WordRanks.words.every(word => /^[a-z]+(?:'[a-z]+)?$/.test(word)));
  Object.values(WordRanks.books).forEach(spread => {
    const total = spread.stop + spread.rare + spread.bands.reduce((sum, n) => sum + n, 0);
    assert.ok(Math.abs(total - 1000) <= 5, `per mille adds up (${total})`);
  });
});

test('no made-up word appears anywhere in the app’s books', () => {
  const text = catalog.books.flatMap(book => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, book.manifestPath), 'utf8'));
    return manifest.chapters.map(ch => JSON.parse(fs.readFileSync(path.join(ROOT, ch.path), 'utf8')).text);
  }).join('\n').toLowerCase();
  V.MADE_UP_WORDS.forEach(word => assert.doesNotMatch(text, new RegExp(`\\b${word}`), word));
  assert.ok(V.MADE_UP_WORDS.length >= Math.ceil(WordRanks.words.length / WordRanks.bandSize) * V.FAKE_PER_STEP);
});

test('word families are counted once and a word must appear in two books', async () => {
  const { buildWordRanks } = await import('../scripts/build-word-ranks.mjs');
  const built = buildWordRanks([
    { id: 'a', texts: ['They walked home. Walking is good. The garden was quiet. Zorbleflax said hello to her fiancé.'] },
    { id: 'b', texts: ['She likes to walk. She walks to the garden every day, and the garden is quiet. Her fiancé came.'] },
  ]);
  assert.ok(built.words.includes('walk'), 'walked, walking and walks are one family, shown as walk');
  assert.ok(!['walked', 'walking', 'walks'].some(word => built.words.includes(word)));
  assert.ok(built.words.includes('garden'));
  assert.ok(!built.words.includes('zorbleflax'), 'Only in one book');
  assert.ok(!built.words.includes('fianc'), 'An accented word is not cut short');
  assert.deepEqual(Object.keys(built.books), ['a', 'b']);
});

test('word-ranks.js is up to date with the builder and the books', async () => {
  const { buildWordRanks } = await import('../scripts/build-word-ranks.mjs');
  const books = catalog.books.filter(book => !['the-conversation', 'voa-learning-english'].includes(book.id)).map(book => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, book.manifestPath), 'utf8'));
    return { id: book.id, texts: manifest.chapters.map(ch => JSON.parse(fs.readFileSync(path.join(ROOT, ch.path), 'utf8')).text) };
  });
  const built = buildWordRanks(books);
  assert.deepEqual(built.words, WordRanks.words, 'Run node scripts/build-word-ranks.mjs');
});
