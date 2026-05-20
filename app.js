/* ============================================================
   English Vocabulary & Listening Trainer
   Pure HTML/JS, localStorage-backed, no build step.
   ============================================================ */

'use strict';

// ============ Constants ============
const STORAGE_KEY = 'englishTrainerData_v1';
const MAX_LEVEL = 5;                 // archive when level reaches this
const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const DAY_MS = 86400000;
const SESSION_SIZE = 15;             // max cards per session
const DICT_API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const TRANSLATE_API = 'https://api.mymemory.translated.net/get';

// ============ State ============
let state = loadState();
let session = null;       // active learn session
let drill = null;         // active drill state

// ============ Storage ============
function defaultState() {
  return {
    words: [],
    settings: { voiceURI: null, rate: 1, theme: 'light' },
    activity: {},   // { 'YYYY-MM-DD': reviewCount }
    streak: { current: 0, lastDay: null },
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed);
  } catch (e) {
    console.error('Failed to load state', e);
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ============ Helpers ============
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function nowMs() { return Date.now(); }
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pickRandom(arr, n) { return shuffle(arr).slice(0, n); }
function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function toast(msg, ms = 1800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

// ============ Activity / Streak ============
function recordReview() {
  const t = todayKey();
  state.activity[t] = (state.activity[t] || 0) + 1;
  const last = state.streak.lastDay;
  if (last !== t) {
    const lastDate = last ? new Date(last) : null;
    const todayDate = new Date(t);
    const diffDays = lastDate ? Math.round((todayDate - lastDate) / DAY_MS) : Infinity;
    state.streak.current = (diffDays === 1) ? state.streak.current + 1 : 1;
    state.streak.lastDay = t;
  }
  document.getElementById('streakBadge').textContent = `🔥 ${state.streak.current}`;
  saveState();
}

// ============ SRS Engine (modified SM-2 + Leitner) ============
function applyRating(word, rating) {
  word.ease = word.ease || DEFAULT_EASE;
  word.interval = word.interval || 1;
  word.level = word.level || 0;
  word.rightCount = word.rightCount || 0;
  word.wrongCount = word.wrongCount || 0;

  switch (rating) {
    case 'again':
      word.level = Math.max(0, word.level - 1);
      word.ease = Math.max(MIN_EASE, word.ease - 0.2);
      word.interval = 1;
      word.wrongCount += 1;
      break;
    case 'hard':
      word.interval = Math.max(1, Math.round(word.interval * 1.2));
      word.ease = Math.max(MIN_EASE, word.ease - 0.15);
      word.rightCount += 1;
      break;
    case 'good':
      word.interval = Math.max(1, Math.round(word.interval * word.ease));
      word.level += 1;
      word.rightCount += 1;
      break;
    case 'easy':
      word.interval = Math.max(2, Math.round(word.interval * word.ease * 1.3));
      word.ease += 0.15;
      word.level += 1;
      word.rightCount += 1;
      break;
  }
  word.nextReview = nowMs() + word.interval * DAY_MS;

  if (word.level >= MAX_LEVEL) {
    word.level = MAX_LEVEL;
    word.archivedAt = new Date().toISOString();
  }
}

function priorityScore(word) {
  if (word.archivedAt) return -Infinity;
  const overdueDays = Math.max(0, (nowMs() - (word.nextReview || 0)) / DAY_MS);
  const levelWeight = (MAX_LEVEL - word.level) * 10;
  const wrongWeight = (word.wrongCount || 0) * 2;
  const newBonus = (word.rightCount === 0 && word.wrongCount === 0) ? 15 : 0;
  return levelWeight + overdueDays + wrongWeight + newBonus + Math.random() * 2;
}

function pickSessionWords(limit = SESSION_SIZE) {
  const active = state.words.filter(w => !w.archivedAt);
  if (active.length === 0) return [];
  return active
    .map(w => ({ w, score: priorityScore(w) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.w);
}

// ============ View routing ============
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const view = document.getElementById('view-' + name);
  const tab = document.querySelector(`.tab[data-view="${name}"]`);
  if (view) view.classList.add('active');
  if (tab) tab.classList.add('active');

  if (name === 'learn') startSession();
  if (name === 'library') renderLibrary();
  if (name === 'stats') renderStats();
}

// ============ TTS ============
let voices = [];
function loadVoices() {
  if (typeof speechSynthesis === 'undefined') return;
  voices = speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().startsWith('en'));
  const sel = document.getElementById('voiceSelect');
  if (!sel) return;
  sel.innerHTML = '';
  voices.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(opt);
  });
  if (state.settings.voiceURI) sel.value = state.settings.voiceURI;
}
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener('voiceschanged', loadVoices);
}

function speak(text, opts = {}) {
  return new Promise(resolve => {
    if (!text || typeof speechSynthesis === 'undefined') return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voice = voices.find(v => v.voiceURI === state.settings.voiceURI) || voices[0];
    if (voice) u.voice = voice;
    u.rate = (opts.rate ?? state.settings.rate ?? 1) * (opts.slow ? 0.7 : 1);
    u.pitch = 1;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

// ============ External APIs ============
async function fetchDictionary(word) {
  try {
    const r = await fetch(DICT_API + encodeURIComponent(word.trim().toLowerCase()));
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || !data[0]) return null;
    const entry = data[0];
    const phonetic = entry.phonetic
      || (entry.phonetics && entry.phonetics.find(p => p.text)?.text)
      || '';
    const defs = [];
    const examples = [];
    for (const m of entry.meanings || []) {
      for (const d of m.definitions || []) {
        if (d.definition) defs.push(d.definition);
        if (d.example) examples.push(d.example);
      }
    }
    return {
      phonetic,
      defEN: defs.slice(0, 2).join(' • '),
      examples: examples.slice(0, 3).map(en => ({ en, cn: '' })),
    };
  } catch (e) {
    console.warn('Dictionary fetch failed', e);
    return null;
  }
}

async function translateToCN(text) {
  if (!text || !text.trim()) return '';
  try {
    const url = `${TRANSLATE_API}?q=${encodeURIComponent(text)}&langpair=en|zh-CN`;
    const r = await fetch(url);
    const data = await r.json();
    return data?.responseData?.translatedText || '';
  } catch (e) {
    console.warn('Translate failed', e);
    return '';
  }
}

// ============ Add View ============
function renderExamples(list = []) {
  const wrap = document.getElementById('examplesList');
  wrap.innerHTML = '';
  if (list.length === 0) addExampleRow();
  else list.forEach(ex => addExampleRow(ex.en, ex.cn));
}
function addExampleRow(en = '', cn = '') {
  const wrap = document.getElementById('examplesList');
  const row = document.createElement('div');
  row.className = 'example-row';
  row.innerHTML = `
    <input type="text" placeholder="English sentence" value="${escapeHTML(en)}" />
    <input type="text" placeholder="中文翻译" value="${escapeHTML(cn)}" />
    <button class="icon-btn" title="Remove">✕</button>
  `;
  row.querySelector('button').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
}
function collectExamples() {
  return [...document.querySelectorAll('#examplesList .example-row')]
    .map(row => {
      const [e, c] = row.querySelectorAll('input');
      return { en: e.value.trim(), cn: c.value.trim() };
    })
    .filter(ex => ex.en);
}

async function autoFill() {
  const word = document.getElementById('newWord').value.trim();
  if (!word) { toast('Enter a word first'); return; }
  toast('Fetching dictionary...');
  const data = await fetchDictionary(word);
  if (!data) { toast('No dictionary entry found'); return; }
  if (data.phonetic) document.getElementById('newPhonetic').value = data.phonetic;
  document.getElementById('defEN').value = data.defEN;
  toast('Translating to Chinese...');
  const defCN = await translateToCN(data.defEN);
  document.getElementById('defCN').value = defCN;
  const translated = [];
  for (const ex of data.examples) {
    const cn = await translateToCN(ex.en);
    translated.push({ en: ex.en, cn });
  }
  while (translated.length < 2) translated.push({ en: '', cn: '' });
  renderExamples(translated);
  toast('Auto-fill complete ✓');
}

async function translateDefOnly() {
  const en = document.getElementById('defEN').value.trim();
  if (!en) { toast('Type English definition first'); return; }
  toast('Translating...');
  const cn = await translateToCN(en);
  document.getElementById('defCN').value = cn;
}

function clearForm() {
  ['newWord', 'newPhonetic', 'defEN', 'defCN', 'newTags'].forEach(id => {
    document.getElementById(id).value = '';
  });
  renderExamples([]);
}

function saveWord() {
  const text = document.getElementById('newWord').value.trim();
  if (!text) { toast('Word is required'); return; }
  const existing = state.words.find(w => w.text.toLowerCase() === text.toLowerCase());
  if (existing) {
    if (!confirm(`"${text}" already exists. Update it?`)) return;
    Object.assign(existing, {
      phonetic: document.getElementById('newPhonetic').value.trim(),
      defEN: document.getElementById('defEN').value.trim(),
      defCN: document.getElementById('defCN').value.trim(),
      examples: collectExamples(),
      tags: document.getElementById('newTags').value.split(',').map(s => s.trim()).filter(Boolean),
    });
  } else {
    state.words.push({
      id: uid(),
      text,
      phonetic: document.getElementById('newPhonetic').value.trim(),
      defEN: document.getElementById('defEN').value.trim(),
      defCN: document.getElementById('defCN').value.trim(),
      examples: collectExamples(),
      tags: document.getElementById('newTags').value.split(',').map(s => s.trim()).filter(Boolean),
      level: 0,
      ease: DEFAULT_EASE,
      interval: 1,
      nextReview: nowMs(),
      rightCount: 0,
      wrongCount: 0,
      createdAt: new Date().toISOString(),
      archivedAt: null,
    });
  }
  saveState();
  toast(`✓ Saved "${text}"`);
  clearForm();
}

async function bulkImport() {
  const raw = document.getElementById('bulkInput').value.trim();
  if (!raw) return;
  const status = document.getElementById('bulkStatus');
  const words = raw.split('\n').map(s => s.trim()).filter(Boolean);
  let added = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    status.textContent = `Processing ${i + 1}/${words.length}: ${w}...`;
    if (state.words.find(x => x.text.toLowerCase() === w.toLowerCase())) continue;
    const data = await fetchDictionary(w);
    const defCN = data ? await translateToCN(data.defEN || '') : '';
    const examples = [];
    if (data) {
      for (const ex of data.examples) {
        const cn = await translateToCN(ex.en);
        examples.push({ en: ex.en, cn });
      }
    }
    state.words.push({
      id: uid(),
      text: w,
      phonetic: data?.phonetic || '',
      defEN: data?.defEN || '',
      defCN,
      examples,
      tags: [],
      level: 0, ease: DEFAULT_EASE, interval: 1,
      nextReview: nowMs(), rightCount: 0, wrongCount: 0,
      createdAt: new Date().toISOString(), archivedAt: null,
    });
    added++;
    saveState();
  }
  status.textContent = `✓ Imported ${added} new word(s)`;
  document.getElementById('bulkInput').value = '';
}

// ============ Learn Session ============
function startSession() {
  const words = pickSessionWords();
  const empty = document.getElementById('emptyLearn');
  const card = document.getElementById('flashcard');
  if (words.length === 0) {
    empty.classList.remove('hidden');
    empty.innerHTML = `
      <h2>No words to learn yet 🌱</h2>
      <p>Add some words first, or all your words are mastered.</p>
      <button class="btn-primary" data-goto="add">+ Add a Word</button>
    `;
    empty.querySelector('[data-goto]').addEventListener('click', () => showView('add'));
    card.classList.add('hidden');
    document.getElementById('sessionProgress').textContent = '0 / 0';
    return;
  }
  empty.classList.add('hidden');
  card.classList.remove('hidden');
  session = { queue: words, index: 0, total: words.length };
  showCard();
}

function endSession() {
  session = null;
  speechSynthesis.cancel();
  startSession();
}

function showCard() {
  if (!session || session.index >= session.queue.length) {
    document.getElementById('flashcard').classList.add('hidden');
    const empty = document.getElementById('emptyLearn');
    empty.classList.remove('hidden');
    empty.innerHTML = `
      <h2>Session complete 🎉</h2>
      <p>Great work! Come back later for more reviews.</p>
      <button class="btn-primary" id="restartBtn">Start Another Session</button>
    `;
    document.getElementById('restartBtn').addEventListener('click', startSession);
    toast('Session complete!');
    return;
  }
  const word = session.queue[session.index];
  document.getElementById('sessionProgress').textContent = `${session.index + 1} / ${session.total}`;
  document.getElementById('cardLevel').textContent = `Level ${word.level}/${MAX_LEVEL}`;

  const modeSel = document.getElementById('learnMode').value;
  const mode = modeSel === 'mixed' ? randomMode(word) : modeSel;
  renderCard(word, mode);
}

function randomMode(word) {
  const modes = ['meaning', 'listening', 'spelling', 'cloze'];
  const hasExamples = word.examples && word.examples.length > 0;
  const pool = hasExamples ? modes : modes.filter(m => m !== 'cloze');
  return pool[Math.floor(Math.random() * pool.length)];
}

function renderCard(word, mode) {
  const body = document.getElementById('cardBody');
  const actions = document.getElementById('cardActions');
  body.innerHTML = '';
  actions.innerHTML = '';

  if (mode === 'meaning') renderMeaningCard(word, body, actions);
  else if (mode === 'listening') renderListeningCard(word, body, actions);
  else if (mode === 'spelling') renderSpellingCard(word, body, actions);
  else if (mode === 'cloze') renderClozeCard(word, body, actions);
}

function ratingButtons(word) {
  return `
    <button class="rating-btn again" data-r="again"><span class="label">Again</span><span class="sub">&lt; 1 day</span></button>
    <button class="rating-btn hard"  data-r="hard"><span class="label">Hard</span><span class="sub">~${Math.max(1, Math.round((word.interval||1)*1.2))}d</span></button>
    <button class="rating-btn good"  data-r="good"><span class="label">Good</span><span class="sub">~${Math.max(1, Math.round((word.interval||1)*(word.ease||2.5)))}d</span></button>
    <button class="rating-btn easy"  data-r="easy"><span class="label">Easy</span><span class="sub">~${Math.max(2, Math.round((word.interval||1)*(word.ease||2.5)*1.3))}d</span></button>
  `;
}

function attachRating(scope, word) {
  scope.querySelectorAll('.rating-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      applyRating(word, btn.dataset.r);
      recordReview();
      saveState();
      session.index++;
      showCard();
    });
  });
}

// --- Meaning recall ---
function renderMeaningCard(word, body, actions) {
  body.innerHTML = `
    <div class="word-display">${escapeHTML(word.text)}</div>
    <div class="phonetic">${escapeHTML(word.phonetic || '')}</div>
    <button class="btn-ghost" id="revealBtn">Reveal Meaning</button>
    <div id="revealArea" class="hidden"></div>
  `;
  document.getElementById('revealBtn').addEventListener('click', () => {
    document.getElementById('revealBtn').remove();
    const area = document.getElementById('revealArea');
    area.classList.remove('hidden');
    area.innerHTML = `
      <div class="definition">${escapeHTML(word.defEN || '(no English definition)')}</div>
      <div class="definition-cn">${escapeHTML(word.defCN || '(no Chinese meaning)')}</div>
      ${(word.examples || []).map(ex => `
        <div class="example">
          <div class="en">${escapeHTML(ex.en)}</div>
          ${ex.cn ? `<div class="cn">${escapeHTML(ex.cn)}</div>` : ''}
        </div>
      `).join('')}
    `;
    speak(word.text);
    actions.innerHTML = ratingButtons(word);
    attachRating(actions, word);
  });
}

// --- Listening MCQ ---
function renderListeningCard(word, body, actions) {
  const hasExample = word.examples && word.examples[0];
  const playText = hasExample ? word.examples[0].en : word.text;
  const others = state.words
    .filter(w => w.id !== word.id && w.defCN)
    .map(w => w.defCN);
  const correctText = (hasExample && word.examples[0].cn)
    ? word.examples[0].cn
    : (word.defCN || word.defEN || word.text);
  const distractors = pickRandom(others, 3);
  const options = shuffle([{ text: correctText, correct: true },
    ...distractors.map(t => ({ text: t, correct: false }))]);
  body.innerHTML = `
    <div class="phonetic">👂 Listen and choose the meaning</div>
    <button class="btn-ghost" id="replayBtn">🔊 Play Again</button>
    <div class="mcq-options" style="margin-top:20px"></div>
  `;
  const optsEl = body.querySelector('.mcq-options');
  options.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.className = 'mcq-option';
    btn.textContent = opt.text;
    btn.addEventListener('click', () => {
      optsEl.querySelectorAll('.mcq-option').forEach(b => b.disabled = true);
      const correctIdx = options.findIndex(o => o.correct);
      const correctBtn = optsEl.children[correctIdx];
      if (opt.correct) {
        btn.classList.add('correct');
        actions.innerHTML = `<div class="feedback ok" style="width:100%">✓ Correct — <b>${escapeHTML(word.text)}</b></div>${ratingButtons(word)}`;
      } else {
        btn.classList.add('wrong');
        correctBtn.classList.add('correct');
        actions.innerHTML = `<div class="feedback bad" style="width:100%">✗ Word: <b>${escapeHTML(word.text)}</b></div>${ratingButtons(word)}`;
      }
      speak(word.text);
      attachRating(actions, word);
    });
    optsEl.appendChild(btn);
  });
  document.getElementById('replayBtn').addEventListener('click', () => speak(playText));
  speak(playText);
}

// --- Spelling (dictation) ---
function renderSpellingCard(word, body, actions) {
  body.innerHTML = `
    <div class="phonetic">🔤 Listen and type the word</div>
    <button class="btn-ghost" id="replayBtn">🔊 Play Again</button>
    <input type="text" class="spelling-input" id="spellInput" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Type the word..." />
    <button class="btn-primary" id="checkSpell" style="margin-top:10px">Check</button>
    <div id="spellFeedback"></div>
  `;
  speak(word.text);
  const input = document.getElementById('spellInput');
  input.focus();
  const submit = () => {
    const val = input.value.trim().toLowerCase();
    const correct = val === word.text.toLowerCase();
    const fb = document.getElementById('spellFeedback');
    input.disabled = true;
    document.getElementById('checkSpell').disabled = true;
    if (correct) {
      fb.innerHTML = `<div class="feedback ok">✓ Correct — ${escapeHTML(word.text)}</div>
        <div class="definition-cn">${escapeHTML(word.defCN || '')}</div>`;
    } else {
      fb.innerHTML = `<div class="feedback bad">✗ Answer: <b>${escapeHTML(word.text)}</b></div>
        <div class="definition-cn">${escapeHTML(word.defCN || '')}</div>`;
    }
    actions.innerHTML = ratingButtons(word);
    attachRating(actions, word);
  };
  document.getElementById('checkSpell').addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  document.getElementById('replayBtn').addEventListener('click', () => speak(word.text));
}

// --- Cloze ---
function renderClozeCard(word, body, actions) {
  const ex = (word.examples || [])[0];
  if (!ex || !ex.en) return renderMeaningCard(word, body, actions);
  const escWord = word.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('\\b' + escWord + '\\w*', 'i');
  const blanked = escapeHTML(ex.en).replace(pattern, '<span class="cloze-blank">_____</span>');
  body.innerHTML = `
    <div class="phonetic">🎯 Fill in the blank</div>
    <div class="example" style="margin-top:14px;font-size:18px">${blanked}</div>
    <div class="definition-cn" style="margin-top:6px">${escapeHTML(ex.cn || '')}</div>
    <input type="text" class="spelling-input" id="clozeInput" placeholder="Type the missing word..." autocomplete="off" />
    <button class="btn-primary" id="checkCloze" style="margin-top:10px">Check</button>
    <div id="clozeFeedback"></div>
  `;
  const input = document.getElementById('clozeInput');
  input.focus();
  const submit = () => {
    const val = input.value.trim().toLowerCase();
    input.disabled = true;
    document.getElementById('checkCloze').disabled = true;
    const ok = val === word.text.toLowerCase();
    document.getElementById('clozeFeedback').innerHTML = ok
      ? `<div class="feedback ok">✓ Correct</div>`
      : `<div class="feedback bad">✗ Answer: <b>${escapeHTML(word.text)}</b></div>`;
    speak(ex.en);
    actions.innerHTML = ratingButtons(word);
    attachRating(actions, word);
  };
  document.getElementById('checkCloze').addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

// ============ Library ============
function renderLibrary() {
  const search = (document.getElementById('librarySearch').value || '').toLowerCase();
  const filter = document.getElementById('libraryFilter').value;
  const list = document.getElementById('libraryList');
  list.innerHTML = '';
  let items = state.words;
  if (filter === 'learning') items = items.filter(w => !w.archivedAt);
  else if (filter === 'archived') items = items.filter(w => w.archivedAt);
  else if (filter === 'due') items = items.filter(w => !w.archivedAt && (w.nextReview || 0) <= nowMs());
  if (search) items = items.filter(w =>
    w.text.toLowerCase().includes(search)
    || (w.defEN || '').toLowerCase().includes(search)
    || (w.defCN || '').includes(search)
    || (w.tags || []).some(t => t.toLowerCase().includes(search))
  );
  items = [...items].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  if (items.length === 0) {
    list.innerHTML = `<div class="empty-state"><p>No words found.</p></div>`;
    return;
  }
  items.forEach(w => {
    const pct = Math.round((w.level / MAX_LEVEL) * 100);
    const row = document.createElement('div');
    row.className = 'library-item' + (w.archivedAt ? ' archived' : '');
    row.innerHTML = `
      <div class="word-info">
        <div class="w">${escapeHTML(w.text)} ${w.archivedAt ? '⭐' : ''}</div>
        <div class="d">${escapeHTML(w.defCN || w.defEN || '')}</div>
        <div>${(w.tags || []).map(t => `<span class="tag">${escapeHTML(t)}</span>`).join('')}</div>
      </div>
      <div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="hint" style="text-align:center;margin-top:4px">Level ${w.level}/${MAX_LEVEL}</div>
      </div>
      <div class="item-actions">
        <button class="icon-btn" data-act="speak" title="Play">🔊</button>
        <button class="icon-btn" data-act="edit" title="Edit">✏️</button>
        <button class="icon-btn" data-act="reset" title="Reset progress">↺</button>
        <button class="icon-btn" data-act="delete" title="Delete">🗑️</button>
      </div>
    `;
    row.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => handleLibAction(w.id, btn.dataset.act));
    });
    list.appendChild(row);
  });
}

function handleLibAction(id, act) {
  const w = state.words.find(x => x.id === id);
  if (!w) return;
  if (act === 'speak') return speak(w.text);
  if (act === 'edit') {
    showView('add');
    document.getElementById('newWord').value = w.text;
    document.getElementById('newPhonetic').value = w.phonetic || '';
    document.getElementById('defEN').value = w.defEN || '';
    document.getElementById('defCN').value = w.defCN || '';
    document.getElementById('newTags').value = (w.tags || []).join(', ');
    renderExamples(w.examples || []);
    toast('Editing — save to update');
    return;
  }
  if (act === 'reset') {
    if (!confirm(`Reset progress for "${w.text}"?`)) return;
    w.level = 0; w.interval = 1; w.ease = DEFAULT_EASE;
    w.rightCount = 0; w.wrongCount = 0;
    w.nextReview = nowMs(); w.archivedAt = null;
    saveState(); renderLibrary(); toast('Reset');
    return;
  }
  if (act === 'delete') {
    if (!confirm(`Delete "${w.text}"? This cannot be undone.`)) return;
    state.words = state.words.filter(x => x.id !== id);
    saveState(); renderLibrary(); toast('Deleted');
  }
}

// ============ Drill ============
async function startDrill() {
  if (drill?.running) return;
  const src = document.getElementById('drillSource').value;
  const speed = parseFloat(document.getElementById('drillSpeed').value);
  const pause = parseFloat(document.getElementById('drillPause').value);
  const repeat = parseInt(document.getElementById('drillRepeat').value, 10);
  const sayWord = document.getElementById('drillIncludeWord').checked;
  const showCN = document.getElementById('drillShowCN').checked;
  let pool = state.words;
  if (src === 'learning') pool = pool.filter(w => !w.archivedAt);
  else if (src === 'archived') pool = pool.filter(w => w.archivedAt);
  else if (src === 'due') pool = pool.filter(w => !w.archivedAt && (w.nextReview || 0) <= nowMs());
  if (pool.length === 0) { toast('No words for this source'); return; }
  const queue = shuffle(pool);
  drill = { running: true, queue, idx: 0, total: queue.length };
  for (let i = 0; i < queue.length; i++) {
    if (!drill.running) break;
    drill.idx = i;
    const w = queue[i];
    const ex = (w.examples && w.examples[0]) ? w.examples[0] : { en: w.text, cn: w.defCN || '' };
    document.getElementById('drillWord').textContent = w.text;
    document.getElementById('drillSentence').textContent = ex.en;
    document.getElementById('drillCN').textContent = showCN ? (ex.cn || w.defCN || '') : '';
    document.getElementById('drillProgress').textContent = `${i + 1} / ${queue.length}`;
    for (let r = 0; r < repeat; r++) {
      if (!drill.running) break;
      if (sayWord) { await speak(w.text, { rate: speed }); await wait(300); }
      await speak(ex.en, { rate: speed });
      await wait(pause * 1000);
    }
  }
  if (drill.running) toast('Drill complete 🎧');
  drill.running = false;
}
function stopDrill() {
  if (drill) drill.running = false;
  speechSynthesis.cancel();
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ Stats ============
function renderStats() {
  const all = state.words;
  const learning = all.filter(w => !w.archivedAt);
  const archived = all.filter(w => w.archivedAt);
  const due = learning.filter(w => (w.nextReview || 0) <= nowMs());
  document.getElementById('statTotal').textContent = all.length;
  document.getElementById('statLearning').textContent = learning.length;
  document.getElementById('statArchived').textContent = archived.length;
  document.getElementById('statDue').textContent = due.length;
  document.getElementById('statStreak').textContent = state.streak.current;
  document.getElementById('statReviewed').textContent = state.activity[todayKey()] || 0;
  renderHeatmap();
  renderLevelChart();
}

function renderHeatmap() {
  const wrap = document.getElementById('heatmap');
  wrap.innerHTML = '';
  const today = new Date();
  const days = 84;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const count = state.activity[key] || 0;
    const el = document.createElement('div');
    el.className = 'heatmap-cell';
    if (count >= 1) el.classList.add('l1');
    if (count >= 5) el.classList.add('l2');
    if (count >= 15) el.classList.add('l3');
    if (count >= 30) el.classList.add('l4');
    el.title = `${key}: ${count} reviews`;
    wrap.appendChild(el);
  }
}

function renderLevelChart() {
  const canvas = document.getElementById('levelChart');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const buckets = [0, 0, 0, 0, 0, 0];
  state.words.forEach(word => { buckets[Math.min(MAX_LEVEL, word.level || 0)]++; });
  const max = Math.max(1, ...buckets);
  const barW = (w - 60) / 6;
  const baseY = h - 30;
  buckets.forEach((v, i) => {
    const x = 30 + i * barW + 10;
    const barHeight = (v / max) * (h - 60);
    ctx.fillStyle = i === 5 ? '#2bb673' : '#4f7cff';
    ctx.fillRect(x, baseY - barHeight, barW - 20, barHeight);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text') || '#000';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(v, x + (barW - 20) / 2, baseY - barHeight - 4);
    ctx.fillText(`L${i}`, x + (barW - 20) / 2, baseY + 18);
  });
}

// ============ Shadowing ============
let mediaRecorder = null;
let recChunks = [];
function shadowPlayRef() {
  const t = document.getElementById('shadowText').value.trim();
  if (!t) { toast('Enter text first'); return; }
  speak(t);
}
async function shadowStart() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    recChunks = [];
    mediaRecorder.ondataavailable = e => recChunks.push(e.data);
    mediaRecorder.onstop = () => {
      const blob = new Blob(recChunks, { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const wrap = document.getElementById('shadowPlayback');
      wrap.innerHTML = `
        <div style="margin-top:10px"><b>Your recording:</b></div>
        <audio controls src="${url}"></audio>
        <button class="btn-ghost" id="shadowPlayBoth" style="margin-top:6px">▶ Compare with native</button>
      `;
      document.getElementById('shadowPlayBoth').addEventListener('click', async () => {
        const a = wrap.querySelector('audio');
        a.currentTime = 0; await a.play();
        a.onended = () => speak(document.getElementById('shadowText').value);
      });
      stream.getTracks().forEach(t => t.stop());
    };
    mediaRecorder.start();
    document.getElementById('shadowStart').disabled = true;
    document.getElementById('shadowStop').disabled = false;
    toast('Recording...');
  } catch (e) {
    toast('Microphone access denied');
  }
}
function shadowStop() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  document.getElementById('shadowStart').disabled = false;
  document.getElementById('shadowStop').disabled = true;
}

// ============ Export / Import ============
function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `english-trainer-${todayKey()}.json`;
  a.click();
}
function exportAnki() {
  const rows = state.words.map(w => {
    const front = w.text;
    const back = [w.phonetic, w.defEN, w.defCN, (w.examples || []).map(e => `${e.en} | ${e.cn}`).join('<br>')]
      .filter(Boolean).join('<br><br>');
    return [front, back, (w.tags || []).join(' ')]
      .map(s => `"${String(s).replace(/"/g, '""')}"`).join(',');
  });
  const csv = 'Front,Back,Tags\n' + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `english-trainer-anki-${todayKey()}.csv`;
  a.click();
}
function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || !Array.isArray(parsed.words)) throw new Error('Invalid file');
      if (!confirm(`Import ${parsed.words.length} words? This will merge with existing data.`)) return;
      const byText = new Map(state.words.map(w => [w.text.toLowerCase(), w]));
      parsed.words.forEach(w => {
        if (!byText.has(w.text.toLowerCase())) state.words.push(w);
      });
      Object.entries(parsed.activity || {}).forEach(([k, v]) => {
        state.activity[k] = Math.max(state.activity[k] || 0, v);
      });
      saveState();
      toast(`Imported ${parsed.words.length} words`);
      renderLibrary();
    } catch (e) {
      toast('Import failed — invalid file');
    }
  };
  reader.readAsText(file);
}

// ============ Settings ============
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.settings.theme || 'light');
}
function toggleTheme() {
  state.settings.theme = (state.settings.theme === 'dark') ? 'light' : 'dark';
  saveState(); applyTheme();
}
function resetAll() {
  if (!confirm('Delete ALL words and progress? Cannot be undone.')) return;
  if (!confirm('Are you absolutely sure?')) return;
  state = defaultState();
  saveState();
  applyTheme();
  document.getElementById('streakBadge').textContent = `🔥 0`;
  toast('All data cleared');
  showView('learn');
}

// ============ Init ============
function init() {
  applyTheme();
  document.getElementById('streakBadge').textContent = `🔥 ${state.streak.current || 0}`;
  loadVoices();

  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => showView(t.dataset.view));
  });
  document.querySelectorAll('[data-goto]').forEach(el => {
    el.addEventListener('click', () => showView(el.dataset.goto));
  });

  // Add view
  document.getElementById('autoFillBtn').addEventListener('click', autoFill);
  document.getElementById('translateBtn').addEventListener('click', translateDefOnly);
  document.getElementById('saveWordBtn').addEventListener('click', saveWord);
  document.getElementById('clearFormBtn').addEventListener('click', clearForm);
  document.getElementById('addExampleBtn').addEventListener('click', () => addExampleRow());
  document.getElementById('bulkImportBtn').addEventListener('click', bulkImport);
  renderExamples([]);

  // Learn
  document.getElementById('learnMode').addEventListener('change', () => { if (session) showCard(); });
  document.getElementById('endSession').addEventListener('click', endSession);
  document.getElementById('ttsBtn').addEventListener('click', () => {
    if (session) speak(session.queue[session.index].text);
  });
  document.getElementById('ttsSlowBtn').addEventListener('click', () => {
    if (session) speak(session.queue[session.index].text, { slow: true });
  });

  // Library
  document.getElementById('librarySearch').addEventListener('input', renderLibrary);
  document.getElementById('libraryFilter').addEventListener('change', renderLibrary);

  // Drill
  document.getElementById('drillStartBtn').addEventListener('click', startDrill);
  document.getElementById('drillStopBtn').addEventListener('click', stopDrill);

  // Settings
  document.getElementById('voiceSelect').addEventListener('change', e => {
    state.settings.voiceURI = e.target.value; saveState();
  });
  const rateEl = document.getElementById('ttsRate');
  rateEl.value = state.settings.rate || 1;
  document.getElementById('ttsRateVal').textContent = (state.settings.rate || 1).toFixed(2);
  rateEl.addEventListener('input', e => {
    state.settings.rate = parseFloat(e.target.value);
    document.getElementById('ttsRateVal').textContent = state.settings.rate.toFixed(2);
    saveState();
  });
  document.getElementById('ttsTestBtn').addEventListener('click', () => speak('Hello! This is a test of the selected voice.'));
  document.getElementById('shadowPlayRef').addEventListener('click', shadowPlayRef);
  document.getElementById('shadowStart').addEventListener('click', shadowStart);
  document.getElementById('shadowStop').addEventListener('click', shadowStop);
  document.getElementById('exportJsonBtn').addEventListener('click', exportJSON);
  document.getElementById('exportAnkiBtn').addEventListener('click', exportAnki);
  document.getElementById('importJsonInput').addEventListener('change', e => {
    if (e.target.files[0]) importJSON(e.target.files[0]);
  });
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  document.getElementById('resetAllBtn').addEventListener('click', resetAll);

  // Keyboard shortcuts in learn view (1=Again, 2=Hard, 3=Good, 4=Easy)
  document.addEventListener('keydown', e => {
    if (!document.getElementById('view-learn').classList.contains('active')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const map = { '1': 'again', '2': 'hard', '3': 'good', '4': 'easy' };
    const r = map[e.key];
    if (r) {
      const btn = document.querySelector(`.rating-btn[data-r="${r}"]`);
      if (btn) btn.click();
    }
  });

  startSession();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
