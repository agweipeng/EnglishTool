#!/usr/bin/env node
// Builds word-ranks.js: the words of the app's novels, most frequent first, for the vocabulary test.
//
// Word families count once ("walked", "walking" → "walk", the same way the Reader matches known words), and
// names and function words are left out. A word must appear in at least MIN_BOOKS books, which drops
// characters' names, dialect and one-book oddities (names are mostly caught by the Reader's own check). For each book it also stores how its running words
// spread over the frequency bands, so the shelf can estimate how much of the book a reader knows.
//
// Only public-domain novels are used; the news packages change every day and are left out.
// Run after adding a book:  node scripts/build-word-ranks.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const TextCore = require('../text-core.js');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BAND_SIZE = 1000;
export const MAX_WORDS = 10000;
export const MIN_BOOKS = 2;
const MIN_HEAD_LENGTH = 3;
const LEFT_OUT = new Set(['the-conversation', 'voa-learning-english']);
// French that the novels' characters use (Poirot's "mon ami"); not English words to test
const FOREIGN_WORDS = new Set(('vous nous mon madame monsieur mademoiselle ami mais oui je est les une bien voila cher ' +
  'dieu enfin tout avec moi alors comme mes qui rien').split(' '));
const PER_MILLE = 1000;

// Words with accented letters ("fiancé", "café") would be cut short at the accent, so they are left out
const ACCENTED_WORD = /\p{L}*[^\x00-\x7F\P{L}]\p{L}*/gu;

// Base forms of a key that the Reader treats as the same family (TextCore.familyForms)
const familyForms = key => TextCore.baseForms(key).filter((form, i) => i === 0 || form.length >= MIN_HEAD_LENGTH);

// { key: { count, books: Set } } for the content words of each book, and per book { stop, keys: Map }
function countWords(books) {
  const totals = new Map();
  const perBook = new Map();
  for (const { id, texts } of books) {
    const keys = new Map();
    let stop = 0;
    for (const text of texts) {
      for (const piece of TextCore.analyzeText(text.replace(ACCENTED_WORD, ' '), {}).pieces) {
        if (!piece.isWord || piece.status === 'proper') continue;
        if (piece.status === 'stop') { stop++; continue; }
        keys.set(piece.key, (keys.get(piece.key) || 0) + 1);
      }
    }
    for (const [key, count] of keys) {
      const entry = totals.get(key) || { count: 0, books: new Set() };
      entry.count += count;
      entry.books.add(id);
      totals.set(key, entry);
    }
    perBook.set(id, { stop, keys });
  }
  return { totals, perBook };
}

// Each key's family head. Keys sharing a base form are one family, as in the Reader ("tingled" and "tingling"
// share "tingle" even when "tingle" itself never appears). The head, shown in the test, is the member most of
// the family reduces to ("walk" for walked, walking and walks; "pass", not the rare "pas" that "passed" also
// reduces to), counting how often each word appears; then the shorter, then the more frequent word.
function familyHeads(totals) {
  const parent = new Map([...totals.keys()].map(key => [key, key]));
  const find = key => { while (parent.get(key) !== key) key = parent.get(key); return key; };
  const ownerOfForm = new Map();
  for (const key of totals.keys()) {
    for (const form of familyForms(key)) {
      const owner = ownerOfForm.get(form);
      if (owner === undefined) ownerOfForm.set(form, key);
      else parent.set(find(key), find(owner));
    }
  }
  const families = new Map();
  for (const key of totals.keys()) families.set(find(key), [...(families.get(find(key)) || []), key]);
  const heads = new Map();
  for (const members of families.values()) {
    const score = candidate => members.reduce((sum, key) => sum + (familyForms(key).includes(candidate) ? totals.get(key).count : 0), 0);
    const ranked = members.map(key => ({ key, score: score(key), count: totals.get(key).count }))
      .sort((a, b) => b.score - a.score || a.key.length - b.key.length || b.count - a.count || a.key.localeCompare(b.key));
    members.forEach(key => heads.set(key, ranked[0].key));
  }
  return heads;
}

/**
 * @param {Array<{id: string, texts: string[]}>} books
 * @returns {{ bandSize: number, words: string[], books: Object<string, {stop: number, bands: number[], rare: number}> }}
 *   words most frequent first; per book, per mille of its running words: function words, each band, the rest
 */
export function buildWordRanks(books) {
  const { totals, perBook } = countWords(books);
  const heads = familyHeads(totals);
  const families = new Map();
  for (const [key, { count, books: inBooks }] of totals) {
    const head = heads.get(key);
    const family = families.get(head) || { count: 0, books: new Set() };
    family.count += count;
    inBooks.forEach(id => family.books.add(id));
    families.set(head, family);
  }
  const words = [...families.entries()]
    .filter(([head, family]) => family.books.size >= MIN_BOOKS && head.length >= MIN_HEAD_LENGTH
      && !TextCore.isFunctionWord(head) && !FOREIGN_WORDS.has(head))
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, MAX_WORDS)
    .map(([head]) => head);
  const rank = new Map(words.map((word, i) => [word, i]));
  const bandCount = Math.ceil(words.length / BAND_SIZE);
  const spread = Object.fromEntries([...perBook].map(([id, { stop, keys }]) => {
    const bands = new Array(bandCount).fill(0);
    let rare = 0;
    for (const [key, count] of keys) {
      const at = rank.get(heads.get(key));
      if (at === undefined) rare += count;
      else bands[Math.floor(at / BAND_SIZE)] += count;
    }
    const total = stop + rare + bands.reduce((sum, n) => sum + n, 0);
    const share = n => (total ? Math.round((n / total) * PER_MILLE) : 0);
    return [id, { stop: share(stop), bands: bands.map(share), rare: share(rare) }];
  }));
  return { bandSize: BAND_SIZE, words, books: spread };
}

function readBooks() {
  const catalog = require('../books/catalog.js');
  return catalog.books.filter(book => !LEFT_OUT.has(book.id)).map(book => {
    const manifest = JSON.parse(readFileSync(join(ROOT, book.manifestPath), 'utf8'));
    return { id: book.id, texts: manifest.chapters.map(ch => JSON.parse(readFileSync(join(ROOT, ch.path), 'utf8')).text) };
  });
}

// Runs only as a script, so the tests can import buildWordRanks
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const books = readBooks();
  const ranks = buildWordRanks(books);
  const body = JSON.stringify({ version: 1, ...ranks });
  writeFileSync(join(ROOT, 'word-ranks.js'),
    `// Generated by scripts/build-word-ranks.mjs from ${books.map(b => b.id).join(', ')}. Do not edit.\n` +
    `(function(root){const WordRanks=${body};if(typeof module!=='undefined'&&module.exports)module.exports=WordRanks;else root.WordRanks=WordRanks;})(typeof window!=='undefined'?window:globalThis);\n`);
  console.log(`word-ranks.js: ${ranks.words.length} words in ${Math.ceil(ranks.words.length / BAND_SIZE)} bands from ${books.length} books`);
}
