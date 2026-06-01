#!/usr/bin/env node
// Rebuild digests/index.html from every dated digest file on disk.
//
// Lists ALL issues per category (not just the latest), newest first,
// with links relative to the index (href="<slug>/<date>.html") so they
// resolve correctly when served at /EnglishTool/digests/.
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

function build() {
  const categories = listCategories();
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
body{font-family:monospace;max-width:860px;margin:40px auto;padding:0 20px;background:#0d1117;color:#c9d1d9}
h1{color:#58a6ff;border-bottom:1px solid #30363d;padding-bottom:.5em}
h2{color:#58a6ff;font-size:1.05em;margin:1.6em 0 .4em}
.count{color:#8b949e;font-weight:normal;font-size:.85em}
ul{list-style:none;padding-left:0;margin:0}
li{margin:.25em 0}
a{color:#58a6ff;text-decoration:none}
a:hover{text-decoration:underline}
.back{display:inline-block;margin-bottom:1em;color:#8b949e}
</style>
</head><body>
<a class="back" href="../">← back to EnglishTool</a>
<h1>Digest Archive</h1>
${sections}
</body></html>
`;
}

const html = build();
writeFileSync(OUT, html);
console.log(`Wrote ${OUT}`);
