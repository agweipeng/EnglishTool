'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const policy = (/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html) || [])[1] || '';
const directive = name => (policy.split(';').map(part => part.trim()).find(part => part.startsWith(`${name} `)) || '').split(/\s+/).slice(1);

test('the page has a Content-Security-Policy that only runs its own scripts', () => {
  assert.ok(policy, 'A CSP meta tag is present');
  assert.deepEqual(directive('script-src'), ["'self'"]);
  assert.deepEqual(directive('object-src'), ["'none'"]);
  assert.deepEqual(directive('base-uri'), ["'none'"]);
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'The policy comes before any script');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'No inline <script> blocks');
  assert.doesNotMatch(html, /\son[a-z]+="/i, 'No inline event handlers');
  assert.match(html, /<meta name="referrer" content="no-referrer"/, 'Other sites are not told which page asked');
});

test('every web service the app talks to is allowed by connect-src, and nothing else is', () => {
  const sources = fs.readdirSync(root).filter(file => file.endsWith('.js')).map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const fetched = [...sources.matchAll(/(?:const [A-Z_]+ = |fetch\(|`)'?(https?:\/\/[a-z0-9.-]+(?::\d+)?)/gi)].map(m => m[1]);
  const allowed = directive('connect-src');
  const chatSites = ['https://claude.ai', 'https://chatgpt.com', 'https://github.com', 'https://www.bbc.co.uk'];   // links, never fetched
  for (const origin of new Set(fetched)) {
    if (chatSites.includes(origin) || origin === 'http://127.0.0.1:8000') continue;
    assert.ok(allowed.includes(origin), `${origin} is allowed by connect-src`);
  }
  assert.ok(allowed.includes('https://gist.githubusercontent.com'), 'Large sync files are read from raw_url');
  assert.ok(!allowed.includes('*') && !allowed.includes('https:'), 'No wildcard connections');
});
