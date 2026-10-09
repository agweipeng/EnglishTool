/* Selected-passage analysis UI. AI providers can supply requestParagraphAI({prompt, signal}). */
'use strict';

let paragraphContext = null;
let paragraphResult = null;
let paragraphTab = 'simplified';
let paragraphRequest = null;
let paragraphSequence = 0;

function closeParagraphAnalysis() {
  clearTimeout(selectionTimer);
  ++paragraphSequence;
  paragraphRequest?.abort();
  paragraphRequest = null;
  document.getElementById('readerAnalysisDialog')?.close();
}

function openParagraphAnalysis(text) {
  if (!reader || !text.trim()) return;
  if (text.length > ParagraphCore.MAX_CHARS) { toast('Select a shorter passage — up to 6,000 characters. / 请选中较短的段落。', 3500); return; }
  closeReaderPanel();
  const inBook = !!readerBookId;
  // Book, news or conversation: the AI explains each kind of material differently
  const kind = typeof currentReadingKind === 'function' ? currentReadingKind() : 'book';
  showParagraphDialog({
    text, title: reader.title, chapter: inBook ? activeReaderChapter?.title || '' : '',
    bookId: inBook ? readerBookId : '', chapterId: inBook ? activeReaderChapter?.id || '' : '', kind,
  }, null, readyStatus(text));
  if (window.autoParagraphAI === true && canAnalyzeHere(text)) generateParagraphAnalysis();
}

// Shows a saved analysis from the Analyses tab without asking the model again
function showSavedAnalysis(entry) {
  let result;
  try { result = ParagraphCore.validateResponse(entry.result, entry.text); }
  catch (error) {
    console.warn('Saved analysis could not be shown', error);
    toast('This saved analysis is damaged and cannot be shown. / 这条已保存的解析已损坏，无法显示。', 3500);
    return;
  }
  const { text, title, chapter, bookId, chapterId, kind = 'book' } = entry;
  showParagraphDialog({ text, title, chapter, bookId, chapterId, kind }, result,
    `Saved analysis${entry.model ? ` · ${entry.model}` : ''}. / 已保存的解析。`);
}

function showParagraphDialog(context, result, status) {
  closeParagraphAnalysis();
  paragraphContext = context;
  paragraphResult = result;
  paragraphTab = 'simplified';
  document.getElementById('paragraphOriginal').textContent = context.text;
  document.getElementById('paragraphResponse').value = '';
  document.getElementById('paragraphStatus').textContent = status;
  document.getElementById('paragraphGenerate').disabled = !canAnalyzeHere(context.text);
  renderParagraphAnalysis();
  document.getElementById('readerAnalysisDialog').showModal();
}

function readyStatus(text) {
  const limit = ParagraphCore.LOCAL_MAX_CHARS.toLocaleString();
  if (typeof window.requestParagraphAI !== 'function') {
    return 'An AI connection is needed for analysis here. You can also use Claude or ChatGPT and bring the response back. / 工具内解析需要连接 AI；也可以使用 Claude 或 ChatGPT，再把回复粘贴回来。';
  }
  return canAnalyzeHere(text) ? 'Ready to analyze your selection. / 可以开始解析所选段落。'
    : `Local AI handles up to ${limit} characters in reasonable time. Select a shorter passage, or use Claude or ChatGPT. / 本地 AI 适合最多 ${limit} 个字符的段落，请选中较短的段落，或使用 Claude 或 ChatGPT。`;
}

// Saves a finished analysis to the Analyses tab; returns the status message to show
function keepAnalysis(context, result, model, doneMessage) {
  const saved = typeof saveAnalysis === 'function' && saveAnalysis(context, result, model);
  return saved ? `${doneMessage} Saved in the Analyses tab. / 已保存到“解析”标签页。` : doneMessage;
}

function localModelName() {
  return typeof localAIConfig !== 'undefined' && localAIConfig ? localAIConfig.model : '';
}

// Local models are slow, so longer passages are left to Claude or ChatGPT
function canAnalyzeHere(text) {
  return typeof window.requestParagraphAI === 'function' && text.length <= ParagraphCore.LOCAL_MAX_CHARS;
}

function bilingualParagraph(value, className = '') {
  return `<div class="${className}"><p>${escapeHTML(value.en)}</p><p class="paragraph-cn" lang="zh-CN">${escapeHTML(value.cn)}</p></div>`;
}

function paragraphItemCards(items, kind) {
  if (!items.length) return '<p class="hint">No items selected. / 没有选出的条目。</p>';
  return items.map((item, index) => {
    const existing = findWordByText(item.text);
    return `<article class="paragraph-card"><h4>${escapeHTML(item.text)}</h4>
      ${bilingualParagraph(item.meaning)}<blockquote>${escapeHTML(item.example)}</blockquote>
      <div class="form-actions"><button class="btn-ghost" data-paragraph-act="say" data-kind="${kind}" data-index="${index}">🔊 Listen / 听读</button>
      <button class="btn-primary" data-paragraph-act="learn" data-kind="${kind}" data-index="${index}" ${existing ? 'disabled' : ''}>${existing ? '✓ In your library / 已加入词库' : '＋ Learn / 加入学习'}</button></div></article>`;
  }).join('');
}

function renderParagraphAnalysis() {
  document.querySelectorAll('[data-paragraph-tab]').forEach(button => {
    const selected = button.dataset.paragraphTab === paragraphTab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  const content = document.getElementById('paragraphContent');
  content.setAttribute('aria-labelledby', `paragraphTab-${paragraphTab}`);
  if (!paragraphResult) { content.innerHTML = '<p class="hint">Your explanation will appear here. / 段落解析将显示在这里。</p>'; return; }
  if (paragraphTab === 'simplified') {
    content.innerHTML = bilingualParagraph(paragraphResult.simplified, 'paragraph-card')
      + `<article class="paragraph-card"><h4>Speak about it / 开口练习</h4>${bilingualParagraph(paragraphResult.speaking)}</article>`;
  } else if (paragraphTab === 'highlights') {
    content.innerHTML = `<article class="paragraph-card"><h4>Main point / 段落大意</h4>${bilingualParagraph(paragraphResult.mainPoint)}</article>
      <h3>Useful words / 重点词汇</h3>${paragraphItemCards(paragraphResult.words, 'words')}
      <h3>Useful phrases / 实用短语</h3>${paragraphItemCards(paragraphResult.phrases, 'phrases')}`;
  } else {
    content.innerHTML = paragraphResult.sentences.map((sentence, i) => `<article class="paragraph-card">
      <h4>${i + 1}. ${escapeHTML(sentence.original)}</h4><span class="paragraph-label">Main structure / 主干</span>${bilingualParagraph(sentence.core)}
      ${sentence.parts.map(part => `<div class="paragraph-part"><b>${escapeHTML(part.text)}</b>${bilingualParagraph(part.explanation)}</div>`).join('')}</article>`).join('');
  }
}

async function generateParagraphAnalysis() {
  if (!paragraphContext || !canAnalyzeHere(paragraphContext.text)) return;
  paragraphRequest?.abort();
  const controller = new AbortController();
  paragraphRequest = controller;
  const sequence = ++paragraphSequence;
  const context = paragraphContext;
  const button = document.getElementById('paragraphGenerate');
  const status = document.getElementById('paragraphStatus');
  button.disabled = true;
  // A local model can take a minute or two; show that it is still working
  const started = Date.now();
  const showProgress = () => {
    if (sequence !== paragraphSequence) return;
    const seconds = Math.round((Date.now() - started) / 1000);
    status.textContent = `Analyzing this passage… ${seconds}s — a local model can take 1–2 minutes. / 正在解析所选段落… ${seconds} 秒——本地模型可能需要 1–2 分钟。`;
  };
  showProgress();
  const ticker = setInterval(showProgress, 1000);
  try {
    const response = await window.requestParagraphAI({ prompt: ParagraphCore.buildPrompt(context), signal: controller.signal });
    if (sequence !== paragraphSequence) return;
    paragraphResult = ParagraphCore.validateResponse(ParagraphCore.groundExamples(response, context.text), context.text);
    status.textContent = keepAnalysis(context, paragraphResult, localModelName(), 'Analysis ready. / 解析已完成。');
    renderParagraphAnalysis();
  } catch (error) {
    if (sequence !== paragraphSequence || error.name === 'AbortError') return;
    status.textContent = error?.name === 'LocalAIError' ? error.message
      : 'The AI response could not be used. Try again with a shorter passage. / AI 回复无法使用，请尝试较短的段落后重试。';
    console.warn('Paragraph analysis failed', error);
  } finally {
    clearInterval(ticker);
    if (sequence === paragraphSequence) { paragraphRequest = null; button.disabled = false; }
  }
}

function pasteParagraphAnalysis() {
  if (!paragraphContext) return;
  try {
    const result = ParagraphCore.validateResponse(document.getElementById('paragraphResponse').value, paragraphContext.text);
    ++paragraphSequence;
    paragraphRequest?.abort();
    paragraphRequest = null;
    paragraphResult = result;
    document.getElementById('paragraphGenerate').disabled = !canAnalyzeHere(paragraphContext.text);
    document.getElementById('paragraphStatus').textContent = keepAnalysis(paragraphContext, result, 'Pasted reply', 'Analysis loaded. / 解析已载入。');
    renderParagraphAnalysis();
  } catch {
    document.getElementById('paragraphStatus').textContent = 'Paste the complete response to the copied prompt, including every section. / 请粘贴针对已复制提示词的完整回复，包含所有部分。';
  }
}

function handleParagraphCard(button) {
  const kind = button.dataset.kind;
  if (!['words', 'phrases'].includes(kind)) return;
  const item = paragraphResult?.[kind]?.[Number(button.dataset.index)];
  if (!item) return;
  if (button.dataset.paragraphAct === 'say') return speak(item.text);
  if (button.dataset.paragraphAct !== 'learn' || findWordByText(item.text)) return;
  const entry = newWordEntry({ text: item.text.toLowerCase(), defEN: item.meaning.en, defCN: item.meaning.cn,
    examples: [{ en: item.example, cn: '' }], tags: paragraphContext.title ? [paragraphContext.title] : [] });
  state.words.push(entry);
  try { saveState(); }
  catch { state.words.splice(state.words.indexOf(entry), 1); toast('Could not save this word. / 无法保存此词条。'); return; }
  refreshReaderStatuses();
  renderParagraphAnalysis();
  toast('Added to your learning library. / 已加入学习词库。');
}

function initParagraphAnalysis() {
  const dialog = document.getElementById('readerAnalysisDialog');
  document.getElementById('paragraphClose').addEventListener('click', closeParagraphAnalysis);
  dialog.addEventListener('cancel', closeParagraphAnalysis);
  document.getElementById('paragraphGenerate').addEventListener('click', generateParagraphAnalysis);
  document.getElementById('paragraphLocalAI').addEventListener('click', openLocalAISettings);
  document.querySelectorAll('[data-paragraph-chat]').forEach(button => button.addEventListener('click', () => {
    const service = button.dataset.paragraphChat;
    if (paragraphContext) {
      copyAndOpenChat(service, ParagraphCore.buildPrompt(paragraphContext),
        `Prompt copied → paste it into ${AI_CHATS[service].name}, then bring the reply back below. / 提示词已复制，请粘贴到 ${AI_CHATS[service].name}，再把回复粘贴回来。`);
    }
  }));
  closeOnBackdropClick(dialog, closeParagraphAnalysis);
  document.getElementById('paragraphPasteBtn').addEventListener('click', pasteParagraphAnalysis);
  document.getElementById('paragraphListen').addEventListener('click', () => { if (paragraphContext) speak(paragraphContext.text); });
  document.getElementById('paragraphContent').addEventListener('click', event => {
    const button = event.target.closest('[data-paragraph-act]');
    if (button) handleParagraphCard(button);
  });
  const tabs = [...document.querySelectorAll('[data-paragraph-tab]')];
  tabs.forEach((button, index) => {
    button.addEventListener('click', () => { paragraphTab = button.dataset.paragraphTab; renderParagraphAnalysis(); });
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].click(); tabs[next].focus();
    });
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initParagraphAnalysis);
else initParagraphAnalysis();
