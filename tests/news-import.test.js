'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const core = () => import('../scripts/news-import-core.mjs');
const sentence = 'Researchers say the new results could change how cities plan for hotter summers. ';
const longParagraph = sentence.repeat(35);

function conversationEntry({ id = 293729, slug = 'heat-and-cities', title = 'Heat &amp; cities', published = '2026-10-07T15:20:48Z', body = `&lt;p&gt;${longParagraph}&lt;/p&gt;` } = {}) {
  return `<entry><id>tag:theconversation.com,2011:article/${id}</id><published>${published}</published>
    <link rel="alternate" type="text/html" href="https://theconversation.com/${slug}-${id}"/>
    <title>${title}</title><author><name>Josephine Bourner, University of Oxford</name></author>
    <content type="html">${body}</content></entry>`;
}

test('article HTML becomes clean paragraphs without images, captions, players or tables', async () => {
  const { htmlToParagraphs } = await core();
  const html = `<figure><img src="x.jpg"/><figcaption>A caption</figcaption></figure>
    <p>First &ldquo;quoted&rdquo; line<br/>continues.</p><h2>A heading</h2>
    <table><tr><td><p>cell</p></td></tr></table><p class="ta-c">No media source currently available</p>
    <ul><li>One <a href="#">point</a></li></ul><img src="https://counter.theconversation.com/count.gif"/><p> </p>`;
  assert.deepEqual(htmlToParagraphs(html), ['First “quoted” line continues.', 'A heading', 'One point']);
});

test('The Conversation feed keeps full articles verbatim with author, date and link', async () => {
  const { parseConversationFeed } = await core();
  const disclosure = '&lt;p class="fine-print"&gt;&lt;em&gt;The author has disclosed no relevant affiliations.&lt;/em&gt;&lt;/p&gt;';
  const xml = `<feed>${conversationEntry({ body: `&lt;p&gt;${longParagraph}&lt;/p&gt;${disclosure}` })}
    ${conversationEntry({ id: 1, slug: 'podcast', body: '&lt;p&gt;Listen to the podcast.&lt;/p&gt;' })}</feed>`;
  const [article, ...rest] = parseConversationFeed(xml);
  assert.equal(rest.length, 0, 'Very short items such as podcast notes are skipped');
  assert.equal(article.id, 'heat-and-cities-293729');
  assert.equal(article.title, 'Heat & cities');
  assert.equal(article.author, 'Josephine Bourner, University of Oxford');
  assert.equal(article.published, '2026-10-07T15:20:48Z');
  assert.equal(article.url, 'https://theconversation.com/heat-and-cities-293729');
  assert.equal(article.text, `${longParagraph.trim()}\n\nThe author has disclosed no relevant affiliations.`, 'Nothing is reworded (CC BY-ND)');
});

test('VOA RSS items and article pages give the article text and its audio', async () => {
  const { parseRssItems, parseVoaArticle } = await core();
  const rss = `<rss><channel><title>Education - Voice of America</title>
    <item><title>Grow Your Vocabulary </title><link>https://learningenglish.voanews.com/a/grow-your-vocabulary/4113426.html</link>
    <pubDate>Tue, 04 Mar 2025 22:00:39 +0000</pubDate></item></channel></rss>`;
  assert.deepEqual(parseRssItems(rss), [{ title: 'Grow Your Vocabulary', url: 'https://learningenglish.voanews.com/a/grow-your-vocabulary/4113426.html', published: '2025-03-04T22:00:39.000Z' }]);
  const page = `<h1 class="title pg-title">\n  Grow Your Vocabulary\n</h1><audio src="https://voa-audio.voanews.eu/vle/a.mp3"></audio>
    <div class="wsw"><div class="wsw__embed"><div class="c-mmp"><h3>Grow Your Vocabulary</h3><div><p class="ta-c">No media source currently available</p></div>
      <ul><li><a href="a_hq.mp3">128 kbps | MP3</a></li><li><a href="a.mp3">64 kbps | MP3</a></li></ul></div></div>
    <p>${longParagraph}</p><p>John Roe wrote this story for Learning English.</p><h2>Words in This Story</h2><p><strong>root</strong> - <em>n.</em> the basic part of a word</p></div>
    <div class="footer-toolbar"><p>Share this page with friends now</p></div>`;
  const article = parseVoaArticle(page);
  assert.equal(article.title, 'Grow Your Vocabulary');
  assert.equal(article.audioUrl, 'https://voa-audio.voanews.eu/vle/a.mp3');
  assert.equal(article.text, `${longParagraph.trim()}\n\nJohn Roe wrote this story for Learning English.\n\nWords in This Story\n\nroot - n. the basic part of a word`);
  assert.equal(parseVoaArticle(page.replace('John Roe wrote this story for Learning English.', '')), null, 'Without a VOA byline the text may not be VOA’s own work');
  assert.equal(parseVoaArticle(page.replace('John Roe wrote', 'AP reported and John Roe wrote')), null);
  assert.equal(parseVoaArticle('<h1>Video only</h1><div class="wsw"><p>Watch the video.</p></div>'), null, 'Audio or video pages without a transcript are skipped');
  const adapted = page.replace('John Roe wrote this story for Learning English.', 'Jane Doe reported this story for the Associated Press. John Roe adapted it for Learning English.');
  assert.equal(parseVoaArticle(adapted), null, 'Stories adapted from news-agency reports are not public domain, so they are skipped');
});

test('feed parsing tolerates attribute order and skips broken entries, podcasts and articles it cannot show in full', async () => {
  const { parseConversationFeed, htmlToParagraphs } = await core();
  const reordered = conversationEntry().replace('rel="alternate" type="text/html" href="https://theconversation.com/heat-and-cities-293729"', 'href="https://theconversation.com/heat-and-cities-293729" rel="alternate"');
  const noTitle = conversationEntry({ id: 2, slug: 'untitled', title: '' });
  const noLink = conversationEntry({ id: 3, slug: 'x' }).replace(/<link[^>]*>/, '');
  const podcast = conversationEntry({ id: 4, slug: 'podcast', body: `&lt;p&gt;${longParagraph}&lt;/p&gt;&lt;p&gt;This episode of The Conversation Weekly was produced by A.&lt;/p&gt;` });
  const withTable = conversationEntry({ id: 5, slug: 'table', body: `&lt;p&gt;${longParagraph}&lt;/p&gt;&lt;table&gt;&lt;tr&gt;&lt;td&gt;Data&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;` });
  const withAside = conversationEntry({ id: 6, slug: 'aside', body: `&lt;p&gt;${longParagraph}&lt;/p&gt;&lt;aside&gt;Read more&lt;/aside&gt;` });
  const articles = parseConversationFeed(`<feed>${reordered}${noTitle}${noLink}${podcast}${withTable}${withAside}</feed>`);
  assert.deepEqual(articles.map(a => a.id), ['heat-and-cities-293729']);
  assert.deepEqual(htmlToParagraphs('<blockquote><p>Quote one.</p><p>Quote two.</p></blockquote><p>Caf&eacute; &pound;5</p>'), ['Quote one. Quote two.', 'Café £5']);
});

test('article IDs are stable, safe slugs', async () => {
  const { articleId } = await core();
  assert.equal(articleId('https://theconversation.com/heat-and-cities-293729'), 'heat-and-cities-293729');
  assert.equal(articleId('https://learningenglish.voanews.com/a/grow-your-vocabulary/4113426.html'), 'grow-your-vocabulary-4113426');
  assert.equal(articleId('https://learningenglish.voanews.com/a/8010609.html'), '8010609');
  const long = articleId(`https://theconversation.com/${'very-long-title-'.repeat(10)}293729`);
  assert.ok(long.length <= 80 && long.endsWith('-293729'), long);
});

test('a news package keeps the newest articles, merges with the previous package and validates like a book', async () => {
  const { buildNewsPackage } = await core();
  const { create } = require('../book-repository.js');
  const meta = { id: 'the-conversation', title: 'The Conversation', titleCN: '对话', author: 'The Conversation', language: 'en', genre: 'News',
    readingStage: 'Daily news', readingOrder: 20, sourceUrl: 'https://theconversation.com', license: 'CC BY-ND 4.0', recommendation: 'Daily.' };
  const article = (id, day, title = `Story ${id}`) => ({ id, title, author: 'A Writer', published: `2026-10-0${day}T10:00:00Z`, url: `https://theconversation.com/${id}`, text: longParagraph.trim() });
  const first = buildNewsPackage(meta, [article('a-1', 1), article('b-2', 2)], [], 2);
  assert.deepEqual(first.chapters.map(c => [c.id, c.number]), [['b-2', 1], ['a-1', 2]], 'Newest first');
  const second = buildNewsPackage(meta, [article('c-3', 3), article('b-2', 2, 'Story b, corrected')], first.chapters, 2);
  assert.deepEqual(second.chapters.map(c => c.id), ['c-3', 'b-2'], 'Oldest article drops out of a full package');
  assert.equal(second.chapters[1].title, 'Story b, corrected');
  assert.equal(buildNewsPackage(meta, [], first.chapters, 2).manifest.version, first.manifest.version, 'No new articles means no change to commit');
  const { manifest, chapters } = second;
  assert.equal(manifest.sectionType, 'article');
  assert.equal(manifest.kind, 'news');
  assert.equal(manifest.latestArticle, '2026-10-03T10:00:00Z', 'The shelf can show how fresh the news is');
  assert.ok(!('text' in manifest.chapters[0]) && manifest.chapters[0].path === 'books/the-conversation/chapters/c-3.json');
  const catalog = { schemaVersion: 1, books: [{ id: manifest.id, sectionCount: chapters.length, manifestPath: `books/${manifest.id}/manifest.json` }] };
  const files = { [`books/${manifest.id}/manifest.json`]: manifest, ...Object.fromEntries(chapters.map(c => [`books/${manifest.id}/chapters/${c.id}.json`, c])) };
  const repository = create({ catalog, loadJSON: async path => files[path] });
  assert.equal((await repository.getChapter(manifest.id, 'c-3')).text, longParagraph.trim());
});

test('a news package refuses articles that are unsafe or incomplete', async () => {
  const { buildNewsPackage } = await core();
  const meta = { id: 'voa', title: 'VOA', author: 'VOA', sourceUrl: 'https://learningenglish.voanews.com', license: 'Public domain' };
  const good = { id: 'ok-1', title: 'Fine', author: '', published: '2025-03-04T22:00:39Z', url: 'https://learningenglish.voanews.com/a/1.html', text: longParagraph };
  assert.throws(() => buildNewsPackage(meta, [{ ...good, id: '../escape' }], [], 5), /Invalid article/);
  assert.throws(() => buildNewsPackage(meta, [{ ...good, url: 'javascript:alert(1)' }], [], 5), /Invalid article/);
  assert.throws(() => buildNewsPackage(meta, [{ ...good, published: 'yesterday' }], [], 5), /Invalid article/);
  assert.throws(() => buildNewsPackage({ ...meta, id: 'Bad Id' }, [good], [], 5), /Invalid news source/);
});
