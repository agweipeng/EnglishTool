#!/usr/bin/env node
/* Downloads modern English articles into Reader packages under books/<id>/ and rebuilds the catalog.
     node scripts/import-news.mjs conversation   # daily, from the GitHub Action
     node scripts/import-news.mjs voa            # one-time VOA Learning English archive
   Only openly licensed sources: The Conversation (CC BY-ND 4.0, republished unchanged)
   and VOA Learning English (U.S. government work, public domain). */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNewsPackage, parseConversationFeed, parseRssItems, parseVoaArticle, articleId, isConversationArticle } from './news-import-core.mjs';
import { writePackage, buildCatalog } from './import-book.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USER_AGENT = 'Mozilla/5.0 (compatible; EnglishTool-Reader/1.0; +https://github.com/agweipeng/EnglishTool)';
const TIMEOUT_MS = 20000;
const PAUSE_BETWEEN_PAGES_MS = 400;   // be polite to the VOA site
const VOA = 'https://learningenglish.voanews.com';
const VOA_FEEDS = {
  'As It Is': '/api/zkm-ql-vomx-tpej-rqi',
  'Words and Their Stories': '/api/zmypyl-vomx-tpeyry_',
  'Science & Technology': '/api/zmg_pl-vomx-tpeymtm',
  'Health & Lifestyle': '/api/zmmpql-vomx-tpey-_q',
  'Education': '/api/ztmp_l-vomx-tpek-__',
  'Ask a Teacher': '/api/zti_qvl-vomx-tpekgvqr',
  'Everyday Grammar': '/api/zoroqql-vomx-tpeptpqq',
  'Arts & Culture': '/api/zpyp_l-vomx-tpe_rym',
};

const SOURCES = {
  conversation: {
    max: 30,
    keep: isConversationArticle,
    load: loadConversation,
    meta: {
      id: 'the-conversation', title: 'The Conversation', titleCN: '对话（每日新闻与评论）', author: 'University experts',
      language: 'en', genre: 'News & ideas', readingStage: 'Daily news', readingOrder: 20,
      sourceUrl: 'https://theconversation.com/global',
      license: 'Creative Commons Attribution-NoDerivatives 4.0 International (CC BY-ND 4.0). Article text is republished unchanged; images and embedded media are not included.',
      licenseUrl: 'https://creativecommons.org/licenses/by-nd/4.0/',
      credit: 'This article is republished from The Conversation under a Creative Commons license.',
      recommendation: 'New articles every day, written by university experts for general readers: current topics in natural, educated native English.',
    },
  },
  voa: {
    max: 150,
    // A fixed archive: every run re-reads all of it, so nothing is kept from earlier runs
    keep: () => false,
    load: loadVoaArchive,
    meta: {
      id: 'voa-learning-english', title: 'VOA Learning English', titleCN: '美国之音慢速英语', author: 'Voice of America',
      language: 'en', genre: 'Graded news & idioms', readingStage: 'Easier news', readingOrder: 21,
      sourceUrl: VOA,
      license: 'Public domain (U.S. government work). Agency photos and other third-party material are not included.',
      credit: 'From VOA Learning English, a public-domain service of the Voice of America.',
      recommendation: 'Simpler, slower news English with audio and “Words in This Story” glossaries. An archive from early 2025: VOA stopped publishing new lessons in March 2025.',
    },
  },
};

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.text();
}

const pause = ms => new Promise(done => setTimeout(done, ms));

async function loadConversation() {
  return parseConversationFeed(await fetchText('https://theconversation.com/global/articles.atom'));
}

async function loadVoaArchive() {
  const seen = new Set();
  const articles = [];
  for (const [category, path] of Object.entries(VOA_FEEDS)) {
    let items = [];
    try { items = parseRssItems(await fetchText(VOA + path)); }
    catch (error) { console.warn(`Skipped the ${category} feed: ${error.message}`); continue; }
    // Only VOA's own pages are fetched, whatever the feed links to
    for (const item of items.filter(item => item.url.startsWith(`${VOA}/`) && !seen.has(item.url))) {
      seen.add(item.url);
      try {
        const page = parseVoaArticle(await fetchText(item.url));
        if (page) articles.push({ ...page, id: articleId(item.url), author: '', published: item.published, url: item.url, category });
        else console.log(`Skipped ${item.url}: no transcript, or not VOA's own writing`);
      } catch (error) {
        console.warn(`Skipped ${item.url}: ${error.message}`);
      }
      await pause(PAUSE_BETWEEN_PAGES_MS);
    }
    console.log(`${category}: ${articles.length} articles so far`);
  }
  return articles;
}

function readPackage(id) {
  const manifestPath = join(ROOT, 'books', id, 'manifest.json');
  if (!existsSync(manifestPath)) return { manifest: null, chapters: [] };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return { manifest, chapters: manifest.chapters.map(chapter => JSON.parse(readFileSync(join(ROOT, chapter.path), 'utf8'))) };
}

async function main(name) {
  const source = SOURCES[name];
  if (!source) throw new Error(`Usage: node scripts/import-news.mjs ${Object.keys(SOURCES).join(' | ')}`);
  const articles = await source.load();
  // A network or site change must never empty the shelf
  if (!articles.length) throw new Error(`No articles found for ${name}; the existing package was left unchanged`);
  const previous = readPackage(source.meta.id);
  // Articles kept from earlier runs follow today's rules too
  const kept = previous.chapters.filter(source.keep);
  const { manifest, chapters } = buildNewsPackage(source.meta, articles, kept, source.max);
  // Unchanged packages are not rewritten, so the daily job only commits real news
  if (JSON.stringify(manifest) === JSON.stringify(previous.manifest)) { console.log(`${manifest.title}: no new articles`); return; }
  writePackage(manifest, chapters);
  buildCatalog();
  console.log(`${manifest.title}: ${chapters.length} articles, ${manifest.wordCount.toLocaleString()} words`);
}

main(process.argv[2]).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
