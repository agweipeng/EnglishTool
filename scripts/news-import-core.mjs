/* Turns news feeds and article pages into Reader packages (same shape as a book, one article per section).
   Pure functions only: scripts/import-news.mjs does the network and file work. */
import { hash, validId, wordCount } from './book-import-core.mjs';

// Shorter items are podcast notes, photo or video pages. VOA writes shorter, simpler articles.
export const CONVERSATION_MIN_WORDS = 400;
export const VOA_MIN_WORDS = 300;
const MAX_ID_LENGTH = 80;
const MAX_ARTICLE_CHARS = 200000;
const PLAYER_NOTICE = 'No media source currently available';
// Images, captions, players and tables don't read as running text
const REMOVED_ELEMENTS = /<(script|style|figure|table|aside|noscript|iframe|audio|video|form)\b[\s\S]*?<\/\1>/gi;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', middot: '·', bull: '•',
  shy: '', deg: '°', times: '×', pound: '£', euro: '€', copy: '©', reg: '®', trade: '™',
  aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä', ccedil: 'ç', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  iacute: 'í', iuml: 'ï', ntilde: 'ñ', oacute: 'ó', ocirc: 'ô', ouml: 'ö', uacute: 'ú', uuml: 'ü', szlig: 'ß' };
// The Conversation: tables and sidebars are article content we can't show, so such articles are skipped
// rather than republished incompletely (CC BY-ND). Podcast show notes aren't articles.
const INCOMPLETE_CONTENT = /<(table|aside)\b/i;
const PODCAST_NOTES = /The Conversation Weekly/;

export function decodeEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] !== '#') return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

const cleanText = text => decodeEntities(String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ''))
  .replace(/\s+/g, ' ').trim();
const firstMatch = (text, pattern) => pattern.exec(text)?.[1] ?? '';

// Paragraphs, headings, list items and quotes, in order, as plain text
export function htmlToParagraphs(html) {
  const cleaned = String(html || '').replace(REMOVED_ELEMENTS, ' ');
  return [...cleaned.matchAll(/<(p|h[1-6]|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    // Nested paragraphs (e.g. inside a quote) must not run together
    .map(match => cleanText(match[2].replace(/<br\s*\/?>|<\/(p|li|div|h[1-6])>/gi, ' ')))
    .filter(text => text && text !== PLAYER_NOTICE);
}

// "https://site/a/some-title/4113426.html" → "some-title-4113426", kept short and safe for file names
export function articleId(url) {
  const parts = new URL(url).pathname.split('/').filter(part => part && part !== 'a').map(part => part.replace(/\.html?$/, ''));
  const slug = parts.join('-').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (slug.length <= MAX_ID_LENGTH) return slug;
  const number = /-(\d+)$/.exec(slug)?.[1] || '';
  const head = slug.slice(0, MAX_ID_LENGTH - (number ? number.length + 1 : 0)).replace(/-+$/, '');
  return number ? `${head}-${number}` : head;
}

const isLongEnough = (article, minWords) => wordCount(article.text) >= minWords;
// Also applied to articles kept from earlier runs, so rule changes reach them too
export const isConversationArticle = article => isLongEnough(article, CONVERSATION_MIN_WORDS) && !PODCAST_NOTES.test(article.text);

// <link rel="alternate" href="…"/>, whatever the attribute order
function alternateLink(entry) {
  const tag = [...entry.matchAll(/<link\b[^>]*>/g)].map(match => match[0]).find(link => /\brel="alternate"/.test(link));
  return decodeEntities(firstMatch(tag || '', /\bhref="([^"]+)"/));
}

// The Conversation's Atom feed carries each full article as escaped HTML.
// A broken or unsuitable entry is skipped so it can't stop the rest of the day's news.
export function parseConversationFeed(xml) {
  return [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].flatMap(([, entry]) => {
    const url = alternateLink(entry);
    const title = cleanText(firstMatch(entry, /<title[^>]*>([\s\S]*?)<\/title>/));
    const html = decodeEntities(firstMatch(entry, /<content[^>]*>([\s\S]*?)<\/content>/));
    if (!/^https:\/\//.test(url) || !title || INCOMPLETE_CONTENT.test(html)) return [];
    const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map(match => cleanText(match[1]));
    const article = { id: articleId(url), title, author: authors.join('; '),
      published: cleanText(firstMatch(entry, /<published>([\s\S]*?)<\/published>/)), url, text: htmlToParagraphs(html).join('\n\n') };
    return validId(article.id) && isConversationArticle(article) ? [article] : [];
  });
}

// VOA RSS items only link to the article pages
export function parseRssItems(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const date = new Date(cleanText(firstMatch(item, /<pubDate>([\s\S]*?)<\/pubDate>/)));
    return { title: cleanText(firstMatch(item, /<title>([\s\S]*?)<\/title>/)), url: cleanText(firstMatch(item, /<link>([\s\S]*?)<\/link>/)),
      published: Number.isNaN(date.getTime()) ? '' : date.toISOString() };
  }).filter(item => item.title && item.url && item.published);
}

// Removes every <div> that starts with `openTag`, including the divs nested inside it
function removeDivBlocks(html, openTag) {
  let result = html;
  for (let start = result.indexOf(openTag); start >= 0; start = result.indexOf(openTag)) {
    const tags = /<\/?div\b[^>]*>/gi;
    tags.lastIndex = start;
    let depth = 0;
    let end = result.length;
    for (let tag = tags.exec(result); tag; tag = tags.exec(result)) {
      depth += tag[0][1] === '/' ? -1 : 1;
      if (depth === 0) { end = tags.lastIndex; break; }
    }
    result = `${result.slice(0, start)} ${result.slice(end)}`;
  }
  return result;
}

// VOA's own writing is public domain; stories adapted from news-agency reports are not.
// Keep only articles with a VOA Learning English byline and no agency mention.
const VOA_BYLINE = /\bfor (VOA )?Learning English\b/;
const AGENCY_REPORT = /\b(AP|Associated Press|Reuters|Agence France-Presse|AFP)\b/;

// A VOA article page: the story is in div.wsw, which ends before the footer toolbar.
// Audio players (div.wsw__embed) sit inside the story and are removed.
export function parseVoaArticle(page) {
  const html = String(page || '');
  const start = html.indexOf('<div class="wsw">');
  if (start < 0) return null;
  const end = html.indexOf('<div class="footer-toolbar"', start);
  const body = removeDivBlocks(html.slice(start, end < 0 ? undefined : end), '<div class="wsw__embed');
  const text = htmlToParagraphs(body).join('\n\n');
  const heading = [...html.matchAll(/<h1([^>]*)>([\s\S]*?)<\/h1>/g)].find(match => !match[1].includes('title--program'));
  const article = { title: cleanText(heading?.[2]), text, audioUrl: firstMatch(html, /(https:\/\/voa-audio\.voanews\.eu\/[^"'\s&]+?\.mp3)/) };
  const ownWork = VOA_BYLINE.test(text) && !AGENCY_REPORT.test(text);
  return article.title && ownWork && isLongEnough(article, VOA_MIN_WORDS) ? article : null;
}

function checkedArticle(article) {
  const ok = article && validId(article.id) && typeof article.title === 'string' && article.title.trim()
    && typeof article.author === 'string' && /^https:\/\//.test(article.url || '')
    && Number.isFinite(Date.parse(article.published)) && typeof article.text === 'string'
    && article.text.trim() && article.text.length <= MAX_ARTICLE_CHARS
    && (!article.audioUrl || /^https:\/\//.test(article.audioUrl))
    && (article.category === undefined || typeof article.category === 'string');
  if (!ok) throw new Error(`Invalid article: ${article?.id || article?.url || 'unknown'}`);
  const { id, title, author, published, url, text, audioUrl, category } = article;
  return { id, title: title.trim(), author, published, url, text: text.trim(),
    ...(category ? { category } : {}), ...(audioUrl ? { audioUrl } : {}) };
}

/* Merges new articles into the previous package (a corrected article replaces its old copy),
   keeps the newest `max`, and returns a manifest and chapter files that load like a book. */
export function buildNewsPackage(meta, articles, previousChapters, max) {
  if (!meta || !validId(meta.id) || typeof meta.title !== 'string' || !meta.title.trim() || typeof meta.author !== 'string'
    || !/^https:\/\//.test(meta.sourceUrl || '') || !meta.license || !Number.isInteger(max) || max < 1) {
    throw new Error('Invalid news source metadata: check ID, title, publisher, source, license and article limit');
  }
  const byId = new Map();
  [...previousChapters, ...articles].map(checkedArticle).forEach(article => byId.set(article.id, article));
  const chapters = [...byId.values()]
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published) || a.id.localeCompare(b.id))
    .slice(0, max)
    .map((article, index) => ({ ...article, number: index + 1, wordCount: wordCount(article.text), version: hash(article.text).slice(0, 16) }));
  const manifest = {
    schemaVersion: 1, ...meta, sectionType: 'article', kind: 'news', version: hash(JSON.stringify(chapters)).slice(0, 16),
    introduction: '', latestArticle: chapters[0]?.published || '',
    wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    chapters: chapters.map(({ text, ...chapter }) => ({ ...chapter, path: `books/${meta.id}/chapters/${chapter.id}.json` })),
  };
  return { manifest, chapters };
}
