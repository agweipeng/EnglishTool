/* Importing an article from a link: pure logic shared by the browser and tests.
   A static site can't download other websites' pages (browsers block it), so the page is read through the
   Jina Reader service (r.jina.ai), which returns its main text as Markdown. Only the article link is sent. */
(function (root) {
  'use strict';
  const JINA_READER = 'https://r.jina.ai/';
  const MIN_ARTICLE_CHARS = 200;   // less than this is a login wall, cookie notice or error page
  const MAX_TITLE_CHARS = 200;
  const MAX_MARKDOWN_CHARS = 400000;   // far more than any article; keeps cleaning fast

  const safeLink = value => {
    try {
      const url = new URL(String(value || '').trim());
      return ['http:', 'https:'].includes(url.protocol) && url.hostname ? url.href : '';
    } catch {
      return '';
    }
  };

  // A full http(s) link; "www.bbc.com/…" gets https:// added, and a name or password in the link is removed
  function normalizeArticleUrl(value) {
    let text = String(value || '').trim();
    if (text && !/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
    const link = safeLink(text);
    const url = link ? new URL(link) : null;
    if (!url || !url.hostname.includes('.')) {
      throw new Error('Enter the full article link, starting with https:// / 请输入完整的文章链接（以 https:// 开头）');
    }
    url.username = '';
    url.password = '';
    return url.href;
  }

  const readerRequestUrl = url => `${JINA_READER}${url}`;

  // Each pattern below works on one line and excludes its own opening character (or has a length limit),
  // so even a hostile page is cleaned in linear time
  const LINK_TEXT = String.raw`((?:[^\[\]\n]|\[[^\[\]\n]*\])*)`;   // allows one level of [brackets], e.g. [[1]]
  const LINK_TARGET = String.raw`\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"\n]*")?\)`;
  const IMAGE = new RegExp(String.raw`!\[[^\[\]\n]*\]` + LINK_TARGET, 'g');
  const LINK = new RegExp(String.raw`\[` + LINK_TEXT + String.raw`\]` + LINK_TARGET, 'g');
  const ADJACENT_LINK = /\)(?=\[[^\[\]\n]*\]\()/g;   // "[reported](a)[on](b)" keeps a space between the words
  const TAG = /<!--[^\n]{0,500}?-->|<\/?[A-Za-z][^<>\n]*>/g;   // real tags only, so "x <5 and y> 3" stays
  const BOLD = /(\*\*|__)(?=\S)([^\n]{0,300}?\S)\1/g;
  const ITALIC = /(^|[\s(])([*_])(?=\S)([^*_\n]{0,300}?\S)\2(?=[\s).,;:!?]|$)/g;
  const CITATION = /\[\d{1,3}\]/g;
  const ESCAPED = /\\([\\`*_{}[\]()#+\-.!>|])/g;
  const DROPPED_LINE = /^[ \t]*(?:(?:[-*_=][ \t]*){3,}|\|.*\||\[[^\]\n]+\]:[ \t]*\S.*)$/;   // rules, tables, link references

  function cleanLine(line) {
    if (DROPPED_LINE.test(line)) return '';
    return line
      .replace(/^#{1,6}[ \t]+/, '')
      .replace(/^[ \t]*>[ \t]?/, '')
      .replace(/^[ \t]*[-*+][ \t]+/, '• ')
      .replace(TAG, '')
      .replace(IMAGE, '')
      .replace(ADJACENT_LINK, ') ')
      .replace(LINK, '$1')
      .replace(CITATION, '')
      .replace(BOLD, '$2')
      .replace(ITALIC, '$1$3')
      .replace(ESCAPED, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trimEnd();
  }

  // Code blocks are dropped, unless the fence never closes (then it wasn't one)
  function withoutCodeBlocks(lines) {
    const kept = [];
    let fence = null;
    for (const line of lines) {
      if (/^[ \t]*```/.test(line)) {
        if (fence) fence = null;
        else fence = [];
        continue;
      }
      if (fence) fence.push(line);
      else kept.push(line);
    }
    return fence ? kept.concat(fence) : kept;
  }

  // Markdown → plain text the reader can show: keeps paragraphs and link words, drops images,
  // tables, code and formatting marks
  function markdownToText(markdown) {
    const lines = String(markdown || '').slice(0, MAX_MARKDOWN_CHARS).replace(/\r\n?/g, '\n').split('\n');
    return withoutCodeBlocks(lines).map(cleanLine).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // The reader service's JSON reply → { title, url, text, published }, or an error that says why
  function parseReaderReply(reply, requestedUrl) {
    const data = reply && reply.data;
    if (!reply || reply.code !== 200 || !data || typeof data.content !== 'string') {
      throw new Error('The article reader could not read this page. Copy and paste the text instead. / 无法读取该网页，请复制粘贴正文。');
    }
    const text = markdownToText(data.content);
    if (text.length < MIN_ARTICLE_CHARS) {
      throw new Error('This page has not enough article text (it may need a login). Copy and paste the text instead. / 该网页正文太少（可能需要登录），请复制粘贴正文。');
    }
    const url = safeLink(data.url) || requestedUrl;
    const title = (typeof data.title === 'string' ? data.title.trim() : '') || new URL(url).hostname.replace(/^www\./, '');
    return {
      title: title.slice(0, MAX_TITLE_CHARS),
      url,
      text,
      published: typeof data.publishedTime === 'string' ? data.publishedTime : '',
    };
  }

  const api = { JINA_READER, MIN_ARTICLE_CHARS, normalizeArticleUrl, readerRequestUrl, markdownToText, parseReaderReply };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArticleImportCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
