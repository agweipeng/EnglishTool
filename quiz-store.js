/* Saved quizzes (state.quizzes): pure list logic shared by the browser and tests. Every checked quiz is
   kept; a deleted quiz becomes a small tombstone so sync doesn't bring it back. */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const SyncedList = isNode ? require('./synced-list.js') : root.SyncedList;
  const QuizCore = isNode ? require('./quiz-core.js') : root.QuizCore;
  const SOURCES = ['mix', 'library', 'analyses'];
  const CHECKERS = ['local', 'claude', 'chatgpt'];
  const text = value => (typeof value === 'string' ? value : '');

  function createEntry({ source, items, feedback = null, feedbackText = '', checkedWith, model = '' }, now, id) {
    return {
      id, createdAt: now, updatedAt: now,
      source: SOURCES.includes(source) ? source : 'mix',
      items: items.map(item => ({
        text: text(item.text), meaning: { en: text(item.meaning?.en), cn: text(item.meaning?.cn) }, example: text(item.example),
        from: { type: item.from?.type === 'analysis' ? 'analysis' : 'word', id: text(item.from?.id) },
        answer: text(item.answer).slice(0, QuizCore.MAX_ANSWER_CHARS),
      })),
      feedback, feedbackText: text(feedbackText).slice(0, QuizCore.MAX_REPLY_CHARS),
      checkedWith: CHECKERS.includes(checkedWith) ? checkedWith : 'claude', model: text(model),
    };
  }

  // A live quiz needs its items and some feedback: the structured result, or the reply kept as text
  const hasFeedback = entry => (!!entry.feedback && typeof entry.feedback === 'object' && Array.isArray(entry.feedback.items))
    || (typeof entry.feedbackText === 'string' && !!entry.feedbackText.trim());
  const list = SyncedList.create(entry => Array.isArray(entry.items) && entry.items.length > 0
    && entry.items.every(item => typeof item?.text === 'string' && !!item.text.trim()) && hasFeedback(entry));

  const upsert = (entries, entry) => list.upsert(entries, entry, (saved, next) => saved.id === next.id);
  const { remove, merge } = list;
  const visible = entries => list.live(entries);   // newest first; there is no limit on how many are kept

  const api = { createEntry, upsert, remove, merge, visible };
  if (isNode) module.exports = api;
  else root.QuizStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
