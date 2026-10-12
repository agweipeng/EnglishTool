'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = name => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', name), 'utf8');
const BOT_PUSHERS = ['daily-news.yml', 'fix-digest-links.yml'];

for (const name of BOT_PUSHERS) {
  test(`${name} retries its push when someone else pushed first`, () => {
    const text = workflow(name);
    assert.match(text, /for i in 1 2 3; do/);
    assert.match(text, /git pull --rebase -X theirs && git push && exit 0/);
    assert.match(text, /git rebase --abort/);
    // Only the retry loop pushes: no bare push that could fail on a race
    assert.equal(text.match(/git push/g).length, 1);
  });

  test(`${name} has a time limit`, () => {
    assert.match(workflow(name), /^\s+timeout-minutes: \d+$/m);
  });

  test(`${name} runs on a Node version that still gets security fixes`, () => {
    const version = Number((/node-version: '(\d+)'/.exec(workflow(name)) || [])[1]);
    assert.ok(version >= 22, `Node ${version}`);
  });
}
