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
  const calls = { imports: [], readAloud: [] };
  const sandbox = vm.createContext({
    console, Date, URL,
    document: { readyState: 'loading', addEventListener() {}, getElementById: element },
    escapeHTML: text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    importArticleFromLink: (url, options) => { calls.imports.push([url, { ...options }]); },
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

test('AI headlines are listed safely on the News tab, each with a way to read it in the Reader', () => {
  const h = harness();
  h.sandbox.data = news;
  h.run('renderAINews(data)');
  const anthropic = h.element('newsAnthropic').innerHTML;
  assert.match(anthropic, /Claude &lt;b&gt;news/);
  assert.doesNotMatch(anthropic, /<b>news/);
  assert.doesNotMatch(anthropic, /javascript:/, 'Unsafe links are left out');
  assert.match(anthropic, /data-news-import="anthropic:0"/);
  assert.match(anthropic, /Import to Reader/);
  assert.match(h.element('newsGoogle').innerHTML, /No items yet/);
  assert.match(h.element('newsGithub').innerHTML, /owner\/&lt;repo&gt;/);
  assert.match(h.element('newsGithub').innerHTML, /12\.3k/);
  assert.notEqual(h.element('newsLastUpdated').textContent, '—');
});

test('Import to Reader brings the headline’s article into the Reader', () => {
  const h = harness();
  h.sandbox.data = news;
  h.run('renderAINews(data)');
  h.run(`onAINewsClick({ target: { closest: selector => selector === '[data-news-import]' ? { dataset: { newsImport: 'openai:0' } } : null } })`);
  assert.deepEqual(h.calls.imports, [['https://openai.com/index/b/', { openReader: true }]]);
})

test('Read aloud still works on a headline, and unknown buttons do nothing', () => {
  const h = harness();
  h.sandbox.data = news;
  h.run('renderAINews(data)');
  h.run(`onAINewsClick({ preventDefault() {}, target: { closest: selector => selector === '[data-mic-text]' ? { dataset: { micText: 'OpenAI post' } } : null } })`);
  assert.deepEqual(h.calls.readAloud, ['OpenAI post']);
  h.run(`onAINewsClick({ target: { closest: selector => selector === '[data-news-import]' ? { dataset: { newsImport: 'openai:9' } } : null } })`);
  assert.equal(h.calls.imports.length, 0);
});

const bbcEpisode = { title: 'Why does music <b>move</b> us?', url: 'https://www.bbc.co.uk/learningenglish/english/features/6-minute-english_2026/ep-261001',
  date: '2026-10-01', description: 'What do you listen to?', audioUrl: 'https://downloads.bbc.co.uk/learningenglish/features/6min/261001_music_download.mp3' };

test('BBC 6 Minute English episodes are listed with their date and teaser', () => {
  const h = harness();
  h.sandbox.data = { ...news, sources: { ...news.sources, bbc: [bbcEpisode, { ...bbcEpisode, url: 'javascript:alert(1)' }] } };
  h.run('renderAINews(data)');
  const bbc = h.element('newsBBC').innerHTML;
  assert.match(bbc, /Why does music &lt;b&gt;move/);
  assert.match(bbc, /What do you listen to\?/);
  assert.match(bbc, /data-news-import="bbc:0"/);
  assert.doesNotMatch(bbc, /javascript:/);
  assert.match(bbc, /🎧/, 'Marked as having audio');
  h.sandbox.data = news;
  h.run('renderAINews(data)');
  assert.match(h.element('newsBBC').innerHTML, /No episodes in the last 10 days/);
});

test('importing an episode opens it as a conversation with its audio', () => {
  const h = harness();
  h.sandbox.data = { ...news, sources: { ...news.sources, bbc: [bbcEpisode] } };
  h.run('renderAINews(data)');
  h.run(`onAINewsClick({ target: { closest: selector => selector === '[data-news-import]' ? { dataset: { newsImport: 'bbc:0' } } : null } })`);
  assert.deepEqual(h.calls.imports, [[bbcEpisode.url, { openReader: true, type: 'conversation', audioUrl: bbcEpisode.audioUrl }]]);
});
