'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const feeds = () => import('../scripts/news-feeds.mjs');
const NOW = new Date('2026-10-11T06:00:00Z');

const rssItem = ({ title, link, date = 'Sat, 10 Oct 2026 20:00:00 GMT', source = '', sourceUrl = '' }) => `<item>
  <title>${title}</title><link>${link}</link><pubDate>${date}</pubDate>
  ${source ? `<source url="${sourceUrl}">${source}</source>` : ''}<description>&lt;p&gt;Teaser&lt;/p&gt;</description></item>`;
const rss = items => `<?xml version="1.0"?><rss><channel><title>Feed</title>${items.join('')}</channel></rss>`;

test('RSS items are read with title, link, date and publisher; entities and CDATA are decoded', async () => {
  const { parseRSS } = await feeds();
  const xml = rss([
    rssItem({ title: '<![CDATA[Nvidia & AMD rally]]>', link: 'https://www.cnbc.com/2026/10/10/chips.html' }),
    rssItem({ title: 'Apple &amp; the iPhone 18 - CNBC', link: 'https://news.google.com/rss/articles/CBMiAbc?oc=5', source: 'CNBC', sourceUrl: 'https://www.cnbc.com' }),
    '<item><title>No link</title></item>',
  ]);
  assert.deepEqual(parseRSS(xml), [
    { title: 'Nvidia & AMD rally', url: 'https://www.cnbc.com/2026/10/10/chips.html', date: '2026-10-10T20:00:00.000Z', publisher: '', publisherUrl: '' },
    { title: 'Apple & the iPhone 18', url: 'https://news.google.com/rss/articles/CBMiAbc?oc=5', date: '2026-10-10T20:00:00.000Z', publisher: 'CNBC', publisherUrl: 'https://www.cnbc.com' },
  ]);
});

test('only publishers whose articles the Reader can import are kept; paywalled and blocked sites are not', async () => {
  const { isReadableArticle } = await feeds();
  ['https://www.cnbc.com/2026/10/10/a.html', 'https://apnews.com/article/x', 'https://www.theguardian.com/world/2026/oct/10/x',
    'https://www.bbc.co.uk/news/articles/x', 'https://www.bbc.com/news/articles/x', 'https://www.theverge.com/x', 'https://techcrunch.com/2026/10/10/x/',
    'https://gizmodo.com/grok-bot-2000823057']
    .forEach(url => assert.equal(isReadableArticle(url), true, url));
  ['https://finance.yahoo.com/news/x.html', 'https://www.reuters.com/x', 'https://www.wsj.com/x', 'https://www.cnbc.com/investingclub/2026/10/09/x.html',
    'https://www.cnbc.com/pro/x.html', 'http://www.cnbc.com/2026/a.html', 'https://news.google.com/rss/articles/x', 'not a url']
    .forEach(url => assert.equal(isReadableArticle(url), false, url));
});

test('pages that are not articles to read (quotes, videos, photos, audio, live blogs, section fronts) are left out', async () => {
  const { isReadableArticle } = await feeds();
  ['https://www.cnbc.com/quotes/GOOGL', 'https://www.cnbc.com/video/2026/10/10/meta.html', 'https://www.cnbc.com/meta/',
    'https://www.theguardian.com/lifeandstyle/picture/2026/oct/10/cartoon', 'https://www.theguardian.com/world/gallery/2026/oct/10/x',
    'https://www.theguardian.com/news/audio/2026/oct/10/x', 'https://www.theguardian.com/business/live/2026/oct/10/x',
    'https://www.theguardian.com/world/china', 'https://www.bbc.co.uk/news/videos/c1']
    .forEach(url => assert.equal(isReadableArticle(url), false, url));
});

test('each topic keeps its newest 3 headlines from the last 7 days that really mention it, and an article is used only once', async () => {
  const { collectTopic, TOPICS } = await feeds();
  const nvda = TOPICS.find(t => t.key === 'NVDA');
  const meta = TOPICS.find(t => t.key === 'META');
  const noWeb = async () => { throw new Error('direct links need no lookup'); };
  const pickTopicItems = (candidates, topic, { now, seen }) => collectTopic(candidates, topic, { now, seen, fetchText: noWeb, google: { failures: 0 } });
  const item = (title, date, url = `https://www.cnbc.com/2026/10/10/${encodeURIComponent(title)}.html`) => ({ title, url, date, publisher: 'CNBC' });
  const candidates = [
    item('Nvidia hits a record', '2026-10-10T10:00:00.000Z'),
    item('Nvidia and TSMC expand', '2026-10-09T10:00:00.000Z'),
    item('Why Nvidia stock fell', '2026-10-10T12:00:00.000Z'),
    item('Nvidia earnings preview', '2026-10-08T10:00:00.000Z'),
    item('Old Nvidia story', '2026-10-01T10:00:00.000Z'),
    item('Chip stocks rally', '2026-10-10T11:00:00.000Z'),
  ];
  const seen = new Set();
  assert.deepEqual((await pickTopicItems(candidates, nvda, { now: NOW, seen })).map(i => i.title),
    ['Why Nvidia stock fell', 'Nvidia hits a record', 'Nvidia and TSMC expand']);
  assert.deepEqual((await pickTopicItems(candidates, nvda, { now: NOW, seen })).map(i => i.title), ['Nvidia earnings preview'], 'Already used articles are skipped');
  assert.deepEqual((await pickTopicItems([item('A metadata guide', '2026-10-10T10:00:00.000Z'), item('Meta shares rise', '2026-10-10T09:00:00.000Z')], meta, { now: NOW, seen: new Set() }))
    .map(i => i.title), ['Meta shares rise'], '"Meta" must be the company, not part of another word');
});

test('Google lookups are limited: a few per topic, and none after Google keeps failing', async () => {
  const { collectTopic, TOPICS, MAX_LOOKUPS_PER_TOPIC, GOOGLE_FAILURE_LIMIT } = await feeds();
  const nvda = TOPICS.find(t => t.key === 'NVDA');
  const googleItems = count => Array.from({ length: count }, (_, i) => ({
    title: `Nvidia story ${i}`, url: `https://news.google.com/rss/articles/N${i}`, date: '2026-10-10T10:00:00.000Z', publisher: 'CNBC' }));
  let calls = 0;
  const blocked = async () => { calls += 1; throw new Error('HTTP 429'); };
  const google = { failures: 0 };
  assert.deepEqual(await collectTopic(googleItems(30), nvda, { now: NOW, seen: new Set(), fetchText: blocked, google }), []);
  assert.equal(calls, GOOGLE_FAILURE_LIMIT, 'Stops asking Google once it keeps failing');
  assert.deepEqual(await collectTopic(googleItems(30), nvda, { now: NOW, seen: new Set(), fetchText: blocked, google }), []);
  assert.equal(calls, GOOGLE_FAILURE_LIMIT, 'and does not ask again for the next topic');

  let lookups = 0;
  const notReadable = async (url, options = {}) => {
    if (options.method === 'POST') {
      lookups += 1;
      return `)]}'\n\n${JSON.stringify([['wrb.fr', 'Fbv4je', JSON.stringify(['garturlres', 'https://finance.yahoo.com/x.html', 1])]])}`;
    }
    return '<div data-n-a-sg="S" data-n-a-ts="1"></div>';
  };
  await collectTopic(googleItems(30), nvda, { now: NOW, seen: new Set(), fetchText: notReadable, google: { failures: 0 } });
  assert.equal(lookups, MAX_LOOKUPS_PER_TOPIC, 'At most a few Google links are looked up per topic');
});

test('a topic that comes back empty keeps its headlines from the day before while they are recent', async () => {
  const { keepRecentTopics } = await feeds();
  const today = [{ key: 'NVDA', label: 'NVDA', items: [{ title: 'New', url: 'https://www.cnbc.com/2026/10/11/new.html', publisher: 'CNBC', date: '2026-10-11' }] },
    { key: 'AAPL', label: 'AAPL', items: [] }, { key: 'GROK', label: 'Grok', items: [] }, { key: 'META', label: 'META', items: [] }];
  const yesterday = [{ key: 'AAPL', label: 'AAPL', items: [{ title: 'Apple story', url: 'https://www.theverge.com/a', publisher: 'The Verge', date: '2026-10-09' }] },
    { key: 'GROK', label: 'Grok', items: [{ title: 'Old Grok story', url: 'https://gizmodo.com/g', publisher: 'Gizmodo', date: '2026-09-20' }] },
    { key: 'META', label: 'META', items: 'not a list' }];
  const kept = keepRecentTopics(today, yesterday, NOW);
  assert.deepEqual(kept.map(t => [t.key, t.items.map(i => i.title)]),
    [['NVDA', ['New']], ['AAPL', ['Apple story']], ['GROK', []], ['META', []]]);
  assert.deepEqual(keepRecentTopics(today, undefined, NOW), today, 'Without an older file nothing changes');
});

test('one odd feed entry does not lose the rest of the feed', async () => {
  const { parseRSS, buildChina } = await feeds();
  const xml = rss([rssItem({ title: 'Bad character &#99999999; here', link: 'https://www.cnbc.com/2026/10/10/a.html' }),
    rssItem({ title: 'Good story', link: 'https://www.cnbc.com/2026/10/10/b.html' })]);
  assert.deepEqual(parseRSS(xml).map(i => i.title), ['Bad character � here', 'Good story']);

  const china = await buildChina(async url => (url.includes('bbci')
    ? rss([rssItem({ title: 'Broken link', link: 'https://www.bbc.co.uk:99999999/news/articles/x' }),
      rssItem({ title: 'BBC China story', link: 'https://www.bbc.co.uk/news/articles/c1' })])
    : rss([rssItem({ title: 'Guardian China story', link: 'https://www.theguardian.com/world/2026/oct/10/x' })])));
  assert.deepEqual(china.map(i => i.title).sort(), ['BBC China story', 'Guardian China story']);
});

test('a Google News link is turned into the real article link, and a failure gives an empty answer', async () => {
  const { resolveGoogleNewsLink } = await feeds();
  const calls = [];
  const fetchText = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.startsWith('https://news.google.com/rss/articles/')) return '<c-wiz><div data-n-a-sg="SIG" data-n-a-ts="1791600000"></div></c-wiz>';
    const inner = JSON.stringify(['garturlres', 'https://www.cnbc.com/2026/10/10/apple.html', 1]);
    return `)]}'\n\n${JSON.stringify([['wrb.fr', 'Fbv4je', inner]])}\n`;
  };
  assert.equal(await resolveGoogleNewsLink('https://news.google.com/rss/articles/CBMiAbc?oc=5', fetchText), 'https://www.cnbc.com/2026/10/10/apple.html');
  assert.deepEqual(calls.map(c => c.method), ['GET', 'POST']);
  assert.equal(calls[0].url, 'https://news.google.com/rss/articles/CBMiAbc');
  assert.equal(await resolveGoogleNewsLink('https://news.google.com/rss/articles/CBMiAbc', async () => { throw new Error('blocked'); }), '');
  assert.equal(await resolveGoogleNewsLink('https://news.google.com/rss/articles/CBMiAbc', async () => '<html>consent</html>'), '');
  assert.equal(await resolveGoogleNewsLink('https://www.cnbc.com/x.html', fetchText), 'https://www.cnbc.com/x.html', 'A direct link is kept');
});

// A fake web for buildMarkets: CNBC feeds, Google News searches, and Google's link service
function fakeWeb({ googleBlocked = false } = {}) {
  const google = {
    'https://news.google.com/rss/articles/APPLE1': 'https://www.cnbc.com/2026/10/10/apple-iphone.html',
    'https://news.google.com/rss/articles/APPLE2': 'https://finance.yahoo.com/news/apple.html',
    'https://news.google.com/rss/articles/GROK1': 'https://www.theverge.com/2026/10/10/grok.html',
  };
  return async (url, options = {}) => {
    if (url.includes('search.cnbc.com')) {
      return rss([rssItem({ title: 'Nvidia hits a record as chip stocks climb', link: 'https://www.cnbc.com/2026/10/10/nvidia.html' }),
        rssItem({ title: 'S&amp;P 500 closes higher', link: 'https://www.cnbc.com/2026/10/10/sp500.html' })]);
    }
    if (url.startsWith('https://news.google.com/rss/search')) {
      const query = decodeURIComponent(new URL(url).searchParams.get('q'));
      if (/Apple/.test(query)) {
        return rss([rssItem({ title: 'Apple cuts iPhone orders - CNBC', link: 'https://news.google.com/rss/articles/APPLE1?oc=5', source: 'CNBC', sourceUrl: 'https://www.cnbc.com' }),
          rssItem({ title: 'Apple stock dips - Yahoo Finance', link: 'https://news.google.com/rss/articles/APPLE2?oc=5', source: 'CNBC', sourceUrl: 'https://www.cnbc.com' }),
          rssItem({ title: 'Apple news - MarketBeat', link: 'https://news.google.com/rss/articles/APPLE3?oc=5', source: 'MarketBeat', sourceUrl: 'https://www.marketbeat.com' })]);
      }
      if (/Grok/.test(query)) return rss([rssItem({ title: 'xAI updates Grok - The Verge', link: 'https://news.google.com/rss/articles/GROK1?oc=5', source: 'The Verge', sourceUrl: 'https://www.theverge.com' })]);
      return rss([]);
    }
    if (googleBlocked) throw new Error('HTTP 429');
    if (url.startsWith('https://news.google.com/rss/articles/')) return `<div data-n-a-sg="S" data-n-a-ts="1"></div>`;
    if (url.includes('batchexecute')) {
      const id = JSON.parse(JSON.parse(new URLSearchParams(options.body).get('f.req'))[0][0][1])[2];
      const real = google[`https://news.google.com/rss/articles/${id}`];
      return real ? `)]}'\n\n${JSON.stringify([['wrb.fr', 'Fbv4je', JSON.stringify(['garturlres', real, 1])]])}` : ')]}\'\n\n[]';
    }
    throw new Error(`unexpected ${url}`);
  };
}

test('the markets section mixes CNBC and Google News, with real readable links only', async () => {
  const { buildMarkets } = await feeds();
  const markets = await buildMarkets(fakeWeb(), NOW);
  const byKey = Object.fromEntries(markets.map(topic => [topic.key, topic]));
  assert.deepEqual(markets.map(t => t.key), ['SPY', 'QQQ', 'SMH', 'NVDA', 'GOOGL', 'AAPL', 'META', 'GROK']);
  assert.deepEqual(byKey.AAPL.items, [{ title: 'Apple cuts iPhone orders', url: 'https://www.cnbc.com/2026/10/10/apple-iphone.html', publisher: 'CNBC', date: '2026-10-10' }],
    'Yahoo (not readable) and MarketBeat (not an allowed publisher) are dropped');
  assert.equal(byKey.GROK.items[0].url, 'https://www.theverge.com/2026/10/10/grok.html');
  assert.equal(byKey.NVDA.items[0].url, 'https://www.cnbc.com/2026/10/10/nvidia.html');
  assert.equal(byKey.SPY.items[0].title, 'S&P 500 closes higher');
  assert.deepEqual(byKey.QQQ.items, []);
  assert.ok(!byKey.SMH.items.some(i => i.url === byKey.NVDA.items[0].url), 'The Nvidia article is not repeated under chips');
});

test('when Google blocks the link service, the CNBC headlines are still there', async () => {
  const { buildMarkets } = await feeds();
  const markets = await buildMarkets(fakeWeb({ googleBlocked: true }), NOW);
  const byKey = Object.fromEntries(markets.map(topic => [topic.key, topic]));
  assert.deepEqual(byKey.AAPL.items, []);
  assert.equal(byKey.NVDA.items.length, 1);
});

test('China news: the newest stories from BBC and the Guardian, without repeats', async () => {
  const { buildChina } = await feeds();
  const fetchText = async url => {
    if (url.includes('bbci.co.uk')) {
      return rss([rssItem({ title: 'China trade story', link: 'https://www.bbc.co.uk/news/articles/c1?at_medium=RSS&amp;at_campaign=rss', date: 'Sat, 10 Oct 2026 08:00:00 GMT' }),
        rssItem({ title: 'Older BBC story', link: 'https://www.bbc.co.uk/news/articles/c2', date: 'Mon, 05 Oct 2026 08:00:00 GMT' })]);
    }
    return rss([rssItem({ title: 'China agrees to halve car exports', link: 'https://www.theguardian.com/business/2026/oct/09/china-cars', date: 'Fri, 09 Oct 2026 15:00:00 GMT' }),
      rssItem({ title: 'China trade story', link: 'https://www.theguardian.com/world/2026/oct/10/same', date: 'Sat, 10 Oct 2026 07:00:00 GMT' })]);
  };
  const china = await buildChina(fetchText);
  assert.deepEqual(china.map(i => [i.publisher, i.title, i.date]), [
    ['BBC', 'China trade story', '2026-10-10'],
    ['The Guardian', 'China agrees to halve car exports', '2026-10-09'],
    ['BBC', 'Older BBC story', '2026-10-05'],
  ]);
  assert.equal(china[0].url, 'https://www.bbc.co.uk/news/articles/c1', 'Tracking parameters are removed');
});

test('China news is shared between BBC and the Guardian, and one fills in when the other has too few', async () => {
  const { buildChina } = await feeds();
  const stories = (count, make) => rss(Array.from({ length: count }, (_, i) => make(i)));
  const hour = i => new Date(Date.UTC(2026, 9, 10, 20 - i)).toUTCString();
  const guardian = i => rssItem({ title: `Guardian story ${i}`, link: `https://www.theguardian.com/world/2026/oct/10/g${i}`, date: hour(i) });
  const bbc = i => rssItem({ title: `BBC story ${i}`, link: `https://www.bbc.co.uk/news/articles/b${i}`, date: hour(i + 10) });
  const count = list => list.reduce((totals, item) => ({ ...totals, [item.publisher]: (totals[item.publisher] || 0) + 1 }), {});

  const both = await buildChina(async url => (url.includes('bbci') ? stories(6, bbc) : stories(10, guardian)));
  assert.deepEqual(count(both), { 'The Guardian': 4, BBC: 4 }, 'The newer Guardian stories do not push BBC out');
  assert.deepEqual(both.map(i => i.date), [...both.map(i => i.date)].sort().reverse(), 'Newest first');

  const fewBBC = await buildChina(async url => (url.includes('bbci') ? stories(2, bbc) : stories(10, guardian)));
  assert.deepEqual(count(fewBBC), { 'The Guardian': 6, BBC: 2 });
});
