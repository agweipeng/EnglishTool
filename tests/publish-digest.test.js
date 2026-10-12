'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The script pushes to the live site, so it is checked by reading it, not by running it
const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'publish-digest.sh'), 'utf8');
const lines = script.split('\n');
const lineOf = pattern => lines.findIndex(line => pattern.test(line));

test('the digest publisher pulls before writing any files, and stops if the pull fails', () => {
  const pull = lineOf(/git pull/);
  assert.ok(pull >= 0, 'the script pulls');
  assert.doesNotMatch(lines[pull], /\|\|\s*true/, 'a failed pull must stop the script');
  const firstWrite = lineOf(/mkdir -p|>\s*"\$/);
  assert.ok(firstWrite >= 0 && pull < firstWrite, 'the pull comes before the first file write');
});

test('the digest publisher refuses to run on any branch but main, before pulling or writing', () => {
  const guard = lineOf(/rev-parse --abbrev-ref HEAD/);
  assert.ok(guard >= 0, 'the script checks the branch');
  assert.match(lines.slice(guard, guard + 3).join('\n'), /exit 1/);
  assert.ok(guard < lineOf(/git pull/), 'before the pull, so a feature branch is never rebased');
});

test('the digest publisher leaves digests/index.html to the Build Digest Index workflow', () => {
  assert.doesNotMatch(script, /INDEX=|>\s*"\$INDEX"|digests\/index\.html"/);
});

test('the digest publisher commits only its own files', () => {
  const commit = lines[lineOf(/git commit/)];
  assert.match(commit, /git commit .*-- "digests\/\$SLUG\/\$DATE\.html" "digests\/\$SLUG\/title\.txt"/);
});

test('the digest publisher still validates the slug and escapes the HTML', () => {
  assert.match(script, /\^\[a-z0-9\]\[a-z0-9-\]\*\$/);
  assert.match(script, /html\.escape/);
});
