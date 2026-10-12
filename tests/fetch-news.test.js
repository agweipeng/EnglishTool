'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Importing the script must not start a network run
const fetchNews = () => import('../scripts/fetch-news.mjs');

test('HTML entities are decoded once, with &amp; last', async () => {
  const { decodeHtmlEntities } = await fetchNews();
  assert.equal(decodeHtmlEntities('&amp;lt;b&amp;gt;'), '&lt;b&gt;');
  assert.equal(decodeHtmlEntities('Q&amp;A &lt;live&gt; &quot;now&quot; it&#39;s'), 'Q&A <live> "now" it\'s');
  assert.equal(decodeHtmlEntities('a&nbsp;b'), 'a b');
});

test('numeric entities above U+FFFF become the right character, bad ones a replacement mark', async () => {
  const { decodeHtmlEntities } = await fetchNews();
  assert.equal(decodeHtmlEntities('&#128512; &#x1F600;'), '😀 😀');
  assert.equal(decodeHtmlEntities('&#8217;'), '’');
  assert.equal(decodeHtmlEntities('&#99999999;'), '�');
  assert.equal(decodeHtmlEntities(undefined), '');
});

test('unchanged news keeps the previous generatedAt so the file is byte-identical', async () => {
  const { withGeneratedAt } = await fetchNews();
  const sources = { anthropic: [{ title: 'A', url: 'https://a.example/1' }], bbc: [] };
  const previous = { generatedAt: '2026-10-11T06:00:00.000Z', sources: structuredClone(sources) };
  const out = withGeneratedAt(sources, previous, new Date('2026-10-12T06:00:00Z'));
  assert.deepEqual(out, { generatedAt: '2026-10-11T06:00:00.000Z', sources });
  assert.deepEqual(Object.keys(out), ['generatedAt', 'sources']);
});

test('changed news, or no usable previous file, gets a new generatedAt', async () => {
  const { withGeneratedAt } = await fetchNews();
  const now = new Date('2026-10-12T06:00:00Z');
  const sources = { anthropic: [{ title: 'B', url: 'https://a.example/2' }] };
  const changed = { generatedAt: '2026-10-11T06:00:00.000Z', sources: { anthropic: [] } };
  assert.equal(withGeneratedAt(sources, changed, now).generatedAt, now.toISOString());
  assert.equal(withGeneratedAt(sources, null, now).generatedAt, now.toISOString());
  assert.equal(withGeneratedAt(sources, { sources }, now).generatedAt, now.toISOString());
});

test('a source that kept old items is reported as a GitHub Actions warning', async () => {
  const { staleWarning } = await fetchNews();
  assert.equal(staleWarning('openai', 'HTTP 403'),
    "::warning title=News source::openai kept yesterday's items (HTTP 403)");
  // A newline would end the annotation early and spill the rest into the plain log
  assert.equal(staleWarning('china', 'bad\nfeed'),
    "::warning title=News source::china kept yesterday's items (bad feed)");
});

test('an empty source falls back to yesterday and warns; a fresh one does not', async () => {
  const { keepIfEmpty } = await fetchNews();
  const warnings = [];
  const warn = line => warnings.push(line);
  const old = [{ title: 'old' }];
  assert.deepEqual(keepIfEmpty('google', { items: [{ title: 'new' }] }, old, warn), [{ title: 'new' }]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(keepIfEmpty('google', { items: [], error: 'timeout' }, old, warn), old);
  assert.deepEqual(keepIfEmpty('github', { items: [] }, undefined, warn), []);
  assert.deepEqual(warnings, [
    "::warning title=News source::google kept yesterday's items (timeout)",
    "::warning title=News source::github kept yesterday's items (no items today)",
  ]);
});
