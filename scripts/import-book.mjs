#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseBook } from './book-import-core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOKS = join(ROOT, 'books');
const json = value => JSON.stringify(value, null, 2) + '\n';
export function importBook(sourceFile, metadataFile) {
  const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
  // Validate the complete input before writing any generated assets.
  const { source, manifest, chapters } = parseBook(readFileSync(sourceFile, 'utf8'), metadata);
  const directory = join(BOOKS, metadata.id);
  mkdirSync(join(directory, 'chapters'), { recursive: true });
  writeFileSync(join(directory, 'source.txt'), source);
  writeFileSync(join(directory, 'metadata.json'), json({ ...metadata, sectionIds: chapters.map(c => c.id) }));
  writeFileSync(join(directory, 'manifest.json'), json(manifest));
  const resources = { [`books/${metadata.id}/manifest.json`]: manifest };
  chapters.forEach(chapter => {
    const path = `books/${metadata.id}/chapters/${chapter.id}.json`;
    writeFileSync(join(ROOT, path), json(chapter));
    resources[path] = chapter;
  });
  // Direct file opening cannot fetch JSON. Load this package only when selected.
  writeFileSync(join(directory, 'file-data.js'), `// Generated direct-file fallback; loaded on demand.\n(function(root){Object.assign(root.BookResources||(root.BookResources=Object.create(null)),${JSON.stringify(resources)});})(window);\n`);
  console.log(`${metadata.title}: ${chapters.length} ${metadata.sectionType === 'story' ? 'stories' : 'chapters'}, ${manifest.wordCount.toLocaleString()} words`);
}
export function buildCatalog() {
  const books = readdirSync(BOOKS, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => join(BOOKS, entry.name, 'manifest.json')).filter(existsSync)
    .map(path => JSON.parse(readFileSync(path, 'utf8')))
    .sort((a, b) => (a.readingOrder || 100) - (b.readingOrder || 100) || a.id.localeCompare(b.id))
    .map(({ chapters, introduction, ...metadata }) => ({ ...metadata, sectionCount: chapters.length, manifestPath: `books/${metadata.id}/manifest.json` }));
  const catalog = { schemaVersion: 1, recommendedBookId: books[0]?.id || '', books };
  writeFileSync(join(BOOKS, 'catalog.json'), json(catalog));
  writeFileSync(join(BOOKS, 'catalog.js'), `// Generated metadata only: no book text.\n(function(root){const catalog=${json(catalog)};if(typeof module!=='undefined'&&module.exports)module.exports=catalog;else root.BookCatalog=catalog;})(typeof window!=='undefined'?window:globalThis);\n`);
}
const args = process.argv.slice(2);
if (args.includes('--all')) {
  for (const entry of readdirSync(BOOKS, { withFileTypes: true })) {
    const directory = join(BOOKS, entry.name);
    if (entry.isDirectory() && existsSync(join(directory, 'metadata.json'))) importBook(join(directory, 'source.txt'), join(directory, 'metadata.json'));
  }
  buildCatalog();
} else if (args.includes('--source') && args.includes('--metadata')) {
  importBook(resolve(args[args.indexOf('--source') + 1]), resolve(args[args.indexOf('--metadata') + 1]));
  buildCatalog();
} else {
  throw new Error('Usage: node scripts/import-book.mjs --source book.txt --metadata metadata.json (or --all)');
}
