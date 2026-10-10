'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = () => import('../scripts/bbc-six-minute.mjs');

// The list page's markup for one episode (shortened, made-up titles)
const card = (code, title, teaser, size = 'featured') => `<div class="widget-bbcle-coursecontentlist-${size}">
  <div class="img"><a href="/learningenglish/english/features/6-minute-english_20${code.slice(0, 2)}/ep-${code}"><img src="x.jpg" alt="" /></a></div>
  <div class="text">\t\n\t<h2><a  href="/learningenglish/english/features/6-minute-english_20${code.slice(0, 2)}/ep-${code}">${title}</a></h2>
  <div class="details"><h3><b>Episode ${code} </b> / some date </h3><p>${teaser}</p></div></div></div>`;
const listPage = [
  '<a href="/learningenglish/english/features/6-minute-english">6 Minute English</a>',
  card('261008', 'Are people &amp; pets happier?', 'Do you have a pet?'),
  card('261001', 'Why does music move us?', 'What do you listen to?', 'standard'),
  card('260924', 'An older episode', 'Too old for the list', 'standard'),
  card('261001', 'Why does music move us?', 'What do you listen to?', 'standard'),
].join('\n');

test('episodes from the last 10 days are listed newest first, with date, teaser and full link', async () => {
  const { parseEpisodeList } = await core();
  const episodes = parseEpisodeList(listPage, new Date('2026-10-10T06:00:00Z'));
  assert.deepEqual(episodes, [
    { title: 'Are people & pets happier?', url: 'https://www.bbc.co.uk/learningenglish/english/features/6-minute-english_2026/ep-261008',
      date: '2026-10-08', description: 'Do you have a pet?' },
    { title: 'Why does music move us?', url: 'https://www.bbc.co.uk/learningenglish/english/features/6-minute-english_2026/ep-261001',
      date: '2026-10-01', description: 'What do you listen to?' },
  ]);
});

test('the number of days can be changed, and a page without episodes gives an empty list', async () => {
  const { parseEpisodeList } = await core();
  assert.equal(parseEpisodeList(listPage, new Date('2026-10-10T06:00:00Z'), 30).length, 3);
  assert.deepEqual(parseEpisodeList('<html>Sorry, something went wrong</html>', new Date('2026-10-10T06:00:00Z')), []);
});

test('the episode audio is the BBC download MP3, and nothing else', async () => {
  const { parseEpisodeAudio } = await core();
  const page = '<a href="https://example.com/x.mp3">x</a><a href="https://downloads.bbc.co.uk/learningenglish/features/6min/261008_6_minute_english_pets_download.mp3">Download</a>';
  assert.equal(parseEpisodeAudio(page), 'https://downloads.bbc.co.uk/learningenglish/features/6min/261008_6_minute_english_pets_download.mp3');
  assert.equal(parseEpisodeAudio('<p>No audio</p>'), '');
});
