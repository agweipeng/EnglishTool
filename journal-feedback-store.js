/* Journal replies from Claude or ChatGPT (state.journalFeedback): pure map logic shared by the browser and tests.
   { 'YYYY-MM-DD': { text, source, updatedAt } } — clearing a reply keeps an empty, dated entry so sync doesn't bring it back. */
(function (root) {
  'use strict';
  const MAX_FEEDBACK_CHARS = 30000;
  const SOURCES = ['claude', 'chatgpt', 'other'];
  const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

  const isEntry = entry => !!entry && typeof entry === 'object' && typeof entry.text === 'string'
    && entry.text.length <= MAX_FEEDBACK_CHARS && SOURCES.includes(entry.source)
    && typeof entry.updatedAt === 'string' && !Number.isNaN(Date.parse(entry.updatedAt));
  const isMap = value => !!value && typeof value === 'object' && !Array.isArray(value);

  // A new map with this day's reply replaced; an empty reply clears it
  function set(map, date, { text, source }, now) {
    if (!DATE_KEY.test(date)) throw new Error('Invalid journal date');
    const clean = String(text || '').trim();
    if (clean.length > MAX_FEEDBACK_CHARS) throw new Error('The reply is too long to save.');
    return { ...(isMap(map) ? map : {}), [date]: { text: clean, source: SOURCES.includes(source) ? source : 'other', updatedAt: now } };
  }

  // This day's saved reply, or null when there is none
  function get(map, date) {
    const entry = isMap(map) ? map[date] : null;
    return isEntry(entry) && entry.text ? entry : null;
  }

  // Newest edit wins for each day (compared as times, not text); damaged entries from other devices or
  // files are dropped, and only the reply fields are kept
  function merge(local, remote) {
    const merged = {};
    for (const map of [local, remote]) {
      if (!isMap(map)) continue;
      for (const [date, entry] of Object.entries(map)) {
        if (!DATE_KEY.test(date) || !isEntry(entry)) continue;
        if (merged[date] && Date.parse(entry.updatedAt) <= Date.parse(merged[date].updatedAt)) continue;
        merged[date] = { text: entry.text, source: entry.source, updatedAt: entry.updatedAt };
      }
    }
    return merged;
  }

  const count = map => (isMap(map) ? Object.keys(map).filter(date => get(map, date)).length : 0);

  const api = { MAX_FEEDBACK_CHARS, SOURCES, set, get, merge, count };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JournalFeedbackStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
