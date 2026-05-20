/* ============================================================
   English Vocabulary & Listening Trainer
   Pure HTML/JS, localStorage-backed, no build step.
   ============================================================ */

'use strict';

// ============ Constants ============
const STORAGE_KEY = 'englishTrainerData_v1';
const SYNC_KEY = 'englishTrainerSync_v1';
const GIST_FILE = 'english-trainer-data.json';
const PUSH_DEBOUNCE_MS = 2500;
const MAX_LEVEL = 5;                 // archive when level reaches this
const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const DAY_MS = 86400000;
const SESSION_SIZE = 15;             // max cards per session
const DICT_API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const TRANSLATE_API = 'https://api.mymemory.translated.net/get';
const DATAMUSE_API = 'https://api.datamuse.com/words';

// Leech: 4+ wrong, or 6+ attempts with >40% wrong rate
const LEECH_MIN_WRONG = 4;
const LEECH_MIN_TOTAL = 6;
const LEECH_WRONG_RATIO = 0.4;

// ~80 most common stopwords for transcript extraction
const STOPWORDS = new Set(('a an the and or but if then so because while when where what who whom whose why how that this these those is am are was were be been being have has had do does did doing will would shall should can could may might must of in on at to from for with by as into onto over under about against between through during before after above below up down out off near i you he she it we they me him her us them my your his its our their mine yours hers ours theirs not no yes than too very just only also even still yet already always never very much more most few less least some any all each every').split(' '));

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
  schedulePush();
}

// ============ Sync config (local-only, never pushed to gist) ============

function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveSyncConfig(cfg) {
  localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
}
function clearSyncConfig() {
  localStorage.removeItem(SYNC_KEY);
}
function isSyncConnected() {
  const c = loadSyncConfig();
  return !!(c.token && c.gistId);
}

// ============ GitHub Gist API ============

function ghHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
async function ghAuth(token) {
  const r = await fetch('https://api.github.com/user', { headers: ghHeaders(token) });
  return r.ok ? await r.json() : null;
}
async function ghFindGist(token) {
  const r = await fetch('https://api.github.com/gists?per_page=100', { headers: ghHeaders(token) });
  if (!r.ok) return null;
  const list = await r.json();
  return list.find(g => g.files && g.files[GIST_FILE]) || null;
}
async function ghCreateGist(token, content) {
  const r = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({
      description: 'English Trainer sync data (do not edit by hand)',
      public: false,
      files: { [GIST_FILE]: { content } },
    }),
  });
  return r.ok ? await r.json() : null;
}
async function ghGetGist(token, id) {
  const r = await fetch(`https://api.github.com/gists/${id}`, { headers: ghHeaders(token) });
  if (!r.ok) return null;
  const data = await r.json();
  return data.files?.[GIST_FILE]?.content || null;
}
async function ghUpdateGist(token, id, content) {
  const r = await fetch(`https://api.github.com/gists/${id}`, {
    method: 'PATCH',
    headers: ghHeaders(token),
    body: JSON.stringify({ files: { [GIST_FILE]: { content } } }),
  });
  return r.ok;
}

// ============ Merge logic (per-word updatedAt wins) ============

function wordEditTs(w) { return w.updatedAt || w.createdAt || ''; }

function mergeStates(local, remote) {
  if (!remote || !Array.isArray(remote.words)) return local;
  const byId = new Map();
  for (const w of (local.words || [])) byId.set(w.id, w);
  for (const w of remote.words) {
    const cur = byId.get(w.id);
    if (!cur) byId.set(w.id, w);
    else if (wordEditTs(w) > wordEditTs(cur)) byId.set(w.id, w);
  }
  const activity = { ...(local.activity || {}) };
  for (const [k, v] of Object.entries(remote.activity || {})) {
    activity[k] = Math.max(activity[k] || 0, v);
  }
  const localLast = local.streak?.lastDay || '';
  const remoteLast = remote.streak?.lastDay || '';
  const streak = remoteLast > localLast ? remote.streak : local.streak;
  return {
    ...local,
    words: [...byId.values()],
    activity,
    streak,
  };
}

// ============ Sync orchestration ============

function setSyncStatus(s) {
  const el = document.getElementById('syncIndicator');
  if (!el) return;
  el.classList.remove('hidden', 'ok', 'syncing', 'error');
  if (s === 'hidden') { el.classList.add('hidden'); return; }
  el.classList.add(s);
  el.title = ({
    ok: 'Synced',
    syncing: 'Syncing…',
    error: 'Sync error (click to retry)',
  })[s] || 'Sync';
}

async function connectSync(token) {
  const t = (token || '').trim();
  if (!t) return { error: 'Token is required' };
  setSyncStatus('syncing');
  const user = await ghAuth(t);
  if (!user) { setSyncStatus('error'); return { error: 'Invalid token or insufficient scope' }; }
  let gist = await ghFindGist(t);
  if (!gist) {
    gist = await ghCreateGist(t, JSON.stringify(state));
    if (!gist) { setSyncStatus('error'); return { error: 'Failed to create gist' }; }
  }
  saveSyncConfig({ token: t, gistId: gist.id, user: user.login, lastSyncedAt: Date.now() });
  await syncNow();
  return { ok: true, user: user.login, gistId: gist.id };
}

async function syncNow() {
  const cfg = loadSyncConfig();
  if (!cfg.token || !cfg.gistId) return false;
  setSyncStatus('syncing');
  try {
    const remoteJson = await ghGetGist(cfg.token, cfg.gistId);
    if (remoteJson) {
      try {
        const remote = JSON.parse(remoteJson);
        state = mergeStates(state, remote);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); // direct write, no re-push
      } catch (e) { /* corrupt remote, will be overwritten by push */ }
    }
    const ok = await ghUpdateGist(cfg.token, cfg.gistId, JSON.stringify(state));
    if (!ok) { setSyncStatus('error'); return false; }
    cfg.lastSyncedAt = Date.now();
    saveSyncConfig(cfg);
    setSyncStatus('ok');
    refreshActiveView();
    return true;
  } catch (e) {
    setSyncStatus('error');
    return false;
  }
}

function disconnectSync() {
  clearSyncConfig();
  setSyncStatus('hidden');
}

// Debounced auto-push triggered by saveState()
let pushTimer = null;
function schedulePush() {
  const cfg = loadSyncConfig();
  if (!cfg.token || !cfg.gistId) return;
  setSyncStatus('syncing');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    const ok = await ghUpdateGist(cfg.token, cfg.gistId, JSON.stringify(state));
    if (ok) {
      cfg.lastSyncedAt = Date.now();
      saveSyncConfig(cfg);
      setSyncStatus('ok');
    } else {
      setSyncStatus('error');
    }
  }, PUSH_DEBOUNCE_MS);
}

// Re-render whichever view is currently visible after a sync pull
function refreshActiveView() {
  const active = document.querySelector('.view.active');
  if (!active) return;
  const id = active.id.replace('view-', '');
  if (id === 'library') renderLibrary();
  else if (id === 'stats') renderStats();
  else if (id === 'reading') renderReading();
  // learn view: don't disrupt an in-progress card
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
  word.updatedAt = new Date().toISOString();

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
  const leechBoost = isLeech(word) ? 25 : 0;
  return levelWeight + overdueDays + wrongWeight + newBonus + leechBoost + Math.random() * 2;
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
  if (name === 'reading') renderReading();
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

// ----- Datamuse enrichment (free, no API key) -----

async function datamuseQuery(params) {
  try {
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(`${DATAMUSE_API}?${qs}`);
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data.map(x => x.word).filter(Boolean) : [];
  } catch (e) {
    console.warn('Datamuse failed', e);
    return [];
  }
}

function fetchSynonyms(word) { return datamuseQuery({ rel_syn: word, max: 6 }); }
function fetchAntonyms(word) { return datamuseQuery({ rel_ant: word, max: 6 }); }

async function fetchCollocations(word) {
  const [before, after] = await Promise.all([
    datamuseQuery({ rel_bgb: word, max: 4 }),
    datamuseQuery({ rel_bga: word, max: 4 }),
  ]);
  return {
    before: before.map(w => `${w} ${word}`),
    after: after.map(w => `${word} ${w}`),
  };
}

async function fetchWordFamily(word) {
  // Derivationally related forms (rel_der) gives noun/verb/adj variants.
  // Fallback to prefix search if rel_der returns nothing.
  let words = await datamuseQuery({ rel_der: word, max: 8 });
  if (words.length === 0 && word.length >= 4) {
    const stem = word.slice(0, Math.max(4, word.length - 2));
    words = await datamuseQuery({ sp: stem + '*', max: 12 });
    words = words.filter(w => w !== word).slice(0, 8);
  }
  return words;
}

async function enrichWord(word) {
  const [synonyms, antonyms, family, coll] = await Promise.all([
    fetchSynonyms(word),
    fetchAntonyms(word),
    fetchWordFamily(word),
    fetchCollocations(word),
  ]);
  return {
    synonyms,
    antonyms,
    family,
    collocations: [...coll.before, ...coll.after],
  };
}

// ----- Leech detection -----

function isLeech(word) {
  const wrong = word.wrongCount || 0;
  const right = word.rightCount || 0;
  const total = wrong + right;
  if (wrong >= LEECH_MIN_WRONG) return true;
  if (total >= LEECH_MIN_TOTAL && wrong / total > LEECH_WRONG_RATIO) return true;
  return false;
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
  toast('Fetching synonyms, family, collocations...');
  const enrichment = await enrichWord(word);
  renderEnrichment(enrichment);
  toast('Auto-fill complete ✓');
}

function renderEnrichment(e) {
  const wrap = document.getElementById('enrichmentArea');
  if (!wrap) return;
  wrap.dataset.synonyms = (e.synonyms || []).join('|');
  wrap.dataset.antonyms = (e.antonyms || []).join('|');
  wrap.dataset.family = (e.family || []).join('|');
  wrap.dataset.collocations = (e.collocations || []).join('|');
  wrap.innerHTML = `
    ${chipBlock('Synonyms', e.synonyms)}
    ${chipBlock('Antonyms', e.antonyms)}
    ${chipBlock('Word Family', e.family)}
    ${chipBlock('Collocations', e.collocations)}
  `;
}

function chipBlock(label, list) {
  if (!list || list.length === 0) return '';
  return `<div class="chip-block">
    <span class="chip-label">${label}:</span>
    ${list.map(x => `<span class="chip">${escapeHTML(x)}</span>`).join('')}
  </div>`;
}

function collectEnrichment() {
  const wrap = document.getElementById('enrichmentArea');
  const get = k => (wrap?.dataset[k] || '').split('|').filter(Boolean);
  return {
    synonyms: get('synonyms'),
    antonyms: get('antonyms'),
    family: get('family'),
    collocations: get('collocations'),
  };
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
  const enr = document.getElementById('enrichmentArea');
  if (enr) {
    enr.innerHTML = '';
    ['synonyms', 'antonyms', 'family', 'collocations'].forEach(k => delete enr.dataset[k]);
  }
}

function saveWord() {
  const text = document.getElementById('newWord').value.trim();
  if (!text) { toast('Word is required'); return; }
  const enrichment = collectEnrichment();
  const existing = state.words.find(w => w.text.toLowerCase() === text.toLowerCase());
  const nowIso = new Date().toISOString();
  if (existing) {
    if (!confirm(`"${text}" already exists. Update it?`)) return;
    Object.assign(existing, {
      phonetic: document.getElementById('newPhonetic').value.trim(),
      defEN: document.getElementById('defEN').value.trim(),
      defCN: document.getElementById('defCN').value.trim(),
      examples: collectExamples(),
      tags: document.getElementById('newTags').value.split(',').map(s => s.trim()).filter(Boolean),
      ...enrichment,
      updatedAt: nowIso,
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
      synonyms: enrichment.synonyms,
      antonyms: enrichment.antonyms,
      family: enrichment.family,
      collocations: enrichment.collocations,
      level: 0,
      ease: DEFAULT_EASE,
      interval: 1,
      nextReview: nowMs(),
      rightCount: 0,
      wrongCount: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
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
    const enrichment = await enrichWord(w);
    state.words.push({
      id: uid(),
      text: w,
      phonetic: data?.phonetic || '',
      defEN: data?.defEN || '',
      defCN,
      examples,
      tags: [],
      synonyms: enrichment.synonyms,
      antonyms: enrichment.antonyms,
      family: enrichment.family,
      collocations: enrichment.collocations,
      level: 0, ease: DEFAULT_EASE, interval: 1,
      nextReview: nowMs(), rightCount: 0, wrongCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
    });
    added++;
    saveState();
  }
  status.textContent = `✓ Imported ${added} new word(s)`;
  document.getElementById('bulkInput').value = '';
}

// Extract uncommon vocabulary from a pasted transcript paragraph.
// Filters out stopwords, words already in library, words shorter than 3 chars,
// and proper nouns (best-effort: words that only appear capitalized).
function extractFromTranscript() {
  const raw = document.getElementById('transcriptInput').value.trim();
  if (!raw) { toast('Paste some text first'); return; }
  const tokens = raw.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
  const existing = new Set(state.words.map(w => w.text.toLowerCase()));
  const freq = new Map();
  tokens.forEach(t => {
    if (STOPWORDS.has(t)) return;
    if (existing.has(t)) return;
    if (t.length < 4) return;
    freq.set(t, (freq.get(t) || 0) + 1);
  });
  const ranked = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([w]) => w);
  if (ranked.length === 0) { toast('No new words found'); return; }
  document.getElementById('bulkInput').value = ranked.join('\n');
  toast(`Found ${ranked.length} new word(s). Click "Import All" to add.`);
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
  const modes = ['meaning', 'listening', 'spelling', 'cloze', 'context'];
  const hasExamples = word.examples && word.examples.length > 0;
  const otherExamples = state.words.some(w => w.id !== word.id && (w.examples || []).some(e => e.en));
  let pool = modes;
  if (!hasExamples) pool = pool.filter(m => m !== 'cloze' && m !== 'context');
  if (!otherExamples) pool = pool.filter(m => m !== 'context');
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
  else if (mode === 'context') renderContextCard(word, body, actions);
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
      ${chipBlock('Synonyms', word.synonyms)}
      ${chipBlock('Antonyms', word.antonyms)}
      ${chipBlock('Word Family', word.family)}
      ${chipBlock('Collocations', word.collocations)}
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

// --- Context Card: which sentence does this word belong in? ---
function renderContextCard(word, body, actions) {
  const ownEx = (word.examples || []).find(e => e.en);
  if (!ownEx) return renderMeaningCard(word, body, actions);
  const escWord = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Build distractor sentences from OTHER words; blank out their key word
  const otherSentences = state.words
    .filter(w => w.id !== word.id)
    .flatMap(w => (w.examples || [])
      .filter(e => e.en)
      .map(e => ({
        text: e.en.replace(new RegExp('\\b' + escWord(w.text) + '\\w*', 'i'), '_____'),
        cn: e.cn,
      })))
    .filter(s => s.text.includes('_____'));
  const distractors = pickRandom(otherSentences, 2);
  if (distractors.length < 2) return renderMeaningCard(word, body, actions);
  const correctSentence = {
    text: ownEx.en.replace(new RegExp('\\b' + escWord(word.text) + '\\w*', 'i'), '_____'),
    cn: ownEx.cn,
    correct: true,
  };
  const options = shuffle([correctSentence, ...distractors.map(d => ({ ...d, correct: false }))]);
  body.innerHTML = `
    <div class="word-display">${escapeHTML(word.text)}</div>
    <div class="phonetic">${escapeHTML(word.phonetic || '')}</div>
    <div class="phonetic" style="margin-top:6px">🎯 Which sentence does this word fit?</div>
    <div class="mcq-options" style="margin-top:14px"></div>
  `;
  const optsEl = body.querySelector('.mcq-options');
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'mcq-option';
    btn.innerHTML = `<div>${escapeHTML(opt.text)}</div>${opt.cn ? `<div class="cn" style="margin-top:6px;color:var(--text-muted);font-size:13px">${escapeHTML(opt.cn)}</div>` : ''}`;
    btn.addEventListener('click', () => {
      optsEl.querySelectorAll('.mcq-option').forEach(b => b.disabled = true);
      const correctIdx = options.findIndex(o => o.correct);
      optsEl.children[correctIdx].classList.add('correct');
      if (!opt.correct) btn.classList.add('wrong');
      speak(word.text);
      const head = opt.correct
        ? `<div class="feedback ok" style="width:100%">✓ Correct</div>`
        : `<div class="feedback bad" style="width:100%">✗ Right answer highlighted</div>`;
      actions.innerHTML = head + ratingButtons(word);
      attachRating(actions, word);
    });
    optsEl.appendChild(btn);
  });
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
  else if (filter === 'leech') items = items.filter(w => !w.archivedAt && isLeech(w));
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
    const leech = !w.archivedAt && isLeech(w);
    row.className = 'library-item' + (w.archivedAt ? ' archived' : '') + (leech ? ' leech' : '');
    row.innerHTML = `
      <div class="word-info">
        <div class="w">${escapeHTML(w.text)} ${w.archivedAt ? '⭐' : ''}${leech ? ' 🐛' : ''}</div>
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
    renderEnrichment({
      synonyms: w.synonyms || [],
      antonyms: w.antonyms || [],
      family: w.family || [],
      collocations: w.collocations || [],
    });
    toast('Editing — save to update');
    return;
  }
  if (act === 'reset') {
    if (!confirm(`Reset progress for "${w.text}"?`)) return;
    w.level = 0; w.interval = 1; w.ease = DEFAULT_EASE;
    w.rightCount = 0; w.wrongCount = 0;
    w.nextReview = nowMs(); w.archivedAt = null;
    w.updatedAt = new Date().toISOString();
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

// ============ Spaced Reading ============
// Build a "paragraph" from the user's recent active words using their example sentences,
// with the target word highlighted. Click any word to hear it, or play the whole passage.

let readingState = null;

function renderReading() {
  const N = parseInt(document.getElementById('readingCount')?.value || '12', 10);
  const source = document.getElementById('readingSource')?.value || 'recent';
  let pool = state.words.filter(w => !w.archivedAt && (w.examples || []).some(e => e.en));
  if (source === 'leech') pool = pool.filter(isLeech);
  else if (source === 'due') pool = pool.filter(w => (w.nextReview || 0) <= nowMs());
  // newest first
  pool = [...pool].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const picked = pool.slice(0, N);
  const wrap = document.getElementById('readingPassage');
  if (!wrap) return;
  if (picked.length === 0) {
    wrap.innerHTML = `<p class="hint">No words with example sentences yet. Add some words first.</p>`;
    readingState = null;
    return;
  }
  readingState = { words: picked };
  wrap.innerHTML = picked.map((w, idx) => {
    const ex = w.examples.find(e => e.en);
    const escWord = w.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const highlighted = escapeHTML(ex.en).replace(
      new RegExp('\\b' + escWord + '\\w*', 'i'),
      m => `<mark data-word="${escapeHTML(w.text)}">${m}</mark>`
    );
    return `
      <div class="reading-sentence" data-idx="${idx}">
        <div class="reading-en">${highlighted}</div>
        ${ex.cn ? `<div class="reading-cn">${escapeHTML(ex.cn)}</div>` : ''}
      </div>
    `;
  }).join('');
  // Click any highlight to hear
  wrap.querySelectorAll('mark').forEach(m => {
    m.addEventListener('click', () => speak(m.dataset.word));
  });
}

async function readingPlayAll() {
  if (!readingState || !readingState.words.length) return;
  const speed = parseFloat(document.getElementById('readingSpeed').value);
  readingState.playing = true;
  for (let i = 0; i < readingState.words.length; i++) {
    if (!readingState.playing) break;
    const w = readingState.words[i];
    const ex = w.examples.find(e => e.en);
    const el = document.querySelector(`.reading-sentence[data-idx="${i}"]`);
    if (el) { el.classList.add('active'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    await speak(ex.en, { rate: speed });
    if (el) el.classList.remove('active');
    await wait(400);
  }
  readingState.playing = false;
}
function readingStop() {
  if (readingState) readingState.playing = false;
  speechSynthesis.cancel();
}

// ============ Stats ============
function renderStats() {
  const all = state.words;
  const learning = all.filter(w => !w.archivedAt);
  const archived = all.filter(w => w.archivedAt);
  const due = learning.filter(w => (w.nextReview || 0) <= nowMs());
  const leeches = learning.filter(isLeech);
  document.getElementById('statTotal').textContent = all.length;
  document.getElementById('statLearning').textContent = learning.length;
  document.getElementById('statArchived').textContent = archived.length;
  document.getElementById('statDue').textContent = due.length;
  document.getElementById('statStreak').textContent = state.streak.current;
  document.getElementById('statReviewed').textContent = state.activity[todayKey()] || 0;
  const leechEl = document.getElementById('statLeeches');
  if (leechEl) leechEl.textContent = leeches.length;
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

// ============ Sync Code (cross-device paste sync) ============
// A pragmatic sync without backend: encode state to a compact base64 string
// the user can copy on one device and paste on another. For true cloud sync
// (Firebase / Supabase), see the note in Settings.

function generateSyncCode() {
  try {
    const json = JSON.stringify(state);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    const ta = document.getElementById('syncCodeOut');
    ta.value = b64;
    ta.select();
    navigator.clipboard?.writeText(b64);
    toast('Sync code copied to clipboard');
  } catch (e) {
    toast('Failed to generate code');
  }
}

function applySyncCode() {
  const code = document.getElementById('syncCodeIn').value.trim();
  if (!code) { toast('Paste a sync code first'); return; }
  try {
    const json = decodeURIComponent(escape(atob(code)));
    const parsed = JSON.parse(json);
    if (!parsed || !Array.isArray(parsed.words)) throw new Error('bad');
    if (!confirm(`Replace local data with ${parsed.words.length} words from sync code?`)) return;
    state = Object.assign(defaultState(), parsed);
    saveState();
    applyTheme();
    document.getElementById('streakBadge').textContent = `🔥 ${state.streak.current || 0}`;
    toast('Synced from code ✓');
    showView('library');
  } catch (e) {
    toast('Invalid sync code');
  }
}

// ============ Gist sync UI handlers ============

function renderSyncUI() {
  const connected = isSyncConnected();
  const disc = document.getElementById('syncDisconnected');
  const conn = document.getElementById('syncConnected');
  if (!disc || !conn) return;
  if (connected) {
    const cfg = loadSyncConfig();
    disc.classList.add('hidden');
    conn.classList.remove('hidden');
    document.getElementById('syncUser').textContent = cfg.user || '?';
    document.getElementById('syncGistId').textContent = (cfg.gistId || '').slice(0, 12) + '…';
    document.getElementById('syncLastTime').textContent = cfg.lastSyncedAt
      ? new Date(cfg.lastSyncedAt).toLocaleString()
      : 'never';
    setSyncStatus('ok');
  } else {
    disc.classList.remove('hidden');
    conn.classList.add('hidden');
    setSyncStatus('hidden');
  }
}

async function handleConnectClick() {
  const token = document.getElementById('gistToken').value.trim();
  if (!token) { toast('Paste your GitHub token first'); return; }
  const btn = document.getElementById('syncConnectBtn');
  btn.disabled = true; btn.textContent = 'Connecting...';
  const res = await connectSync(token);
  btn.disabled = false; btn.textContent = '🔗 Connect';
  if (res.error) { toast(res.error); return; }
  document.getElementById('gistToken').value = '';
  toast(`Connected as ${res.user} ✓`);
  renderSyncUI();
  refreshActiveView();
}

function handleDisconnectClick() {
  if (!confirm('Disconnect from Gist sync? Local data is kept; the gist itself is not deleted.')) return;
  disconnectSync();
  renderSyncUI();
  toast('Disconnected');
}

// ============ URL param: ?add=<word> (used by browser extension) ============
function handleUrlParams() {
  const p = new URLSearchParams(location.search);
  const w = p.get('add');
  if (!w) return;
  showView('add');
  document.getElementById('newWord').value = w;
  const sentence = p.get('sentence');
  if (sentence) {
    renderExamples([{ en: sentence, cn: '' }]);
  }
  toast(`Quick-add: "${w}"`);
  // Clear the param so reloads don't re-trigger
  history.replaceState(null, '', location.pathname);
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
  document.getElementById('transcriptExtractBtn').addEventListener('click', extractFromTranscript);
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

  // Reading
  document.getElementById('readingRefresh').addEventListener('click', renderReading);
  document.getElementById('readingPlayAll').addEventListener('click', readingPlayAll);
  document.getElementById('readingStop').addEventListener('click', readingStop);
  document.getElementById('readingSource').addEventListener('change', renderReading);
  document.getElementById('readingCount').addEventListener('change', renderReading);

  // Sync (manual code)
  document.getElementById('syncGenBtn').addEventListener('click', generateSyncCode);
  document.getElementById('syncApplyBtn').addEventListener('click', applySyncCode);

  // Cloud sync (Gist)
  document.getElementById('syncConnectBtn').addEventListener('click', handleConnectClick);
  document.getElementById('syncDisconnectBtn').addEventListener('click', handleDisconnectClick);
  document.getElementById('syncNowBtn').addEventListener('click', async () => {
    const ok = await syncNow();
    toast(ok ? 'Synced ✓' : 'Sync failed');
    renderSyncUI();
  });
  document.getElementById('syncIndicator').addEventListener('click', async () => {
    const ok = await syncNow();
    if (!ok) toast('Sync failed — check token / network');
    renderSyncUI();
  });
  renderSyncUI();
  // Initial pull on app load if connected (non-blocking)
  if (isSyncConnected()) {
    syncNow().then(() => renderSyncUI());
  }

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
  handleUrlParams();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
