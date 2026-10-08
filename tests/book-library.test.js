'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const catalog = require('../books/catalog.js');
const { create } = require('../book-repository.js');
const { createStore, validateSnapshot } = require('../reader-progress.js');
const resource = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const store = (memory = new Map()) => createStore({ getItem: k => memory.get(k) || null, setItem: (k,v) => memory.set(k,v) });

test('every bundled package preserves all story words and retains the full source license', async () => {
  const { parseBook, hash } = await import('../scripts/book-import-core.mjs');
  const required = { 'wizard-of-oz': 24, 'railway-children': 14, 'secret-garden': 27, 'anne-of-green-gables': 38, 'sherlock-holmes': 12 };
  for (const [id, count] of Object.entries(required)) {
    assert.equal(catalog.books.find(book => book.id === id)?.sectionCount, count);
  }
  assert.ok(catalog.books.every(book => !('text' in book) && !('chapters' in book) && !('introduction' in book)), 'Catalog stays metadata-only as books are added');
  for (const book of catalog.books) {
    const source = fs.readFileSync(path.join(__dirname, '..', book.sourceFile), 'utf8');
    const metadata = resource(`books/${book.id}/metadata.json`);
    const manifest = resource(book.manifestPath);
    const parsed = parseBook(source, metadata);
    assert.deepEqual(manifest, parsed.manifest);
    assert.equal(hash(source), manifest.sourceHash);
    assert.match(source, /THE FULL PROJECT GUTENBERG/);
    const story = source.slice(source.indexOf('\n', source.indexOf('*** START OF')), source.indexOf('*** END OF'));
    const headings = [...story.matchAll(new RegExp(metadata.parser.headingPattern, 'gm'))];
    const body = story.slice(headings[0].index).replace(new RegExp(metadata.parser.headingPattern, 'gm'), '')
      .replace(/^\[Illustration[^\n]*\][ \t]*$/gm, '').replace(/\s+/g, ' ').trim();
    const chapters = manifest.chapters.map(c => resource(c.path));
    // Gutenberg marks italics as _word_; the reader drops the marks but keeps every word.
    const withoutItalics = text => text.replace(/_/g, '');
    assert.equal(withoutItalics(chapters.map(c => c.text).join(' ').replace(/\s+/g, ' ').trim()), withoutItalics(body), book.id);
    assert.ok(chapters.every(c => !/_[^_\s][^_]*_/.test(c.text)), `${book.id}: no italic underscores left`);
    assert.ok(manifest.chapters.every(c => c.title !== c.title.toUpperCase() && !/\.$/.test(c.title)), `${book.id}: tidy titles`);
    assert.deepEqual(chapters, parsed.chapters);
    // File:// compatibility contains exactly the same JSON resources.
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../books/${book.id}/file-data.js`), 'utf8'), { window });
    assert.equal(JSON.stringify(window.BookResources[book.manifestPath]), JSON.stringify(manifest));
    chapters.forEach((chapter, i) => assert.equal(window.BookResources[manifest.chapters[i].path].text, chapter.text));
  }
});

test('loader fetches only the selected manifest and chapter, and shares cached requests', async () => {
  const fetched = [];
  const repository = create({ catalog, loadJSON: async path => { fetched.push(path); return resource(path); } });
  assert.equal(fetched.length, 0);
  const manifest = await repository.getBook('railway-children');
  assert.deepEqual(fetched, ['books/railway-children/manifest.json']);
  const [a,b] = await Promise.all([repository.getChapter(manifest.id, manifest.chapters[4].id), repository.getChapter(manifest.id, manifest.chapters[4].id)]);
  assert.equal(a, b);
  assert.equal(fetched.length, 2);
  await repository.getChapter(manifest.id, manifest.chapters[4].id);
  assert.equal(fetched.length, 2);
});

test('loader rejects bad paths and invalid responses; failures can be retried', async () => {
  const manifest = resource(catalog.books.find(book => book.id === 'wizard-of-oz').manifestPath);
  let fail = true;
  const repository = create({ catalog, loadJSON: async path => {
    if (fail) { fail = false; throw new Error('network failed'); }
    return resource(path);
  } });
  await assert.rejects(repository.getBook(manifest.id));
  assert.equal((await repository.getBook(manifest.id)).id, manifest.id);
  await assert.rejects(repository.getBook('../app.js'));
  await assert.rejects(repository.getChapter(manifest.id, 'missing'));
  const bad = create({ catalog, loadJSON: () => ({ ...manifest, chapters: [{ id: 'bad', path: '../app.js' }] }) });
  await assert.rejects(bad.getBook(manifest.id));
  const corrupt = create({ catalog, loadJSON: p => p.endsWith('manifest.json') ? manifest : { ...resource(p), id: 'wrong' } });
  await assert.rejects(corrupt.getChapter(manifest.id, manifest.chapters[0].id));
});

test('stable chapter IDs survive reordering; legacy indices migrate and removed chapters reset safely', () => {
  const book = resource(catalog.books.find(book => book.id === 'wizard-of-oz').manifestPath);
  const memory = new Map([['englishTrainerBookmarks_v1', JSON.stringify({ [book.id]: { chapterIndex: 4, scrollRatio: .4 } })]]);
  const progress = store(memory);
  const migrated = progress.get(book);
  assert.equal(migrated.chapterId, book.chapters[4].id);
  progress.write(book.id, migrated);
  const reordered = { ...book, chapters: [...book.chapters].reverse() };
  assert.equal(progress.get(reordered).chapterId, book.chapters[4].id);
  assert.equal(progress.get(reordered).chapterIndex, 19);
  const removed = { ...book, chapters: book.chapters.filter(c => c.id !== migrated.chapterId) };
  assert.equal(progress.get(removed).scrollRatio, 0);
  assert.equal(progress.get(removed).chapterIndex, 0);
});

test('progress backup merge preserves newer local bookmarks and accepts unknown future books', () => {
  const a = store(), b = store();
  a.write('future-book', { chapterId: 'chapter-one', scrollRatio: .6, characterOffset: 300, anchor: 'A remembered sentence', updatedAt: '2026-10-08T01:00:00Z' });
  b.merge(JSON.parse(JSON.stringify(a.snapshot())));
  assert.equal(b.bookmarks()['future-book'].anchor, 'A remembered sentence');
  b.write('future-book', { chapterId: 'chapter-two', scrollRatio: .8, updatedAt: '2026-10-08T02:00:00Z' });
  b.merge(a.snapshot());
  assert.equal(b.bookmarks()['future-book'].chapterId, 'chapter-two');
  const before = JSON.stringify(b.snapshot());
  assert.throws(() => b.merge({ version: 2, bookmarks: [], lastBook: {} }));
  assert.equal(JSON.stringify(b.snapshot()), before);
  assert.throws(() => validateSnapshot({ version: 2, bookmarks: { '../bad': {} }, lastBook: {} }));
});

test('importer detects missing sections and duplicate IDs before producing assets', async () => {
  const { parseBook } = await import('../scripts/book-import-core.mjs');
  const metadata = resource('books/railway-children/metadata.json');
  const source = fs.readFileSync(path.join(__dirname, '../books/railway-children/source.txt'), 'utf8');
  assert.throws(() => parseBook(source.replace(/^Chapter II\. [^\n]+/m, 'Missing chapter'), metadata), /Expected|out-of-order/);
  assert.throws(() => parseBook(source, { ...metadata, expectedSections: 15 }), /Expected/);
  assert.throws(() => parseBook(source, { ...metadata, sectionIds: Array(14).fill('same') }), /duplicate/);
  assert.throws(() => parseBook(source, { ...metadata, id: '../escape' }), /metadata/);
  const changedTitle = source.replace('Chapter I. The beginning of things.', 'Chapter I. A new chapter title.');
  assert.equal(parseBook(changedTitle, metadata).chapters[0].id, metadata.sectionIds[0], 'Pinned IDs survive title corrections');
});

test('opening index.html directly loads one selected local package on demand', async () => {
  const loaded = [];
  const window = { BookCatalog: catalog, location: { protocol: 'file:' } };
  const context = vm.createContext({ window, console, document: {
    createElement: () => ({ remove() {} }),
    head: { appendChild: script => {
      loaded.push(script.src);
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', script.src), 'utf8'), context);
      script.onload();
    } },
  } });
  vm.runInContext(fs.readFileSync(require.resolve('../book-repository.js'), 'utf8'), context);
  assert.equal(loaded.length, 0);
  const book = await window.BookRepository.getBook('secret-garden');
  const [first, second] = await Promise.all([
    window.BookRepository.getChapter(book.id, book.chapters[0].id),
    window.BookRepository.getChapter(book.id, book.chapters[1].id),
  ]);
  assert.ok(first.text.length > 100 && second.text.length > 100);
  assert.deepEqual(loaded, ['books/secret-garden/file-data.js']);
});

test('a local package with a missing resource can be repaired and retried without reloading the page', async () => {
  let attempts = 0;
  const window = { BookCatalog: catalog, location: { protocol: 'file:' } };
  const context = vm.createContext({ window, console, document: {
    createElement: () => ({ remove() {} }),
    head: { appendChild: script => {
      if (++attempts > 1) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', script.src), 'utf8'), context);
      script.onload();
    } },
  } });
  vm.runInContext(fs.readFileSync(require.resolve('../book-repository.js'), 'utf8'), context);
  await assert.rejects(window.BookRepository.getBook('secret-garden'));
  assert.equal((await window.BookRepository.getBook('secret-garden')).id, 'secret-garden');
  assert.equal(attempts, 2);
});

test('corrupt manifest fields needed by the reader are rejected before rendering', async () => {
  const manifest = resource(catalog.books.find(book => book.id === 'wizard-of-oz').manifestPath);
  for (const change of [
    { title: null }, { introduction: {} }, { sectionType: 'invalid' },
    { chapters: manifest.chapters.map((c, i) => i ? c : { ...c, wordCount: undefined }) },
    { chapters: manifest.chapters.map((c, i) => i ? c : { ...c, version: undefined }) },
  ]) {
    const repository = create({ catalog, loadJSON: () => ({ ...manifest, ...change }) });
    await assert.rejects(repository.getBook(manifest.id));
  }
});

test('a corrupt local last-book timestamp does not block importing a valid last-book record', () => {
  const memory = new Map([['englishTrainerLastBook_v1', JSON.stringify({ id: 'wizard-of-oz', updatedAt: 'invalid-date' })]]);
  const progress = store(memory);
  progress.merge({ version: 2, bookmarks: {}, lastBook: { id: 'railway-children', updatedAt: '2026-10-08T01:00:00Z' } });
  assert.equal(progress.lastBook().id, 'railway-children');
});

test('a storage failure while merging progress cannot leave only half the backup applied', () => {
  const key = 'englishTrainerBookmarks_v1', lastKey = 'englishTrainerLastBook_v1';
  const memory = new Map([[key, JSON.stringify({ 'wizard-of-oz': { chapterId: 'the-cyclone', chapterIndex: 0, updatedAt: '2026-10-07T00:00:00Z' } })]]);
  const before = memory.get(key);
  const progress = createStore({
    getItem: k => memory.get(k) || null,
    setItem: (k,v) => { if (k === lastKey) throw new Error('Storage is full'); memory.set(k,v); },
    removeItem: k => memory.delete(k),
  });
  assert.throws(() => progress.merge({ version: 2, bookmarks: { 'wizard-of-oz': { chapterId: 'home-again', chapterIndex: 23, updatedAt: '2026-10-08T00:00:00Z' } }, lastBook: { id: 'wizard-of-oz', updatedAt: '2026-10-08T00:00:00Z' } }));
  assert.equal(memory.get(key), before);
});

test('importer drops Gutenberg italic underscores without losing words', async () => {
  const { paragraphs } = await import('../scripts/book-import-core.mjs');
  assert.equal(paragraphs('She is always _the_\nwoman, an _affaire de\ncœur_.\n\n_I_ did.'),
    'She is always the woman, an affaire de cœur.\n\nI did.');
});

test('importer gives section titles consistent title case without a trailing full stop', async () => {
  const { tidyTitle } = await import('../scripts/book-import-core.mjs');
  assert.equal(tidyTitle('A SCANDAL IN BOHEMIA'), 'A Scandal in Bohemia');
  assert.equal(tidyTitle('THE RED-HEADED LEAGUE'), 'The Red-Headed League');
  assert.equal(tidyTitle('THE ADVENTURE OF THE ENGINEER’S THUMB'), 'The Adventure of the Engineer’s Thumb');
  assert.equal(tidyTitle('“I WON’T!” SAID MARY'), '“I Won’t!” Said Mary');
  assert.equal(tidyTitle('“THERE WAS SOMEONE CRYING—THERE WAS!”'), '“There Was Someone Crying—There Was!”');
  assert.equal(tidyTitle('The beginning of things.'), 'The Beginning of Things');
  assert.equal(tidyTitle("Peter's coal-mine."), "Peter's Coal-Mine");
  // Titles that are already tidy stay exactly as they are
  assert.equal(tidyTitle('Mrs. Rachel Lynde Is Surprised'), 'Mrs. Rachel Lynde Is Surprised');
  assert.equal(tidyTitle('How Dorothy Saved the Scarecrow'), 'How Dorothy Saved the Scarecrow');
});
