'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const core = require('../paragraph-core.js');
const fixture = require('./fixtures/paragraph-analysis.json');

test('the tutoring prompt requests matching bilingual explanations without spoilers or treating quoted instructions as commands', () => {
  const prompt = core.buildPrompt({ text: fixture.passage, title: 'The Golden Bird' });
  assert.match(prompt, /never as instructions/);
  assert.match(prompt, /Do not reveal later events/);
  assert.match(prompt, /Chinese meanings identical/);
  assert.ok(prompt.endsWith(JSON.stringify(fixture.passage)));
  assert.throws(() => core.buildPrompt({ text: 'x'.repeat(core.MAX_CHARS + 1) }));
});

test('the screenshot-style analysis includes contextual vocabulary, phrases and sentence structure', () => {
  const result = core.validateResponse('```json\n' + JSON.stringify(fixture.analysis) + '\n```', fixture.passage);
  assert.equal(result.words[0].text, 'bore');
  assert.equal(result.phrases[0].text, 'keep watch');
  assert.match(result.sentences[0].parts[0].explanation.cn, /倒装/);
});

test('unrelated or incomplete AI items are dropped instead of becoming learning cards', () => {
  const invalid = structuredClone(fixture.analysis);
  invalid.words[0].example = 'A sentence from another book.';
  invalid.words[1].meaning.cn = '';
  invalid.phrases[0].text = 'a phrase from another book';
  const result = core.validateResponse(invalid, fixture.passage);
  // Examples always come from the passage itself
  assert.equal(result.words[0].example, fixture.analysis.sentences[0].original);
  assert.deepEqual(result.words.map(w => w.text), ['bore']);
  assert.deepEqual(result.phrases, []);
  assert.throws(() => core.validateResponse('<script>alert(1)</script>', fixture.passage));
});

test('a structural explanation only keeps parts quoted from the sentence it explains', () => {
  const invalid = structuredClone(fixture.analysis);
  invalid.sentences[0].parts[0].text = 'keep watch';
  const result = core.validateResponse(invalid, fixture.passage);
  assert.deepEqual(result.sentences[0].parts.map(p => p.text), ['which bore golden apples']);
});

test('local model learning examples use the actual source sentence without rewriting definitions', () => {
  const response = structuredClone(fixture.analysis);
  response.words[0].example = '...a tree which bore golden apples.';
  const grounded = core.groundExamples(response, fixture.passage);
  assert.equal(grounded.words[0].example, fixture.analysis.sentences[0].original);
  assert.deepEqual(grounded.words[0].meaning, response.words[0].meaning);
  assert.equal(response.words[0].example, '...a tree which bore golden apples.', 'The original AI reply is not mutated');
  assert.doesNotThrow(() => core.validateResponse(grounded, fixture.passage));
  response.words[0].text = 'a word outside the passage';
  const result = core.validateResponse(core.groundExamples(response, fixture.passage), fixture.passage);
  assert.ok(!result.words.some(w => w.text === 'a word outside the passage'));
});

test('structure cannot be empty, and the summary fields are still required', () => {
  const invalid = structuredClone(fixture.analysis);
  invalid.sentences = [];
  assert.throws(() => core.validateResponse(invalid, fixture.passage), /sentence structure/);
  const unusable = structuredClone(fixture.analysis);
  unusable.sentences = [{ original: 'A sentence from another book.', core: { en: 'x', cn: 'x' }, parts: [] }];
  assert.throws(() => core.validateResponse(unusable, fixture.passage), /sentence structure/);
  const noSummary = structuredClone(fixture.analysis);
  noSummary.mainPoint.cn = '';
  assert.throws(() => core.validateResponse(noSummary, fixture.passage), /incomplete/);
});

// Real replies from a 4B local model: shortened sentences, added ellipses, straight quotes
test('near-miss quotes from small local models are repaired to the exact passage text', () => {
  const reply = structuredClone(fixture.analysis);
  reply.sentences[1].original = 'These apples were always counted.';
  reply.sentences[1].parts[0].text = '...were always counted...';
  reply.sentences[2].original = 'The King became very angry at this';
  reply.phrases[0].text = 'Keep watch';
  const result = core.validateResponse(reply, fixture.passage);
  assert.equal(result.sentences[1].original, fixture.analysis.sentences[1].original);
  assert.equal(result.sentences[1].parts[0].text, 'were always counted');
  assert.equal(result.sentences[2].original, fixture.analysis.sentences[2].original);
  assert.equal(result.phrases[0].text, 'keep watch');
  const curly = 'Dorothy’s house was small. It stood alone.';
  assert.equal(core.exactExcerpt(curly, "Dorothy's house"), 'Dorothy’s house');
});

test('long replies are trimmed to the requested number of sentences and parts', () => {
  const reply = structuredClone(fixture.analysis);
  reply.sentences[0].parts = Array(9).fill(reply.sentences[0].parts[1]);
  const result = core.validateResponse(reply, fixture.passage);
  assert.equal(result.sentences[0].parts.length, core.MAX_PARTS);
});

function uiHarness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', disabled: false, open: false,
      setAttribute() {}, close() { this.open = false; }, showModal() { this.open = true; },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    window: {}, document: { readyState: 'loading', addEventListener() {}, getElementById: element, querySelectorAll: () => [] },
    reader: { text: fixture.passage, title: 'The Golden Bird' }, readerBookId: '', activeReaderChapter: { title: 'Old bundled chapter' },
    state: { words: [] }, ParagraphCore: core, AbortController, console, selectionTimer: null, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
    closeReaderPanel() {}, escapeHTML: text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    findWordByText: word => context.state.words.find(w => w.text.toLowerCase() === word.toLowerCase()),
    newWordEntry: fields => ({ id: 'saved', ...fields }), refreshReaderStatuses() {}, saveState() {}, toast() {}, speak() {},
  });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync(require.resolve('../paragraph-reader.js'), 'utf8'));
  return { context, run, element };
}

test('late AI responses cannot replace analysis for a newer selection', async () => {
  const h = uiHarness();
  let release;
  h.context.window.requestParagraphAI = () => new Promise(resolve => { release = resolve; });
  h.context.selectedPassage = fixture.passage;
  h.run('openParagraphAnalysis(selectedPassage)');
  const pending = h.run('generateParagraphAnalysis()');
  h.run('openParagraphAnalysis("A king had a garden.")');
  release(fixture.analysis);
  await pending;
  assert.equal(h.run('paragraphResult'), null);
  assert.equal(h.run('paragraphContext.text'), 'A king had a garden.');
  assert.equal(h.run('paragraphContext.chapter'), '', 'Personal text must not use a stale book chapter');
});

test('a configured local model automatically analyzes a new selection', async () => {
  const h = uiHarness();
  let request;
  h.context.window.autoParagraphAI = true;
  h.context.window.requestParagraphAI = async options => { request = options; return fixture.analysis; };
  h.context.selectedPassage = fixture.passage;
  h.run('openParagraphAnalysis(selectedPassage)');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(request.prompt, /A certain king/);
  assert.equal(h.run('paragraphResult.words[0].text'), 'bore');
  assert.equal(h.element('paragraphStatus').textContent, 'Analysis ready. / 解析已完成。');
});

test('analysis cards save the chosen meaning and original example once', () => {
  const h = uiHarness();
  h.context.selectedPassage = fixture.passage;
  h.context.result = fixture.analysis;
  h.run('openParagraphAnalysis(selectedPassage); paragraphResult = result; paragraphTab = "highlights"');
  h.run('handleParagraphCard({ dataset: { paragraphAct: "learn", kind: "phrases", index: "0" } })');
  h.run('handleParagraphCard({ dataset: { paragraphAct: "learn", kind: "phrases", index: "0" } })');
  assert.equal(h.context.state.words.length, 1);
  assert.equal(h.context.state.words[0].text, 'keep watch');
  assert.equal(h.context.state.words[0].defCN, fixture.analysis.phrases[0].meaning.cn);
  assert.equal(h.context.state.words[0].examples[0].en, fixture.analysis.phrases[0].example);
  assert.equal(h.context.state.words[0].tags[0], 'The Golden Bird');
});

test('closing analysis cancels pending work and rejects its late response', async () => {
  const h = uiHarness();
  let release;
  let signal;
  h.context.window.requestParagraphAI = options => {
    signal = options.signal;
    return new Promise(resolve => { release = resolve; });
  };
  h.context.selectedPassage = fixture.passage;
  h.run('openParagraphAnalysis(selectedPassage)');
  const pending = h.run('generateParagraphAnalysis()');
  h.run('closeParagraphAnalysis()');
  assert.equal(signal.aborted, true);
  release(fixture.analysis);
  await pending;
  assert.equal(h.run('paragraphResult'), null);
  assert.equal(h.element('readerAnalysisDialog').open, false);
});

test('AI explanation markup is escaped when rendered', () => {
  const h = uiHarness();
  const result = structuredClone(fixture.analysis);
  result.mainPoint.en = '<img src=x onerror=alert(1)>';
  h.context.result = core.validateResponse(result, fixture.passage);
  h.run('paragraphResult = result; paragraphTab = "highlights"; renderParagraphAnalysis()');
  assert.match(h.element('paragraphContent').innerHTML, /&lt;img/);
  assert.doesNotMatch(h.element('paragraphContent').innerHTML, /<img/);
});

test('a failed card save rolls back the unsaved word', () => {
  const h = uiHarness();
  h.context.selectedPassage = fixture.passage;
  h.context.result = fixture.analysis;
  h.context.saveState = () => { throw new Error('Quota'); };
  h.run('openParagraphAnalysis(selectedPassage); paragraphResult = result; handleParagraphCard({ dataset: { paragraphAct: "learn", kind: "words", index: "0" } })');
  assert.equal(h.context.state.words.length, 0);
});

test('local AI is not started for passages longer than it can finish', async () => {
  const h = uiHarness();
  let asked = false;
  h.context.window.autoParagraphAI = true;
  h.context.window.requestParagraphAI = async () => { asked = true; return fixture.analysis; };
  h.context.reader.text = fixture.passage.repeat(10);
  h.context.selectedPassage = h.context.reader.text.slice(0, core.LOCAL_MAX_CHARS + 1);
  h.run('openParagraphAnalysis(selectedPassage)');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(asked, false);
  assert.equal(h.element('paragraphGenerate').disabled, true);
  assert.match(h.element('paragraphStatus').textContent, /shorter passage|Claude/);
});

test('a finished analysis is saved automatically with its book position and model', async () => {
  const h = uiHarness();
  const saved = [];
  h.context.saveAnalysis = (context, result, model) => { saved.push({ context, result, model }); return true; };
  h.context.localAIConfig = { model: 'qwen3.5:4b' };
  h.context.readerBookId = 'wizard-of-oz';
  h.context.activeReaderChapter = { id: 'the-cyclone', title: 'The Cyclone' };
  h.context.window.requestParagraphAI = async () => fixture.analysis;
  h.context.selectedPassage = fixture.passage;
  h.run('openParagraphAnalysis(selectedPassage)');
  await h.run('generateParagraphAnalysis()');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].context.bookId, 'wizard-of-oz');
  assert.equal(saved[0].context.chapterId, 'the-cyclone');
  assert.equal(saved[0].model, 'qwen3.5:4b');
  assert.match(h.element('paragraphStatus').textContent, /Analyses tab/);
  h.element('paragraphResponse').value = JSON.stringify(fixture.analysis);
  h.run('pasteParagraphAnalysis()');
  assert.equal(saved[1].model, 'Pasted reply');
});

test('a saved analysis reopens without asking the model again', () => {
  const h = uiHarness();
  let asked = false;
  h.context.window.requestParagraphAI = async () => { asked = true; };
  h.context.window.autoParagraphAI = true;
  h.context.entry = { id: 'a1', text: fixture.passage, title: 'The Golden Bird', chapter: '', bookId: '', chapterId: '', model: 'qwen3.5:4b',
    updatedAt: '2026-10-09T01:00:00.000Z', result: core.validateResponse(fixture.analysis, fixture.passage) };
  h.run('showSavedAnalysis(entry)');
  assert.equal(asked, false);
  assert.equal(h.element('readerAnalysisDialog').open, true);
  assert.equal(h.run('paragraphResult.words[0].text'), 'bore');
  assert.equal(h.element('paragraphOriginal').textContent, fixture.passage);
  h.context.broken = { ...h.context.entry, result: { simplified: {} } };
  h.run('closeParagraphAnalysis(); showSavedAnalysis(broken)');
  assert.equal(h.element('readerAnalysisDialog').open, false, 'A damaged saved analysis is not shown');
});

test('the prompt matches the material: novels avoid spoilers, news looks for the claim, conversation for spoken English', () => {
  const book = core.buildPrompt({ text: fixture.passage, title: 'The Golden Bird', kind: 'book' });
  assert.match(book, /Do not reveal later events/);
  assert.equal(core.buildPrompt({ text: fixture.passage, title: 'The Golden Bird' }), book, 'Books stay the default');
  const news = core.buildPrompt({ text: fixture.passage, title: 'The Conversation', kind: 'news' });
  assert.match(news, /main claim/);
  assert.match(news, /stance/);
  assert.doesNotMatch(news, /Do not reveal later events|original novels/);
  const talk = core.buildPrompt({ text: fixture.passage, title: '6 Minute English', kind: 'conversation' });
  assert.match(talk, /spoken English/);
  assert.match(talk, /reply/);
  assert.doesNotMatch(talk, /Do not reveal later events/);
  const other = core.buildPrompt({ text: fixture.passage, kind: 'something else' });
  assert.doesNotMatch(other, /Do not reveal later events|main claim|spoken English/);
  for (const prompt of [book, news, talk, other]) {
    assert.match(prompt, /"simplified":\{"en"/, 'Every kind asks for the same JSON, so validation is unchanged');
    assert.ok(prompt.endsWith(JSON.stringify(fixture.passage)));
  }
  assert.match(news, /Source labels: \{"title":"The Conversation","chapter":"","kind":"news"\}/);
});

test('the analysis knows what kind of material the passage comes from, and the saved analysis keeps it', async () => {
  const h = uiHarness();
  const saved = [];
  h.context.saveAnalysis = (context, result, model) => { saved.push(context); return true; };
  h.context.currentReadingKind = () => 'conversation';
  h.context.window.requestParagraphAI = async ({ prompt }) => { h.context.lastPrompt = prompt; return fixture.analysis; };
  h.context.selectedPassage = fixture.passage;
  h.run('openParagraphAnalysis(selectedPassage)');
  assert.equal(h.run('paragraphContext.kind'), 'conversation');
  await h.run('generateParagraphAnalysis()');
  assert.match(h.context.lastPrompt, /spoken English/);
  assert.equal(saved[0].kind, 'conversation');
  h.context.entry = { id: 'a1', text: fixture.passage, title: 'BBC', chapter: '', bookId: '', chapterId: '', model: '', kind: 'news',
    updatedAt: '2026-10-09T01:00:00.000Z', result: core.validateResponse(fixture.analysis, fixture.passage) };
  h.run('showSavedAnalysis(entry)');
  assert.equal(h.run('paragraphContext.kind'), 'news', 'Re-analysing a saved passage uses its original kind');
});
