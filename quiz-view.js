/* Quiz tab: write 2–3 sentences with each of 5 words or phrases, then check all 5 with local AI, Claude or
   ChatGPT. The quiz being written is a draft on this device; checked quizzes are kept in state.quizzes and
   sync with the rest of the learning data. */
'use strict';

const QUIZ_DRAFT_KEY = 'englishTrainerQuizDraft_v1';
const QUIZ_DRAFT_SAVE_MS = 600;
const QUIZ_LOCAL_TIMEOUT_MS = 180000;   // five items take a small local model a while
const QUIZ_SOURCES = ['mix', 'library', 'analyses'];
const QUIZ_VERDICT_LABELS = {
  natural: '✓ Natural / 自然', understandable: '~ Understandable / 能懂但不地道',
  wrong: '✗ Needs work / 需要修改', unchecked: '? Not checked / 未检查',
};
const QUIZ_CHECKER_NAMES = { local: 'Local AI', claude: 'Claude', chatgpt: 'ChatGPT' };
const QUIZ_EMPTY_MESSAGES = {
  mix: 'No words yet. Add words in the Library, or analyze a passage in the Reader. / 还没有词语：请在词库中添加单词，或在 Reader 中解析段落。',
  library: 'Your Library has no words yet. Add some, or choose Analyses. / 词库中还没有单词，请先添加，或改用解析。',
  analyses: 'No saved analyses yet. Analyze a passage in the Reader, or choose Library. / 还没有保存的解析，请在 Reader 中解析段落，或改用词库。',
};

let quizDraft = null;        // { source, items, index, swapped, updatedAt }: the quiz being written
let quizShownId = '';        // the saved quiz whose results are shown
let quizRequest = null;      // the local AI check in progress
let quizSequence = 0;
let quizDraftTimer = null;
const QUIZ_CHATS = ['claude', 'chatgpt'];

const setQuizNotice = message => { document.getElementById('quizNotice').textContent = message; };
const setQuizStatus = message => { document.getElementById('quizStatus').textContent = message; };
const hasQuizAnswers = draft => !!draft && draft.items.some(item => item.answer.trim());

// ---------- Draft (this device only) ----------

function validQuizDraft(value) {
  if (!value || !Array.isArray(value.items) || !value.items.length || value.items.length > QuizCore.QUIZ_SIZE) return null;
  if (!value.items.every(item => item && typeof item.text === 'string' && item.text.trim())) return null;
  const items = value.items.map(item => ({
    text: item.text, meaning: { en: String(item.meaning?.en || ''), cn: String(item.meaning?.cn || '') },
    example: String(item.example || ''), from: item.from || { type: 'word', id: '' },
    answer: typeof item.answer === 'string' ? item.answer.slice(0, QuizCore.MAX_ANSWER_CHARS) : '',
  }));
  return {
    source: QUIZ_SOURCES.includes(value.source) ? value.source : 'mix', items,
    index: Math.min(Math.max(0, Math.floor(Number(value.index)) || 0), items.length - 1),
    swapped: Array.isArray(value.swapped) ? value.swapped.filter(text => typeof text === 'string') : [],
    service: QUIZ_CHATS.includes(value.service) ? value.service : 'claude',   // the chat a pasted reply comes from
    updatedAt: String(value.updatedAt || ''),
  };
}

function loadQuizDraft() {
  try { return validQuizDraft(JSON.parse(localStorage.getItem(QUIZ_DRAFT_KEY))); }
  catch { return null; }
}

function saveQuizDraft() {
  clearTimeout(quizDraftTimer);
  try {
    if (quizDraft) localStorage.setItem(QUIZ_DRAFT_KEY, JSON.stringify(quizDraft));
    else localStorage.removeItem(QUIZ_DRAFT_KEY);
  } catch (error) {
    console.warn('Quiz draft not saved', error);
    setQuizNotice('Could not keep your draft on this device — browser storage may be full. / 无法在本设备保存草稿，浏览器存储空间可能已满。');
  }
}

// Every change makes a new draft object; typing is saved a moment after it stops, other changes at once
function setQuizDraft(draft, { saveNow = false } = {}) {
  quizDraft = draft ? { ...draft, updatedAt: new Date().toISOString() } : null;
  clearTimeout(quizDraftTimer);
  if (saveNow) saveQuizDraft();
  else quizDraftTimer = setTimeout(saveQuizDraft, QUIZ_DRAFT_SAVE_MS);
}

// ---------- Writing the quiz ----------

function quizCandidates(source, exclude = []) {
  return {
    library: QuizCore.libraryCandidates(state.words, isLeech),
    analyses: QuizCore.analysisCandidates(AnalysisStore.visible(state.analyses)),
    recent: QuizCore.recentKeys(QuizStore.visible(state.quizzes)),
    source, exclude,
  };
}

function startNewQuiz() {
  if (quizRequest) return;
  if (hasQuizAnswers(quizDraft) && !confirm('Start a new quiz? Your unchecked answers will be discarded. / 开始新测验？未检查的答案将被丢弃。')) return;
  const chosen = document.getElementById('quizSource').value;
  const source = QUIZ_SOURCES.includes(chosen) ? chosen : 'mix';
  const items = QuizCore.pickQuizItems(quizCandidates(source));
  if (!items.length) { setQuizNotice(QUIZ_EMPTY_MESSAGES[source]); return; }
  const service = document.getElementById('quizReplySource').value;
  setQuizDraft({ source, items: items.map(item => ({ ...item, answer: '' })), index: 0, swapped: [],
    service: QUIZ_CHATS.includes(service) ? service : 'claude' }, { saveNow: true });
  quizShownId = '';
  setQuizNotice(items.length < QuizCore.QUIZ_SIZE
    ? `Only ${items.length} words or phrases were available, so this quiz is shorter. / 只找到 ${items.length} 个词或短语，所以本次测验较短。` : '');
  setQuizStatus('');
  renderQuizView();
}

function swapQuizItem() {
  if (!quizDraft || quizRequest) return;
  const current = quizDraft.items[quizDraft.index];
  const exclude = [...quizDraft.items.map(item => item.text), ...quizDraft.swapped];
  const [next] = QuizCore.pickQuizItems({ ...quizCandidates(quizDraft.source, exclude), count: 1 });
  if (!next) { toast('No other words to swap in. / 没有其他可换的词。'); return; }
  const items = quizDraft.items.map((item, i) => (i === quizDraft.index ? { ...next, answer: '' } : item));
  setQuizDraft({ ...quizDraft, items, swapped: [...quizDraft.swapped, current.text] }, { saveNow: true });
  renderQuizView();
}

function moveQuizTest(step) {
  if (!quizDraft) return;
  const index = Math.min(Math.max(0, quizDraft.index + step), quizDraft.items.length - 1);
  setQuizDraft({ ...quizDraft, index }, { saveNow: true });
  renderQuizView();
}

function setQuizAnswer(answer) {
  if (!quizDraft || quizRequest) return;
  const value = String(answer).slice(0, QuizCore.MAX_ANSWER_CHARS);
  const items = quizDraft.items.map((item, i) => (i === quizDraft.index ? { ...item, answer: value } : item));
  setQuizDraft({ ...quizDraft, items });
  renderQuizUsed();
  renderQuizCheck();
}

// ---------- Checking ----------

async function checkQuizWithLocalAI() {
  if (!hasQuizAnswers(quizDraft) || quizRequest) return;
  if (typeof window.requestParagraphAI !== 'function') { openLocalAISettings(); return; }
  const draft = quizDraft;
  const controller = new AbortController();
  const sequence = ++quizSequence;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, QUIZ_LOCAL_TIMEOUT_MS);
  const started = Date.now();
  const showProgress = () => {
    const seconds = Math.round((Date.now() - started) / 1000);
    setQuizStatus(`Checking your sentences… ${seconds}s — a local model can take a few minutes. / 正在检查你的句子… ${seconds} 秒——本地模型可能需要几分钟。`);
  };
  quizRequest = controller;
  showProgress();
  const ticker = setInterval(showProgress, 1000);
  renderQuizTest();
  renderQuizCheck();
  try {
    const reply = await window.requestParagraphAI({ prompt: QuizCore.buildQuizPrompt(draft.items), signal: controller.signal,
      schema: QuizCore.FEEDBACK_SCHEMA, schemaName: 'quiz_feedback' });
    if (sequence !== quizSequence) return;
    quizRequest = null;
    finishQuiz(draft, QuizCore.parseQuizFeedback(reply, draft.items), 'local', localModelName());
  } catch (error) {
    if (sequence !== quizSequence) return;
    if (error.name !== 'AbortError') console.warn('Quiz check failed', error);
    setQuizStatus(error.name === 'AbortError'
      ? (timedOut ? 'The local model took too long. Try again, or check with Claude or ChatGPT. / 本地模型响应超时，请重试，或改用 Claude 或 ChatGPT。'
        : 'Check cancelled. Your answers are kept. / 已取消检查，答案已保留。')
      : error.name === 'LocalAIError' ? error.message
        : 'The local AI check failed. Your answers are kept; please try again. / 本地 AI 检查失败，答案已保留，请重试。');
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
    if (sequence === quizSequence) {
      quizRequest = null;
      renderQuizTest();
      renderQuizCheck();
    }
  }
}

// The tap copies the prompt; the link itself opens the chat (the ChatGPT app on iPhone)
function onQuizChatClick(event) {
  if (quizRequest) { event.preventDefault(); return; }
  if (!hasQuizAnswers(quizDraft)) { event.preventDefault(); toast('Write at least one answer first. / 请先至少写一题。'); return; }
  const service = event.currentTarget.dataset.chat;
  setQuizReplySource(service);
  copyChatPrompt(service, QuizCore.buildQuizPrompt(quizDraft.items),
    `Prompt copied → paste it into ${AI_CHATS[service].name}, then paste the reply below. / 提示词已复制，请粘贴到 ${AI_CHATS[service].name}，再把回复粘贴到下方。`);
}

function saveQuizReply() {
  if (!quizDraft) return;
  const reply = document.getElementById('quizReply').value.trim();
  if (!reply) { setQuizStatus('Paste the whole reply first. / 请先粘贴完整回复。'); return; }
  if (QuizCore.looksLikeQuizPrompt(reply)) {
    setQuizStatus('This is the prompt you copied, not the AI’s reply. Paste it into the chat first, then paste the chat’s answer here. / 这是你复制的提示词，不是 AI 的回复。请先把它粘贴到聊天中，再把聊天的回答粘贴到这里。');
    return;
  }
  ++quizSequence;
  quizRequest?.abort();
  quizRequest = null;
  const chosen = document.getElementById('quizReplySource').value;
  finishQuiz(quizDraft, QuizCore.parseQuizFeedback(reply, quizDraft.items), QUIZ_CHATS.includes(chosen) ? chosen : 'claude', '');
}

// Remembered in the draft, so the reply is credited to the right chat even after the page reloads
function setQuizReplySource(service) {
  document.getElementById('quizReplySource').value = service;
  if (quizDraft && QUIZ_CHATS.includes(service)) setQuizDraft({ ...quizDraft, service }, { saveNow: true });
}

// Saves the checked quiz; on failure the draft (and the answers) stay
function finishQuiz(draft, parsed, checkedWith, model) {
  const entry = QuizStore.createEntry({ source: draft.source, items: draft.items, ...parsed, checkedWith, model },
    new Date().toISOString(), uid());
  const previous = state.quizzes;
  state.quizzes = QuizStore.upsert(previous, entry);
  try {
    saveState();
  } catch (error) {
    state.quizzes = previous;
    console.warn('Quiz not saved', error);
    toast('Could not save this quiz — browser storage may be full. Your answers are kept. / 无法保存测验，浏览器存储空间可能已满，答案已保留。', 4000);
    setQuizStatus('Not saved: browser storage may be full. / 未保存：浏览器存储空间可能已满。');
    renderQuizView();
    return false;
  }
  setQuizDraft(null, { saveNow: true });
  quizShownId = entry.id;
  document.getElementById('quizReply').value = '';
  setQuizNotice('');
  setQuizStatus(parsed.feedback ? 'Checked and saved below. / 已检查并保存在下方。'
    : 'Saved as text: the reply wasn’t in the expected format. / 已作为文本保存：回复格式与预期不符。');
  renderQuizView();
  document.getElementById('quizResults').scrollIntoView({ block: 'start', behavior: 'smooth' });
  return true;
}

function deleteQuiz(id) {
  if (!confirm('Delete this quiz? / 删除这次测验？')) return;
  const previous = state.quizzes;
  state.quizzes = QuizStore.remove(previous, id, new Date().toISOString());
  try {
    saveState();
  } catch (error) {
    state.quizzes = previous;
    console.warn('Quiz not deleted', error);
    toast('Could not delete it — please try again. / 删除失败，请重试。');
    return;
  }
  if (quizShownId === id) quizShownId = '';
  refreshQuizSaved();
}

// ---------- Rendering ----------

function renderQuizTest() {
  const container = document.getElementById('quizTest');
  if (!quizDraft) { container.innerHTML = ''; return; }
  const item = quizDraft.items[quizDraft.index];
  const number = quizDraft.index + 1;
  const total = quizDraft.items.length;
  container.innerHTML = `<fieldset class="quiz-card" ${quizRequest ? 'disabled' : ''}>
    <legend class="hint">Test ${number} of ${total} / 第 ${number} 题，共 ${total} 题</legend>
    <div class="quiz-progress" aria-hidden="true"><span style="width:${Math.round((number / total) * 100)}%"></span></div>
    <div class="quiz-word"><b>${escapeHTML(item.text)}</b><button type="button" class="btn-ghost" data-quiz-act="say" aria-label="Listen / 听读">🔊</button></div>
    ${item.meaning.en ? `<p>${escapeHTML(item.meaning.en)}</p>` : ''}
    ${item.meaning.cn ? `<p class="paragraph-cn" lang="zh-CN">${escapeHTML(item.meaning.cn)}</p>` : ''}
    ${quizExampleHTML(item)}
    <label for="quizAnswer">Write 2–3 sentences using “${escapeHTML(item.text)}” in different ways. / 用它以不同方式写 2–3 个句子。</label>
    <textarea id="quizAnswer" rows="4" maxlength="${QuizCore.MAX_ANSWER_CHARS}">${escapeHTML(item.answer)}</textarea>
    <p id="quizUsed" class="quiz-used" aria-live="polite"></p>
    <div class="form-actions">
      <button type="button" class="btn-ghost" data-quiz-act="back" ${number === 1 ? 'disabled' : ''}>← Back / 上一题</button>
      <button type="button" class="btn-primary" data-quiz-act="next" ${number === total ? 'disabled' : ''}>Next → / 下一题</button>
      <button type="button" class="btn-ghost" data-quiz-act="swap">Swap word / 换一个词</button>
    </div>
  </fieldset>`;
  renderQuizUsed();
}

// The saved example (from the book, the analysis or the Library entry) shows how the word is used
function quizExampleHTML(item) {
  const example = quizText(item.example).trim();
  if (!example) {
    return '<p class="hint quiz-example">No example saved for this word yet — checking your answers will give you a model sentence. / 这个词还没有保存例句，检查答案时会给出示范句。</p>';
  }
  return `<blockquote class="quiz-example"><span class="hint">Example / 例句</span>
    <span>${escapeHTML(example)}</span>
    <button type="button" class="btn-ghost" data-quiz-act="say-example" aria-label="Listen to the example / 听例句">🔊</button></blockquote>`;
}

// A hint only: it never blocks moving on or checking
function renderQuizUsed() {
  const hint = document.getElementById('quizUsed');
  if (!hint || !quizDraft) return;
  const item = quizDraft.items[quizDraft.index];
  const used = QuizCore.usesTarget(item.answer, item.text);
  hint.className = `quiz-used${used ? ' ok' : ''}`;
  hint.textContent = !item.answer.trim() ? '' : used ? `✓ “${item.text}” used / 已用到` : `“${item.text}” not used yet / 还没用到`;
}

function renderQuizCheck() {
  document.getElementById('quizCheck').classList.toggle('hidden', !hasQuizAnswers(quizDraft));
  document.getElementById('quizLocalBtn').disabled = !!quizRequest;
  document.getElementById('quizCancelBtn').classList.toggle('hidden', !quizRequest);
}

const quizReadButton = sentence => (sentence
  ? `<button type="button" class="mic-btn" data-quiz-read="${escapeHTML(sentence)}" title="Read aloud challenge">🎙️ Read aloud</button>` : '');
// Saved quizzes can arrive from another device or an old backup, so missing or odd fields render as empty
const quizText = value => (typeof value === 'string' ? value : '');
function quizNote(note) {
  const en = quizText(note?.en);
  const cn = quizText(note?.cn);
  return `${en ? `<p class="hint">${escapeHTML(en)}</p>` : ''}${cn ? `<p class="hint paragraph-cn" lang="zh-CN">${escapeHTML(cn)}</p>` : ''}`;
}
function quizAnswerText(item) {
  const answer = quizText(item.answer);
  return answer.trim() ? escapeHTML(answer) : 'Skipped / 已跳过';
}

function quizScoreText(quiz) {
  const score = QuizCore.quizScore(quiz.feedback);
  return score ? `${score.natural}/${score.total} natural · 自然` : 'Text feedback · 文本反馈';
}

function quizSentenceHTML(sentence) {
  const yours = quizText(sentence.yours);
  const better = quizText(sentence.better);
  return `<div class="quiz-sentence"><p class="quiz-yours">${escapeHTML(yours)}</p>
    ${better && better !== yours ? `<p class="quiz-better">→ ${escapeHTML(better)}</p>` : ''}
    ${quizNote(sentence.note)}${quizReadButton(better || yours)}</div>`;
}

function quizItemHTML(item, result) {
  const checked = result && typeof result === 'object' ? result : {};
  const verdict = QUIZ_VERDICT_LABELS[checked.verdict] ? checked.verdict : 'unchecked';
  const sentences = (Array.isArray(checked.sentences) ? checked.sentences : []).filter(sentence => sentence && typeof sentence === 'object');
  const model = quizText(checked.model);
  const example = quizText(item.example);
  return `<article class="paragraph-card quiz-result quiz-${verdict}">
    <h4><span class="quiz-verdict">${QUIZ_VERDICT_LABELS[verdict]}</span> ${escapeHTML(item.text)}</h4>
    ${sentences.length ? sentences.map(quizSentenceHTML).join('') : `<p class="quiz-yours">${quizAnswerText(item)}</p>`}
    ${model ? `<p class="quiz-model"><b>Model / 示范：</b>${escapeHTML(model)} ${quizReadButton(model)}</p>` : ''}
    ${example ? `<blockquote>${escapeHTML(example)}</blockquote>` : ''}
  </article>`;
}

function quizResultsHTML(quiz) {
  const details = [new Date(quiz.createdAt).toLocaleString(), QUIZ_CHECKER_NAMES[quiz.checkedWith], quiz.model].filter(Boolean).join(' · ');
  const head = `<div class="quiz-result-head"><h3>Results / 结果 · ${escapeHTML(quizScoreText(quiz))}</h3><p class="hint">${escapeHTML(details)}</p></div>`;
  if (!quiz.feedback) {
    return `${head}${quiz.items.map(item => `<article class="paragraph-card"><h4>${escapeHTML(item.text)}</h4><p class="quiz-yours">${quizAnswerText(item)}</p></article>`).join('')}
      <article class="paragraph-card"><h4>AI reply / AI 回复</h4><div class="quiz-reply-text">${escapeHTML(quiz.feedbackText)}</div></article>`;
  }
  const tip = quizNote(quiz.feedback.tip);
  return `${head}${tip ? `<article class="paragraph-card quiz-tip"><h4>Tip / 建议</h4>${tip}</article>` : ''}
    ${quiz.items.map((item, i) => quizItemHTML(item, quiz.feedback.items[i])).join('')}`;
}

function renderQuizResults() {
  const quiz = QuizStore.visible(state.quizzes).find(saved => saved.id === quizShownId);
  if (!quiz) quizShownId = '';
  document.getElementById('quizResults').innerHTML = quiz ? quizResultsHTML(quiz) : '';
}

function renderQuizHistory() {
  const quizzes = QuizStore.visible(state.quizzes);
  document.getElementById('quizHistory').innerHTML = quizzes.length ? quizzes.map(quiz => `<article class="quiz-history-item${quiz.id === quizShownId ? ' active' : ''}" data-id="${escapeHTML(quiz.id)}">
      <button type="button" class="quiz-history-open" data-quiz-act="open"><span class="hint">${escapeHTML(new Date(quiz.createdAt).toLocaleDateString())}</span>
        <b>${escapeHTML(quizScoreText(quiz))}</b><span>${escapeHTML(quiz.items.map(item => item.text).join(' · '))}</span></button>
      <button type="button" class="btn-ghost" data-quiz-act="delete">Delete / 删除</button>
    </article>`).join('')
    : '<p class="hint">No checked quizzes yet. Every quiz you check is kept here. / 还没有检查过的测验，每次检查后的测验都会保存在这里。</p>';
}

// After a sync: saved quizzes only, so the text box being typed in is never reset
function refreshQuizSaved() {
  renderQuizResults();
  renderQuizHistory();
}

function renderQuizView() {
  renderQuizTest();
  renderQuizCheck();
  refreshQuizSaved();
}

function onQuizClick(event) {
  const read = event.target.closest('[data-quiz-read]');
  if (read) return openReadAloud(read.dataset.quizRead);
  const button = event.target.closest('[data-quiz-act]');
  if (!button) return undefined;
  const act = button.dataset.quizAct;
  if (act === 'say') return quizDraft && speak(quizDraft.items[quizDraft.index].text);
  if (act === 'say-example') return quizDraft && speak(quizText(quizDraft.items[quizDraft.index].example));
  if (act === 'back') return moveQuizTest(-1);
  if (act === 'next') return moveQuizTest(1);
  if (act === 'swap') return swapQuizItem();
  const id = button.closest('[data-id]')?.dataset.id;
  if (!id) return undefined;
  if (act === 'delete') return deleteQuiz(id);
  if (act === 'open') {
    quizShownId = id;
    refreshQuizSaved();
    document.getElementById('quizResults').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  return undefined;
}

function initQuizView() {
  quizDraft = loadQuizDraft();
  // Only when a saved draft is restored, so reopening the tab never undoes a source chosen for the next quiz
  if (quizDraft) {
    document.getElementById('quizSource').value = quizDraft.source;
    document.getElementById('quizReplySource').value = quizDraft.service;
  }
  document.getElementById('quizReplySource').addEventListener('change', event => setQuizReplySource(event.target.value));
  const view = document.getElementById('view-quiz');
  view.addEventListener('click', onQuizClick);
  view.addEventListener('input', event => { if (event.target.id === 'quizAnswer') setQuizAnswer(event.target.value); });
  document.getElementById('quizNewBtn').addEventListener('click', startNewQuiz);
  document.getElementById('quizLocalBtn').addEventListener('click', checkQuizWithLocalAI);
  document.getElementById('quizCancelBtn').addEventListener('click', () => quizRequest?.abort());
  document.getElementById('quizReplyBtn').addEventListener('click', saveQuizReply);
  document.querySelectorAll('[data-chat-for="quiz"]').forEach(link => link.addEventListener('click', onQuizChatClick));
  window.addEventListener('pagehide', () => { if (quizDraft) saveQuizDraft(); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initQuizView);
else initQuizView();
