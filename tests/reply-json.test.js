'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findReplyJSON } = require('../reply-json.js');

const hasItems = value => Array.isArray(value.items);

test('finds the JSON object a chat reply wraps in prose and a code fence', () => {
  const reply = 'Sure! Here is the feedback:\n```json\n{"items":[{"word":"carry on"}]}\n```\nGood luck!';
  assert.deepEqual(findReplyJSON(reply, hasItems), { items: [{ word: 'carry on' }] });
});

test('repairs curly quotes, raw line breaks, a trailing comma and a byte-order mark copied from a phone', () => {
  const reply = '﻿{“items”: [{“model”: “He said “yes” and\ncarried on.”}],}';
  assert.equal(findReplyJSON(reply, hasItems).items[0].model, 'He said “yes” and\ncarried on.');
});

test('returns null when no object passes the check', () => {
  assert.equal(findReplyJSON('{"en":"a","cn":"b"} and no items', hasItems), null);
  assert.equal(findReplyJSON('', hasItems), null);
  assert.equal(findReplyJSON(undefined, hasItems), null);
});

test('Markdown backslashes from a copied chat answer are removed, but real JSON escapes are kept', () => {
  const reply = '{"items": \\[{"model": "a\\_b \\*c\\* say \\"hi\\" \\\\ end\\nnext"}\\]}';
  assert.equal(findReplyJSON(reply, hasItems).items[0].model, 'a_b *c* say "hi" \\ end\nnext');
});
