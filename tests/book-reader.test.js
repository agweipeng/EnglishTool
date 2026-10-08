'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TextCore = require('../text-core.js');
const books = require('../books/library.js');
const book = books[0];

test('bundled book includes all 24 original chapters without losing story text', () => {
  const raw = fs.readFileSync(require.resolve('../books/wizard-of-oz-source.txt'), 'utf8').replace(/\r\n?/g, '\n');
  const story = raw.slice(raw.indexOf('\nChapter I\n'), raw.indexOf('*** END OF THE PROJECT GUTENBERG EBOOK'));
  const original = story.replace(/^Chapter [IVXLCDM]+\n[^\n]+\n/gm, '')
    .replace(/^\[Illustration[^\n]*\]\s*$/gm, '').replace(/\s+/g, ' ').trim();
  assert.equal(book.chapters.length, 24);
  assert.equal(book.chapters.map(c => c.text).join(' ').replace(/\s+/g, ' ').trim(), original);
  assert.equal(book.chapters[0].title, 'The Cyclone');
  assert.equal(book.chapters[23].title, 'Home Again');
  assert.match(book.introduction, /Chicago, April, 1900/);
  assert.ok(raw.includes('START: FULL LICENSE'), 'Retain the complete Gutenberg license');
});

function readerHarness(memory = new Map()) {
  const elements = new Map();
  const events = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(id === 'view-reader' ? ['active'] : []);
      elements.set(id, {
        value: '', innerHTML: '', textContent: '', disabled: false, open: false,
        classList: {
          add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
          toggle(c, force) { if (force) classes.add(c); else classes.delete(c); },
        },
        addEventListener(name, handler) { events.set(`${id}:${name}`, handler); },
        getBoundingClientRect: () => ({ top: 700 - browserWindow.scrollY, height: 4000 }),
      });
    }
    return elements.get(id);
  }
  const browserWindow = {
    BookLibrary: books, scrollY: 0, innerHeight: 800, addEventListener() {},
    scrollTo({ top }) { this.scrollY = top; },
  };
  const context = vm.createContext({
    window: browserWindow, location: { search: '' }, TextCore,
    state: { words: [], known: [] }, knownWordSet: () => new Set(), learningWordSet: () => new Set(),
    document: {
      readyState: 'loading', addEventListener() {}, getElementById: element, querySelectorAll: () => [],
      querySelector: () => ({ getBoundingClientRect: () => ({ height: 80 }) }),
    },
    localStorage: {
      getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value),
    },
    escapeHTML: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    toast() {}, console, URLSearchParams,
    requestAnimationFrame: fn => fn(), setTimeout: () => 1, clearTimeout() {},
  });
  vm.runInContext(fs.readFileSync(require.resolve('../reader.js'), 'utf8'), context);
  return { run: code => vm.runInContext(code, context), element, browserWindow, memory, events, context };
}

test('opening the reader loads the recommended book and chapter controls', () => {
  const h = readerHarness();
  h.run('renderReader()');
  assert.equal(h.element('readerInput').value, book.chapters[0].text);
  assert.equal(h.element('readerTitle').value, book.title);
  assert.equal(h.element('readerPrevChapter').disabled, true);
  assert.equal(h.element('readerNextChapter').disabled, false);
  assert.match(h.element('readerPassage').innerHTML, /Dorothy/);
  assert.equal(h.element('readerPaste').open, false);
});

test('chapter navigation survives reload and clamps navigation boundaries', () => {
  const h = readerHarness();
  h.run('openBookChapter("wizard-of-oz", 23)');
  assert.equal(h.element('readerNextChapter').disabled, true);
  assert.equal(h.element('readerPrevChapter').disabled, false);
  h.run('openBookChapter("wizard-of-oz", 24)');
  assert.equal(h.element('readerInput').value, book.chapters[23].text);
  const reloaded = readerHarness(h.memory);
  reloaded.run('renderReader()');
  assert.equal(reloaded.element('readerChapter').value, '23');
  assert.equal(reloaded.element('readerInput').value, book.chapters[23].text);
});

test('bookmark restores position within the chapter after a reload', () => {
  const h = readerHarness();
  h.run('openBookChapter("wizard-of-oz", 2)');
  h.browserWindow.scrollY = 1800;
  h.run('saveBookPosition()');
  const saved = JSON.parse(h.memory.get('englishTrainerBookmarks_v1'))[book.id];
  assert.ok(saved.scrollRatio > 0 && saved.scrollRatio < 1);
  const reloaded = readerHarness(h.memory);
  reloaded.run('renderReader()');
  assert.equal(reloaded.browserWindow.scrollY, 1800);
  assert.equal(reloaded.element('readerChapter').value, '2');
});

test('legacy pasted text is preserved and editing a chapter detaches its bookmark', () => {
  const memory = new Map([['englishTrainerReader_v1', JSON.stringify({ text: 'My own story.', title: 'Personal text' })]]);
  const h = readerHarness(memory);
  h.run('renderReader()');
  assert.equal(h.element('readerInput').value, 'My own story.');
  assert.equal(h.element('readerTitle').value, 'Personal text');
  assert.equal(h.element('readerPaste').open, true);
  h.run('openBookChapter("wizard-of-oz", 1)');
  h.element('readerInput').value = 'A different story.';
  h.run('analyzeReaderText()');
  assert.equal(h.run('readerBookId'), '');
  assert.equal(JSON.parse(memory.get('englishTrainerBookmarks_v1'))[book.id].chapterIndex, 1);
});

test('bad bookmark data cannot select a missing chapter or invalid scroll position', () => {
  const h = readerHarness(new Map([['englishTrainerBookmarks_v1', JSON.stringify({ 'wizard-of-oz': { chapterIndex: 999, scrollRatio: 30 } })]]));
  assert.equal(h.run('bookBookmark(readerBooks()[0]).chapterIndex'), 23);
  assert.equal(h.run('bookBookmark(readerBooks()[0]).scrollRatio'), 1);
  h.memory.set('englishTrainerBookmarks_v1', 'invalid JSON');
  h.run('renderReader()');
  assert.equal(h.element('readerChapter').value, '0');
});

test('scrolling back up to the chapter controls keeps the reading position', () => {
  const h = readerHarness();
  h.run('openBookChapter("wizard-of-oz", 2)');
  h.browserWindow.scrollY = 1800;           // reading inside the chapter
  h.run('saveBookPosition()');
  const reading = JSON.parse(h.memory.get('englishTrainerBookmarks_v1'))[book.id].scrollRatio;
  h.browserWindow.scrollY = 0;              // back at the top: bookshelf, chapter list, paste box
  h.run('saveBookPosition()');
  assert.equal(JSON.parse(h.memory.get('englishTrainerBookmarks_v1'))[book.id].scrollRatio, reading);
});

test('resume and paste actions taken at the top of the page keep the reading position', () => {
  const h = readerHarness();
  h.run('openBookChapter("wizard-of-oz", 2)');
  h.browserWindow.scrollY = 1800;
  h.run('saveBookPosition()');
  h.browserWindow.scrollY = 0;
  h.run('openBookChapter("wizard-of-oz", undefined, true)');   // "Resume reading" pressed at the top
  assert.equal(h.browserWindow.scrollY, 1800);
  h.browserWindow.scrollY = 0;
  h.element('readerInput').value = 'Some pasted text.';
  h.run('analyzeReaderText()');                                // paste box is at the top too
  const reloaded = readerHarness(h.memory);
  reloaded.run('openBookChapter("wizard-of-oz", undefined, true)');
  assert.equal(reloaded.browserWindow.scrollY, 1800);
});

test('a failing scroll call cannot leave bookmarks permanently disabled', () => {
  const h = readerHarness();
  h.browserWindow.scrollTo = () => { throw new TypeError('unsupported scroll behavior'); };
  assert.doesNotThrow(() => h.run('openBookChapter("wizard-of-oz", 2, true)'));
  assert.equal(h.run('restoringReaderBookmark'), false);
});

test('the end-of-chapter button opens the next chapter and stops at the last one', () => {
  const h = readerHarness();
  h.run('initReader(); openBookChapter("wizard-of-oz", 0)');
  assert.match(h.element('readerNextChapterEnd').textContent, /Chapter 2/);
  h.events.get('readerNextChapterEnd:click')();
  assert.equal(h.element('readerChapter').value, '1');
  assert.equal(h.browserWindow.scrollY, 0);
  h.run('openBookChapter("wizard-of-oz", 23)');
  assert.equal(h.element('readerNextChapterEnd').disabled, true);
  assert.match(h.element('readerNextChapterEnd').textContent, /finished/i);
});

// ---------- word panel: English definitions ----------

const settle = () => new Promise(r => setImmediate(r));
async function settleAll() { for (let i = 0; i < 6; i++) await settle(); }
function pieceIndex(h, word) {
  return h.run(`reader.analysis.pieces.findIndex(p => p.text === ${JSON.stringify(word)})`);
}

test('clicking an unknown word shows its English definition from the dictionary', async () => {
  const h = readerHarness();
  const asked = [];
  h.context.fetchDictionary = async w => {
    asked.push(w);
    return w === 'prairie' ? { phonetic: '/ˈprɛəri/', defEN: 'A large open area of grassland.', examples: [] } : null;
  };
  h.run('openBookChapter("wizard-of-oz", 0)');
  h.run(`openWordPanel(${pieceIndex(h, 'prairies')})`);
  assert.match(h.element('readerPanel').innerHTML, /Looking up/);
  await settleAll();
  const html = h.element('readerPanel').innerHTML;
  assert.match(html, /A large open area of grassland\./);
  assert.match(html, /prairie/);
  assert.match(html, /ˈprɛəri/);
  // The lookup is cached: opening the same word again does not fetch again
  const fetches = asked.length;
  h.run(`openWordPanel(${pieceIndex(h, 'prairies')})`);
  await settleAll();
  assert.equal(asked.length, fetches);
});

test('a word in the library shows its saved English and Chinese meanings without a lookup', async () => {
  const h = readerHarness();
  let fetched = false;
  h.context.fetchDictionary = async () => { fetched = true; return null; };
  h.context.state.words = [{ text: 'prairie', defEN: 'Open grassland.', defCN: '大草原', level: 1 }];
  h.run('openBookChapter("wizard-of-oz", 0)');
  h.run(`openWordPanel(${pieceIndex(h, 'prairies')})`);
  await settleAll();
  const html = h.element('readerPanel').innerHTML;
  assert.match(html, /Open grassland\./);
  assert.match(html, /大草原/);
  assert.equal(fetched, false);
});

test('a missing dictionary entry shows a clear message', async () => {
  const h = readerHarness();
  h.context.fetchDictionary = async () => null;
  h.run('openBookChapter("wizard-of-oz", 0)');
  h.run(`openWordPanel(${pieceIndex(h, 'prairies')})`);
  await settleAll();
  assert.match(h.element('readerPanel').innerHTML, /No dictionary entry/);
});

test('a slow lookup never overwrites a newer panel or reopens a closed one', async () => {
  const h = readerHarness();
  let release;
  h.context.fetchDictionary = w => (w.startsWith('prair')
    ? new Promise(r => { release = () => r({ phonetic: '', defEN: 'STALE DEFINITION', examples: [] }); })
    : Promise.resolve({ phonetic: '', defEN: 'Fresh definition.', examples: [] }));
  h.run('openBookChapter("wizard-of-oz", 0)');
  h.run(`openWordPanel(${pieceIndex(h, 'prairies')})`);
  h.run(`openWordPanel(${pieceIndex(h, 'Kansas')})`);
  await settleAll();
  release();
  await settleAll();
  assert.doesNotMatch(h.element('readerPanel').innerHTML, /STALE DEFINITION/);
  h.run(`openWordPanel(${pieceIndex(h, 'prairies')}); closeReaderPanel()`);
  await settleAll();
  assert.equal(h.element('readerPanel').classList.contains('hidden'), true);
});

test('clearing the draft retains the book bookmark for resuming later', () => {
  const h = readerHarness();
  h.run('openBookChapter("wizard-of-oz", 3); clearReader()');
  assert.equal(h.element('readerInput').value, '');
  assert.equal(JSON.parse(h.memory.get('englishTrainerBookmarks_v1'))[book.id].chapterIndex, 3);
  h.run('renderReader()');
  assert.equal(h.element('readerChapter').value, '3');
});
