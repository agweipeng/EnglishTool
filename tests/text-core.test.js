// Unit tests for text-core.js — run with: node --test tests/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const TC = require('../text-core.js');

// ---------- normalizeWords ----------

test('normalizeWords lowercases, drops apostrophes and splits on punctuation', () => {
  assert.deepEqual(TC.normalizeWords('Don’t stop—now!'), ['dont', 'stop', 'now']);
  assert.deepEqual(TC.normalizeWords("Well-known, isn't it?"), ['well', 'known', 'isnt', 'it']);
  assert.deepEqual(TC.normalizeWords(''), []);
});

// ---------- diffWords / scoreDictation ----------

test('diffWords marks matches, misses and additions', () => {
  const diff = TC.diffWords(['the', 'cat', 'sat'], ['the', 'sat', 'down']);
  assert.deepEqual(diff, [
    { word: 'the', kind: 'ok' },
    { word: 'cat', kind: 'miss' },
    { word: 'sat', kind: 'ok' },
    { word: 'down', kind: 'added' },
  ]);
});

test('scoreDictation gives 100 for a perfect answer ignoring case and punctuation', () => {
  const r = TC.scoreDictation('She left, quietly.', 'she left quietly');
  assert.equal(r.accuracy, 100);
  assert.equal(r.isPerfect, true);
});

test('scoreDictation scores a missed word against the target length', () => {
  const r = TC.scoreDictation('I made up my mind', 'I made my mind');
  assert.equal(r.accuracy, 80);
  assert.equal(r.isPerfect, false);
});

test('scoreDictation penalises extra typed words', () => {
  assert.equal(TC.scoreDictation('go home', 'go home now please').accuracy, 50);
});

test('scoreDictation returns 0 for empty input', () => {
  assert.equal(TC.scoreDictation('hello there', '').accuracy, 0);
});

// ---------- baseForms ----------

test('baseForms starts with the token itself', () => {
  assert.equal(TC.baseForms('Walked')[0], 'walked');
});

test('baseForms covers regular inflections', () => {
  const cases = {
    cities: 'city', boxes: 'box', cats: 'cat', walked: 'walk', loved: 'love',
    stopped: 'stop', carried: 'carry', running: 'run', making: 'make',
    walking: 'walk', happier: 'happy', happily: 'happy', quickly: 'quick',
  };
  for (const [form, base] of Object.entries(cases)) {
    assert.ok(TC.baseForms(form).includes(base), `${form} → ${base}`);
  }
});

test('baseForms covers irregular forms, contractions and possessives', () => {
  assert.ok(TC.baseForms('went').includes('go'));
  assert.ok(TC.baseForms('children').includes('child'));
  assert.ok(TC.baseForms("don't").includes('do'));
  assert.ok(TC.baseForms('can’t').includes('can'));
  assert.ok(TC.baseForms("Mary's").includes('mary'));
});

test('baseForms avoids risky stems', () => {
  assert.ok(!TC.baseForms('early').includes('ear'));
  assert.ok(!TC.baseForms('glass').includes('glas'));
  assert.ok(!TC.baseForms('flower').includes('flow'));
});

test('baseForms does not map -eed words to a shorter word', () => {
  assert.ok(!TC.baseForms('seed').includes('see'));
  assert.ok(!TC.baseForms('feed').includes('fee'));
  assert.ok(TC.baseForms('used').includes('use'));
  assert.ok(TC.baseForms('agreed').includes('agree'));
});

test('baseForms tries the silent-e form first after a consonant-vowel-consonant stem', () => {
  const hoping = TC.baseForms('hoping');
  assert.ok(hoping.indexOf('hope') < hoping.indexOf('hop'));
  const walking = TC.baseForms('walking');
  assert.equal(walking[1], 'walk');
  assert.ok(TC.baseForms('hopping').includes('hop'));
});

// ---------- isFunctionWord / isKnownForm ----------

test('isFunctionWord accepts stopwords, contractions and very short words', () => {
  assert.equal(TC.isFunctionWord('The'), true);
  assert.equal(TC.isFunctionWord("didn't"), true);
  assert.equal(TC.isFunctionWord('ox'), true);
  assert.equal(TC.isFunctionWord('lantern'), false);
});

test('isKnownForm matches inflected forms of known words', () => {
  const known = new Set(['walk']);
  assert.equal(TC.isKnownForm('walked', known), true);
  assert.equal(TC.isKnownForm('the', new Set()), true);
  assert.equal(TC.isKnownForm('glimmer', known), false);
});

test('isKnownForm does not treat suffix-stripped stopwords as known', () => {
  // "forest" minus "est" is "for", a stopword; the word itself is still unknown
  assert.equal(TC.isKnownForm('forest', new Set()), false);
});

// ---------- tokenizeText ----------

test('tokenizeText pieces rebuild the original text', () => {
  const text = 'He said, "Don’t go."\nShe stayed.';
  const pieces = TC.tokenizeText(text);
  assert.equal(pieces.map(p => p.text).join(''), text);
  assert.deepEqual(pieces.filter(p => p.isWord).map(p => p.text), ['He', 'said', 'Don’t', 'go', 'She', 'stayed']);
  const go = pieces.find(p => p.text === 'go');
  assert.equal(text.slice(go.start, go.start + 2), 'go');
});

// ---------- splitSentences / sentenceAt ----------

test('sentenceAt returns the sentence containing an offset', () => {
  const text = 'Mr. Darcy smiled. She left!\nThe end';
  assert.equal(TC.sentenceAt(text, text.indexOf('Darcy')), 'Mr. Darcy smiled.');
  assert.equal(TC.sentenceAt(text, text.indexOf('left')), 'She left!');
  assert.equal(TC.sentenceAt(text, text.indexOf('end')), 'The end');
});

test('sentenceAt trims very long sentences to a window around the word', () => {
  const long = `${'word '.repeat(100)}target ${'more '.repeat(100)}`.trim() + '.';
  const s = TC.sentenceAt(long, long.indexOf('target'));
  assert.ok(s.includes('target'));
  assert.ok(s.length < 320);
  assert.ok(s.startsWith('…') && s.endsWith('…'));
});

test('sentenceAt joins hard-wrapped lines but splits on blank lines', () => {
  const text = 'The wind began\nto wail through the trees. It was late.\n\nChapter Two\n\nShe woke.';
  assert.equal(TC.sentenceAt(text, text.indexOf('wail')), 'The wind began to wail through the trees.');
  assert.equal(TC.sentenceAt(text, text.indexOf('Two')), 'Chapter Two');
});

test('sentenceAt adds no leading ellipsis when the window starts at the sentence start', () => {
  const text = `Hi. target ${'word '.repeat(100)}end.`;
  const s = TC.sentenceAt(text, text.indexOf('target'));
  assert.ok(s.startsWith('target'));
  assert.ok(s.endsWith('…'));
});

test('splitSentences covers the whole text', () => {
  const text = 'One. Two? Three';
  const parts = TC.splitSentences(text);
  assert.equal(parts[0].start, 0);
  assert.equal(parts[parts.length - 1].end, text.length);
  assert.equal(parts.length, 3);
});

// ---------- analyzeText ----------

test('analyzeText classifies words and computes coverage', () => {
  const text = 'Then Elizabeth walked to the glimmering lake. Elizabeth smiled.';
  const r = TC.analyzeText(text, { known: new Set(['walk', 'lake', 'smile']), learning: new Set() });
  const status = w => r.pieces.find(p => p.text === w).status;
  assert.equal(status('Elizabeth'), 'proper');
  assert.equal(status('walked'), 'known');
  assert.equal(status('the'), 'stop');
  assert.equal(status('glimmering'), 'unknown');
  // counted: then, walked, to, the, glimmering, lake, smiled = 7; known incl. stopwords = 6
  assert.equal(r.counts.total, 7);
  assert.equal(r.coveragePct, 85.7);
  assert.equal(r.unknownPct, 14.3);
  assert.deepEqual(r.unknown, [{ word: 'glimmering', count: 1 }]);
});

test('analyzeText marks library words as learning', () => {
  const r = TC.analyzeText('The glimmering lake.', { known: new Set(), learning: new Set(['glimmer']) });
  assert.equal(r.pieces.find(p => p.text === 'glimmering').status, 'learning');
  assert.equal(r.counts.learning, 1);
});

test('analyzeText does not treat sentence-initial words as proper nouns', () => {
  const r = TC.analyzeText('The cat sat. Suddenly it ran.', { known: new Set(), learning: new Set() });
  assert.equal(r.pieces.find(p => p.text === 'Suddenly').status, 'unknown');
});

test('analyzeText sorts unknown words by frequency', () => {
  const r = TC.analyzeText('lantern moor lantern', { known: new Set(), learning: new Set() });
  assert.deepEqual(r.unknown.map(u => u.word), ['lantern', 'moor']);
});

test('analyzeText handles empty text', () => {
  const r = TC.analyzeText('', {});
  assert.equal(r.counts.total, 0);
  assert.equal(r.coveragePct, 0);
  assert.deepEqual(r.unknown, []);
});

// ---------- splitAtWord ----------

test('splitAtWord finds inflected and irregular forms of the headword', () => {
  assert.deepEqual(TC.splitAtWord('She wept quietly.', 'weep'), { before: 'She ', match: 'wept', after: ' quietly.' });
  assert.equal(TC.splitAtWord('He carried the box.', 'carry').match, 'carried');
  assert.equal(TC.splitAtWord('Glimmering lights.', 'glimmer').match, 'Glimmering');
  assert.equal(TC.splitAtWord('I was hoping so.', 'hope').match, 'hoping');
});

test('splitAtWord finds phrases, allowing a different possessive', () => {
  assert.equal(TC.splitAtWord('The meeting took place at noon.', 'take place').match, 'took place');
  const r = TC.splitAtWord('Margaret made up her mind.', 'make up my mind');
  assert.deepEqual(r, { before: 'Margaret ', match: 'made up her mind', after: '.' });
});

test('splitAtWord returns null when the word is absent', () => {
  assert.equal(TC.splitAtWord('Nothing here.', 'glimmer'), null);
  assert.equal(TC.splitAtWord('Anything.', ''), null);
});

// ---------- known-word sync (tombstones) ----------

test('applyKnownChange marks fresh words without a log entry', () => {
  const r = TC.applyKnownChange({ known: ['walk'], knownLog: {} }, ['Lake'], true, 't1');
  assert.deepEqual(r.known, ['walk', 'lake']);
  assert.deepEqual(r.knownLog, {});
});

test('applyKnownChange records un-marking and a later re-mark', () => {
  const removed = TC.applyKnownChange({ known: ['walk', 'moor'], knownLog: {} }, ['moor'], false, 't1');
  assert.deepEqual(removed.known, ['walk']);
  assert.deepEqual(removed.knownLog, { moor: { known: false, ts: 't1' } });
  const back = TC.applyKnownChange(removed, ['moor'], true, 't2');
  assert.deepEqual(back.known, ['walk', 'moor']);
  assert.deepEqual(back.knownLog, { moor: { known: true, ts: 't2' } });
});

test('mergeKnown unions lists but honours the newest un-mark', () => {
  const local = { known: ['walk'], knownLog: { moor: { known: false, ts: '2026-10-08T10:00:00Z' } } };
  const remote = { known: ['walk', 'moor', 'lake'], knownLog: {} };
  const merged = TC.mergeKnown(local, remote);
  assert.deepEqual([...merged.known].sort(), ['lake', 'walk']);
  assert.deepEqual(merged.knownLog.moor, { known: false, ts: '2026-10-08T10:00:00Z' });
});

test('mergeKnown lets a newer re-mark beat an older un-mark', () => {
  const local = { known: ['moor'], knownLog: { moor: { known: true, ts: '2026-10-08T11:00:00Z' } } };
  const remote = { known: [], knownLog: { moor: { known: false, ts: '2026-10-08T10:00:00Z' } } };
  const merged = TC.mergeKnown(local, remote);
  assert.deepEqual(merged.known, ['moor']);
  assert.equal(merged.knownLog.moor.known, true);
});

test('mergeKnown tolerates missing or malformed fields', () => {
  const merged = TC.mergeKnown({}, { known: 'oops', knownLog: null });
  assert.deepEqual(merged, { known: [], knownLog: {} });
});

// ---------- word families (one "known" click covers all forms) ----------

test('expandForms adds base forms but drops stems shorter than 3 letters', () => {
  const forms = TC.expandForms(['walked', 'used']);
  assert.ok(forms.has('walked') && forms.has('walk'));
  assert.ok(forms.has('used') && forms.has('use'));
  assert.ok(!forms.has('us'));
});

test('analyzeText treats other forms of a known word as known', () => {
  const r = TC.analyzeText('She was walking. He walks home.', { known: new Set(['walked']), learning: new Set() });
  assert.equal(r.pieces.find(p => p.text === 'walking').status, 'known');
  assert.equal(r.pieces.find(p => p.text === 'walks').status, 'known');
});

test('analyzeText treats other forms of a learning word as learning', () => {
  const r = TC.analyzeText('The light glimmered.', { known: new Set(), learning: new Set(['glimmering']) });
  assert.equal(r.pieces.find(p => p.text === 'glimmered').status, 'learning');
});

test('analyzeText does not let short junk stems join unrelated words', () => {
  // "seed" → stem "se"; "sees" → stem "se" too, but they are different words
  const r = TC.analyzeText('He sees it.', { known: new Set(['seed']), learning: new Set() });
  assert.equal(r.pieces.find(p => p.text === 'sees').status, 'unknown');
});

test('relatedKnownWords finds every stored form of the same word', () => {
  assert.deepEqual(TC.relatedKnownWords('walking', ['walked', 'walk', 'lake']), ['walked', 'walk']);
  assert.deepEqual(TC.relatedKnownWords('sees', ['seed']), []);
});

// ---------- isPhrase ----------

test('isPhrase is true for multi-word entries only', () => {
  assert.equal(TC.isPhrase('make up my mind'), true);
  assert.equal(TC.isPhrase('  ephemeral '), false);
  assert.equal(TC.isPhrase(''), false);
});

// ---------- containsSpokenTarget ----------

test('containsSpokenTarget finds the target inside a spoken sentence', () => {
  assert.equal(TC.containsSpokenTarget('make up my mind', ['I finally made up my mind']), true);
  assert.equal(TC.containsSpokenTarget('ephemeral', ['a femoral', 'ephemeral']), true);
  assert.equal(TC.containsSpokenTarget('ephemeral', ['a femoral']), false);
  assert.equal(TC.containsSpokenTarget('ephemeral', []), false);
  assert.equal(TC.containsSpokenTarget('', ['anything']), false);
  assert.equal(TC.containsSpokenTarget('make up my mind', ['she made up her mind']), true);
});

// ---------- buildRoleplayPrompt ----------

test('buildRoleplayPrompt includes scenario, target words and the END review', () => {
  const p = TC.buildRoleplayPrompt({
    scenario: 'Ordering coffee',
    words: [{ text: 'make up my mind', defCN: '下定决心；决定' }, { text: 'ephemeral', defCN: '' }],
  });
  assert.ok(p.includes('Scenario: Ordering coffee'));
  assert.ok(p.includes('- make up my mind (下定决心)'));
  assert.ok(p.includes('- ephemeral'));
  assert.ok(p.includes('END'));
});

test('buildRoleplayPrompt works without target words', () => {
  const p = TC.buildRoleplayPrompt({ scenario: 'Small talk' });
  assert.ok(p.includes('Scenario: Small talk'));
  assert.ok(!p.includes('\n- '));
});

// Shaped like https://en.wiktionary.org/api/rest_v1/page/definition/woods
const WIKTIONARY_WOODS = {
  en: [
    { partOfSpeech: 'Noun', language: 'English', definitions: [
      { definition: '<span class="form-of-definition use-with-mention"><a href="/wiki/Appendix:Glossary#plural">plural</a> of <span class="form-of-definition-link"><a href="/wiki/wood" title="wood">wood</a></span></span>' },
    ] },
    { partOfSpeech: 'Noun', language: 'English', definitions: [
      { definition: '<span class="usage-label-sense"></span> A dense collection of trees, smaller than a <a href="/wiki/forest" title="forest">forest</a>.',
        examples: ['We walked through the <b>woods</b> &amp; fields.'] },
      { definition: 'A second, rarer sense.' },
    ] },
    { partOfSpeech: 'Verb', language: 'English', definitions: [
      { definition: '<span class="form-of-definition">third-person singular of <a title="wood">wood</a></span>' },
    ] },
  ],
  fr: [{ partOfSpeech: 'Noun', language: 'French', definitions: [{ definition: 'Not English.' }] }],
};

test('parseWiktionary keeps real English definitions as plain text', () => {
  const dict = TC.parseWiktionary(WIKTIONARY_WOODS);
  assert.equal(dict.defEN, 'A dense collection of trees, smaller than a forest.');
  assert.deepEqual(dict.examples, [{ en: 'We walked through the woods & fields.', cn: '' }]);
  assert.equal(dict.phonetic, '');
});

test('parseWiktionary joins the first sense of up to two parts of speech', () => {
  const dict = TC.parseWiktionary({ en: [
    { partOfSpeech: 'Verb', definitions: [{ definition: 'To move <i>swiftly</i>.' }, { definition: 'Ignored.' }] },
    { partOfSpeech: 'Noun', definitions: [{ definition: 'An act of running.' }] },
    { partOfSpeech: 'Adjective', definitions: [{ definition: 'Third part of speech.' }] },
  ] });
  assert.equal(dict.defEN, 'To move swiftly. • An act of running.');
});

test('parseWiktionary returns null when there are only inflection pointers or no English entry', () => {
  const formOnly = { en: [{ partOfSpeech: 'Verb', definitions: [
    { definition: '<span class="form-of-definition">simple past of <a title="glimmer">glimmer</a></span>' },
  ] }] };
  assert.equal(TC.parseWiktionary(formOnly), null);
  assert.equal(TC.parseWiktionary({ fr: [] }), null);
  assert.equal(TC.parseWiktionary(null), null);
  assert.equal(TC.parseWiktionary({ en: 'bad' }), null);
});
