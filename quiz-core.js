/* Quiz tab logic with no screen code: choosing the words or phrases, checking a target is used, the prompt
   for the AI and reading its feedback. Shared by the browser and the tests. */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const textCore = isNode ? require('./text-core.js') : root.TextCore;
  const replyJSON = isNode ? require('./reply-json.js') : root.ReplyJSON;

  const QUIZ_SIZE = 5;
  const TOP_CANDIDATES = 20;        // each source's random draw comes from this many of its best candidates
  const RECENT_QUIZZES = 3;         // words from this many latest quizzes are held back
  const MAX_ANSWER_CHARS = 1000;
  const MAX_REPLY_CHARS = 30000;
  const MAX_FEEDBACK_SENTENCES = 5;
  const VERDICTS = ['natural', 'understandable', 'wrong'];

  const text = value => (typeof value === 'string' ? value.trim() : '');
  const keyOf = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const bilingual = value => (typeof value === 'string' ? { en: text(value), cn: '' } : { en: text(value?.en), cn: text(value?.cn) });

  // Library words in the role-play order: stubborn words, then phrases, then the newest
  function libraryCandidates(words, isStubborn = () => false) {
    const active = (Array.isArray(words) ? words : []).filter(word => word && !word.archivedAt && text(word.text));
    const newest = [...active].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const ordered = [...new Set([...newest.filter(isStubborn), ...newest.filter(word => textCore.isPhrase(word.text)), ...newest])];
    return ordered.map(word => ({
      text: text(word.text), meaning: { en: text(word.defEN), cn: text(word.defCN) },
      example: text((Array.isArray(word.examples) ? word.examples : []).find(example => text(example?.en))?.en),
      from: { type: 'word', id: String(word.id || '') },
    }));
  }

  // Words, then phrases, of each saved analysis (pass the analyses newest first)
  function analysisCandidates(analyses) {
    return (Array.isArray(analyses) ? analyses : []).flatMap(entry => ['words', 'phrases']
      .flatMap(kind => (Array.isArray(entry?.result?.[kind]) ? entry.result[kind] : []))
      .filter(item => text(item?.text))
      .map(item => ({ text: text(item.text), meaning: bilingual(item.meaning), example: text(item.example),
        from: { type: 'analysis', id: String(entry.id || '') } })));
  }

  // The words or phrases of the latest quizzes (pass the quizzes newest first)
  function recentKeys(quizzes) {
    return new Set((Array.isArray(quizzes) ? quizzes : []).slice(0, RECENT_QUIZZES)
      .flatMap(quiz => (Array.isArray(quiz?.items) ? quiz.items : []).map(item => keyOf(item?.text))));
  }

  function shuffle(list, random) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  // One item from each list in turn; a list that runs out is skipped
  function interleave(lists, count) {
    const picked = [];
    for (let round = 0; picked.length < count && lists.some(list => round < list.length); round++) {
      for (const list of lists) if (round < list.length && picked.length < count) picked.push(list[round]);
    }
    return picked;
  }

  // The chosen source's lists (Library before Analyses), without duplicates or excluded words
  function sourceLists({ library = [], analyses = [], source = 'mix', exclude = [] }) {
    const seen = new Set(exclude.map(keyOf));
    const chosen = source === 'library' ? [library] : source === 'analyses' ? [analyses] : [library, analyses];
    return chosen.map(list => list.filter(item => {
      const key = keyOf(item.text);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }));
  }

  // Up to `count` items drawn at random from each source's best candidates. Recently practised words are held
  // back unless there would otherwise be too few.
  function pickQuizItems(options) {
    const { recent = new Set(), random = Math.random, count = QUIZ_SIZE } = options;
    const lists = sourceLists(options);
    const draw = isRecent => lists.map(list => shuffle(list
      .filter(item => recent.has(keyOf(item.text)) === isRecent).slice(0, TOP_CANDIDATES), random));
    const fresh = interleave(draw(false), count);
    return fresh.length < count ? [...fresh, ...interleave(draw(true), count - fresh.length)] : fresh;
  }

  // The sentences use the word or phrase in any form ("carried on" for "carry on")
  const usesTarget = (answer, target) => textCore.containsSpokenTarget(target, [String(answer || '')]);

  const FEEDBACK_SHAPE = '{"items":[{"word":"...","verdict":"natural|understandable|wrong","sentences":[{"yours":"...","better":"...","note":{"en":"...","cn":"..."}}],"model":"..."}],"tip":{"en":"...","cn":"..."}}';

  function buildQuizPrompt(items) {
    const tests = items.map((item, i) => {
      const meaning = [text(item.meaning?.en), text(item.meaning?.cn)].filter(Boolean).join(' / ');
      return `${i + 1}. Target: "${item.text}"${meaning ? ` — meaning: ${meaning}` : ''}\nLearner's sentences:\n${text(item.answer) || '(skipped)'}`;
    }).join('\n\n');
    return `You are a friendly English teacher. A Chinese-speaking learner is practising using new words actively, aiming for natural, conversational English.
For each numbered item below, the learner wrote 2–3 sentences using the target word or phrase. Answer every item, in the same order:
- "verdict": "natural" if the target is used correctly and every sentence sounds natural; "understandable" if the meaning is right but the wording is unnatural or has small mistakes; "wrong" if the target is missing or misused, or the item was skipped.
- "sentences": for each of the learner's sentences, "yours" (the sentence as written), "better" (a corrected, natural version — repeat it unchanged if it is already natural) and "note" (one short explanation in English "en" and in Simplified Chinese "cn").
- "model": one natural sentence of your own that uses the target the way a native speaker would.
Finish with "tip": one short overall tip in English "en" and Simplified Chinese "cn".
Reply with JSON only, no other text, in exactly this shape:
${FEEDBACK_SHAPE}

${tests}`;
  }

  // What a local model is held to: the same shape the prompt asks for
  const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const string = { type: 'string' };
  const note = object({ en: string, cn: string });
  const FEEDBACK_SCHEMA = object({
    items: { type: 'array', minItems: 1, maxItems: QUIZ_SIZE, items: object({
      word: string, verdict: { type: 'string', enum: VERDICTS },
      sentences: { type: 'array', maxItems: MAX_FEEDBACK_SENTENCES, items: object({ yours: string, better: string, note }) },
      model: string }) },
    tip: note,
  });

  // Replies sometimes wrap the feedback ({"feedback": {"items": [...]}})
  const hasItems = value => !!value && typeof value === 'object' && Array.isArray(value.items);
  const feedbackRoot = value => (hasItems(value) ? value : Object.values(value).find(hasItems));

  function itemResult(raw) {
    const verdict = text(raw?.verdict).toLowerCase();
    const sentences = (Array.isArray(raw?.sentences) ? raw.sentences : []).slice(0, MAX_FEEDBACK_SENTENCES)
      .map(sentence => ({ yours: text(sentence?.yours), better: text(sentence?.better), note: bilingual(sentence?.note) }))
      .filter(sentence => sentence.yours || sentence.better);
    return { verdict: VERDICTS.includes(verdict) ? verdict : 'unchecked', sentences, model: text(raw?.model) };
  }

  // { feedback, feedbackText }: results match the items by position; a reply without usable JSON is kept
  // as text so it is never lost
  function parseQuizFeedback(reply, items) {
    const raw = String(reply || '').slice(0, MAX_REPLY_CHARS);
    const found = replyJSON.findReplyJSON(raw, value => !!feedbackRoot(value));
    if (!found) return { feedback: null, feedbackText: raw.trim() };
    const results = feedbackRoot(found);
    return { feedback: { items: items.map((item, i) => itemResult(results.items[i])), tip: bilingual(results.tip) }, feedbackText: '' };
  }

  // { natural, total }: how many items were judged natural; null for a reply kept as text
  function quizScore(feedback) {
    if (!feedback || !Array.isArray(feedback.items)) return null;
    return { natural: feedback.items.filter(item => item?.verdict === 'natural').length, total: feedback.items.length };
  }

  const api = { QUIZ_SIZE, MAX_ANSWER_CHARS, MAX_REPLY_CHARS, FEEDBACK_SCHEMA, libraryCandidates, analysisCandidates,
    recentKeys, pickQuizItems, usesTarget, buildQuizPrompt, parseQuizFeedback, quizScore };
  if (isNode) module.exports = api;
  else root.QuizCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
