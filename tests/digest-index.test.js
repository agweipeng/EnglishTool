'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Importing the script must not rewrite the digests
const builder = () => import('../scripts/build-digest-index.mjs');
const DIGESTS = path.join(__dirname, '..', 'digests');

test('every digest page gets a no-script policy first, and running again changes nothing', async () => {
  const { protectPage, PAGE_POLICY } = await builder();
  const page = '<!doctype html>\n<html><head><title>x</title></head><body><img src=x onerror="alert(1)"></body></html>';
  const once = protectPage(page);
  assert.ok(once.startsWith(`<!doctype html>${PAGE_POLICY}`), 'Before anything else on the page');
  assert.match(PAGE_POLICY, /default-src 'none'/);
  assert.doesNotMatch(PAGE_POLICY, /script-src/, 'No script source is allowed at all');
  assert.equal(protectPage(once), once);
  assert.ok(protectPage('<p>no doctype</p>').startsWith(PAGE_POLICY));
});

test('script-like markup in a digest is noticed', async () => {
  const { hasActiveContent } = await builder();
  ['<script>x</script>', '<a href="javascript:x">', '<img onerror=x>', '<iframe src=x>'].forEach(html => assert.ok(hasActiveContent(html), html));
  assert.equal(hasActiveContent('<pre>Shares fell; one analyst said "on track".</pre>'), false);
});

test('the digests in the repo carry the policy and no script-like markup', async () => {
  const { PAGE_POLICY, hasActiveContent } = await builder();
  const pages = fs.readdirSync(DIGESTS, { withFileTypes: true }).filter(d => d.isDirectory())
    .flatMap(d => fs.readdirSync(path.join(DIGESTS, d.name)).filter(f => f.endsWith('.html')).map(f => path.join(DIGESTS, d.name, f)));
  assert.ok(pages.length > 0);
  for (const file of [...pages, path.join(DIGESTS, 'index.html')]) {
    const html = fs.readFileSync(file, 'utf8');
    assert.ok(html.includes(PAGE_POLICY), `${path.relative(DIGESTS, file)} has the policy`);
    assert.equal(hasActiveContent(html), false, `${path.relative(DIGESTS, file)} has no script-like markup`);
  }
});
