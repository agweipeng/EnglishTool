// BBC Learning English "6 Minute English": reads the episode list page and an episode page.
// Used by fetch-news.mjs for the News tab; only titles, links, dates, teasers and the audio link are kept.
// Episode links end in ep-YYMMDD, the date the episode came out.

export const LIST_URL = 'https://www.bbc.co.uk/learningenglish/english/features/6-minute-english';
const SITE = 'https://www.bbc.co.uk';
const DAY_MS = 86400000;
export const RECENT_DAYS = 10;

const EPISODE_CARD = /<h2[^>]*>\s*<a\s[^>]*?href="(\/learningenglish\/english\/features\/6-minute-english_\d{4}\/ep-(\d{2})(\d{2})(\d{2}))"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]*?)(?=<h2[\s>]|$)/g;
const AUDIO_LINK = /href="(https:\/\/downloads\.bbc\.co\.uk\/learningenglish\/[^"]+\.mp3)"/;

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
const plainText = html => decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// [{ title, url, date: 'YYYY-MM-DD', description }] from the last `days` days, newest first
export function parseEpisodeList(html, now = new Date(), days = RECENT_DAYS) {
  const oldest = new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);
  const byUrl = new Map();
  for (const [, path, yy, mm, dd, title, rest] of String(html || '').matchAll(EPISODE_CARD)) {
    const date = `20${yy}-${mm}-${dd}`;
    const url = SITE + path;
    if (date < oldest || byUrl.has(url) || !plainText(title)) continue;
    const teaser = /<p>([\s\S]*?)<\/p>/.exec(rest);
    byUrl.set(url, { title: plainText(title), url, date, description: teaser ? plainText(teaser[1]) : '' });
  }
  return [...byUrl.values()].sort((a, b) => b.date.localeCompare(a.date));
}

// The episode's MP3 on the BBC download server, or '' when the page has none
export function parseEpisodeAudio(html) {
  return AUDIO_LINK.exec(String(html || ''))?.[1] || '';
}
