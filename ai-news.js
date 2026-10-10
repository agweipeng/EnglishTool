/* News tab: daily AI headlines from news.json (written by .github/workflows/daily-news.yml).
   The articles are copyrighted, so the repository only stores links; "Import to Reader" fetches an
   article for you (article-import.js) into your private reading materials for word lookups and AI analysis. */
'use strict';

const AI_NEWS_SECTIONS = [
  { key: 'anthropic', id: 'newsAnthropic' },
  { key: 'openai', id: 'newsOpenAI' },
  { key: 'google', id: 'newsGoogle' },
];
const AI_NEWS_LIST_IDS = ['newsBBC', ...AI_NEWS_SECTIONS.map(section => section.id), 'newsGithub'];
let aiNewsCache = null;
let aiNewsItems = new Map();   // 'openai:0' → { title, url }; 'bbc:0' → { title, url, type, audioUrl }

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
  const repos = (Array.isArray(sources.github) ? sources.github : []).filter(repo => repo && safeNewsUrl(repo.url));
  document.getElementById('newsGithub').innerHTML = repos.length ? repos.map(repoCard).join('') : '<p class="hint">No items yet.</p>';
}

function articleCard(item, key) {
  return `<div class="news-card-wrap">
      <a class="news-card" href="${escapeHTML(item.url)}" target="_blank" rel="noopener">
        <div class="news-card-title">${escapeHTML(item.title)}</div>
        <div class="news-card-meta">${escapeHTML(newsHost(item.url))} ↗</div>
      </a>
      <div class="news-card-actions">
        <button class="btn-ghost" data-news-import="${escapeHTML(key)}" title="Read this article in the Reader with word lookups and AI analysis">📥 Import to Reader</button>
        <button class="mic-btn" data-mic-text="${escapeHTML(item.title)}" title="Read aloud challenge">🎙️ Read aloud</button>
      </div>
    </div>`;
}

// BBC 6 Minute English: a conversation with a transcript and audio, so it is imported as one, with its player
function renderBBCEpisodes(list) {
  const episodes = (Array.isArray(list) ? list : [])
    .map(item => ({ title: String(item?.title || '').trim(), url: safeNewsUrl(item?.url), date: String(item?.date || ''),
      description: String(item?.description || ''), audioUrl: /^https:\/\//.test(item?.audioUrl || '') ? item.audioUrl : '' }))
    .filter(item => item.title && item.url);
  episodes.forEach((item, index) => aiNewsItems.set(`bbc:${index}`, { ...item, type: 'conversation' }));
  document.getElementById('newsBBC').innerHTML = episodes.length ? episodes.map((item, index) => episodeCard(item, `bbc:${index}`)).join('')
    : '<p class="hint">No episodes in the last 10 days. / 最近 10 天没有新节目。</p>';
}

function episodeCard(item, key) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(item.date)
    ? new Date(`${item.date}T12:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';
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
