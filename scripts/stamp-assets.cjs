#!/usr/bin/env node
/* Adds a content fingerprint to every app script and stylesheet link in index.html (app.js?v=1a2b3c4d).
   GitHub Pages lets browsers reuse files for 10 minutes; with a new link for each changed file, a release
   never runs a mix of old and new scripts. Run before committing: node scripts/stamp-assets.cjs
   tests/asset-versions.test.js fails when a fingerprint is out of date. */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// books/catalog.js is rewritten daily by the news workflow, so it stays unversioned
const UNVERSIONED = new Set(['books/catalog.js']);
const ASSET_LINK = /(<script src="|<link rel="stylesheet" href=")([^"?:]+\.(?:js|css))(?:\?v=([0-9a-f]*))?"/g;

const assetVersion = content => crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);

// The app's own script and stylesheet links: [{ file, version }]
function localAssets(html) {
  return [...html.matchAll(ASSET_LINK)]
    .filter(([, , file]) => !UNVERSIONED.has(file))
    .map(([, , file, version]) => ({ file, version: version || '' }));
}

// index.html with each app link's fingerprint set from read(file)
function stampAssets(html, read) {
  return html.replace(ASSET_LINK, (link, opening, file) => (UNVERSIONED.has(file) ? link : `${opening}${file}?v=${assetVersion(read(file))}"`));
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const indexFile = path.join(root, 'index.html');
  const html = fs.readFileSync(indexFile, 'utf8');
  const stamped = stampAssets(html, file => fs.readFileSync(path.join(root, file)));
  if (stamped === html) {
    console.log('index.html: all asset links are up to date');
  } else {
    fs.writeFileSync(indexFile, stamped);
    console.log(`index.html: updated ${localAssets(stamped).length} asset links`);
  }
}

module.exports = { assetVersion, localAssets, stampAssets };
