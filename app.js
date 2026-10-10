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
const MAX_EXAMPLES = 3;              // example sentences kept per word
const DICT_API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const WIKTIONARY_API = 'https://en.wiktionary.org/api/rest_v1/page/definition/';
const DICT_TIMEOUT_MS = 5000;  // give up on a dictionary that hasn't answered by then
const TRANSLATE_API = 'https://api.mymemory.translated.net/get';
const DATAMUSE_API = 'https://api.datamuse.com/words';

// Leech: 4+ wrong, or 6+ attempts with >40% wrong rate
const LEECH_MIN_WRONG = 4;
const LEECH_MIN_TOTAL = 6;
const LEECH_WRONG_RATIO = 0.4;

// ============ State ============
let state = loadState();
let session = null;       // active learn session
let drill = null;         // active drill state

// ============ Storage ============
function defaultState() {
  return {
    words: [],
    deletedWords: {},  // { wordId: deletedAt } — so a sync doesn't bring deleted words back (learning-merge.js)
    settings: { voiceURI: null, rate: 1, theme: 'light' },
    activity: {},   // { 'YYYY-MM-DD': reviewCount }
    streak: { current: 0, lastDay: null },
    journal: {},    // { 'YYYY-MM-DD': 'entry text' }
    journalLog: {}, // { 'YYYY-MM-DD': savedAt } — last save or delete of each entry, for merging
    journalFeedback: {},  // { 'YYYY-MM-DD': { text, source, updatedAt } } — pasted AI replies (journal-feedback-store.js)
    known: [],      // lowercase words the user already knows (Book Reader)
    knownLog: {},   // { word: { known, ts } } — un-marks, so sync doesn't resurrect them
    analyses: [],   // saved AI passage analyses (see analysis-store.js)
    materials: [],  // saved transcripts and articles for the Reader (see material-store.js)
    quizzes: [],    // checked quizzes with their AI feedback (see quiz-store.js)
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
  if (typeof renderStorageMeter === 'function' && document.getElementById('view-settings')?.classList?.contains('active')) renderStorageMeter();
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
  // A failed list must not look like "no gist yet", or connecting would create a second one
  if (!r.ok) throw new Error(`Could not list your gists (${r.status})`);
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
  // A failed read must stop the sync: treating it as "no remote data" would overwrite the other devices
  const r = await fetch(`https://api.github.com/gists/${id}`, { headers: ghHeaders(token) });
  if (!r.ok) throw new Error(`Could not read the sync gist (${r.status})`);
  const data = await r.json();
  const file = data.files?.[GIST_FILE];
  if (!file) return null;
  if (!file.truncated) return file.content || null;
  // The API cuts files over 1 MB short; the full text is at raw_url
  const raw = await fetch(file.raw_url);
  if (!raw.ok) throw new Error(`Could not read the full sync file (${raw.status})`);
  return raw.text();
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

function mergeStates(local, remote) {
  if (!remote || !Array.isArray(remote.words)) return local;
  // Words and journal entries: the newest edit or deletion wins (learning-merge.js)
  const { words, deletedWords } = LearningMerge.mergeWords(local, remote);
  const { journal, journalLog } = LearningMerge.mergeJournal(local, remote);
  const activity = { ...(local.activity || {}) };
  for (const [k, v] of Object.entries(remote.activity || {})) {
    activity[k] = Math.max(activity[k] || 0, v);
  }
  const localLast = local.streak?.lastDay || '';
  const remoteLast = remote.streak?.lastDay || '';
  const streak = remoteLast > localLast ? remote.streak : local.streak;
  // Known words: union, except words whose newest log entry is an un-mark
  const { known, knownLog } = TextCore.mergeKnown(local, remote);
  return {
    ...local,
    words,
    deletedWords,
    activity,
    streak,
    journal,
    journalLog,
    known,
    knownLog,
    analyses: AnalysisStore.merge(local.analyses, remote.analyses),
    materials: MaterialStore.merge(local.materials, remote.materials),
    journalFeedback: JournalFeedbackStore.merge(local.journalFeedback, remote.journalFeedback),
    quizzes: QuizStore.merge(local.quizzes, remote.quizzes),
  };
}

// `next` (a fresh state for Reset All, or the data of a Sync Code), plus deletion records for everything in
// `current` that `next` doesn't have, so a sync with another device doesn't bring the old data back
function replaceState(current, next, now) {
  const liveIds = list => new Set((Array.isArray(list) ? list : []).filter(e => e && !e.deleted).map(e => e.id));
  const dropMissing = (store, key) => {
    const kept = liveIds(next[key]);
    const list = Array.isArray(current[key]) ? current[key] : [];
    const gone = [...liveIds(list)].filter(id => !kept.has(id));
    return store.merge(next[key], gone.reduce((rest, id) => store.remove(rest, id, now), list).filter(e => e.deleted));
  };
  const keptWords = liveIds(next.words);
  const goneWords = [...liveIds(current.words)].filter(id => !keptWords.has(id));
  const removed = LearningMerge.deleteWords({ deletedWords: next.deletedWords }, goneWords, now);
  // Words of `next` this device had deleted come back on every device
  const { words, deletedWords } = LearningMerge.restoreWords(
    { words: next.words, deletedWords: { ...(current.deletedWords || {}), ...removed.deletedWords } }, [...keptWords], now);
  const journalOf = data => ({ journal: data.journal || {}, journalLog: data.journalLog || {} });
  const { journal, journalLog } = Object.keys(current.journal || {}).filter(date => !(next.journal || {})[date])
    .reduce((data, date) => LearningMerge.setJournalEntry(data, date, '', now), journalOf(next));
  const journalFeedback = Object.keys(current.journalFeedback || {})
    .filter(date => JournalFeedbackStore.get(current.journalFeedback, date) && !JournalFeedbackStore.get(next.journalFeedback, date))
    .reduce((map, date) => JournalFeedbackStore.set(map, date, { text: '', source: 'other' }, now), next.journalFeedback || {});
  const nextKnown = new Set(next.known || []);
  const { known, knownLog } = TextCore.applyKnownChange(next, (current.known || []).filter(k => !nextKnown.has(k)), false, now);
  return {
    ...next,
    words,
    deletedWords,
    journal,
    journalLog,
    journalFeedback,
    known,
    knownLog,
    analyses: dropMissing(AnalysisStore, 'analyses'),
    materials: dropMissing(MaterialStore, 'materials'),
    quizzes: dropMissing(QuizStore, 'quizzes'),
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
  try {
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
  } catch (e) {
    console.error('Gist connect failed', e);
    setSyncStatus('error');
    return { error: 'Could not reach GitHub — check your connection and try again' };
  }
}

// One round: read the gist, merge it into this device, and push only if the gist is missing something.
// A failed read throws, so nothing is pushed over data we could not see.
async function pullMergePush(cfg) {
  const remoteJson = await ghGetGist(cfg.token, cfg.gistId);
  let remoteChanged = false;
  if (remoteJson) {
    try {
      const before = JSON.stringify(state);
      const merged = mergeStates(state, JSON.parse(remoteJson));
      const after = JSON.stringify(merged);
      if (after !== before) {
        state = merged;
        localStorage.setItem(STORAGE_KEY, after); // direct write, no re-push
        remoteChanged = true;
      }
    } catch (e) { /* corrupt remote, will be overwritten by push */ }
  }
  const content = JSON.stringify(state);
  const ok = content === remoteJson || await ghUpdateGist(cfg.token, cfg.gistId, content);
  return { ok, remoteChanged };
}

// Only one sync runs at a time. A save during a sync asks for one more round afterwards,
// so its change is merged and pushed too.
let syncRun = null;
let syncAgain = false;

async function runSyncRounds(cfg) {
  setSyncStatus('syncing');
  try {
    let ok = true;
    let remoteChanged = false;
    do {
      syncAgain = false;
      const round = await pullMergePush(cfg);
      ok = round.ok;
      remoteChanged = remoteChanged || round.remoteChanged;
    } while (ok && syncAgain && isSameSyncConfig(cfg));
    // Disconnected (or reconnected) while this sync ran: don't save the old token again
    if (!isSameSyncConfig(cfg)) return false;
    if (!ok) { setSyncStatus('error'); return false; }
    saveSyncConfig({ ...cfg, lastSyncedAt: Date.now() });
    setSyncStatus('ok');
    if (remoteChanged) refreshActiveView();
    return true;
  } catch (e) {
    if (isSameSyncConfig(cfg)) setSyncStatus('error');
    return false;
  }
}

function isSameSyncConfig(cfg) {
  const current = loadSyncConfig();
  return current.gistId === cfg.gistId && current.token === cfg.token;
}

async function syncNow() {
  const cfg = loadSyncConfig();
  if (!cfg.token || !cfg.gistId) return false;
  if (syncRun) { syncAgain = true; return syncRun; }
  syncRun = runSyncRounds(cfg).finally(() => { syncRun = null; });
  return syncRun;
}

function disconnectSync() {
  clearSyncConfig();
  setSyncStatus('hidden');
}

// Debounced auto-sync triggered by saveState(). It merges the gist first, like Sync now,
// so a push from this device never replaces what another device saved in the meantime.
let pushTimer = null;
function schedulePush() {
  const cfg = loadSyncConfig();
  if (!cfg.token || !cfg.gistId) return;
  setSyncStatus('syncing');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow(), PUSH_DEBOUNCE_MS);
}

// Re-render whichever view is currently visible after a sync pull
function refreshActiveView() {
  const active = document.querySelector('.view.active');
  if (!active) return;
  const id = active.id.replace('view-', '');
  if (id === 'library') renderLibrary();
  else if (id === 'practice') renderReading();
  else if (id === 'reader') {
    refreshReaderStatuses();
    if (typeof renderReadingMaterials === 'function') renderReadingMaterials();
  }
  else if (id === 'analyses' && typeof renderAnalysesView === 'function') renderAnalysesView();
  // Quiz: saved quizzes only, so a sync never resets the text box being typed in
  else if (id === 'quiz' && typeof refreshQuizSaved === 'function') refreshQuizSaved();
  else if (id === 'settings' && typeof renderStorageMeter === 'function') renderStorageMeter();
  // Learn: only the progress numbers, so an in-progress card is never disrupted
  else if (id === 'learn') renderStats();
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
// For a failed saveState(); a full browser storage is the usual cause
function storageErrorMessage(e) {
  return e?.name === 'QuotaExceededError'
    ? 'Not saved — browser storage is full (see Settings → Storage)'
    : 'Not saved — something went wrong';
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
// Former tabs live inside others now; their names (buttons, the ?add= quick-add) open the tab that holds them
const VIEW_ALIASES = { add: 'library', stats: 'learn', drill: 'practice', reading: 'practice' };

// Opens the add-word form inside Words; `focus` also brings it into view and puts the cursor in it
function openAddWordPanel(focus) {
  document.getElementById('addWordPanel').open = true;
  if (!focus) return;
  document.getElementById('addWordPanel').scrollIntoView({ block: 'start' });
  document.getElementById('newWord').focus();
}

function showView(requested) {
  const name = VIEW_ALIASES[requested] || requested;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const view = document.getElementById('view-' + name);
  const tab = document.querySelector(`.tab[data-view="${name}"]`);
  if (view) view.classList.add('active');
  if (tab) tab.classList.add('active');

  if (name === 'learn') { renderStats(); startSession(); }
  if (name === 'library') {
    renderLibrary();
    if (requested === 'add' || !state.words.length) openAddWordPanel(requested === 'add');
  }
  if (name === 'practice') renderReading();
  if (name === 'reader') renderReader();
  if (name === 'analyses' && typeof renderAnalysesView === 'function') renderAnalysesView();
  if (name === 'quiz' && typeof renderQuizView === 'function') renderQuizView();
  if (name === 'news' && typeof loadAINews === 'function') loadAINews();
  if (name === 'settings' && typeof renderStorageMeter === 'function') renderStorageMeter();
  if (name === 'journal') { renderJournal(); renderRoleplayWords(); }
  if (typeof syncReaderURL === 'function') syncReaderURL();
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
// Asks both dictionaries at once and uses the first real answer. Free Dictionary is
// built from Wiktionary, so Wiktionary's "no entry" is final; Free Dictionary is only
// waited for when Wiktionary can't be reached. Timeouts stop a broken service from
// holding up a lookup.
async function fetchDictionary(word) {
  const key = encodeURIComponent(word.trim().toLowerCase());
  const wiki = fetchWiktionary(key);
  const free = fetchFreeDictionary(key);
  const first = await Promise.race([wiki, free.then(dict => dict || wiki)]);
  return first !== undefined ? first : free;
}

// null when the word has no entry (404); throws on other failures and timeouts
async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// The parsed entry, null when Wiktionary has none, or undefined when it couldn't be reached
async function fetchWiktionary(key) {
  try {
    return TextCore.parseWiktionary(await fetchJson(WIKTIONARY_API + key, DICT_TIMEOUT_MS));
  } catch (e) {
    console.warn('Wiktionary fetch failed', e);
    return undefined;
  }
}

async function fetchFreeDictionary(key) {
  try {
    const data = await fetchJson(DICT_API + key, DICT_TIMEOUT_MS);
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
    if (!r.ok) return '';
    const data = await r.json();
    const translated = data?.responseData?.translatedText || '';
    // MyMemory answers 200 with a warning text once the daily quota is used up
    return /^MYMEMORY WARNING/i.test(translated) ? '' : translated;
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

// ----- Known words (Book Reader) -----
// "Known" = marked known in the reader, or mastered (archived) in the library.

function knownWordSet() {
  const archived = state.words.filter(w => w.archivedAt).map(w => w.text.toLowerCase());
  return new Set([...(state.known || []), ...archived]);
}

function learningWordSet() {
  return new Set(state.words.filter(w => !w.archivedAt).map(w => w.text.toLowerCase()));
}

function setKnown(words, isKnown) {
  const next = TextCore.applyKnownChange(state, words, isKnown, new Date().toISOString());
  state.known = next.known;
  state.knownLog = next.knownLog;
  saveState();
}

function markKnown(words) { setKnown(words, true); }
function unmarkKnown(words) { setKnown(words, false); }

// Escaped sentence with the word (any inflected form) wrapped by `wrap(matchText)`;
// null when the sentence doesn't contain the word.
function markWordHTML(sentence, word, wrap) {
  const parts = TextCore.splitAtWord(sentence, word);
  if (!parts) return null;
  return escapeHTML(parts.before) + wrap(parts.match) + escapeHTML(parts.after);
}

// Plain-text sentence with the word blanked out, or null when it isn't found
function blankWord(sentence, word) {
  const parts = TextCore.splitAtWord(sentence, word);
  return parts ? `${parts.before}_____${parts.after}` : null;
}

// ----- Shared word-entry builders -----

// A fresh library entry with default SRS fields
function newWordEntry(fields) {
  const nowIso = new Date().toISOString();
  return {
    id: uid(),
    phonetic: '', defEN: '', defCN: '', examples: [], tags: [],
    synonyms: [], antonyms: [], family: [], collocations: [],
    ...fields,
    level: 0, ease: DEFAULT_EASE, interval: 1,
    nextReview: nowMs(), rightCount: 0, wrongCount: 0,
    createdAt: nowIso, updatedAt: nowIso, archivedAt: null,
  };
}

// Dictionary + Chinese translation + Datamuse enrichment for a word or phrase.
// Pass `dict` when the dictionary entry was already fetched (null = none found).
async function lookupWordFields(text, dict) {
  const data = dict === undefined ? await fetchDictionary(text) : dict;
  const defCN = await translateToCN(data?.defEN || text);
  const examples = [];
  for (const ex of data?.examples || []) {
    examples.push({ en: ex.en, cn: await translateToCN(ex.en) });
  }
  const enrichment = TextCore.isPhrase(text) ? {} : await enrichWord(text);
  return { phonetic: data?.phonetic || '', defEN: data?.defEN || '', defCN, examples, ...enrichment };
}

function findWordByText(text) {
  const key = text.trim().toLowerCase();
  return state.words.find(w => w.text.toLowerCase() === key) || null;
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

// opts.addableFrom: source word id — chips become "+ add as phrase card" buttons
function chipBlock(label, list, opts = {}) {
  if (!list || list.length === 0) return '';
  const chip = x => opts.addableFrom
    ? `<button class="chip chip-add" data-phrase="${escapeHTML(x)}" data-source="${escapeHTML(opts.addableFrom)}" title="Add as a phrase card">＋ ${escapeHTML(x)}</button>`
    : `<span class="chip">${escapeHTML(x)}</span>`;
  return `<div class="chip-block">
    <span class="chip-label">${label}:</span>
    ${list.map(chip).join('')}
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
  if (existing && !confirm(`"${text}" already exists. Update it?`)) return;
  const fields = {
    phonetic: document.getElementById('newPhonetic').value.trim(),
    defEN: document.getElementById('defEN').value.trim(),
    defCN: document.getElementById('defCN').value.trim(),
    examples: collectExamples(),
    tags: document.getElementById('newTags').value.split(',').map(s => s.trim()).filter(Boolean),
    ...enrichment,
  };
  const previous = state.words;
  state.words = existing
    ? state.words.map(w => (w === existing ? { ...w, ...fields, updatedAt: new Date().toISOString() } : w))
    : [...state.words, newWordEntry({ text, ...fields })];
  try {
    saveState();
  } catch (e) {
    console.error('Word could not be saved', e);
    state.words = previous;
    toast(storageErrorMessage(e), 4000);
    return;
  }
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
    if (findWordByText(w)) continue;
    const entry = newWordEntry({ text: w, ...(await lookupWordFields(w)) });
    const previous = state.words;
    state.words = [...state.words, entry];
    try {
      saveState();
    } catch (e) {
      console.error('Bulk import stopped', e);
      state.words = previous;
      status.textContent = `${storageErrorMessage(e)} — imported ${added} of ${words.length} word(s)`;
      return;
    }
    added++;
  }
  status.textContent = `✓ Imported ${added} new word(s)`;
  document.getElementById('bulkInput').value = '';
}

// Extract uncommon vocabulary from a pasted transcript paragraph.
// Filters out stopwords, words already in the library or marked known
// (including inflected forms like "walked" for "walk"), and words shorter than 4 chars.
function extractFromTranscript() {
  const raw = document.getElementById('transcriptInput').value.trim();
  if (!raw) { toast('Paste some text first'); return; }
  const tokens = raw.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
  const skip = TextCore.expandForms([...knownWordSet(), ...learningWordSet()]);
  const freq = new Map();
  tokens.forEach(t => {
    if (TextCore.isKnownForm(t, skip)) return;
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
  const modes = ['meaning', 'listening', 'spelling', 'cloze', 'context', 'dictation', 'production'];
  const hasExamples = (word.examples || []).some(e => e.en);
  const otherExamples = state.words.some(w => w.id !== word.id && (w.examples || []).some(e => e.en));
  let pool = modes;
  if (!hasExamples) pool = pool.filter(m => m !== 'cloze' && m !== 'context' && m !== 'dictation');
  if (!otherExamples) pool = pool.filter(m => m !== 'context');
  if (!word.defCN && !word.defEN) pool = pool.filter(m => m !== 'production');
  return pool[Math.floor(Math.random() * pool.length)];
}

// Modes whose answer the card's word-TTS buttons would give away
const MODES_WITHOUT_WORD_TTS = new Set(['dictation', 'production']);

function renderCard(word, mode) {
  const body = document.getElementById('cardBody');
  const actions = document.getElementById('cardActions');
  body.innerHTML = '';
  actions.innerHTML = '';
  document.querySelector('.card-tts').classList.toggle('hidden', MODES_WITHOUT_WORD_TTS.has(mode));

  if (mode === 'meaning') renderMeaningCard(word, body, actions);
  else if (mode === 'listening') renderListeningCard(word, body, actions);
  else if (mode === 'spelling') renderSpellingCard(word, body, actions);
  else if (mode === 'cloze') renderClozeCard(word, body, actions);
  else if (mode === 'context') renderContextCard(word, body, actions);
  else if (mode === 'dictation') renderDictationCard(word, body, actions);
  else if (mode === 'production') renderProductionCard(word, body, actions);
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
      // A sync during the session may have replaced (or deleted) this word; rate the one in state
      const live = state.words.find(w => w.id === word.id);
      if (live) applyRating(live, btn.dataset.r);
      try {
        recordReview();  // saves the rating too
      } catch (e) {
        console.error('Review could not be saved', e);
        toast(storageErrorMessage(e), 4000);
      }
      // Always move on, so a failed save never makes the same card count twice
      session.index++;
      renderStats();
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
      ${chipBlock('Collocations', word.collocations, { addableFrom: word.id })}
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
  // First example that actually contains the word (in any form) — otherwise the answer would show
  const ex = (word.examples || []).find(e => e.en && TextCore.splitAtWord(e.en, word.text));
  if (!ex) return renderMeaningCard(word, body, actions);
  const blanked = markWordHTML(ex.en, word.text, () => '<span class="cloze-blank">_____</span>');
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
  const ownEx = (word.examples || []).find(e => e.en && blankWord(e.en, word.text));
  if (!ownEx) return renderMeaningCard(word, body, actions);
  // Build distractor sentences from OTHER words; blank out their key word
  const otherSentences = state.words
    .filter(w => w.id !== word.id)
    .flatMap(w => (w.examples || [])
      .filter(e => e.en)
      .map(e => ({ text: blankWord(e.en, w.text), cn: e.cn })))
    .filter(s => s.text);
  const distractors = pickRandom(otherSentences, 2);
  if (distractors.length < 2) return renderMeaningCard(word, body, actions);
  const correctSentence = {
    text: blankWord(ownEx.en, word.text),
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
  else if (filter === 'phrase') items = items.filter(w => TextCore.isPhrase(w.text));
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
        <div class="w">${escapeHTML(w.text)}${w.phonetic ? ` <span class="ph">${escapeHTML(w.phonetic)}</span>` : ''} ${w.archivedAt ? '⭐' : ''}${leech ? ' 🐛' : ''}</div>
        ${w.defEN ? `<div class="d d-en">${escapeHTML(w.defEN)}</div>` : ''}
        ${w.defCN ? `<div class="d d-cn">${escapeHTML(w.defCN)}</div>` : ''}
        ${!w.defEN && !w.defCN ? `<div class="d">(no definition)</div>` : ''}
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
    const previous = { words: state.words, deletedWords: state.deletedWords };
    // A dated deletion, so a sync with another device doesn't bring the word back
    Object.assign(state, LearningMerge.deleteWords(state, [id], new Date().toISOString()));
    try {
      saveState();
    } catch (e) {
      Object.assign(state, previous);
      toast(storageErrorMessage(e), 4000);
      return;
    }
    renderLibrary(); toast('Deleted');
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
    const highlighted = markWordHTML(ex.en, w.text, m => `<mark data-word="${escapeHTML(w.text)}">${escapeHTML(m)}</mark>`)
      || escapeHTML(ex.en);
    return `
      <div class="reading-sentence" data-idx="${idx}">
        <div class="reading-en">${highlighted}</div>
        ${ex.cn ? `<div class="reading-cn">${escapeHTML(ex.cn)}</div>` : ''}
        <button class="mic-btn" data-mic-text="${escapeHTML(ex.en)}" title="Read aloud challenge">🎙️ Read aloud</button>
      </div>
    `;
  }).join('');
  // Click any highlight to hear
  wrap.querySelectorAll('mark').forEach(m => {
    m.addEventListener('click', () => speak(m.dataset.word));
  });
  wrap.querySelectorAll('.mic-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openReadAloud(btn.dataset.micText);
    });
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
  const knownEl = document.getElementById('statKnown');
  if (knownEl) knownEl.textContent = knownWordSet().size;
  const summary = document.getElementById('learnProgressSummary');
  if (summary) summary.textContent = `${due.length} due · 🔥 ${state.streak.current} · ${state.activity[todayKey()] || 0} reviewed today`;
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
  if (typeof saveBookPosition === 'function') saveBookPosition();
  const readingProgress = ReaderProgress.createStore(localStorage).snapshot();
  const blob = new Blob([JSON.stringify({ ...state, readingProgress }, null, 2)], { type: 'application/json' });
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
// `current` with a JSON backup merged in, as a new object. A backup is for recovery: its words and journal
// entries that are missing here come back (on every device), even when they had been deleted.
function mergeBackup(current, parsed, now) {
  const texts = new Set((current.words || []).map(w => w.text.toLowerCase()));
  const added = parsed.words.filter(w => {
    const key = w.text.toLowerCase();
    if (texts.has(key)) return false;
    texts.add(key);
    return true;
  });
  const { words, deletedWords } = LearningMerge.restoreWords(
    { words: [...(current.words || []), ...added], deletedWords: current.deletedWords }, added.map(w => w.id), now);
  const activity = { ...(current.activity || {}) };
  Object.entries(parsed.activity || {}).forEach(([k, v]) => { activity[k] = Math.max(activity[k] || 0, v); });
  const merged = LearningMerge.mergeJournal(current, parsed);
  const { journal, journalLog } = Object.entries(LearningMerge.mergeJournal({}, parsed).journal)
    .filter(([date]) => !Object.hasOwn(merged.journal, date))
    .reduce((data, [date, text]) => LearningMerge.setJournalEntry(data, date, text, now), merged);
  const streak = parsed.streak;
  const isStreak = !!streak && Number.isInteger(streak.current) && streak.current >= 0
    && typeof streak.lastDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(streak.lastDay);
  const { known, knownLog } = TextCore.mergeKnown(current, parsed);
  return {
    ...current,
    words,
    deletedWords,
    activity,
    journal,
    journalLog,
    streak: isStreak && streak.lastDay > (current.streak?.lastDay || '') ? { current: streak.current, lastDay: streak.lastDay } : current.streak,
    known,
    knownLog,
    analyses: AnalysisStore.merge(current.analyses, parsed.analyses),
    materials: MaterialStore.merge(current.materials, parsed.materials),
    quizzes: QuizStore.merge(current.quizzes, parsed.quizzes),
    journalFeedback: JournalFeedbackStore.merge(current.journalFeedback, parsed.journalFeedback),
  };
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || !Array.isArray(parsed.words)) throw new Error('Invalid file');
      if (parsed.known !== undefined && !Array.isArray(parsed.known)) throw new Error('Invalid known-word list');
      if (parsed.words.some(w => !w || typeof w.text !== 'string' || !w.text.trim())) throw new Error('Invalid word');
      if (parsed.readingProgress !== undefined) ReaderProgress.validateSnapshot(parsed.readingProgress);
      if (parsed.analyses !== undefined && !Array.isArray(parsed.analyses)) throw new Error('Invalid saved analyses');
      if (parsed.materials !== undefined && !Array.isArray(parsed.materials)) throw new Error('Invalid reading materials');
      if (parsed.quizzes !== undefined && !Array.isArray(parsed.quizzes)) throw new Error('Invalid quizzes');
      const analysisCount = AnalysisStore.visible(parsed.analyses).length;
      const materialCount = MaterialStore.visible(parsed.materials).length;
      const quizCount = QuizStore.visible(parsed.quizzes).length;
      const extras = [parsed.readingProgress ? 'reading bookmarks' : '', analysisCount ? `${analysisCount} saved analyses` : '',
        materialCount ? `${materialCount} reading materials` : '', quizCount ? `${quizCount} quizzes` : ''].filter(Boolean);
      if (!confirm(`Import ${parsed.words.length} words${extras.length ? ` and ${extras.join(' and ')}` : ''}? This will merge with existing data.`)) return;
      if (parsed.readingProgress) {
        ReaderProgress.createStore(localStorage).merge(parsed.readingProgress);
        if (typeof onReaderProgressImported === 'function') onReaderProgressImported();
      }
      const previous = state;
      state = mergeBackup(previous, parsed, new Date().toISOString());
      try {
        saveState();
      } catch (e) {
        state = previous;
        throw e;
      }
      if (typeof renderReadingMaterials === 'function') renderReadingMaterials();
      toast(`Imported ${parsed.words.length} words`);
      renderLibrary();
    } catch (e) {
      toast(e.name === 'QuotaExceededError' ? 'Import failed — browser storage is full' : 'Import failed — invalid file');
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
  const previous = state;
  state = replaceState(previous, defaultState(), new Date().toISOString());
  try {
    saveState();
  } catch (e) {
    state = previous;
    toast(storageErrorMessage(e));
    return;
  }
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
    const previous = state;
    state = replaceState(previous, Object.assign(defaultState(), parsed), new Date().toISOString());
    try {
      saveState();
    } catch (e) {
      state = previous;
      toast(storageErrorMessage(e));
      return;
    }
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
  let res;
  try {
    res = await connectSync(token);
  } finally {
    btn.disabled = false; btn.textContent = '🔗 Connect';
  }
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

// ============ Journal ============

const GRADE_PROMPT_PREFIX = `Please grade my English journal entry below. I'm a Chinese speaker working on vocabulary and natural writing. Provide:

1. **Grammar & naturalness fixes** — list each issue: original sentence → corrected version → brief explanation (in Chinese if it helps).
2. **Better word choices** — point out 2-3 places where a more sophisticated or natural word would fit.
3. **3 new useful vocabulary words** related to what I wrote — with Chinese meaning + an example sentence each.
4. **Overall rating** (1-10) and the single biggest thing I should focus on next.

My entry`;

function currentJournalDate() {
  const el = document.getElementById('journalDate');
  return (el && el.value) || todayKey();
}

function renderJournal() {
  const dateEl = document.getElementById('journalDate');
  // Text that couldn't be saved stays on screen with its own day, instead of being replaced by another day
  if (!commitJournal()) { dateEl.value = pendingJournal.date; return; }
  if (!dateEl.value) dateEl.value = todayKey();
  const date = dateEl.value;
  const text = (state.journal && state.journal[date]) || '';
  document.getElementById('journalText').value = text;
  updateJournalCounts();
  renderJournalFeedback();
  renderJournalHistory();
}

function updateJournalCounts() {
  const t = document.getElementById('journalText').value;
  const words = t.trim() ? t.trim().split(/\s+/).length : 0;
  document.getElementById('journalWordCount').textContent = words;
  document.getElementById('journalCharCount').textContent = t.length;
}

// ----- Entry text, saved a moment after typing stops -----
const JOURNAL_SAVE_MS = 1000;
let journalTimer = null;
let pendingJournal = null;   // { date, text } waiting to be saved

// The date is taken now, so switching days before the save can't move the text to another day
function scheduleJournalSave() {
  pendingJournal = { date: currentJournalDate(), text: document.getElementById('journalText').value };
  clearTimeout(journalTimer);
  journalTimer = setTimeout(commitJournal, JOURNAL_SAVE_MS);
}

// Saves the text waiting (if any); false when it couldn't be saved
function commitJournal() {
  clearTimeout(journalTimer);
  const pending = pendingJournal;
  pendingJournal = null;
  if (!pending) return true;
  const saved = (state.journal || {})[pending.date] || '';
  if (saved === (pending.text.trim() ? pending.text : '')) return true;
  const previous = { journal: state.journal, journalLog: state.journalLog };
  Object.assign(state, LearningMerge.setJournalEntry(state, pending.date, pending.text, new Date().toISOString()));
  try {
    saveState();
  } catch (error) {
    console.error('Journal entry could not be saved', error);
    Object.assign(state, previous);
    pendingJournal = pending;   // kept, so the next save (or leaving the page) tries again
    toast(storageErrorMessage(error), 4000);
    return false;
  }
  renderJournalHistory();
  return true;
}

function saveJournalCurrent() {
  pendingJournal = { date: currentJournalDate(), text: document.getElementById('journalText').value };
  return commitJournal();
}

function renderJournalHistory() {
  const wrap = document.getElementById('journalHistory');
  const entries = Object.entries(state.journal || {})
    .filter(([, t]) => t && t.trim())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 14);
  if (entries.length === 0) {
    wrap.innerHTML = `<p class="hint">No entries yet. Write your first one above.</p>`;
    return;
  }
  wrap.innerHTML = entries.map(([date, text]) => {
    const wordCount = text.trim().split(/\s+/).length;
    const preview = text.slice(0, 140) + (text.length > 140 ? '…' : '');
    const feedback = JournalFeedbackStore.get(state.journalFeedback, date);
    return `
      <div class="journal-entry" data-date="${escapeHTML(date)}">
        <div class="journal-entry-date">${escapeHTML(date)}</div>
        <div class="journal-entry-preview">${escapeHTML(preview)}</div>
        <div class="journal-entry-words">${wordCount} words${feedback ? ` · 💬 ${escapeHTML(AI_CHATS[feedback.source]?.name || 'AI')} feedback` : ''}</div>
      </div>
    `;
  }).join('');
  wrap.querySelectorAll('.journal-entry').forEach(el => {
    el.addEventListener('click', () => {
      const d = el.dataset.date;
      document.getElementById('journalDate').value = d;
      renderJournal();
    });
  });
}

// Runs inside the tap on a "Grade with …" link; the link itself opens the chat (or the ChatGPT app on iPhone)
function gradeJournal(service, event) {
  const text = document.getElementById('journalText').value.trim();
  if (!text) { event?.preventDefault(); toast('Write something first'); return; }
  const date = currentJournalDate();
  const prompt = `${GRADE_PROMPT_PREFIX} (date: ${date}):\n\n${text}`;
  // The reply box expects this service's answer unless a reply is already saved
  lastJournalGradeService = service;
  if (!document.getElementById('journalFeedback').value.trim()) document.getElementById('journalFeedbackSource').value = service;
  copyChatPrompt(service, prompt,
    `Prompt copied → paste it into ${AI_CHATS[service].name}, then paste the reply below. / 提示词已复制，请粘贴到 ${AI_CHATS[service].name}，再把回复粘贴到下方。`);
}

// ----- Pasted AI replies (state.journalFeedback), saved per day a moment after typing stops -----
const JOURNAL_FEEDBACK_SAVE_MS = 800;
let journalFeedbackTimer = null;
let pendingJournalFeedback = null;   // { date, text, source } waiting to be saved
let lastJournalGradeService = 'claude';

// Saves any reply still waiting first, so switching days or reopening an entry never shows or loses stale text
function renderJournalFeedback() {
  commitJournalFeedback();
  const entry = JournalFeedbackStore.get(state.journalFeedback, currentJournalDate());
  document.getElementById('journalFeedback').value = entry?.text || '';
  document.getElementById('journalFeedbackSource').value = entry?.source || lastJournalGradeService;
  document.getElementById('journalFeedbackStatus').textContent = entry
    ? `Saved ${new Date(entry.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · 已保存` : '';
}

// The date is taken now, so switching days before the save can't move the reply to another day
function scheduleJournalFeedbackSave() {
  pendingJournalFeedback = {
    date: currentJournalDate(),
    text: document.getElementById('journalFeedback').value,
    source: document.getElementById('journalFeedbackSource').value,
  };
  document.getElementById('journalFeedbackStatus').textContent = 'Saving… / 保存中…';
  clearTimeout(journalFeedbackTimer);
  journalFeedbackTimer = setTimeout(commitJournalFeedback, JOURNAL_FEEDBACK_SAVE_MS);
}

function commitJournalFeedback() {
  clearTimeout(journalFeedbackTimer);
  const pending = pendingJournalFeedback;
  pendingJournalFeedback = null;
  if (!pending) return;
  const status = document.getElementById('journalFeedbackStatus');
  const current = JournalFeedbackStore.get(state.journalFeedback, pending.date);
  const unchanged = (current?.text || '') === pending.text.trim() && (!current || current.source === pending.source);
  if (unchanged) { status.textContent = current ? 'Saved · 已保存' : ''; return; }
  if (pending.text.trim().length > JournalFeedbackStore.MAX_FEEDBACK_CHARS) {
    status.textContent = `Too long to save — keep it under ${JournalFeedbackStore.MAX_FEEDBACK_CHARS.toLocaleString()} characters. / 内容过长，无法保存。`;
    return;
  }
  const previous = state.journalFeedback;
  state.journalFeedback = JournalFeedbackStore.set(previous, pending.date, pending, new Date().toISOString());
  try {
    saveState();
  } catch (error) {
    console.error('Journal feedback could not be saved', error);
    state.journalFeedback = previous;
    status.textContent = error.name === 'QuotaExceededError'
      ? 'Could not save — browser storage is full (see Settings → Storage). / 无法保存：浏览器存储空间已满。'
      : 'Could not save the reply. / 无法保存回复。';
    return;
  }
  if (pending.date === currentJournalDate()) status.textContent = pending.text.trim() ? 'Saved · 已保存' : 'Reply cleared · 已清除';
  renderJournalHistory();
}

async function copyJournalOnly() {
  const text = document.getElementById('journalText').value.trim();
  if (!text) { toast('Nothing to copy'); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast('Entry copied');
  } catch { toast('Copy failed'); }
}

function deleteCurrentJournal() {
  if (!commitJournal()) return;
  const date = currentJournalDate();
  if (!state.journal?.[date]) { toast('No entry to delete'); return; }
  const feedback = JournalFeedbackStore.get(state.journalFeedback, date);
  if (!confirm(`Delete journal entry for ${date}${feedback ? ' and its AI feedback' : ''}?`)) return;
  const now = new Date().toISOString();
  const previous = { journal: state.journal, journalLog: state.journalLog, journalFeedback: state.journalFeedback };
  // A dated deletion, so a sync doesn't bring the entry back
  Object.assign(state, LearningMerge.setJournalEntry(state, date, '', now));
  if (feedback) state.journalFeedback = JournalFeedbackStore.set(state.journalFeedback, date, { text: '', source: feedback.source }, now);
  try {
    saveState();
  } catch (error) {
    console.error('Journal entry could not be deleted', error);
    Object.assign(state, previous);
    toast(storageErrorMessage(error), 4000);
    return;
  }
  document.getElementById('journalText').value = '';
  pendingJournalFeedback = null;
  clearTimeout(journalFeedbackTimer);
  renderJournalFeedback();
  updateJournalCounts();
  renderJournalHistory();
  toast('Deleted');
}

// ============ Read Aloud Challenge ============
// Browser-only: SpeechRecognition transcribes user speech, compared against target text.
// Falls back gracefully if SpeechRecognition is unavailable (older Safari, Firefox).

let recognition = null;
let readAloudTargetText = '';

// Plain-language explanations for SpeechRecognition error codes
const SPEECH_ERROR_MESSAGES = {
  'not-allowed': 'Microphone access is blocked. Allow the microphone for this site in your browser settings (iPhone: Settings → Apps → Safari → Microphone), then try again.',
  'service-not-allowed': 'Speech recognition is turned off. On iPhone/iPad, turn on Settings → General → Keyboard → Enable Dictation, then try again.',
  'network': 'The speech-recognition service could not be reached. Chrome sends your audio to Google — if Google is blocked on your network, try Safari or Edge.',
  'audio-capture': 'No microphone was found. Check that one is connected and not in use by another app.',
  'language-not-supported': 'English speech recognition is not available in this browser.',
  'unsupported': 'Speech recognition is not supported in this browser. Try Chrome, Edge, or Safari on iOS 14.5+.',
};

function speechErrorMessage(code) {
  return SPEECH_ERROR_MESSAGES[code] || `Speech recognition failed (${code || 'unknown error'}). Please try again.`;
}

// Errors that just mean "nothing was heard" or "stopped" — not worth a warning
const BENIGN_SPEECH_ERRORS = new Set(['no-speech', 'aborted']);

function openReadAloud(target) {
  readAloudTargetText = (target || '').trim();
  document.getElementById('readAloudTarget').textContent = readAloudTargetText;
  document.getElementById('readAloudResult').innerHTML = '';
  const micBtn = document.getElementById('readAloudMicBtn');
  micBtn.classList.remove('recording');
  micBtn.textContent = '🎙️ Start';
  document.getElementById('readAloudOverlay').classList.remove('hidden');
}
function closeReadAloud() {
  document.getElementById('readAloudOverlay').classList.add('hidden');
  stopReadAloud();
}

function showReadAloudWarning(code) {
  document.getElementById('readAloudResult').innerHTML =
    `<p class="hint">⚠️ ${escapeHTML(speechErrorMessage(code))}</p>`;
}

function startReadAloud() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showReadAloudWarning('unsupported'); return; }
  const micBtn = document.getElementById('readAloudMicBtn');
  if (recognition) { stopReadAloud(); return; }
  const resultEl = document.getElementById('readAloudResult');
  const resetButton = () => {
    recognition = null;
    micBtn.classList.remove('recording');
    micBtn.textContent = '🎙️ Start';
  };
  speechSynthesis.cancel();   // don't let the reference audio be transcribed
  recognition = new SR();
  recognition.lang = 'en-US';
  recognition.continuous = true;       // keep listening through pauses until Stop
  recognition.interimResults = true;   // show words live while reading
  recognition.maxAlternatives = 1;
  let said = '';
  let errorCode = null;
  recognition.onresult = (e) => {
    // e.results holds the whole session (final + in-progress), so rebuild from it
    said = Array.from(e.results, r => r[0].transcript.trim()).join(' ').trim();
    resultEl.innerHTML = `<p class="hint">Hearing: “${escapeHTML(said)}”</p>`;
  };
  // Remember the error; onend always follows and must not overwrite it
  recognition.onerror = (e) => { errorCode = e.error; };
  recognition.onend = () => {
    resetButton();
    if (errorCode && !BENIGN_SPEECH_ERRORS.has(errorCode) && !said) {
      showReadAloudWarning(errorCode);
      return;
    }
    showReadAloudResult(said);
  };
  try {
    recognition.start();
  } catch (e) {
    console.warn('Speech recognition failed to start', e);
    resetButton();
    showReadAloudWarning(e.name || 'start-failed');
    return;
  }
  micBtn.classList.add('recording');
  micBtn.textContent = '⏹ Stop';
  resultEl.innerHTML = '<p class="hint">Listening… read the text aloud, then press Stop.</p>';
}
function stopReadAloud() {
  if (recognition) {
    try { recognition.stop(); } catch {}
  }
}

function showReadAloudResult(said) {
  const target = TextCore.normalizeWords(readAloudTargetText);
  const saidWords = TextCore.normalizeWords(said);
  if (saidWords.length === 0) {
    document.getElementById('readAloudResult').innerHTML =
      `<p class="hint">No speech detected. Try again — make sure your mic is on.</p>`;
    return;
  }
  const diff = TextCore.diffWords(target, saidWords);
  const matches = diff.filter(d => d.kind === 'ok').length;
  const accuracy = Math.round((matches / target.length) * 100);
  const accClass = accuracy >= 85 ? 'good' : accuracy >= 60 ? 'mid' : 'bad';
  const diffHtml = diff.map(d =>
    `<span class="${d.kind}">${escapeHTML(d.word)}</span>`
  ).join(' ');
  document.getElementById('readAloudResult').innerHTML = `
    <div class="read-aloud-result">
      <div class="read-aloud-accuracy ${accClass}">${accuracy}% accuracy</div>
      <div class="read-aloud-diff">${diffHtml}</div>
      <div class="read-aloud-said">You said: "${escapeHTML(said)}"</div>
    </div>
  `;
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

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));
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

  // Journal
  document.getElementById('journalDate').addEventListener('change', renderJournal);
  const saveJournalNow = () => { commitJournal(); commitJournalFeedback(); };
  window.addEventListener('pagehide', saveJournalNow);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveJournalNow(); });
  document.getElementById('journalText').addEventListener('input', () => {
    updateJournalCounts();
    scheduleJournalSave();
  });
  document.querySelectorAll('[data-chat-for="journal"]').forEach(link => link.addEventListener('click', event => {
    saveJournalCurrent();
    gradeJournal(link.dataset.chat, event);
  }));
  document.getElementById('journalFeedback').addEventListener('input', scheduleJournalFeedbackSave);
  document.getElementById('journalFeedbackSource').addEventListener('change', scheduleJournalFeedbackSave);
  document.getElementById('journalCopyBtn').addEventListener('click', copyJournalOnly);
  document.getElementById('journalDeleteBtn').addEventListener('click', deleteCurrentJournal);

  // Read-aloud modal
  document.getElementById('readAloudMicBtn').addEventListener('click', startReadAloud);
  document.getElementById('readAloudTtsBtn').addEventListener('click', () => speak(readAloudTargetText));
  document.getElementById('readAloudCloseBtn').addEventListener('click', closeReadAloud);
  document.getElementById('readAloudOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'readAloudOverlay') closeReadAloud();
  });

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

  renderStats();
  startSession();
  handleUrlParams();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
