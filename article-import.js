/* Reader → Import an article from a link (also used by the News tab's "Import to Reader").
   The text arrives through ArticleImportCore (Jina Reader), opens in the reader as news, and is saved
   to My reading materials so it stays private, synced and ready for AI analysis. */
'use strict';

const ARTICLE_IMPORT_TIMEOUT_MS = 45000;
let articleImportSequence = 0;
let articleImportRequest = null;

function setArticleImportStatus(message) {
  document.getElementById('readerImportStatus').textContent = message;
}

// Text in the reader that would be lost: yours (not an open book chapter) and not already on the materials shelf
function hasUnsavedReaderText() {
  const text = document.getElementById('readerInput').value.trim();
  if (!text || (typeof readerBookId !== 'undefined' && readerBookId)) return false;
  return !MaterialStore.visible(state.materials).some(item => item.text === text);
}

// Before a book chapter or a saved material replaces the reader text: true when nothing would be lost or the user agrees
function mayReplaceReaderText() {
  return !hasUnsavedReaderText() || confirm('Replace the text in the reader? It is not saved — save it to your materials first if you want to keep it. / 替换阅读器中的文字吗？这些文字尚未保存。');
}

// Opening something else stops an import still loading, so the article can't replace what was opened
function cancelArticleImport() {
  if (!articleImportRequest) return;
  ++articleImportSequence;
  articleImportRequest.abort();
  articleImportRequest = null;
  document.getElementById('readerImportBtn').disabled = false;
  setArticleImportStatus('');
}

function importFailureMessage(error, status) {
  if (status === 429) return 'Too many imports in a short time — wait a minute and try again. / 导入过于频繁，请稍等一分钟再试。';
  if (status) return `The article reader could not open this page (error ${status}). Copy and paste the text instead. / 无法打开该网页，请复制粘贴正文。`;
  if (error?.name === 'AbortError') return 'The page took too long to load. Try again, or copy and paste the text. / 网页加载超时，请重试或复制粘贴正文。';
  if (error?.name === 'TypeError') return 'Could not reach the article reader — check your connection, or copy and paste the text. / 无法连接文章读取服务，请检查网络或复制粘贴正文。';
  return error?.message || 'Import failed. Copy and paste the text instead. / 导入失败，请复制粘贴正文。';
}

async function fetchArticle(url, signal) {
  const response = await fetch(ArticleImportCore.readerRequestUrl(url), { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  let reply;
  try {
    reply = await response.json();
  } catch {
    reply = null;   // a web page (such as a Wi-Fi login) instead of the reader's reply
  }
  return ArticleImportCore.parseReaderReply(reply, url);
}

// Saving uses the title as the shelf key: a different page with the same title gets its site name added,
// so it never replaces something else; the same page again just updates
function shelfTitle(article) {
  const taken = title => MaterialStore.visible(state.materials)
    .find(item => item.title.toLocaleLowerCase() === title.toLocaleLowerCase());
  const owner = taken(article.title);
  if (!owner || owner.sourceUrl === article.url) return article.title;
  const named = `${article.title} — ${new URL(article.url).hostname.replace(/^www\./, '')}`;
  for (let copy = 1; ; copy++) {
    const title = copy === 1 ? named : `${named} (${copy})`;
    const existing = taken(title);
    if (!existing || existing.sourceUrl === article.url) return title;
  }
}

// Fills the paste form with the article, shows it, and saves it when it fits on the shelf.
// Returns { message, saved }.
function showImportedArticle(article, type) {
  const title = shelfTitle(article);
  clearReader();
  document.getElementById('readerTitle').value = title;
  document.getElementById('readerMaterialType').value = type;
  document.getElementById('readerMaterialSource').value = article.url;
  document.getElementById('readerInput').value = article.text;
  analyzeReaderText();
  document.getElementById('readerPaste').open = false;
  document.getElementById('readerImportUrl').value = '';
  if (article.text.length > MaterialStore.MAX_MATERIAL_CHARS) {
    return { saved: false, message: `Imported “${title}”, but it is too long to save to your materials (${MaterialStore.MAX_MATERIAL_CHARS.toLocaleString()} characters). / 已导入，但文章过长，无法保存到阅读材料。` };
  }
  return saveCurrentReadingMaterial()
    ? { saved: true, message: `Imported “${title}” and saved it to My reading materials. / 已导入并保存到“我的阅读材料”。` }
    : { saved: false, message: `Imported “${title}”, but it was not saved to your materials — see the message above (the shelf may be full). / 已导入，但未保存到阅读材料。` };
}

const confirmReplaceReaderText = () => confirm('Replace the text in the reader with this article? Save it to your materials first if you want to keep it. / 用这篇文章替换阅读器中的文字吗？');
const IMPORT_CANCELLED = 'Import cancelled — your text is still in the reader. / 已取消导入，阅读器中的文字保留不变。';

async function importArticleFromLink(link, { openReader = false } = {}) {
  let url;
  try {
    url = ArticleImportCore.normalizeArticleUrl(link);
  } catch (error) {
    toast(error.message, 3500);
    return false;
  }
  if (openReader) showView('reader');
  if (hasUnsavedReaderText() && !confirmReplaceReaderText()) {
    setArticleImportStatus(IMPORT_CANCELLED);
    return false;
  }
  const textBefore = document.getElementById('readerInput').value;
  // News headlines are news; for a pasted link a chosen type (such as Conversation) is kept, and the default Book becomes News
  const chosenType = document.getElementById('readerMaterialType').value;
  const type = !openReader && chosenType && chosenType !== 'book' ? chosenType : 'news';

  articleImportRequest?.abort();
  const request = new AbortController();
  const sequence = ++articleImportSequence;
  articleImportRequest = request;
  const timer = setTimeout(() => request.abort(), ARTICLE_IMPORT_TIMEOUT_MS);
  const button = document.getElementById('readerImportBtn');
  button.disabled = true;
  setArticleImportStatus('Importing the article… / 正在导入文章…');
  try {
    const article = await fetchArticle(url, request.signal);
    if (sequence !== articleImportSequence) return false;
    // Something new was pasted or typed while the article loaded: ask again before replacing it
    if (document.getElementById('readerInput').value !== textBefore && hasUnsavedReaderText() && !confirmReplaceReaderText()) {
      setArticleImportStatus(IMPORT_CANCELLED);
      return false;
    }
    const { message, saved } = showImportedArticle(article, type);
    setArticleImportStatus(message);
    // When saving failed, its own message (why) stays on screen
    if (saved) toast(message, 4000);
    return true;
  } catch (error) {
    if (sequence !== articleImportSequence) return false;
    console.warn('Article import failed', error);
    const message = importFailureMessage(error, error?.status);
    setArticleImportStatus(message);
    toast(message, 5000);
    return false;
  } finally {
    clearTimeout(timer);
    if (sequence === articleImportSequence) {
      articleImportRequest = null;
      button.disabled = false;
    }
  }
}

const importArticleFromForm = () => importArticleFromLink(document.getElementById('readerImportUrl').value);

function initArticleImport() {
  document.getElementById('readerImportBtn').addEventListener('click', importArticleFromForm);
  document.getElementById('readerImportUrl').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); importArticleFromForm(); }
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initArticleImport);
else initArticleImport();
