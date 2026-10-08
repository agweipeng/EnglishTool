import { createHash } from 'node:crypto';

export const hash = text => createHash('sha256').update(text).digest('hex');
export const validId = id => typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
export const wordCount = text => (text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || []).length;
// Joins hard-wrapped lines and drops Gutenberg's _italic_ marks (the words stay).
export function paragraphs(text) {
  return text.replace(/^\[Illustration[^\n]*\][ \t]*$/gm, '').trim()
    .split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ').replace(/_([^_]+)_/g, '$1').trim())
    .filter(Boolean).join('\n\n');
}

// Short words stay lowercase inside a title ("A Scandal in Bohemia")
const SMALL_TITLE_WORDS = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'of', 'on', 'in', 'at', 'to', 'by', 'with', 'from', 'as']);

// Sources mix ALL-CAPS, sentence case and trailing full stops; show them all in title case.
export function tidyTitle(raw) {
  const trimmed = raw.trim().replace(/\.$/, '');
  const base = trimmed === trimmed.toUpperCase() ? trimmed.toLowerCase() : trimmed;
  const words = base.split(/\s+/);
  return words.map((word, i) => {
    const isInner = i > 0 && i < words.length - 1;
    if (isInner && SMALL_TITLE_WORDS.has(word.toLowerCase())) return word.toLowerCase();
    return word.replace(/(^[^\p{L}]*|[-–—])(\p{Ll})/gu, (m, before, letter) => before + letter.toUpperCase());
  }).join(' ');
}
function romanNumber(value) {
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  return [...value].reduce((sum, c, i) => sum + (values[c] < (values[value[i + 1]] || 0) ? -values[c] : values[c]), 0);
}
export function parseBook(rawSource, metadata) {
  if (!metadata || !validId(metadata.id) || typeof metadata.title !== 'string' || !metadata.title.trim()
    || typeof metadata.author !== 'string' || !metadata.author.trim()
    || !['chapter', 'story'].includes(metadata.sectionType)
    || !Number.isInteger(metadata.expectedSections) || metadata.expectedSections < 1
    || !metadata.parser?.headingPattern || !/^https:\/\//.test(metadata.sourceUrl || '') || !metadata.license) {
    throw new Error('Invalid book metadata: check ID, title, author, section type, count, parser, source and license');
  }
  const source = rawSource.replace(/\r\n?/g, '\n');
  const start = /^\*\*\* START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n/m.exec(source);
  const end = /^\*\*\* END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*/m.exec(source);
  if (!start || !end || end.index <= start.index) throw new Error('Missing Gutenberg source boundaries');
  const story = source.slice(start.index + start[0].length, end.index);
  const headings = [...story.matchAll(new RegExp(metadata.parser.headingPattern, 'gm'))];
  if (headings.length !== metadata.expectedSections) {
    throw new Error(`Expected ${metadata.expectedSections} sections; found ${headings.length}`);
  }
  const ids = new Set();
  const chapters = headings.map((heading, index) => {
    const number = /^\d+$/.test(heading[1]) ? Number(heading[1]) : romanNumber(heading[1] || '');
    if (number !== index + 1 || !heading[2]?.trim()) throw new Error(`Missing or out-of-order section ${index + 1}`);
    const title = tidyTitle(heading[2]);
    const id = metadata.sectionIds?.[index] || title.toLowerCase().normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!validId(id) || ids.has(id)) throw new Error(`Invalid or duplicate section ID: ${id}`);
    ids.add(id);
    const text = paragraphs(story.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? story.length));
    if (text.length < 100 || text.length > 200000) throw new Error(`Unexpected section length: ${id}`);
    return { id, number, title, text, wordCount: wordCount(text), version: hash(text).slice(0, 16) };
  });
  let introduction = '';
  if (metadata.parser.introductionPattern) {
    const intro = story.slice(0, headings[0].index).match(new RegExp(metadata.parser.introductionPattern));
    if (!intro?.[1]) throw new Error('Missing author introduction');
    introduction = paragraphs(intro[1]);
  }
  const { parser, expectedSections, sectionIds, ...details } = metadata;
  const manifest = {
    schemaVersion: 1, ...details, version: hash(JSON.stringify(chapters)).slice(0, 16),
    sourceFile: `books/${metadata.id}/source.txt`, sourceHash: hash(source), introduction,
    wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    chapters: chapters.map(({ text, ...chapter }) => ({ ...chapter, path: `books/${metadata.id}/chapters/${chapter.id}.json` })),
  };
  return { source, manifest, chapters };
}
