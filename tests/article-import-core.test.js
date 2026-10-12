'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../article-import-core.js');

const paragraph = 'Cybersecurity is inherently dual use: the same capabilities that enable a security team to find and fix a vulnerability can also help an attacker. '.repeat(3).trim();

test('only full http or https links are accepted, and the reader service gets the link unchanged', () => {
  assert.equal(core.normalizeArticleUrl('  https://www.anthropic.com/news/cvp  '), 'https://www.anthropic.com/news/cvp');
  assert.equal(core.normalizeArticleUrl('www.bbc.com/news/a'), 'https://www.bbc.com/news/a', 'A link typed without https:// still works');
  assert.equal(core.normalizeArticleUrl('https://me:secret@example.com/a'), 'https://example.com/a', 'A name or password in a link is never sent');
  for (const bad of ['', 'hello', 'javascript:alert(1)', 'ftp://example.com/a', 'https://']) {
    assert.throws(() => core.normalizeArticleUrl(bad), /link/);
  }
  assert.equal(core.readerRequestUrl('https://openai.com/index/b/?x=1'), 'https://r.jina.ai/https://openai.com/index/b/?x=1');
});

test('Markdown from the reader service becomes plain reading text', () => {
  const markdown = [
    '# Expanding the program',
    '',
    '![Hero image](https://cdn.example.com/a.png)',
    '',
    'We are **launching** a new, _expanded_ program. Customers can [apply here](https://portal.example.com/a_(b)).',
    '',
    '',
    '',
    '> A quoted line.',
    '',
    '* First point',
    '- Second point',
    '',
    '---',
    '',
    '| Tier | Access |',
    '| --- | --- |',
    '',
    '```js',
    'console.log(1)',
    '```',
    '[1]: https://example.com/ref',
    'Snake_case_words stay, and 3 * 4 = 12 \\*literally\\*. <b>Bold</b>',
  ].join('\n');
  assert.equal(core.markdownToText(markdown), [
    'Expanding the program',
    '',
    'We are launching a new, expanded program. Customers can apply here.',
    '',
    'A quoted line.',
    '',
    '• First point',
    '• Second point',
    '',
    'Snake_case_words stay, and 3 * 4 = 12 *literally*. Bold',
  ].join('\n'));
  assert.equal(core.markdownToText('Profits fell if x <5 and y> 3 last year, prices <10% then > 20%.'),
    'Profits fell if x <5 and y> 3 last year, prices <10% then > 20%.', 'Less-than and greater-than signs are text, not tags');
  assert.equal(core.markdownToText('Paris[[1]](https://w.example/c1) is big.\n\n* * *\n\n<!-- note --><span class="x">Next</span> part.'),
    'Paris is big.\n\nNext part.', 'Citations, rule lines, comments and tags go');
  assert.equal(core.markdownToText('```\nunclosed fence keeps its text'), 'unclosed fence keeps its text');
  assert.equal(core.markdownToText("we've [reported](https://a.example/1)[on](https://a.example/2)[many](https://a.example/3) of them"),
    "we've reported on many of them", 'Words linked one by one keep their spaces');
});

test('odd or hostile pages are cleaned quickly, so the page never freezes', () => {
  const size = 200000;
  for (const hostile of ['a' + ' '.repeat(size) + 'b', '<'.repeat(size), '!['.repeat(size / 2), '['.repeat(size), ')['.repeat(size / 2),
    '**a '.repeat(size / 4), '(('.repeat(size / 2), '[a]('.repeat(size / 4), '<!--'.repeat(size / 4), '[[1]'.repeat(size / 4)]) {
    const started = Date.now();
    core.markdownToText(hostile);
    assert.ok(Date.now() - started < 1000, `${JSON.stringify(hostile.slice(0, 6))}… took ${Date.now() - started} ms`);
  }
});

test('a reader-service reply becomes an article with its title, text and original link', () => {
  const article = core.parseReaderReply({ code: 200, data: {
    title: '  Expanding the Cyber Verification Program ', url: 'https://www.anthropic.com/news/cvp',
    content: `## Overview\n\n${paragraph}`, publishedTime: '2026-10-06T19:00:00.000Z',
  } }, 'https://anthropic.com/news/cvp');
  assert.deepEqual(article, {
    title: 'Expanding the Cyber Verification Program', url: 'https://www.anthropic.com/news/cvp',
    text: `Overview\n\n${paragraph}`, published: '2026-10-06T19:00:00.000Z',
  });
  const untitled = core.parseReaderReply({ code: 200, data: { title: '', url: 'javascript:x', content: paragraph } }, 'https://www.example.org/a');
  assert.equal(untitled.title, 'example.org', 'Without a title, the site name is used');
  assert.equal(untitled.url, 'https://www.example.org/a', 'Only a safe original link is kept');
});

test('text longer than the limit is cut at the last paragraph break that fits', () => {
  const text = ['First paragraph.', 'Second paragraph.', 'Third paragraph.'].join('\n\n');
  assert.deepEqual(core.cutAtParagraph(text, 40), { text: 'First paragraph.\n\nSecond paragraph.', fullLength: text.length });
  assert.deepEqual(core.cutAtParagraph(text, 1000), { text, fullLength: text.length }, 'Short text is kept whole');
  assert.equal(core.cutAtParagraph('One very long line with no breaks at all', 20).text, 'One very long line',
    'Without a paragraph break, it is cut at a space');
  assert.equal(core.cutAtParagraph('x'.repeat(50), 20).text, 'x'.repeat(20));
});

test('an article longer than the Reader can show is cut to its first part, and says how long it was', () => {
  const block = `${paragraph}\n\n`;
  const content = block.repeat(Math.ceil(250000 / block.length));
  const article = core.parseReaderReply({ code: 200, data: { title: 'Long', url: 'https://a.example/x', content } }, 'https://a.example/x');
  assert.equal(core.MAX_READER_CHARS, 200000);
  assert.ok(article.text.length <= core.MAX_READER_CHARS);
  assert.ok(article.text.endsWith(paragraph), 'The cut falls between paragraphs');
  assert.equal(article.fullLength, content.trim().length);
  const smaller = core.parseReaderReply({ code: 200, data: { title: 'Long', content } }, 'https://a.example/x', 1000);
  assert.ok(smaller.text.length <= 1000 && smaller.text.endsWith(paragraph), 'The caller can pass the Reader limit');
  const short = core.parseReaderReply({ code: 200, data: { title: 'Short', content: paragraph } }, 'https://a.example/x');
  assert.equal('fullLength' in short, false, 'A whole article has no cut note');
});

test('failed or nearly empty pages are refused with a clear reason', () => {
  assert.throws(() => core.parseReaderReply({ code: 422, data: null }, 'https://a.example/x'), /could not read/i);
  assert.throws(() => core.parseReaderReply(null, 'https://a.example/x'), /could not read/i);
  assert.throws(() => core.parseReaderReply({ code: 200, data: { title: 'Sign in', content: 'Please sign in to continue.' } }, 'https://a.example/x'),
    /not enough article text/i);
});
