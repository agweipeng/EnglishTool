/* Analyses tab: every finished AI passage analysis, saved in state.analyses so it
   syncs and backs up with the rest of the learning data. */
'use strict';

const ANALYSIS_PREVIEW_CHARS = 220;
const PASSAGE_ANCHOR_CHARS = 60;
// Books need no label; other kinds of material are named on the card
const ANALYSIS_KIND_NAMES = { news: 'News / 新闻', conversation: 'Conversation / 对话', other: 'Other / 其他' };   // enough of the passage to find it again in the chapter
let analysesQuery = '';

// Saves (or replaces) the analysis of a passage. Returns false if storage is full.
function saveAnalysis(context, result, model) {
  const entry = AnalysisStore.createEntry({
    text: context.text, title: context.title || '', chapter: context.chapter || '',
    bookId: context.bookId || '', chapterId: context.chapterId || '', kind: context.kind || 'book', model: model || '', result,
  }, new Date().toISOString(), uid());
  const previous = state.analyses;
  state.analyses = AnalysisStore.upsert(previous, entry);
  try {
    saveState();
    return true;
  } catch (error) {
    state.analyses = previous;
    console.warn('Analysis not saved', error);
    toast('Could not save this analysis — browser storage may be full. / 无法保存解析，浏览器存储空间可能已满。', 4000);
    return false;
  }
}

function analysisCard(entry) {
  const where = [entry.title, entry.chapter].filter(Boolean).join(' · ') || 'Your own text / 自己粘贴的文本';
  const kindName = ANALYSIS_KIND_NAMES[entry.kind] || '';
  const meta = [where, kindName, new Date(entry.updatedAt).toLocaleString(), entry.model].filter(Boolean).join(' · ');
  const preview = entry.text.length > ANALYSIS_PREVIEW_CHARS ? `${entry.text.slice(0, ANALYSIS_PREVIEW_CHARS)}…` : entry.text;
  const main = entry.result.mainPoint || {};
  const canOpenBook = entry.bookId && typeof readerBookById === 'function' && readerBookById(entry.bookId);
  return `<article class="paragraph-card analysis-card" data-id="${escapeHTML(entry.id)}">
    <div class="analysis-meta">${escapeHTML(meta)}</div>
    <blockquote>${escapeHTML(preview)}</blockquote>
    ${main.en ? `<p>${escapeHTML(main.en)}</p>` : ''}${main.cn ? `<p class="paragraph-cn" lang="zh-CN">${escapeHTML(main.cn)}</p>` : ''}
    <div class="form-actions">
      <button class="btn-primary" data-analysis-act="open">Open / 查看</button>
      ${canOpenBook ? '<button class="btn-ghost" data-analysis-act="book">Open in book / 回到原书</button>' : ''}
      <button class="btn-ghost" data-analysis-act="delete">Delete / 删除</button>
    </div>
  </article>`;
}

function renderAnalysesView() {
  const total = AnalysisStore.visible(state.analyses).length;
  const entries = AnalysisStore.visible(state.analyses, analysesQuery);
  document.getElementById('analysesCount').textContent = total ? `${total} saved · 已保存 ${total} 条` : '';
  document.getElementById('analysesList').innerHTML = entries.length ? entries.map(analysisCard).join('')
    : `<p class="hint">${total
      ? 'No saved analysis matches your search. / 没有匹配搜索的解析。'
      : 'No saved analyses yet. Select a passage in the Book Reader and analyze it — every finished analysis is saved here automatically. / 还没有保存的解析。在 Book Reader 中选中段落进行解析，完成的解析会自动保存在这里。'}</p>`;
}

function deleteAnalysis(entry) {
  if (!confirm('Delete this saved analysis? / 删除这条已保存的解析？')) return;
  const previous = state.analyses;
  state.analyses = AnalysisStore.remove(previous, entry.id, new Date().toISOString());
  try { saveState(); }
  catch (error) {
    state.analyses = previous;
    console.warn('Analysis not deleted', error);
    toast('Could not delete it — please try again. / 删除失败，请重试。');
  }
  renderAnalysesView();
}

// Opens the chapter and scrolls to the analysed passage
async function openAnalysisInBook(entry) {
  showView('reader');
  await (entry.chapterId ? openBookChapter(entry.bookId, entry.chapterId) : openBookChapter(entry.bookId, undefined, true));
  // Runs after the chapter's own scroll restore, which was scheduled first
  requestAnimationFrame(() => scrollToSavedPassage(entry.text));
}

function scrollToSavedPassage(text) {
  if (typeof reader === 'undefined' || !reader) return;
  const offset = reader.text.indexOf(text.slice(0, PASSAGE_ANCHOR_CHARS));
  if (offset < 0) return;
  const span = [...document.querySelectorAll('#readerPassage .rw')]
    .find(candidate => reader.analysis.pieces[candidate.dataset.i].start >= offset);
  span?.scrollIntoView({ block: 'center' });
}

function onAnalysesClick(event) {
  const button = event.target.closest('[data-analysis-act]');
  if (!button) return undefined;
  const id = button.closest('[data-id]')?.dataset.id;
  const entry = AnalysisStore.visible(state.analyses).find(saved => saved.id === id);
  if (!entry) return undefined;
  const act = button.dataset.analysisAct;
  if (act === 'open') return showSavedAnalysis(entry);
  if (act === 'book') return openAnalysisInBook(entry);
  if (act === 'delete') return deleteAnalysis(entry);
  return undefined;
}

function initAnalysesView() {
  document.getElementById('analysesList').addEventListener('click', onAnalysesClick);
  document.getElementById('analysesSearch').addEventListener('input', event => {
    analysesQuery = event.target.value;
    renderAnalysesView();
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAnalysesView);
else initAnalysesView();
