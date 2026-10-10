'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assetVersion, localAssets, stampAssets } = require('../scripts/stamp-assets.cjs');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// GitHub Pages lets browsers reuse a file for 10 minutes, so a release could run old scripts.
// Each app script and stylesheet link carries a fingerprint of its content: a changed file gets a new link.
test('every app script and stylesheet link carries the fingerprint of its current content', () => {
  const assets = localAssets(html);
  assert.ok(assets.length >= 20, 'All app scripts and the stylesheet are found');
  const stale = assets.filter(({ file, version }) => version !== assetVersion(fs.readFileSync(path.join(root, file))))
    .map(({ file, version }) => `${file}?v=${version || '(none)'}`);
  assert.deepEqual(stale, [], 'Run `node scripts/stamp-assets.cjs` to update the links');
});

test('the daily-updated book catalog is left unversioned, so the news job never makes the links stale', () => {
  assert.match(html, /<script src="books\/catalog\.js"><\/script>/);
  assert.ok(!localAssets(html).some(asset => asset.file === 'books/catalog.js'));
});

test('stamping replaces an old fingerprint and leaves other markup alone', () => {
  const page = '<link rel="stylesheet" href="style.css?v=00000000" />\n<script src="app.js"></script>\n<script src="https://cdn.example/x.js"></script>';
  const read = file => Buffer.from(`content of ${file}`);
  const stamped = stampAssets(page, read);
  assert.equal(stamped, `<link rel="stylesheet" href="style.css?v=${assetVersion(read('style.css'))}" />\n`
    + `<script src="app.js?v=${assetVersion(read('app.js'))}"></script>\n<script src="https://cdn.example/x.js"></script>`);
  assert.equal(stampAssets(stamped, read), stamped, 'Stamping twice changes nothing');
});
