/* News tab: BBC Learning English, US market, China and AI headlines from news.json (written by .github/workflows/daily-news.yml).
   The articles are copyrighted, so the repository only stores links; "Import to Reader" fetches an
   article for you (article-import.js) into your private reading materials for word lookups and AI analysis. */
'use strict';

const AI_NEWS_SECTIONS = [
  { key: 'anthropic', id: 'newsAnthropic' },
  { key: 'openai', id: 'newsOpenAI' },
  { key: 'google', id: 'newsGoogle' },
];
const AI_NEWS_LIST_IDS = ['newsBBC', 'newsMarkets', 'newsChina', ...AI_NEWS_SECTIONS.map(section => section.id), 'newsGithub'];
const MARKET_KEY = /^[A-Z]{1,6}$/;   // NVDA, GOOGL, GROK… (used in button data, so nothing else is allowed)
let aiNewsCache = null;
// 'openai:0' → { title, url }; 'mk:NVDA:0' and 'china:0' → { title, url, publisher, date }; 'bbc:0' → { …, type, audioUrl }
let aiNewsItems = new Map();

const safeNewsUrl = url => {
  try { return ['http:', 'https:'].includes(new URL(url).protocol) ? url : ''; } catch { return ''; }
};
const newsHost = url => new URL(url).hostname.replace(/^www\./, '');

async function loadAINews(force = false) {
  if (aiNewsCache && !force) { renderAINews(aiNewsCache); return; }
  AI_NEWS_LIST_IDS.forEach(id => { document.getElementById(id).innerHTML = '<p class="hint">Loading…</p>'; });
  try {
    const response = await fetch(`news.json${force ? `?t=${Date.now()}` : ''}`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    aiNewsCache = await response.json();
    renderAINews(aiNewsCache);
  } catch (error) {
    console.warn('AI news could not be loaded', error);
    document.getElementById('newsLastUpdated').textContent = 'never';
    const message = '<p class="hint">Couldn’t load the AI news. Check your connection and try Refresh. / 无法加载 AI 新闻，请检查网络后刷新。</p>';
    AI_NEWS_LIST_IDS.forEach(id => { document.getElementById(id).innerHTML = message; });
  }
}

function renderAINews(data) {
  const sources = data?.sources || {};
  const updated = new Date(data?.generatedAt);
  document.getElementById('newsLastUpdated').textContent = Number.isNaN(updated.getTime()) ? '—'
    : updated.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  aiNewsItems = new Map();
  AI_NEWS_SECTIONS.forEach(({ key, id }) => {
    const items = (Array.isArray(sources[key]) ? sources[key] : [])
      .map(item => ({ title: String(item?.title || '').trim(), url: safeNewsUrl(item?.url) }))
      .filter(item => item.title && item.url);
    items.forEach((item, index) => aiNewsItems.set(`${key}:${index}`, item));
    document.getElementById(id).innerHTML = items.length ? items.map((item, index) => articleCard(item, `${key}:${index}`)).join('')
      : '<p class="hint">No items yet.</p>';
  });
  renderBBCEpisodes(sources.bbc);
  renderMarkets(sources.markets);
  document.getElementById('newsChina').innerHTML = renderHeadlines(sources.china, 'china') || '<p class="hint">No items yet.</p>';
  const repos = (Array.isArray(sources.github) ? sources.github : []).filter(repo => repo && safeNewsUrl(repo.url));
  document.getElementById('newsGithub').innerHTML = repos.length ? repos.map(repoCard).join('') : '<p class="hint">No items yet.</p>';
}

function articleCard(item, key, meta = newsHost(item.url)) {
  return `<div class="news-card-wrap">
      <a class="news-card" href="${escapeHTML(item.url)}" target="_blank" rel="noopener">
        <div class="news-card-title">${escapeHTML(item.title)}</div>
        <div class="news-card-meta">${escapeHTML(meta)} ↗</div>
      </a>
      <div class="news-card-actions">
        <button class="btn-ghost" data-news-import="${escapeHTML(key)}" title="Read this article in the Reader with word lookups and AI analysis">📥 Import to Reader</button>
        <button class="mic-btn" data-mic-text="${escapeHTML(item.title)}" title="Read aloud challenge">🎙️ Read aloud</button>
      </div>
    </div>`;
}

const newsDate = date => (/^\d{4}-\d{2}-\d{2}$/.test(date)
  ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');

// Cards for headlines with a publisher and date (market and China news), or '' when there are none
function renderHeadlines(list, keyPrefix) {
  const items = (Array.isArray(list) ? list : [])
    .map(item => ({ title: String(item?.title || '').trim(), url: safeNewsUrl(item?.url),
      publisher: String(item?.publisher || ''), date: String(item?.date || '') }))
    .filter(item => item.title && item.url);
  items.forEach((item, index) => aiNewsItems.set(`${keyPrefix}:${index}`, item));
  return items.map((item, index) => articleCard(item, `${keyPrefix}:${index}`,
    [item.publisher || newsHost(item.url), newsDate(item.date)].filter(Boolean).join(' · '))).join('');
}

// US markets: one group per ticker or topic (SPY, QQQ, … Grok), as listed in news.json
function renderMarkets(list) {
  const topics = (Array.isArray(list) ? list : []).filter(topic => MARKET_KEY.test(topic?.key || ''));
  document.getElementById('newsMarkets').innerHTML = topics.length ? topics.map(topic => `<div class="news-topic">
      <h4>${escapeHTML(String(topic.label || topic.key))}</h4>
      <div class="news-list">${renderHeadlines(topic.items, `mk:${topic.key}`) || '<p class="hint">No readable news this week.</p>'}</div>
    </div>`).join('') : '<p class="hint">No items yet.</p>';
}

// BBC 6 Minute English: a conversation with a transcript and audio, so it is imported as one, with its player
function renderBBCEpisodes(list) {
  const episodes = (Array.isArray(list) ? list : [])
    .map(item => ({ title: String(item?.title || '').trim(), url: safeNewsUrl(item?.url), date: String(item?.date || ''),
      description: String(item?.description || ''), audioUrl: /^https:\/\//.test(item?.audioUrl || '') ? item.audioUrl : '' }))
    .filter(item => item.title && item.url);
  episodes.forEach((item, index) => aiNewsItems.set(`bbc:${index}`, { ...item, type: 'conversation' }));
  document.getElementById('newsBBC').innerHTML = episodes.length ? episodes.map((item, index) => episodeCard(item, `bbc:${index}`)).join('')
    : '<p class="hint">No episodes in the last 30 days. / 最近 30 天没有新节目。</p>';
}

function episodeCard(item, key) {
  const date = newsDate(item.date);
  return `<div class="news-card-wrap">
      <a class="news-card" href="${escapeHTML(item.url)}" target="_blank" rel="noopener">
        <div class="news-card-title">${escapeHTML(item.title)}</div>
        ${item.description ? `<div class="news-card-desc">${escapeHTML(item.description)}</div>` : ''}
        <div class="news-card-meta">${escapeHTML([date, item.audioUrl ? '🎧 audio + transcript' : 'transcript'].filter(Boolean).join(' · '))} ↗</div>
      </a>
      <div class="news-card-actions">
        <button class="btn-ghost" data-news-import="${escapeHTML(key)}" title="Read the transcript in the Reader, with the audio, word lookups and AI analysis">📥 Import to Reader</button>
        <button class="mic-btn" data-mic-text="${escapeHTML(item.title)}" title="Read aloud challenge">🎙️ Read aloud</button>
      </div>
    </div>`;
}

function repoCard(repo) {
  const stars = repo.stars >= 1000 ? `${(repo.stars / 1000).toFixed(1)}k` : (repo.stars ?? '');
  return `<a class="news-card" href="${escapeHTML(repo.url)}" target="_blank" rel="noopener">
      <div class="news-card-title">${escapeHTML(repo.name || '')} <span class="news-stars">★ ${escapeHTML(String(stars))}</span></div>
      <div class="news-card-desc">${escapeHTML(repo.description || '')}</div>
      <div class="news-card-meta">${escapeHTML(repo.language || '')}</div>
    </a>`;
}

function onAINewsClick(event) {
  const importButton = event.target.closest('[data-news-import]');
  if (importButton) {
    const item = aiNewsItems.get(importButton.dataset.newsImport);
    if (item) importArticleFromLink(item.url, { openReader: true, ...(item.type ? { type: item.type, audioUrl: item.audioUrl } : {}) });
    return;
  }
  const mic = event.target.closest('[data-mic-text]');
  if (mic) {
    event.preventDefault();
    openReadAloud(mic.dataset.micText);
  }
}

// The News tab loads its headlines when shown (showView in app.js calls loadAINews)
function initAINews() {
  document.getElementById('view-news').addEventListener('click', onAINewsClick);
  document.getElementById('newsRefreshBtn').addEventListener('click', () => loadAINews(true));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAINews);
else initAINews();
