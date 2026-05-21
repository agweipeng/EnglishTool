#!/usr/bin/env node
/* eslint-disable no-console */
// Fetch AI news from Anthropic, OpenAI, Google AI blogs + GitHub Trending (AI repos)
// and write the merged result to news.json at the project root.
//
// Designed to run from a GitHub Action (Node 20+, built-in fetch).
// Per-source failures are logged but do not fail the whole script — the
// output still includes whatever sources succeeded so the app keeps working.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'news.json');

const UA = 'Mozilla/5.0 (compatible; EnglishTool-DailyNews/1.0; +https://github.com/agweipeng/EnglishTool)';
const TIMEOUT_MS = 15000;
const MAX_ITEMS_PER_SOURCE = 8;
const MAX_GITHUB_REPOS = 12;

async function fetchText(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...opts.headers },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', ...opts.headers },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return decodeHtmlEntities(String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

// Anchor text on these sites often contains <title> <category> <date> <description>
// all glued together. Keep the first ~100 chars as the displayed title.
function cleanTitle(s, max = 100) {
  const t = stripTags(s);
  if (t.length <= max) return t;
  // Try to cut at a sentence/clause boundary
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + '…';
}

// Filter out nav/section anchors disguised as articles
const NAV_TITLES = new Set([
  'research', 'news', 'index', 'blog', 'stories', 'company', 'product',
  'developers', 'safety', 'pricing', 'about', 'contact', 'careers', 'login',
  'sign up', 'sign in', 'learn more', 'read more', 'view all', 'see all',
]);
function isNavTitle(t) {
  if (NAV_TITLES.has(t.toLowerCase().trim())) return true;
  // Short 1-2 word titles are almost always category/nav links, not articles
  const words = t.trim().split(/\s+/);
  if (words.length <= 2 && t.length < 25) return true;
  return false;
}

function unique(arr, keyFn) {
  const seen = new Set();
  return arr.filter(x => {
    const k = keyFn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ----- Source: Anthropic -----
// Their /news listing page links to /news/<slug>; we extract those + their h-text.
async function fetchAnthropic() {
  const html = await fetchText('https://www.anthropic.com/news');
  const items = [];
  const re = /<a[^>]+href="(\/news\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const url = 'https://www.anthropic.com' + m[1];
    const title = cleanTitle(m[2]);
    if (!title || title.length < 12 || isNavTitle(title)) continue;
    items.push({ title, url });
  }
  return unique(items, x => x.url).slice(0, MAX_ITEMS_PER_SOURCE);
}

// ----- Source: OpenAI -----
// openai.com aggressively blocks non-browser User-Agents. Use a real browser UA and try multiple paths.
async function fetchOpenAI() {
  const browserUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const headers = {
    'User-Agent': browserUA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const candidates = ['https://openai.com/news/', 'https://openai.com/blog/'];
  let html = '';
  for (const u of candidates) {
    try { html = await fetchText(u, { headers }); if (html) break; } catch {}
  }
  if (!html) throw new Error('all OpenAI urls blocked');
  const items = [];
  const re = /<a[^>]+href="(\/(?:index|news|blog)\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const href = 'https://openai.com' + m[1];
    const title = cleanTitle(m[2]);
    if (!title || title.length < 12 || isNavTitle(title)) continue;
    items.push({ title, url: href });
  }
  return unique(items, x => x.url).slice(0, MAX_ITEMS_PER_SOURCE);
}

// ----- Source: Google AI / Gemini blog -----
// blog.google post URLs look like /products/gemini/<slug>/ — 3+ path segments.
// Section pages have 2 or fewer segments (e.g. /technology/ai/). Filter on that.
async function fetchGoogleAI() {
  const urls = [
    'https://blog.google/technology/ai/',
    'https://blog.google/technology/google-deepmind/',
    'https://blog.google/products/gemini/',
  ];
  const all = [];
  for (const u of urls) {
    try {
      const html = await fetchText(u);
      const re = /<a[^>]+href="(https?:\/\/blog\.google\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(html))) {
        const link = m[1];
        const title = cleanTitle(m[2]);
        if (!title || title.length < 12 || isNavTitle(title)) continue;
        // Count path segments to skip section/category landing pages
        const path = link.replace(/^https?:\/\/blog\.google/, '').replace(/\/+$/, '');
        const segments = path.split('/').filter(Boolean);
        if (segments.length < 3) continue; // need products/<cat>/<post-slug>
        all.push({ title, url: link });
      }
    } catch (e) {
      console.warn(`Google AI sub-fetch failed for ${u}: ${e.message}`);
    }
  }
  return unique(all, x => x.url).slice(0, MAX_ITEMS_PER_SOURCE);
}

// ----- Source: GitHub trending AI repos (Search API) -----
// GitHub Search rejects complex OR-chained topic queries (422). Run a few simple queries
// in parallel and merge by repo URL, then sort by stars and trim.
async function fetchGithubAI() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  const topics = ['llm', 'agent', 'rag', 'ai-agent', 'genai'];
  const results = [];
  for (const topic of topics) {
    try {
      const q = encodeURIComponent(`topic:${topic} pushed:>${since} stars:>100`);
      const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=10`;
      const data = await fetchJson(url, { headers });
      if (data && Array.isArray(data.items)) results.push(...data.items);
    } catch (e) {
      console.warn(`GitHub topic:${topic} failed: ${e.message}`);
    }
  }
  return unique(results, r => r.html_url)
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, MAX_GITHUB_REPOS)
    .map(r => ({
      name: r.full_name,
      url: r.html_url,
      description: r.description || '',
      stars: r.stargazers_count,
      language: r.language || '',
      updatedAt: r.pushed_at,
    }));
}

// ----- Orchestrator -----
async function safe(name, fn) {
  try {
    const data = await fn();
    console.log(`✓ ${name}: ${data.length} items`);
    return data;
  } catch (e) {
    console.warn(`✗ ${name} failed: ${e.message}`);
    return [];
  }
}

async function main() {
  const previous = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, 'utf8')) : null;

  const [anthropic, openai, google, github] = await Promise.all([
    safe('anthropic', fetchAnthropic),
    safe('openai', fetchOpenAI),
    safe('google', fetchGoogleAI),
    safe('github', fetchGithubAI),
  ]);

  // Fallback: if a source returns empty, retain previous content so the UI never goes blank
  const keepIfEmpty = (current, prevList) => current.length > 0 ? current : (prevList || []);

  const out = {
    generatedAt: new Date().toISOString(),
    sources: {
      anthropic: keepIfEmpty(anthropic, previous?.sources?.anthropic),
      openai: keepIfEmpty(openai, previous?.sources?.openai),
      google: keepIfEmpty(google, previous?.sources?.google),
      github: keepIfEmpty(github, previous?.sources?.github),
    },
  };

  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_PATH} (${Buffer.byteLength(JSON.stringify(out))} bytes)`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
