'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TextCore = require('../text-core.js');
const catalog = require('../books/catalog.js');
const ReaderProgress = require('../reader-progress.js');
const Repository = require('../book-repository.js');
const path = require('node:path');
const readResource = resource => JSON.parse(fs.readFileSync(path.join(__dirname, '..', resource), 'utf8'));
const books = catalog.books.map(b => {
  const manifest = readResource(b.manifestPath);
  return { ...manifest, chapters: manifest.chapters.map(c => readResource(c.path)) };
});
const book = books.find(book => book.id === 'wizard-of-oz');

test('bundled book includes all 24 original chapters without losing story text', async () => {
  const raw = fs.readFileSync(require.resolve('../books/wizard-of-oz/source.txt'), 'utf8').replace(/\r\n?/g, '\n');
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
        setAttribute() {},
        addEventListener(name, handler) { events.set(`${id}:${name}`, handler); },
        getBoundingClientRect: () => ({ top: 700 - browserWindow.scrollY, height: 4000 }),
      });
    }
    return elements.get(id);
  }
  const browserWindow = {
    BookCatalog: catalog, BookRepository: Repository.create({ catalog, loadJSON: readResource }), scrollY: 0, innerHeight: 800, addEventListener() {},
    scrollTo({ top }) { this.scrollY = top; },
  };
  const context = vm.createContext({
    window: browserWindow, location: { search: '' }, TextCore, ReaderProgress,
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

test('opening the reader loads the recommended book and chapter controls', async () => {
  const h = readerHarness();
  await h.run('renderReader()');
  const recommended = books.find(book => book.id === catalog.recommendedBookId);
  assert.equal(h.element('readerInput').value, recommended.chapters[0].text);
  assert.equal(h.element('readerTitle').value, recommended.title);
  assert.equal(h.element('readerPrevChapter').disabled, true);
  assert.equal(h.element('readerNextChapter').disabled, false);
  assert.ok(h.element('readerPassage').innerHTML.length > 100);
  assert.equal(h.element('readerPaste').open, false);
});

test('chapter navigation survives reload and clamps navigation boundaries', async () => {
  const h = readerHarness();
  await h.run('openBookChapter("wizard-of-oz", 23)');
  assert.equal(h.element('readerNextChapter').disabled, true);
  assert.equal(h.element('readerPrevChapter').disabled, false);
  await h.run('openBookChapter("wizard-of-oz", 24)');
  assert.equal(h.element('readerInput').value, book.chapters[23].text);
  const reloaded = readerHarness(h.memory);
  await reloaded.run('renderReader()');
  assert.equal(reloaded.element('readerChapter').value, book.chapters[23].id);
  assert.equal(reloaded.element('readerInput').value, book.chapters[23].text);
});

test('bookmark restores position within the chapter after a reload', async () => {
  const h = readerHarness();
  await h.run('openBookChapter("wizard-of-oz", 2)');
  h.browserWindow.scrollY = 1800;
  h.run('saveBookPosition()');
  const saved = JSON.parse(h.memory.get('englishTrainerBookmarks_v1'))[book.id];
  assert.ok(saved.scrollRatio > 0 && saved.scrollRatio < 1);
  const reloaded = readerHarness(h.memory);
  await reloaded.run('renderReader()');
  assert.equal(reloaded.browserWindow.scrollY, 1800);
  assert.equal(reloaded.element('readerChapter').value, book.chapters[2].id);
});

test('legacy pasted text is preserved and editing a chapter detaches its bookmark', async () => {
  const memory = new Map([['englishTrainerReader_v1', JSON.stringify({ text: 'My own story.', title: 'Personal text' })]]);
  const h = readerHarness(memory);
  await h.run('renderReader()');
  assert.equal(h.element('readerInput').value, 'My own story.');
  assert.equal(h.element('readerTitle').value, 'Personal text');
  assert.equal(h.element('readerPaste').open, true);
  await h.run('openBookChapter("wizard-of-oz", 1)');
  h.element('readerInput').value = 'A different story.';
  h.run('analyzeReaderText()');
  assert.equal(h.run('readerBookId'), '');
  assert.equal(JSON.parse(memory.get('englishTrainerBookmarks_v1'))[book.id].chapterIndex, 1);
});

test('bad bookmark data cannot select a missing chapter or invalid scroll position', async () => {
  const h = readerHarness(new Map([['englishTrainerBookmarks_v1', JSON.stringify({ 'wizard-of-oz': { chapterIndex: 999, scrollRatio: 30 } })]]));
  await h.run('openBookChapter("wizard-of-oz", undefined, true)');
  assert.equal(h.run('bookBookmark(activeReaderBook).chapterIndex'), 23);
  assert.equal(h.run('bookBookmark(activeReaderBook).scrollRatio'), 1);
  h.run('clearReader()');
  h.memory.set('englishTrainerBookmarks_v1', 'invalid JSON');
  await h.run('renderReader()');
  assert.equal(h.element('readerChapter').value, book.chapters[0].id);
});

test('scrolling back up to the chapter controls keeps the reading position', async () => {
  const h = readerHarness();
  await h.run('openBookChapter("wizard-of-oz", 2)');
  h.browserWindow.scrollY = 1800;           // reading inside the chapter
  h.run('saveBookPosition()');
  const reading = JSON.parse(h.memory.get('englishTrainerBookmarks_v1'))[book.id].scrollRatio;
  h.browserWindow.scrollY = 0;              // back at the top: bookshelf, chapter list, paste box
  h.run('saveBookPosition()');
  assert.equal(JSON.parse(h.memory.get('englishTrainerBookmarks_v1'))[book.id].scrollRatio, reading);
});

test('resume and paste actions taken at the top of the page keep the reading position', async () => {
  const h = readerHarness();
  await h.run('openBookChapter("wizard-of-oz", 2)');
  h.browserWindow.scrollY = 1800;
  h.run('saveBookPosition()');
  h.browserWindow.scrollY = 0;
  await h.run('openBookChapter("wizard-of-oz", undefined, true)');   // "Resume reading" pressed at the top
  assert.equal(h.browserWindow.scrollY, 1800);
  h.browserWindow.scrollY = 0;
  h.element('readerInput').value = 'Some pasted text.';
  h.run('analyzeReaderText()');                                // paste box is at the top too
  const reloaded = readerHarness(h.memory);
  await reloaded.run('openBookChapter("wizard-of-oz", undefined, true)');
  assert.equal(reloaded.browserWindow.scrollY, 1800);
});

test('a failing scroll call cannot leave bookmarks permanently disabled', async () => {
  const h = readerHarness();
  h.browserWindow.scrollTo = () => { throw new TypeError('unsupported scroll behavior'); };
  await h.run('openBookChapter("wizard-of-oz", 2, true)');
  assert.equal(h.run('restoringReaderBookmark'), false);
});

test('the end-of-chapter button opens the next chapter and stops at the last one', async () => {
  const h = readerHarness();
  h.run('initReader()');
  await h.run('openBookChapter("wizard-of-oz", 0)');
  assert.match(h.element('readerNextChapterEnd').textContent, /Chapter 2/);
  await h.events.get('readerNextChapterEnd:click')();
  assert.equal(h.element('readerChapter').value, book.chapters[1].id);
  assert.equal(h.browserWindow.scrollY, 0);
  await h.run('openBookChapter("wizard-of-oz", 23)');
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
  await h.run('openBookChapter("wizard-of-oz", 0)');
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
  await h.run('openBookChapter("wizard-of-oz", 0)');
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
  await h.run('openBookChapter("wizard-of-oz", 0)');
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
  await h.run('openBookChapter("wizard-of-oz", 0)');
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

test('looks up every form of a word at once instead of one after another', async () => {
  const h = readerHarness();
  const asked = [];
  // Never resolves: a sequential lookup would only ever ask for the first form
  h.context.fetchDictionary = w => { asked.push(w); return new Promise(() => {}); };
  await h.run('openBookChapter("wizard-of-oz", 0)');
  h.run(`openWordPanel(${pieceIndex(h, 'prairies')})`);
  await settleAll();
  assert.ok(asked.includes('prairies'));
  assert.ok(asked.includes('prairie'));
});

test('clearing the draft retains the book bookmark for resuming later', async () => {
  const h = readerHarness();
  await h.run('openBookChapter("wizard-of-oz", 3)');
  h.run('clearReader()');
  assert.equal(h.element('readerInput').value, '');
  assert.equal(JSON.parse(h.memory.get('englishTrainerBookmarks_v1'))[book.id].chapterIndex, 3);
  await h.run('renderReader()');
  assert.equal(h.element('readerChapter').value, book.chapters[3].id);
});

// ---------- Multiple books and asynchronous navigation ----------
test('A → B → A keeps separate chapters and positions; reload resumes the last book', async () => {
  const h = readerHarness();
  await h.run('openBookChapter("wizard-of-oz", 3)');
  h.browserWindow.scrollY = 1800;
  h.run('saveBookPosition()');
  await h.run('openBookChapter("railway-children", 5)');
  h.browserWindow.scrollY = 1400;
  h.run('saveBookPosition()');
  await h.run('openBookChapter("wizard-of-oz", undefined, true)');
  assert.equal(h.element('readerChapter').value, book.chapters[3].id);
  assert.equal(h.browserWindow.scrollY, 1800);
  await h.run('openBookChapter("railway-children", undefined, true)');
  assert.equal(h.browserWindow.scrollY, 1400);
  const reloaded = readerHarness(h.memory);
  await reloaded.run('renderReader()');
  assert.equal(reloaded.run('readerBookId'), 'railway-children');
  assert.equal(reloaded.run('readerChapterIndex'), 5);
  assert.equal(reloaded.browserWindow.scrollY, 1400);
  const draft = JSON.parse(h.memory.get('englishTrainerReader_v1'));
  assert.equal(draft.text, undefined, 'Bundled chapter text is not duplicated in localStorage');
});

test('a slow chapter response cannot overwrite a newer book selection', async () => {
  const h = readerHarness();
  const real = h.browserWindow.BookRepository;
  let release;
  h.browserWindow.BookRepository = {
    ...real,
    getChapter: async (id, chapter) => {
      if (id === 'wizard-of-oz') await new Promise(resolve => { release = resolve; });
      return real.getChapter(id, chapter);
    },
  };
  const slow = h.run('openBookChapter("wizard-of-oz", 0)');
  await settleAll();
  await h.run('openBookChapter("secret-garden", 2)');
  release();
  await slow;
  assert.equal(h.run('readerBookId'), 'secret-garden');
  assert.equal(h.run('readerChapterIndex'), 2);
  assert.equal(h.element('readerTitle').value, 'The Secret Garden');
});

test('pasting or clearing during a pending book load cancels that load', async () => {
  for (const action of ['paste', 'clear']) {
    const h = readerHarness();
    const real = h.browserWindow.BookRepository;
    let release;
    h.browserWindow.BookRepository = { ...real, getBook: async id => {
      await new Promise(resolve => { release = resolve; });
      return real.getBook(id);
    } };
    const pending = h.run('openBookChapter("anne-of-green-gables", 0)');
    if (action === 'paste') {
      h.element('readerInput').value = 'This is my own passage.';
      h.run('analyzeReaderText()');
    } else h.run('clearReader()');
    release();
    await pending;
    assert.equal(h.run('readerBookId'), '');
    assert.equal(h.element('readerInput').value, action === 'paste' ? 'This is my own passage.' : '');
    assert.equal(h.run('readerLoading'), false);
  }
});

test('failed chapter loading leaves the previous text intact and retry recovers', async () => {
  const h = readerHarness();
  h.run('initReader()');
  await h.run('openBookChapter("wizard-of-oz", 0)');
  const real = h.browserWindow.BookRepository;
  h.browserWindow.BookRepository = { ...real, getChapter: async () => { throw new Error('offline'); } };
  await h.run('openBookChapter("sherlock-holmes", 0)');
  assert.equal(h.element('readerInput').value, book.chapters[0].text);
  assert.match(h.element('readerLoadStatus').textContent, /Could not load/);
  assert.equal(h.element('readerRetryBtn').classList.contains('hidden'), false);
  h.browserWindow.BookRepository = real;
  h.events.get('readerRetryBtn:click')();
  await settleAll();
  assert.equal(h.run('readerBookId'), 'sherlock-holmes');
  assert.match(h.element('readerChapterHeading').textContent, /^Story 1:/);
  assert.equal(h.element('readerBookIntroDetails').classList.contains('hidden'), true);
});

test('JSON progress restored on another device resumes the saved book and chapter', async () => {
  const first = readerHarness();
  await first.run('openBookChapter("anne-of-green-gables", 7)');
  first.browserWindow.scrollY = 1300;
  first.run('saveBookPosition()');
  const second = readerHarness();
  const backup = JSON.parse(JSON.stringify(ReaderProgress.createStore({ getItem: k => first.memory.get(k), setItem() {} }).snapshot()));
  ReaderProgress.createStore({ getItem: k => second.memory.get(k), setItem: (k,v) => second.memory.set(k,v) }).merge(backup);
  await second.run('renderReader()');
  assert.equal(second.run('readerBookId'), 'anne-of-green-gables');
  assert.equal(second.run('readerChapterIndex'), 7);
  assert.equal(second.browserWindow.scrollY, 1300);
});

test('text anchors restore the same word after layout or chapter text changes', async () => {
  const h = readerHarness();
  await h.run('openBookChapter("wizard-of-oz", 0)');
  h.browserWindow.scrollY = 1800;
  const pieces = h.run('reader.analysis.pieces');
  const wordIndex = pieces.findIndex(p => p.text === 'prairies');
  h.context.document.querySelectorAll = () => [{ dataset: { i: wordIndex }, getBoundingClientRect: () => ({ top: 500, bottom: 520 }) }];
  h.run('saveBookPosition()');
  const saved = JSON.parse(h.memory.get('englishTrainerBookmarks_v1'))[book.id];
  assert.equal(saved.characterOffset, pieces[wordIndex].start);
  assert.match(saved.anchor, /^prairies/);
  // Model a different layout: the saved word has a different screen position.
  h.context.document.querySelectorAll = () => [{ dataset: { i: wordIndex }, getBoundingClientRect: () => ({ top: 360, bottom: 380 }) }];
  h.browserWindow.scrollY = 0;
  await h.run('openBookChapter("wizard-of-oz", undefined, true)');
  assert.equal(h.browserWindow.scrollY, 268, 'Scroll to the saved word, not an old percentage');
  // A content revision searches for the excerpt when the old offset no longer matches.
  h.run('activeReaderChapter = { ...activeReaderChapter, version: "new-version" }');
  h.browserWindow.scrollY = 0;
  h.context.anchorBookmark = { ...saved, characterOffset: 99999 };
  h.run('restoreReadingPosition(anchorBookmark, .5)');
  assert.equal(h.browserWindow.scrollY, 268);
});

test('a legacy bundled draft without a bookmark migrates its chapter reference', async () => {
  const h = readerHarness(new Map([['englishTrainerReader_v1', JSON.stringify({ bookId: book.id, chapterIndex: 8, title: book.title, text: book.chapters[8].text })]]));
  await h.run('renderReader()');
  assert.equal(h.element('readerChapter').value, book.chapters[8].id);
  assert.equal(JSON.parse(h.memory.get('englishTrainerBookmarks_v1'))[book.id].chapterId, book.chapters[8].id);
});

function enableReaderURL(h, href) {
  h.context.URL = URL;
  const setLocation = href => {
    const url = new URL(href);
    h.context.location = { href: url.href, search: url.search };
    h.browserWindow.location = h.context.location;
  };
  setLocation(href);
  h.browserWindow.history = { replaceState: (state, title, href) => setLocation(href) };
}

test('switching from a book link updates its URL so reload opens the chosen book', async () => {
  const h = readerHarness();
  enableReaderURL(h, 'http://localhost/?book=wizard-of-oz&theme=light#reader');
  await h.run('renderReader()');
  await h.run('openBookChapter("anne-of-green-gables", 4)');
  const reloaded = readerHarness(h.memory);
  enableReaderURL(reloaded, h.context.location.href);
  await reloaded.run('renderReader()');
  assert.equal(reloaded.run('readerBookId'), 'anne-of-green-gables');
  assert.equal(reloaded.run('readerChapterIndex'), 4);
  assert.equal(new URL(h.context.location.href).searchParams.get('theme'), 'light');
  assert.equal(new URL(h.context.location.href).hash, '#reader');
});

test('pasting from a book URL removes the book route and preserves the draft after reload', async () => {
  const h = readerHarness();
  enableReaderURL(h, 'http://localhost/?book=wizard-of-oz');
  await h.run('renderReader()');
  h.element('readerInput').value = 'This is my personal passage.';
  h.element('readerTitle').value = 'Personal';
  h.run('analyzeReaderText()');
  const reloaded = readerHarness(h.memory);
  enableReaderURL(reloaded, h.context.location.href);
  await reloaded.run('renderReader()');
  assert.equal(reloaded.element('readerInput').value, 'This is my personal passage.');
  assert.equal(reloaded.run('readerBookId'), '');
});

test('a short chapter restores its saved word even when scroll distance is zero', async () => {
  const h = readerHarness();
  await h.run('openBookChapter("wizard-of-oz", 23)');
  h.element('readerPassage').getBoundingClientRect = () => ({ top: 700 - h.browserWindow.scrollY, height: 300 });
  const pieces = h.run('reader.analysis.pieces');
  const wordIndex = pieces.findIndex(p => p.isWord && p.start > 100);
  h.context.document.querySelectorAll = () => [{ dataset: { i: wordIndex }, getBoundingClientRect: () => ({ top: 180, bottom: 200 }) }];
  h.browserWindow.scrollY = 900;
  h.run('saveBookPosition()');
  assert.equal(JSON.parse(h.memory.get('englishTrainerBookmarks_v1'))[book.id].scrollRatio, 0);
  h.browserWindow.scrollY = 0;
  await h.run('openBookChapter("wizard-of-oz", undefined, true)');
  assert.equal(h.browserWindow.scrollY, 88);
});

function installBackupImport(h) {
  h.context.FileReader = class { readAsText(file) { this.result = file; this.onload(); } };
  h.context.confirm = () => true;
  h.context.saveState = () => {};
  h.context.renderLibrary = () => {};
  h.context.state.activity = {};
  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  h.run(app.slice(app.indexOf('function exportJSON()'), app.indexOf('// ============ Settings ============')));
}
function futureProgress(bookId, chapterIndex) {
  const book = books.find(b => b.id === bookId);
  return { version: 2, bookmarks: { [bookId]: { chapterId: book.chapters[chapterIndex].id, chapterIndex, scrollRatio: .4, updatedAt: '2099-01-01T00:00:00Z' } }, lastBook: { id: bookId, updatedAt: '2099-01-01T00:00:00Z' } };
}

test('backup import on an existing reader resumes restored progress without saving the stale passage over it', async () => {
  for (const restoredBook of ['wizard-of-oz', 'anne-of-green-gables']) {
    const h = readerHarness();
    enableReaderURL(h, 'http://localhost/?book=wizard-of-oz');
    await h.run('renderReader()');
    h.browserWindow.scrollY = 1800;
    installBackupImport(h);
    h.context.backupFile = JSON.stringify({ words: [], readingProgress: futureProgress(restoredBook, 3) });
    h.run('importJSON(backupFile)');
    await h.run('renderReader()');
    assert.equal(h.run('readerBookId'), restoredBook);
    assert.equal(h.run('readerChapterIndex'), 3);
    assert.equal(JSON.parse(h.memory.get('englishTrainerBookmarks_v1'))[restoredBook].chapterIndex, 3);
  }
});

test('backup import cancels an older book request instead of letting it replace restored progress', async () => {
  const h = readerHarness();
  await h.run('openBookChapter("wizard-of-oz", 0)');
  const real = h.browserWindow.BookRepository;
  let release;
  h.browserWindow.BookRepository = { ...real, getChapter: async (id, chapter) => {
    if (id === 'secret-garden') await new Promise(resolve => { release = resolve; });
    return real.getChapter(id, chapter);
  } };
  const pending = h.run('openBookChapter("secret-garden", 0)');
  await settleAll();
  installBackupImport(h);
  h.context.backupFile = JSON.stringify({ words: [], readingProgress: futureProgress('anne-of-green-gables', 3) });
  h.run('importJSON(backupFile)');
  release();
  await pending;
  await h.run('renderReader()');
  assert.equal(h.run('readerBookId'), 'anne-of-green-gables');
  assert.equal(h.run('readerChapterIndex'), 3);
});

test('Resume falls back to an available book when a backup references a future or removed title', async () => {
  const memory = new Map([['englishTrainerLastBook_v1', JSON.stringify({ id: 'future-book', updatedAt: '2026-10-08T00:00:00Z' })]]);
  const h = readerHarness(memory);
  h.run('initReader()');
  await h.events.get('readerResumeBtn:click')();
  assert.equal(h.run('readerBookId'), catalog.recommendedBookId);
});

test('a chapter that finishes loading after leaving the reader does not scroll the other view', async () => {
  const h = readerHarness();
  const frames = [];
  h.context.requestAnimationFrame = fn => frames.push(fn);
  await h.run('openBookChapter("wizard-of-oz", 0)');
  h.element('view-reader').classList.remove('active');
  h.browserWindow.scrollY = 250;
  frames.forEach(fn => fn());
  assert.equal(h.browserWindow.scrollY, 250);
  assert.equal(h.run('restoringReaderBookmark'), false);
});

test('backup import keeps a personal pasted passage while restoring bookmarks', async () => {
  const h = readerHarness();
  h.element('readerInput').value = 'Keep my private pasted text.';
  h.run('analyzeReaderText()');
  installBackupImport(h);
  h.context.backupFile = JSON.stringify({ words: [], readingProgress: futureProgress('anne-of-green-gables', 3) });
  h.run('importJSON(backupFile)');
  await h.run('renderReader()');
  assert.equal(h.element('readerInput').value, 'Keep my private pasted text.');
  assert.equal(h.run('readerBookId'), '');
});

test('invalid legacy draft indices fall back within the available chapters', async () => {
  const h = readerHarness(new Map([['englishTrainerReader_v1', JSON.stringify({ bookId: book.id, chapterIndex: 999 })]]));
  await h.run('renderReader()');
  assert.equal(h.run('readerBookId'), 'wizard-of-oz');
  assert.equal(h.run('readerChapterIndex'), 23);
  assert.equal(h.element('readerRetryBtn').classList.contains('hidden'), true);
});

test('the book link is only kept in the address while the Reader tab is open', async () => {
  const h = readerHarness();
  enableReaderURL(h, 'http://localhost/?book=wizard-of-oz&theme=light');
  await h.run('renderReader()');
  const param = name => new URL(h.context.location.href).searchParams.get(name);
  h.element('view-reader').classList.remove('active');
  h.run('syncReaderURL()');
  assert.equal(param('book'), null, 'reloading on another tab must stay on that tab');
  assert.equal(param('theme'), 'light');
  h.element('view-reader').classList.add('active');
  h.run('syncReaderURL()');
  assert.equal(param('book'), 'wizard-of-oz');
});

test('a chapter that finishes loading on another tab does not add the book link', async () => {
  const h = readerHarness();
  enableReaderURL(h, 'http://localhost/');
  h.element('view-reader').classList.remove('active');
  await h.run('openBookChapter("sherlock-holmes", 0)');
  assert.equal(new URL(h.context.location.href).searchParams.get('book'), null);
});

function readingSelection(h, text, prefix = '', endInside = true) {
  const start = { inside: true }, end = { inside: endInside };
  h.element('readerPassage').contains = node => node.inside;
  h.browserWindow.getSelection = () => ({ isCollapsed: false, rangeCount: 1, anchorNode: end,
    toString: () => text, getRangeAt: () => ({ startContainer: start, startOffset: 0, endContainer: end }) });
  h.context.document.createRange = () => ({ selectNodeContents() {}, setEnd() {}, toString: () => prefix });
}

test('paragraph selections are recognized and short phrases still use the phrase panel', async () => {
  const h = readerHarness();
  await h.run('openBookChapter("wizard-of-oz", 0)');
  readingSelection(h, book.chapters[0].text.split('\n\n')[0]);
  assert.equal(h.run('selectedReadingText().kind'), 'paragraph');
  readingSelection(h, 'great Kansas prairies', 'Dorothy lived in the midst of the ');
  assert.equal(h.run('selectedPhrase().phrase'), 'great Kansas prairies');
  assert.equal(h.run('selectedPhrase().offset'), 'Dorothy lived in the midst of the '.length);
  readingSelection(h, 'A king had a garden.');
  assert.equal(h.run('selectedReadingText().kind'), 'paragraph');
});

test('a selection reaching outside the passage is rejected', async () => {
  const h = readerHarness();
  await h.run('openBookChapter("wizard-of-oz", 0)');
  readingSelection(h, 'A selected paragraph crossing into the sidebar.', '', false);
  assert.equal(h.run('selectedReadingText()'), null);
});

test('short selections with an abbreviation or a name stay phrases instead of starting AI analysis', async () => {
  const h = readerHarness();
  await h.run('openBookChapter("wizard-of-oz", 0)');
  for (const text of ['Aunt Em.', 'Mrs. Rachel', 'Mrs. Rachel Lynde lived', 'Oh, no!']) {
    readingSelection(h, text);
    assert.equal(h.run('selectedReadingText().kind'), 'phrase', text);
  }
  readingSelection(h, 'Toto was not gray. He was a little black dog.');
  assert.equal(h.run('selectedReadingText().kind'), 'paragraph');
});
