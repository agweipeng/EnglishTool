/* ============================================================
   Text core — pure text logic shared by the browser UI
   (app.js, reader.js, practice-modes.js) and the Node unit
   tests (tests/text-core.test.js). No DOM access in this file.
   ============================================================ */

(function (root) {
  'use strict';

  // ~80 most common stopwords; always count as known when reading
  const STOPWORDS = new Set(('a an the and or but if then so because while when where what who whom whose why how that this these those is am are was were be been being have has had do does did doing will would shall should can could may might must of in on at to from for with by as into onto over under about against between through during before after above below up down out off near i you he she it we they me him her us them my your his its our their mine yours hers ours theirs not no yes than too very just only also even still yet already always never very much more most few less least some any all each every').split(' '));

  const SHORT_WORD_MAX = 2;          // words this short (ox, go) count as known
  const MIN_STEM = 2;                // shortest suffix-stripped form we consider
  const MIN_LY_STEM = 4;             // "early" must not become "ear"
  const MAX_SENTENCE_CHARS = 300;
  const SENTENCE_WINDOW_CHARS = 120;

  const NT_CONTRACTIONS = { "can't": 'can', "won't": 'will', "shan't": 'shall', "ain't": 'am' };

  // Common irregular forms → base form (past tenses, participles, plurals, comparatives)
  const IRREGULAR = Object.fromEntries((
    'said:say went:go gone:go came:come took:take taken:take made:make knew:know known:know ' +
    'thought:think saw:see seen:see got:get gotten:get gave:give given:give found:find told:tell ' +
    'felt:feel left:leave kept:keep began:begin begun:begin brought:bring stood:stand heard:hear ' +
    'meant:mean sat:sit spoke:speak spoken:speak ran:run wrote:write written:write held:hold ' +
    'became:become ate:eat eaten:eat fell:fall fallen:fall grew:grow grown:grow drew:draw drawn:draw ' +
    'threw:throw thrown:throw wore:wear worn:wear rose:rise risen:rise drove:drive driven:drive ' +
    'rode:ride ridden:ride chose:choose chosen:choose broke:break broken:break forgot:forget ' +
    'forgotten:forget caught:catch taught:teach bought:buy fought:fight sought:seek built:build ' +
    'sent:send spent:spend lost:lose paid:pay laid:lay lay:lie led:lead met:meet slept:sleep ' +
    'swept:sweep wept:weep struck:strike hung:hang shook:shake shaken:shake woke:wake woken:wake ' +
    'flew:fly flown:fly sang:sing sung:sing swam:swim drank:drink drunk:drink sank:sink rang:ring ' +
    'won:win understood:understand hid:hide hidden:hide bit:bite bitten:bite lit:light fed:feed ' +
    'fled:flee bled:bleed dug:dig stuck:stick swung:swing crept:creep knelt:kneel dealt:deal ' +
    'men:man women:woman children:child feet:foot teeth:tooth mice:mouse geese:goose people:person ' +
    'lives:life wives:wife knives:knife leaves:leaf wolves:wolf shelves:shelf selves:self ' +
    'better:good best:good worse:bad worst:bad'
  ).split(' ').map(pair => pair.split(':')));

  // Suffix rules: [pattern, replacement, minimum stem length]
  const SUFFIX_RULES = [
    [/ies$/, 'y', MIN_STEM], [/ied$/, 'y', MIN_STEM], [/ier$/, 'y', MIN_STEM],
    [/iest$/, 'y', MIN_STEM], [/ily$/, 'y', 3],
    [/es$/, '', MIN_STEM], [/ly$/, '', MIN_LY_STEM],
  ];
  const ED_ING = /(ed|ing)$/;                         // walk-ed, mak(e)-ing, stop(p)-ed
  const CVC_STEM = /[^aeiou][aeiouy][^aeiouwxy]$/;    // "hop" in "hoping" usually comes from "hope"
  const DOUBLED_CONSONANT = /([b-df-hj-np-tv-z])\1$/;
  const PLURAL_S_EXCEPTIONS = /(ss|us|is)$/;
  const POSSESSIVES = new Set(['my', 'your', 'his', 'her', 'its', 'our', 'their', 'ones', 'someones']);

  const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'vs', 'etc', 'prof', 'capt', 'col', 'gen', 'lt', 'sgt', 'rev']);
  // Sentence ends: terminal punctuation, or a blank line (single newlines are hard wraps)
  const SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s|$)|\n[ \t]*\n\s*/g;
  const SENTENCE_START_GAP = /(?:[.!?…]["'”’)\]]*\s+|\n\s*)["“‘'(\[]*$/;
  const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;

  // ---------- Normalising and diffing (dictation, read-aloud) ----------

  function normalizeWords(s) {
    return String(s || '').toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  // Longest Common Subsequence based word-diff: returns aligned entries
  function diffWords(target, said) {
    const a = target, b = said;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const result = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { result.push({ word: a[i], kind: 'ok' }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { result.push({ word: a[i], kind: 'miss' }); i++; }
      else { result.push({ word: b[j], kind: 'added' }); j++; }
    }
    while (i < m) result.push({ word: a[i++], kind: 'miss' });
    while (j < n) result.push({ word: b[j++], kind: 'added' });
    return result;
  }

  // Extra typed words count against you: accuracy = matches / max(target, typed)
  function scoreDictation(targetText, typedText) {
    const target = normalizeWords(targetText);
    const typed = normalizeWords(typedText);
    const diff = diffWords(target, typed);
    const matches = diff.filter(d => d.kind === 'ok').length;
    const denominator = Math.max(target.length, typed.length);
    const accuracy = denominator ? Math.round((matches / denominator) * 100) : 0;
    return { accuracy, diff, isPerfect: matches === target.length && typed.length === target.length };
  }

  // ---------- Word forms ----------

  function wordKey(s) {
    return String(s || '').toLowerCase().replace(/’/g, "'");
  }

  // "don't" → "do", "Mary's" → "mary"; null when there is no apostrophe
  function contractionCore(key) {
    const apos = key.indexOf("'");
    if (apos === -1) return null;
    if (key.endsWith("n't")) return NT_CONTRACTIONS[key] || key.slice(0, -3);
    return key.slice(0, apos);
  }

  // Stem candidates for an -ed / -ing ending, the more likely one first
  function edIngForms(stem) {
    if (stem.length < MIN_STEM) return [];
    const bare = DOUBLED_CONSONANT.test(stem) ? [stem, stem.slice(0, -1)] : [stem];
    const isEedWord = stem.length === 2 && stem.endsWith('e');   // "seed" is not "see" + d
    const withE = isEedWord ? [] : [stem + 'e'];
    return CVC_STEM.test(stem) ? [...withE, ...bare] : [...bare, ...withE];
  }

  // Candidate dictionary forms of a token, the token itself first
  function baseForms(token) {
    const key = wordKey(token);
    const forms = [key];
    const add = f => { if (f && f.length >= MIN_STEM && !forms.includes(f)) forms.push(f); };
    const core = contractionCore(key);
    if (core && !forms.includes(core)) forms.push(core);
    const stemSource = core || key;
    add(IRREGULAR[stemSource]);
    for (const [pattern, replacement, minStem] of SUFFIX_RULES) {
      if (!pattern.test(stemSource)) continue;
      const stem = stemSource.replace(pattern, '');
      if (stem.length < minStem) continue;
      add(stem + replacement);
    }
    const edIng = ED_ING.exec(stemSource);
    if (edIng) edIngForms(stemSource.slice(0, -edIng[0].length)).forEach(add);
    if (stemSource.endsWith('s') && !PLURAL_S_EXCEPTIONS.test(stemSource)) add(stemSource.slice(0, -1));
    return forms;
  }

  // Stopwords, their contractions ("didn't"), and very short words
  function isFunctionWord(token) {
    const key = wordKey(token);
    if (key.length <= SHORT_WORD_MAX || STOPWORDS.has(key)) return true;
    const core = contractionCore(key);
    return !!core && STOPWORDS.has(core);
  }

  // ---------- Word families ----------
  // Knowing "walked" should also cover "walk", "walking" and "walks". Two words are
  // in the same family when their base forms overlap. Stems under 3 letters are
  // ignored: "seed" and "sees" both reduce to "se" but are different words.
  const MIN_FAMILY_FORM = 3;

  function familyForms(word) {
    return baseForms(word).filter((f, i) => i === 0 || f.length >= MIN_FAMILY_FORM);
  }

  function expandForms(words) {
    const out = new Set();
    for (const w of words || []) familyForms(w).forEach(f => out.add(f));
    return out;
  }

  // Stored known words that belong to the same family as `token` (for un-marking)
  function relatedKnownWords(token, knownList) {
    const forms = new Set(familyForms(token));
    return cleanKnown(knownList).filter(k => familyForms(k).some(f => forms.has(f)));
  }

  function isKnownForm(token, knownSet) {
    if (isFunctionWord(token)) return true;
    return baseForms(token).some(f => knownSet.has(f));
  }

  // ---------- Tokenising and sentences ----------

  // Splits text into alternating word / gap pieces that rebuild the original exactly
  function tokenizeText(text) {
    const src = String(text || '');
    const pieces = [];
    let last = 0;
    for (const m of src.matchAll(WORD_RE)) {
      if (m.index > last) pieces.push({ text: src.slice(last, m.index), isWord: false, start: last });
      pieces.push({ text: m[0], isWord: true, start: m.index });
      last = m.index + m[0].length;
    }
    if (last < src.length) pieces.push({ text: src.slice(last), isWord: false, start: last });
    return pieces;
  }

  function isAbbreviationBefore(text, dotIndex) {
    const m = /([A-Za-z]+)$/.exec(text.slice(Math.max(0, dotIndex - 10), dotIndex));
    return !!m && ABBREVIATIONS.has(m[1].toLowerCase());
  }

  function splitSentences(text) {
    const src = String(text || '');
    const bounds = [];
    for (const m of src.matchAll(SENTENCE_END)) {
      if (m[0][0] === '.' && isAbbreviationBefore(src, m.index)) continue;
      bounds.push(m.index + m[0].length);
    }
    const parts = [];
    let start = 0;
    for (const end of bounds) {
      if (end > start) parts.push({ start, end });
      start = end;
    }
    if (start < src.length) parts.push({ start, end: src.length });
    return parts;
  }

  function collapse(s) { return s.replace(/\s+/g, ' ').trim(); }

  function sentenceAt(text, offset) {
    const src = String(text || '');
    const part = splitSentences(src).find(p => offset >= p.start && offset < p.end);
    if (!part) return '';
    const raw = src.slice(part.start, part.end);
    const sentence = collapse(raw);
    if (sentence.length <= MAX_SENTENCE_CHARS) return sentence;
    const rel = offset - part.start;
    const lead = raw.length - raw.trimStart().length;
    const tailEnd = raw.trimEnd().length;
    const from = Math.max(lead, raw.lastIndexOf(' ', rel - SENTENCE_WINDOW_CHARS) + 1);
    const toSpace = raw.indexOf(' ', rel + SENTENCE_WINDOW_CHARS);
    const to = toSpace === -1 || toSpace > tailEnd ? tailEnd : toSpace;
    return `${from > lead ? '…' : ''}${collapse(raw.slice(from, to))}${to < tailEnd ? '…' : ''}`;
  }

  // ---------- Finding a headword inside a sentence ----------

  function wordsMatch(target, token) {
    if (POSSESSIVES.has(target) && POSSESSIVES.has(token)) return true;   // make up my/her mind
    return sameLemma(target, token);
  }

  /**
   * Split a sentence around the first occurrence of a word or phrase in any
   * inflected form ("weep" finds "wept", "make up my mind" finds "made up her mind").
   * @returns {{before:string, match:string, after:string} | null}
   */
  function splitAtWord(sentence, target) {
    const src = String(sentence || '');
    const want = normalizeWords(target);
    if (want.length === 0) return null;
    const words = tokenizeText(src).filter(p => p.isWord);
    for (let i = 0; i + want.length <= words.length; i++) {
      const isMatch = want.every((w, j) => wordsMatch(w, normalizeWords(words[i + j].text)[0] || ''));
      if (!isMatch) continue;
      const last = words[i + want.length - 1];
      const start = words[i].start;
      const end = last.start + last.text.length;
      return { before: src.slice(0, start), match: src.slice(start, end), after: src.slice(end) };
    }
    return null;
  }

  // ---------- Reading analysis ----------

  function properKey(key) { return key.replace(/'s$/, ''); }

  // Proper nouns: always capitalised, and capitalised at least once mid-sentence
  function findProperNouns(pieces) {
    const seenLower = new Set();
    const capitalisedMid = new Set();
    let seenWord = false;
    let gap = '';
    for (const p of pieces) {
      if (!p.isWord) { gap += p.text; continue; }
      const key = properKey(wordKey(p.text));
      if (!/^[A-Z]/.test(p.text)) seenLower.add(key);
      else if (seenWord && !SENTENCE_START_GAP.test(gap)) capitalisedMid.add(key);
      seenWord = true;
      gap = '';
    }
    return new Set([...capitalisedMid].filter(k => !seenLower.has(k)));
  }

  function pct(part, total) {
    return total ? Math.round((part / total) * 1000) / 10 : 0;
  }

  /**
   * Classify every word of a text against the reader's vocabulary.
   * @param {string} text
   * @param {{ known?: Set<string>, learning?: Set<string> }} sets lowercase dictionary forms
   * @returns {{ pieces: Array, counts: {total:number, known:number, learning:number, unknown:number},
   *   coveragePct:number, learningPct:number, unknownPct:number, unknown: Array<{word:string, count:number}> }}
   */
  function analyzeText(text, sets) {
    // Whole word families count: knowing "walked" covers "walking" too
    const known = expandForms(sets && sets.known);
    const learning = expandForms(sets && sets.learning);
    const pieces = tokenizeText(text);
    const properNouns = findProperNouns(pieces);
    const statusCache = new Map();

    const classify = key => {
      if (isFunctionWord(key)) return 'stop';
      if (properNouns.has(properKey(key))) return 'proper';
      const forms = familyForms(key);
      if (forms.some(f => learning.has(f))) return 'learning';
      if (forms.some(f => known.has(f))) return 'known';
      return 'unknown';
    };

    const tagged = pieces.map(p => {
      if (!p.isWord) return p;
      const key = wordKey(p.text);
      if (!statusCache.has(key)) statusCache.set(key, classify(key));
      return { ...p, key, status: statusCache.get(key) };
    });

    const words = tagged.filter(p => p.isWord && p.status !== 'proper');
    const knownCount = words.filter(p => p.status === 'known' || p.status === 'stop').length;
    const learningCount = words.filter(p => p.status === 'learning').length;
    const unknownWords = words.filter(p => p.status === 'unknown');
    const freq = unknownWords.reduce((m, p) => m.set(p.key, (m.get(p.key) || 0) + 1), new Map());
    const unknown = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([word, count]) => ({ word, count }));
    const total = words.length;

    return {
      pieces: tagged,
      counts: { total, known: knownCount, learning: learningCount, unknown: unknownWords.length },
      coveragePct: pct(knownCount, total),
      learningPct: pct(learningCount, total),
      unknownPct: pct(unknownWords.length, total),
      unknown,
    };
  }

  // ---------- Speaking ----------

  function isPhrase(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length >= 2;
  }

  function sameLemma(a, b) {
    return a === b || baseForms(a).includes(b) || baseForms(b).includes(a);
  }

  // True when any recogniser alternative contains the target words in order
  function containsSpokenTarget(target, alternatives) {
    const want = normalizeWords(target);
    if (want.length === 0) return false;
    return (alternatives || []).some(alt => {
      const heard = normalizeWords(alt);
      for (let i = 0; i + want.length <= heard.length; i++) {
        if (want.every((w, j) => wordsMatch(w, heard[i + j]))) return true;
      }
      return false;
    });
  }

  // ---------- Known-word list sync ----------
  // `known` is a plain list. `knownLog` only records explicit un-marks (and
  // re-marks of un-marked words) as { word: { known, ts } }, so a sync merge
  // — which otherwise unions both lists — doesn't bring un-marked words back.

  function cleanKnown(list) {
    return Array.isArray(list) ? list.filter(w => typeof w === 'string').map(wordKey) : [];
  }

  function cleanKnownLog(log) {
    if (!log || typeof log !== 'object' || Array.isArray(log)) return {};
    return Object.fromEntries(Object.entries(log)
      .filter(([, v]) => v && typeof v.known === 'boolean' && typeof v.ts === 'string'));
  }

  function applyKnownChange(current, words, isKnown, ts) {
    const known = cleanKnown(current && current.known);
    const knownLog = { ...cleanKnownLog(current && current.knownLog) };
    const keys = cleanKnown(words);
    keys.forEach(k => { if (!isKnown || knownLog[k]) knownLog[k] = { known: isKnown, ts }; });
    const removed = new Set(keys);
    const next = isKnown ? [...new Set([...known, ...keys])] : known.filter(k => !removed.has(k));
    return { known: next, knownLog };
  }

  function mergeKnown(local, remote) {
    const knownLog = { ...cleanKnownLog(local && local.knownLog) };
    for (const [k, v] of Object.entries(cleanKnownLog(remote && remote.knownLog))) {
      if (!knownLog[k] || v.ts > knownLog[k].ts) knownLog[k] = v;
    }
    const known = new Set([...cleanKnown(local && local.known), ...cleanKnown(remote && remote.known)]);
    for (const [k, v] of Object.entries(knownLog)) {
      if (v.known) known.add(k);
      else known.delete(k);
    }
    return { known: [...known], knownLog };
  }

  function shortMeaning(defCN) {
    return String(defCN || '').split(/[;；,，]/)[0].trim().slice(0, 40);
  }

  function buildRoleplayPrompt({ scenario, words = [] }) {
    const list = words
      .map(w => `- ${w.text}${shortMeaning(w.defCN) ? ` (${shortMeaning(w.defCN)})` : ''}`)
      .join('\n');
    const vocabRule = words.length
      ? `3. Steer the conversation so I get natural chances to use these words and phrases I'm learning:\n${list}`
      : '3. Use the everyday vocabulary that naturally comes up in this situation.';
    return [
      "Let's do an English conversation role-play. I'm a Chinese speaker practising so I can talk with native English speakers.",
      '',
      `Scenario: ${scenario}`,
      '',
      'Rules:',
      '1. You play the other person and talk like a real native speaker: natural and casual, with contractions and common idioms. Keep each turn short (1-3 sentences) and end with something I can respond to.',
      "2. Stay in character and don't correct me during the conversation.",
      vocabRule,
      '4. If I write in Chinese, reply in English and show me how to say it in English.',
      '5. When I write "END", step out of character and give me: (a) my mistakes, each as original → natural version, (b) which target words I used correctly, (c) 3 useful native expressions for this situation, with Chinese meanings.',
      '',
      'Start the conversation now with your first line.',
    ].join('\n');
  }

  const TextCore = Object.freeze({
    STOPWORDS,
    normalizeWords,
    diffWords,
    scoreDictation,
    baseForms,
    isFunctionWord,
    isKnownForm,
    expandForms,
    relatedKnownWords,
    tokenizeText,
    splitSentences,
    sentenceAt,
    splitAtWord,
    analyzeText,
    isPhrase,
    containsSpokenTarget,
    applyKnownChange,
    mergeKnown,
    buildRoleplayPrompt,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = TextCore;
  else root.TextCore = TextCore;
})(typeof window !== 'undefined' ? window : globalThis);
