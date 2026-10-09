'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, { id, innerHTML: '', textContent: '', value: '', open: false, focused: 0, focus() { this.focused++; },
        scrollIntoView() {}, addEventListener() {} });
    }
    return elements.get(id);
  };
  const calls = { cleared: 0, opened: [], toasts: [], readAloud: [], confirms: [], confirmAnswer: true };
  const sandbox = vm.createContext({
    console, Date, URL,
    document: { readyState: 'loading', addEventListener() {}, getElementById: element },
    window: { open: (...args) => { calls.opened.push(args); } },
    escapeHTML: text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    toast: message => calls.toasts.push(message), confirm: message => { calls.confirms.push(message); return calls.confirmAnswer; },
    clearReader() { calls.cleared++; element('readerPaste').open = true; },
    openReadAloud: text => calls.readAloud.push(text),
  });
  const run = code => vm.runInContext(code, sandbox);
  run(fs.readFileSync(require.resolve('../ai-news.js'), 'utf8'));
  return { sandbox, run, element, calls };
}

const news = {
  generatedAt: '2026-10-09T06:00:00Z',
  sources: {
    anthropic: [{ title: 'Claude <b>news</b>', url: 'https://www.anthropic.com/news/a' }, { title: 'Bad link', url: 'javascript:alert(1)' }],
    openai: [{ title: 'OpenAI post', url: 'https://openai.com/index/b/' }],
    google: [],
    github: [{ name: 'owner/<repo>', url: 'https://github.com/owner/repo', description: 'A <i>tool</i>', stars: 12345, language: 'Python' }],
  },
};

test('AI headlines are listed safely in the Reader, each with a way to read it here', () => {
  const h = harness();
  h.sandbox.data = news;
  h.run('renderAINews(data)');
  const anthropic = h.element('newsAnthropic').innerHTML;
  assert.match(anthropic, /Claude &lt;b&gt;news/);
  assert.doesNotMatch(anthropic, /<b>news/);
  assert.doesNotMatch(anthropic, /javascript:/, 'Unsafe links are left out');
  assert.match(anthropic, /data-news-paste="anthropic:0"/);
  assert.match(anthropic, /Paste to read/);
  assert.match(h.element('newsGoogle').innerHTML, /No items yet/);
  assert.match(h.element('newsGithub').innerHTML, /owner\/&lt;repo&gt;/);
  assert.match(h.element('newsGithub').innerHTML, /12\.3k/);
  assert.notEqual(h.element('newsLastUpdated').textContent, '—');
});

test('Paste to read opens the original and gets the reader ready for its text as news', () => {
  const h = harness();
  h.sandbox.data = news;
  h.run('renderAINews(data)');
  h.run(`onAINewsClick({ target: { closest: selector => selector === '[data-news-paste]' ? { dataset: { newsPaste: 'openai:0' } } : null } })`);
  assert.deepEqual(h.calls.opened, [['https://openai.com/index/b/', '_blank', 'noopener']]);
  assert.equal(h.calls.cleared, 1);
  assert.equal(h.element('readerTitle').value, 'OpenAI post');
  assert.equal(h.element('readerMaterialType').value, 'news', 'AI analysis uses the news guide');
  assert.equal(h.element('readerMaterialSource').value, 'https://openai.com/index/b/');
  assert.equal(h.element('readerPaste').open, true);
  assert.equal(h.element('readerInput').focused, 1);
  assert.match(h.calls.toasts.at(-1), /paste/i);
  assert.equal(h.calls.confirms.length, 0, 'An empty reader is filled without asking');
});

test('Paste to read asks before replacing text already in the reader', () => {
  const h = harness();
  h.sandbox.data = news;
  h.run('renderAINews(data)');
  h.element('readerInput').value = 'My own unsaved notes';
  h.calls.confirmAnswer = false;
  h.run(`onAINewsClick({ target: { closest: selector => selector === '[data-news-paste]' ? { dataset: { newsPaste: 'openai:0' } } : null } })`);
  assert.equal(h.calls.confirms.length, 1);
  assert.equal(h.calls.opened.length, 1, 'The article still opens');
  assert.equal(h.calls.cleared, 0, 'Keeping the text leaves the reader alone');
  assert.equal(h.element('readerInput').value, 'My own unsaved notes');
});

test('Read aloud still works on a headline, and unknown buttons do nothing', () => {
  const h = harness();
  h.sandbox.data = news;
  h.run('renderAINews(data)');
  h.run(`onAINewsClick({ preventDefault() {}, target: { closest: selector => selector === '[data-mic-text]' ? { dataset: { micText: 'OpenAI post' } } : null } })`);
  assert.deepEqual(h.calls.readAloud, ['OpenAI post']);
  h.run(`onAINewsClick({ target: { closest: selector => selector === '[data-news-paste]' ? { dataset: { newsPaste: 'openai:9' } } : null } })`);
  assert.equal(h.calls.opened.length, 0);
});
