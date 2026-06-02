#!/usr/bin/env node
// Rebuild the digest archive in a light theme that matches the EnglishTool app.
//
// Two jobs:
//   1. Recolor every individual digest page (digests/<slug>/<date>.html) to a
//      single canonical light stylesheet — the external publisher writes some
//      pages dark (#0d1117) and this repo's own publisher writes others light;
//      this normalizes them all.
//   2. Rebuild digests/index.html listing ALL issues per category (newest
//      first), light theme, with correct relative links.
//
// Run locally:  node scripts/build-digest-index.mjs
// In CI it runs on every push under digests/** and commits if changed.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIGESTS_DIR = resolve(__dirname, '..', 'digests');
const OUT = join(DIGESTS_DIR, 'index.html');

const DATE_RE = /^\d{4}-\d{2}-\d{2}\.html$/;

// Canonical light stylesheet for individual digest pages (matches app palette).
// Body sans-serif; <pre> stays monospace so the digest's box-drawing/columns align.
const PAGE_STYLE = `<style>` +
  `body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;max-width:860px;margin:40px auto;padding:0 20px;background:#f7f8fb;color:#1c1f24}` +
  `h1{color:#1c1f24;border-bottom:1px solid #e3e6ec;padding-bottom:.5em}` +
  `.meta{color:#5b6471}` +
  `a{color:#4f7cff}` +
  `pre{white-space:pre-wrap;word-wrap:break-word;line-height:1.6;font-size:14px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#fff;border:1px solid #e3e6ec;padding:1em;border-radius:8px}` +
  `hr{border:0;border-top:1px solid #e3e6ec;margin:2em 0}` +
  `</style>`;

const STYLE_RE = /<style>[\s\S]*?<\/style>/i;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function listCategories() {
  return readdirSync(DIGESTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

function datesFor(slug) {
  const dir = join(DIGESTS_DIR, slug);
  return readdirSync(dir)
    .filter(f => DATE_RE.test(f))
    .map(f => f.replace(/\.html$/, ''))
    .sort((a, b) => b.localeCompare(a)); // newest first
}

function titleFor(slug) {
  const tf = join(DIGESTS_DIR, slug, 'title.txt');
  if (existsSync(tf)) {
    const t = readFileSync(tf, 'utf8').trim();
    if (t) return t;
  }
  return slug;
}

// Replace the first <style>...</style> in an individual page with the light one.
function recolorPages(categories) {
  let changed = 0;
  for (const slug of categories) {
    for (const date of datesFor(slug)) {
      const file = join(DIGESTS_DIR, slug, `${date}.html`);
      const html = readFileSync(file, 'utf8');
      if (!STYLE_RE.test(html)) continue;
      const next = html.replace(STYLE_RE, PAGE_STYLE);
      if (next !== html) {
        writeFileSync(file, next);
        changed++;
      }
    }
  }
  return changed;
}

function buildIndex(categories) {
  const sections = categories.map(slug => {
    const dates = datesFor(slug);
    if (dates.length === 0) return '';
    const items = dates.map(d =>
      `<li><a href="${esc(slug)}/${esc(d)}.html">${esc(d)}</a></li>`
    ).join('\n');
    return `<section>
<h2>${esc(titleFor(slug))} <span class="count">${dates.length}</span></h2>
<ul>
${items}
</ul>
</section>`;
  }).filter(Boolean).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Digest Archive</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;max-width:860px;margin:40px auto;padding:0 20px;background:#f7f8fb;color:#1c1f24}
h1{color:#1c1f24;border-bottom:1px solid #e3e6ec;padding-bottom:.5em}
h2{color:#4f7cff;font-size:1.05em;margin:1.6em 0 .4em}
.count{color:#5b6471;font-weight:normal;font-size:.85em}
ul{list-style:none;padding-left:0;margin:0}
li{margin:.25em 0}
a{color:#4f7cff;text-decoration:none}
a:hover{text-decoration:underline}
.back{display:inline-block;margin-bottom:1em;color:#5b6471}
</style>
</head><body>
<a class="back" href="../">← back to EnglishTool</a>
<h1>Digest Archive</h1>
${sections}
</body></html>
`;
}

const categories = listCategories();
const recolored = recolorPages(categories);
writeFileSync(OUT, buildIndex(categories));
console.log(`Recolored ${recolored} digest page(s); wrote ${OUT}`);
