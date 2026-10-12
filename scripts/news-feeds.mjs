// News tab: US markets and China headlines for news.json (used by fetch-news.mjs, run by the daily GitHub Action).
// Only titles, links, publishers and dates are kept. Every link must be one the Reader's "Import to Reader" can
// read in full, so only open publishers are used; Google News links are turned into the real article link first.
// `fetchText(url, { method, body, headers })` is passed in, so the tests run without the network.

const DAY_MS = 86400000;
export const RECENT_DAYS = 7;
export const PER_TOPIC = 3;
export const CHINA_ITEMS = 8;
// Each Google News link costs two requests, so a topic looks up at most this many, and after this many
// failures in a row Google counts as down for the rest of the run (CNBC headlines are still used)
export const MAX_LOOKUPS_PER_TOPIC = 10;
export const GOOGLE_FAILURE_LIMIT = 5;

// Publishers whose articles import in full (tested); Yahoo Finance, Reuters, SCMP and paywalled sites do not
const READABLE_HOSTS = ['cnbc.com', 'apnews.com', 'theguardian.com', 'bbc.co.uk', 'bbc.com', 'theverge.com', 'techcrunch.com', 'gizmodo.com'];
// Where a publisher's articles live: CNBC's are dated (quotes, videos, Pro and Investing Club pages are not),
// and so are the Guardian's (section fronts are not)
const ARTICLE_PATHS = { 'cnbc.com': /^\/\d{4}\/\d{2}\/\d{2}\//, 'theguardian.com': /\/\d{4}\/[a-z]{3}\/\d{2}\// };
// Videos, photos, audio and live blogs have little text to read
const NON_ARTICLE_PATHS = /\/(videos?|picture|gallery|audio|live)\//;

const CNBC_FEED = id => `https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=${id}`;
// Top news, earnings, tech, business, finance, economy
const CNBC_FEEDS = [100003114, 15839135, 19854910, 10001147, 10000664, 20910258].map(CNBC_FEED);
const CHINA_FEEDS = [
  { url: 'https://feeds.bbci.co.uk/news/world/asia/china/rss.xml', publisher: 'BBC' },
  { url: 'https://www.theguardian.com/world/china/rss', publisher: 'The Guardian' },
];

// A headline counts for a topic only when its title really mentions it ("Meta" the company, not "metadata").
// Google News searches by title; combining a search with "site:" filters gave unrelated results, so the
// publishers are checked afterwards instead.
export const TOPICS = [
  { key: 'SPY', label: 'SPY · S&P 500', query: 'intitle:"S&P 500" OR intitle:"Wall Street" OR intitle:"stock market"', match: /S&P 500|\bSPY\b|Wall Street|[Ss]tock market|\bDow\b/ },
  { key: 'QQQ', label: 'QQQ · Nasdaq', query: 'intitle:Nasdaq', match: /Nasdaq|\bQQQ\b/i },
  { key: 'SMH', label: 'SMH · Chip stocks', query: 'intitle:chip OR intitle:chips OR intitle:chipmaker OR intitle:semiconductor', match: /semiconductor|\bchips?\b|chipmakers?|\bSMH\b|TSMC|Broadcom|\bAMD\b|Micron/i },
  { key: 'NVDA', label: 'NVDA · Nvidia', query: 'intitle:Nvidia', match: /Nvidia|\bNVDA\b/i },
  { key: 'GOOGL', label: 'GOOGL · Google', query: 'intitle:Google OR intitle:Alphabet', match: /Google|Alphabet|\bGOOGL?\b/ },
  { key: 'AAPL', label: 'AAPL · Apple', query: 'intitle:Apple OR intitle:iPhone', match: /\bApple\b|iPhone|\bAAPL\b/ },
  { key: 'META', label: 'META · Meta', query: 'intitle:Meta OR intitle:Zuckerberg', match: /\bMeta\b|\bMETA\b|Zuckerberg|Instagram/ },
  { key: 'GROK', label: 'Grok · xAI', query: 'intitle:Grok OR intitle:xAI', match: /\bGrok\b|\bxAI\b/ },
];
// Companies pick first, so an Nvidia story is listed under Nvidia rather than under chip stocks or the market
const PICK_ORDER = ['NVDA', 'GOOGL', 'AAPL', 'META', 'GROK', 'SMH', 'QQQ', 'SPY'];

// A character reference outside Unicode becomes the replacement character instead of failing the whole feed
const codePoint = n => (n >= 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : '�');
function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
const field = (xml, tag) => {
  const found = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  if (!found) return '';
  const raw = found[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(raw);
  return (cdata ? cdata[1] : decodeEntities(raw)).replace(/\s+/g, ' ').trim();
};
const isoDate = text => (Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : '');
const day = iso => iso.slice(0, 10);

// [{ title, url, date (ISO), publisher, publisherUrl }]; Google News adds " - Publisher" to titles, which is removed
export function parseRSS(xml) {
  return [...String(xml || '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const publisher = field(item, 'source');
    const publisherUrl = decodeEntities((/<source\b[^>]*\burl="([^"]*)"/.exec(item) || [])[1] || '');
    const title = field(item, 'title');
    const suffix = publisher ? ` - ${publisher}` : '';
    return {
      title: suffix && title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title,
      url: field(item, 'link'),
      date: isoDate(field(item, 'pubDate')),
      publisher,
      publisherUrl,
    };
  }).filter(item => item.title && /^https?:\/\//.test(item.url));
}

const hostOf = url => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};
const isReadableHost = url => READABLE_HOSTS.includes(hostOf(url));

// True for an https link the Reader can import in full
export function isReadableArticle(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:' || !isReadableHost(url) || NON_ARTICLE_PATHS.test(parsed.pathname)) return false;
  const articlePath = ARTICLE_PATHS[hostOf(url)];
  return !articlePath || articlePath.test(parsed.pathname);
}

// The article a Google News link points to, or '' when Google doesn't say. Uses the same service as the
// Google News page; links that are not Google News links are returned unchanged.
export async function resolveGoogleNewsLink(link, fetchText) {
  if (hostOf(link) !== 'news.google.com') return link;
  try {
    const id = new URL(link).pathname.split('/').pop();
    const page = await fetchText(`https://news.google.com/rss/articles/${id}`);
    const signature = /data-n-a-sg="([^"]+)"/.exec(page)?.[1];
    const timestamp = /data-n-a-ts="([^"]+)"/.exec(page)?.[1];
    if (!signature || !timestamp) return '';
    const request = ['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1],
      'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(timestamp), signature];
    const body = new URLSearchParams({ 'f.req': JSON.stringify([[['Fbv4je', JSON.stringify(request), null, 'generic']]]) }).toString();
    const reply = await fetchText('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    });
    const url = JSON.parse(JSON.parse(reply.split('\n\n')[1])[0][2])[1];
    return typeof url === 'string' && /^https:\/\//.test(url) ? url : '';
  } catch {
    return '';
  }
}

const titleKey = title => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isUnused = (item, seen) => !seen.has(item.url) && !seen.has(titleKey(item.title));
const markUsed = (item, seen) => { seen.add(item.url); seen.add(titleKey(item.title)); };

const oldestDate = now => new Date(now.getTime() - RECENT_DAYS * DAY_MS).toISOString();

// The headlines that may go under a topic: recent, about it, not used yet; newest first
function eligible(candidates, topic, { now, seen }) {
  const oldest = oldestDate(now);
  return candidates.filter(item => item.date >= oldest && topic.match.test(item.title) && isUnused(item, seen))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// The newest PER_TOPIC readable headlines of a topic, marked as used. Google News links are looked up one by
// one (at most MAX_LOOKUPS_PER_TOPIC); `google.failures` counts failed lookups in a row across topics.
export async function collectTopic(candidates, topic, { now, seen, fetchText, google, pauseMs = 0 }) {
  const picked = [];
  let lookups = 0;
  for (const candidate of eligible(candidates, topic, { now, seen })) {
    if (picked.length >= PER_TOPIC) break;
    const isGoogle = hostOf(candidate.url) === 'news.google.com';
    if (isGoogle && (lookups >= MAX_LOOKUPS_PER_TOPIC || google.failures >= GOOGLE_FAILURE_LIMIT)) continue;
    if (isGoogle && pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
    const url = await resolveGoogleNewsLink(candidate.url, fetchText);
    if (isGoogle) {
      lookups += 1;
      google.failures = url ? 0 : google.failures + 1;
    }
    const item = { ...candidate, url };
    if (!isReadableArticle(url) || !isUnused(item, seen)) continue;
    markUsed(item, seen);
    markUsed(candidate, seen);
    picked.push({ title: item.title, url, publisher: item.publisher, date: day(item.date) });
  }
  return picked;
}

async function readFeed(url, fetchText) {
  try {
    return parseRSS(await fetchText(url));
  } catch (error) {
    console.warn(`Feed failed: ${url} (${error.message})`);
    return [];
  }
}

const googleSearch = topic => {
  const query = `${topic.query} when:${RECENT_DAYS}d`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
};

// [{ key, label, items: [{ title, url, publisher, date: 'YYYY-MM-DD' }] }] in TOPICS order
export async function buildMarkets(fetchText, now = new Date(), { pauseMs = 0 } = {}) {
  const cnbc = (await Promise.all(CNBC_FEEDS.map(url => readFeed(url, fetchText)))).flat()
    .map(item => ({ ...item, publisher: 'CNBC' }))
    .filter(item => isReadableArticle(item.url));
  const seen = new Set();
  const google = { failures: 0 };
  const itemsByKey = {};
  for (const key of PICK_ORDER) {
    const topic = TOPICS.find(t => t.key === key);
    const searched = (await readFeed(googleSearch(topic), fetchText)).filter(item => isReadableHost(item.publisherUrl));
    itemsByKey[key] = await collectTopic([...searched, ...cnbc], topic, { now, seen, fetchText, google, pauseMs });
  }
  return TOPICS.map(({ key, label }) => ({ key, label, items: itemsByKey[key] }));
}

// When a topic comes back empty (e.g. Google News was down), its headlines from the previous news.json are
// kept as long as they are still from the last RECENT_DAYS days
export function keepRecentTopics(markets, previous, now = new Date()) {
  if (!Array.isArray(previous)) return markets;
  const oldest = oldestDate(now).slice(0, 10);
  return markets.map(topic => {
    if (topic.items.length) return topic;
    const before = previous.find(old => old?.key === topic.key);
    const items = (Array.isArray(before?.items) ? before.items : []).filter(item => String(item?.date || '') >= oldest);
    return { ...topic, items };
  });
}

// The newest stories, at most an equal share from each publisher unless another one has too few; newest first
function shareByPublisher(stories, limit, publishers) {
  const share = Math.ceil(limit / publishers);
  const fair = stories.filter(story => stories.filter(s => s.publisher === story.publisher).indexOf(story) < share);
  const rest = stories.filter(story => !fair.includes(story));
  return [...fair, ...rest].slice(0, limit).sort((a, b) => b.date.localeCompare(a.date));
}

// The newest China stories from BBC and the Guardian: [{ title, url, publisher, date: 'YYYY-MM-DD' }]
export async function buildChina(fetchText) {
  const withoutTracking = url => {
    try { const clean = new URL(url); clean.search = ''; clean.hash = ''; return clean.href; } catch { return ''; }
  };
  const stories = (await Promise.all(CHINA_FEEDS.map(async feed => (await readFeed(feed.url, fetchText))
    .map(item => ({ ...item, url: withoutTracking(item.url), publisher: feed.publisher })))))
    .flat()
    .filter(item => item.date && isReadableArticle(item.url))
    .sort((a, b) => b.date.localeCompare(a.date));
  const seen = new Set();
  const unique = stories.filter(story => {
    if (!isUnused(story, seen)) return false;
    markUsed(story, seen);
    return true;
  });
  return shareByPublisher(unique, CHINA_ITEMS, CHINA_FEEDS.length)
    .map(story => ({ title: story.title, url: story.url, publisher: story.publisher, date: day(story.date) }));
}
