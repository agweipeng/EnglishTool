/* ============================================================
   Listening & speaking practice:
   - Sentence Dictation card: hear a whole sentence, type it
   - Spoken Production card: see the Chinese, say the English
   - Phrase cards from collocation chips
   - Conversation role-play prompt for claude.ai
   Depends on text-core.js (TextCore) and app.js globals:
   state, saveState, speak, toast, escapeHTML, ratingButtons,
   attachRating, renderSpellingCard, renderMeaningCard, isLeech,
   newWordEntry, lookupWordFields, findWordByText, MAX_EXAMPLES.
   ============================================================ */

'use strict';

const RECOGNITION_ALTERNATIVES = 5;
const ACCURACY_GOOD = 85;   // % shown green
const ACCURACY_MID = 60;    // % shown amber
const ROLEPLAY_WORD_COUNT = 8;
const ROLEPLAY_PER_GROUP = 3;   // max stubborn words / phrases in one role-play
const ROLEPLAY_SCENARIOS = [
  'Small talk with a friendly neighbour about the weekend',
  'Ordering coffee and chatting with the barista',
  'Talking with a friend about a novel we are both reading',
  'Meeting a new colleague over lunch',
  'A job interview for a role in my field',
  'Checking into a hotel and asking for local recommendations',
  'Describing symptoms to a doctor',
];

function accuracyClass(accuracy) {
  if (accuracy >= ACCURACY_GOOD) return 'good';
  return accuracy >= ACCURACY_MID ? 'mid' : 'bad';
}

function diffHtml(diff) {
  return diff.map(d => `<span class="${d.kind}">${escapeHTML(d.word)}</span>`).join(' ');
}

function exampleHtml(ex) {
  if (!ex) return '';
  return `<div class="example"><div class="en">${escapeHTML(ex.en)}</div>${ex.cn ? `<div class="cn">${escapeHTML(ex.cn)}</div>` : ''}</div>`;
}

// ============ Sentence Dictation ============

function renderDictationCard(word, body, actions) {
  const withEnglish = (word.examples || []).filter(e => e.en);
  if (withEnglish.length === 0) return renderSpellingCard(word, body, actions);
  const ex = withEnglish[Math.floor(Math.random() * withEnglish.length)];
  body.innerHTML = `
    <div class="phonetic">✍️ Listen and type the whole sentence</div>
    <div class="form-actions practice-center">
      <button class="btn-ghost" id="dictReplay">🔊 Play again</button>
      <button class="btn-ghost" id="dictSlow">🐢 Slow</button>
    </div>
    <input type="text" class="spelling-input dictation-input" id="dictInput" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Type what you hear..." />
    <button class="btn-primary" id="dictCheck" style="margin-top:10px">Check</button>
    <div id="dictFeedback" class="practice-feedback"></div>
  `;
  const input = document.getElementById('dictInput');
  const submit = () => {
    if (input.disabled) return;
    input.disabled = true;
    document.getElementById('dictCheck').disabled = true;
    const r = TextCore.scoreDictation(ex.en, input.value);
    document.getElementById('dictFeedback').innerHTML = `
      <div class="read-aloud-result">
        <div class="read-aloud-accuracy ${accuracyClass(r.accuracy)}">${r.accuracy}% accuracy</div>
        <div class="read-aloud-diff">${diffHtml(r.diff)}</div>
      </div>
      ${exampleHtml(ex)}
      <div class="hint">Word: <b>${escapeHTML(word.text)}</b> — ${escapeHTML(word.defCN || word.defEN || '')}</div>`;
    speak(ex.en);
    actions.innerHTML = ratingButtons(word);
    attachRating(actions, word);
  };
  document.getElementById('dictReplay').addEventListener('click', () => speak(ex.en));
  document.getElementById('dictSlow').addEventListener('click', () => speak(ex.en, { slow: true }));
  document.getElementById('dictCheck').addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  input.focus();
  speak(ex.en);
}

// ============ Spoken Production ============

function hasSpeechRecognition() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// Resolves with the recogniser's alternatives for one utterance ([] when nothing was heard)
function listenOnce() {
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { reject(new Error('unsupported')); return; }   // message = error code for speechErrorMessage()
    speechSynthesis.cancel();
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = RECOGNITION_ALTERNATIVES;
    let heard = [];
    rec.onresult = e => { heard = Array.from(e.results[0] || [], alt => alt.transcript); };
    rec.onerror = e => {
      if (e.error === 'no-speech') resolve([]);
      else reject(new Error(e.error || 'unknown error'));
    };
    rec.onend = () => resolve(heard);
    rec.start();
  });
}

function renderProductionCard(word, body, actions) {
  const prompt = word.defCN || word.defEN;
  if (!prompt) return renderMeaningCard(word, body, actions);
  const hint = ((word.examples || []).find(e => e.cn) || {}).cn || '';
  const ex = (word.examples || []).find(e => e.en);
  const canListen = hasSpeechRecognition();
  body.innerHTML = `
    <div class="phonetic">🗣️ Say it in English${TextCore.isPhrase(word.text) ? ' — it\'s a phrase' : ''}</div>
    <div class="production-prompt">${escapeHTML(prompt)}</div>
    ${hint ? `<div class="definition-cn">${escapeHTML(hint)}</div>` : ''}
    <div class="form-actions practice-center">
      ${canListen ? '<button class="btn-primary" id="prodMicBtn">🎙️ Speak</button>' : ''}
      <button class="btn-ghost" id="prodRevealBtn">Show answer</button>
    </div>
    <input type="text" class="spelling-input" id="prodInput" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
      placeholder="${canListen ? '…or type it and press Enter' : 'Type it and press Enter'}" />
    <div id="prodFeedback" class="practice-feedback"></div>
  `;
  const input = document.getElementById('prodInput');

  // result: { said: string|null, correct: boolean|null } — null correct = gave up
  const reveal = result => {
    if (input.disabled || !body.contains(input)) return;   // already revealed, or card changed
    body.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
    let head = '';
    if (result.correct === true) head = `<div class="feedback ok">✓ Correct${result.said ? ` — “${escapeHTML(result.said)}”` : ''}</div>`;
    else if (result.correct === false) head = `<div class="feedback bad">✗ ${result.said ? `You said “${escapeHTML(result.said)}”` : 'Not quite'}</div>`;
    document.getElementById('prodFeedback').innerHTML = `
      ${head}
      <div class="word-display">${escapeHTML(word.text)}</div>
      <div class="phonetic">${escapeHTML(word.phonetic || '')}</div>
      ${exampleHtml(ex)}`;
    speak(word.text);
    actions.innerHTML = ratingButtons(word);
    attachRating(actions, word);
  };

  const micBtn = document.getElementById('prodMicBtn');
  if (micBtn) {
    micBtn.addEventListener('click', async () => {
      micBtn.disabled = true;
      micBtn.textContent = '🎙️ Listening…';
      let heard = [];
      let error = null;
      try {
        heard = await listenOnce();
      } catch (err) {
        error = err;
      }
      // The answer may have been revealed (or the card changed) while listening
      if (input.disabled || !body.contains(input)) return;
      if (heard.length > 0) {
        reveal({ said: heard[0], correct: TextCore.containsSpokenTarget(word.text, heard) });
        return;
      }
      toast(error ? speechErrorMessage(error.message) : 'No speech heard — try again', error ? 6000 : 1800);
      micBtn.disabled = false;
      micBtn.textContent = '🎙️ Speak';
    });
  }
  document.getElementById('prodRevealBtn').addEventListener('click', () => reveal({ said: null, correct: null }));
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    reveal({ said: input.value.trim(), correct: TextCore.containsSpokenTarget(word.text, [input.value]) });
  });
}

// ============ Phrase cards from collocation chips ============

async function addPhraseCard(phrase, sourceId, btn) {
  if (findWordByText(phrase)) { toast(`"${phrase}" is already in your library`); return; }
  btn.disabled = true;
  toast(`Adding "${phrase}"…`);
  try {
    const source = state.words.find(w => w.id === sourceId);
    const fields = await lookupWordFields(phrase);
    const lower = phrase.toLowerCase();
    const sourceExamples = ((source && source.examples) || []).filter(e => e.en && TextCore.splitAtWord(e.en, lower));
    btn.textContent = `✓ ${phrase}`;
    // Re-check: it may have been added while the lookups were running
    if (findWordByText(phrase)) { toast(`"${phrase}" is already in your library`); return; }
    state.words.push(newWordEntry({
      text: phrase,
      ...fields,
      examples: [...sourceExamples, ...fields.examples].slice(0, MAX_EXAMPLES),
      tags: ['phrase'],
    }));
    saveState();
    toast(fields.defCN
      ? `✓ Added phrase "${phrase}"`
      : `Added "${phrase}", but the translation failed — add its meaning in the Library`, 3500);
  } catch (e) {
    console.warn('Phrase add failed', e);
    toast('Could not add the phrase — check your connection and try again');
    btn.disabled = false;
  }
}

// ============ Conversation role-play (claude.ai) ============

// A few stubborn words, a few phrases, then the newest active words
function pickRoleplayWords() {
  const active = state.words.filter(w => !w.archivedAt);
  const newest = [...active].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const stubborn = newest.filter(isLeech).slice(0, ROLEPLAY_PER_GROUP);
  const phrases = newest.filter(w => TextCore.isPhrase(w.text)).slice(0, ROLEPLAY_PER_GROUP);
  return [...new Set([...stubborn, ...phrases, ...newest])].slice(0, ROLEPLAY_WORD_COUNT);
}

function renderRoleplayWords() {
  const el = document.getElementById('roleplayWords');
  if (!el) return;
  const words = pickRoleplayWords();
  el.innerHTML = words.length
    ? `Target words: ${words.map(w => `<span class="chip">${escapeHTML(w.text)}</span>`).join(' ')}`
    : 'Add some words first — the role-play will steer you to use them.';
}

function copyRoleplayPrompt() {
  const custom = document.getElementById('roleplayCustom').value.trim();
  const scenario = custom || document.getElementById('roleplayScenario').value;
  const prompt = TextCore.buildRoleplayPrompt({ scenario, words: pickRoleplayWords() });
  return copyAndOpenClaude(prompt, 'Prompt copied → paste it into claude.ai (try voice mode!)');
}

function initPracticeModes() {
  const select = document.getElementById('roleplayScenario');
  select.innerHTML = ROLEPLAY_SCENARIOS.map(s => `<option>${escapeHTML(s)}</option>`).join('');
  document.getElementById('roleplayBtn').addEventListener('click', copyRoleplayPrompt);
  document.addEventListener('click', e => {
    const chip = e.target.closest('.chip-add');
    if (chip && !chip.disabled) addPhraseCard(chip.dataset.phrase, chip.dataset.source, chip);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPracticeModes);
} else {
  initPracticeModes();
}
