/* Vocabulary test: pure logic shared by the browser (vocab-size.js) and the tests. No DOM access.
   Each step shows a few words from one frequency band of word-ranks.js plus made-up words. The share of
   real words ticked, corrected by how often made-up words were ticked, estimates how much of each band the
   reader knows. */
(function (root) {
  'use strict';

  const REAL_PER_STEP = 8;
  const FAKE_PER_STEP = 2;
  // The test stops after a step where (corrected) fewer than this share of the words were known
  const STOP_BELOW = 0.25;
  // Bands known at least this well, from the start, are marked as known (except words ticked as unknown)
  const MARK_FROM = 0.8;

  // Look like English words but are not; none appears in the app's books (tests/vocab-size-core.test.js)
  const MADE_UP_WORDS = Object.freeze([
    'plound', 'sporlick', 'brastic', 'fendle', 'quarmish', 'tolvent', 'sprindle', 'gorrid', 'drastle',
    'wembish', 'crosten', 'harnish', 'mollock', 'trindle', 'skemble', 'frandle', 'polcrate', 'blenter',
    'snorvel', 'glimber', 'pandrous', 'clommet', 'veltish', 'strommer',
  ]);

  const shuffled = (list, random) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  /**
   * The steps of one test, one per band: { band, real: string[], fake: string[] }
   * @param {{ words: string[], bandSize: number }} ranks
   * @param {() => number} random
   */
  function planTest(ranks, random = Math.random) {
    const bandCount = Math.ceil(ranks.words.length / ranks.bandSize);
    const fakes = shuffled(MADE_UP_WORDS, random);
    return Array.from({ length: bandCount }, (_, band) => ({
      band,
      real: shuffled(ranks.words.slice(band * ranks.bandSize, (band + 1) * ranks.bandSize), random).slice(0, REAL_PER_STEP),
      fake: fakes.slice(band * FAKE_PER_STEP, (band + 1) * FAKE_PER_STEP),
    }));
  }

  // Share of made-up words ticked so far (0 when none were shown)
  function falseAlarmRate(answers) {
    const shown = answers.reduce((sum, a) => sum + a.fake.length, 0);
    const ticked = answers.reduce((sum, a) => sum + a.fake.filter(word => a.ticked.includes(word)).length, 0);
    return shown ? ticked / shown : 0;
  }

  // Share of a step's real words known, corrected for guessing: (hits - false alarms) / (1 - false alarms)
  function knownShare(answer, falseAlarms) {
    if (!answer.real.length || falseAlarms >= 1) return 0;
    const hits = answer.real.filter(word => answer.ticked.includes(word)).length / answer.real.length;
    return Math.max(0, Math.min(1, (hits - falseAlarms) / (1 - falseAlarms)));
  }

  /** True when the test should end after these answers: every band was shown, or the words became too hard */
  function isFinished(answers, steps) {
    if (answers.length >= steps.length) return true;
    const last = answers[answers.length - 1];
    return !!last && knownShare(last, falseAlarmRate(answers)) < STOP_BELOW;
  }

  /**
   * @param {Array<{band:number, real:string[], fake:string[], ticked:string[]}>} answers in band order
   * @param {{ words: string[], bandSize: number }} ranks
   * @returns {{ estimate:number, listSize:number, bands:number[], falseAlarms:number, unknown:string[] }}
   *   bands: known share of every band (untested bands count as 0); unknown: real words left unticked
   */
  function scoreTest(answers, ranks) {
    const falseAlarms = falseAlarmRate(answers);
    const bandCount = Math.ceil(ranks.words.length / ranks.bandSize);
    const bands = Array.from({ length: bandCount }, (_, band) => {
      const answer = answers.find(a => a.band === band);
      return answer ? Math.round(knownShare(answer, falseAlarms) * 100) / 100 : 0;
    });
    const bandWords = band => Math.min(ranks.bandSize, ranks.words.length - band * ranks.bandSize);
    const estimate = Math.round(bands.reduce((sum, share, band) => sum + share * bandWords(band), 0) / 10) * 10;
    const unknown = answers.flatMap(a => a.real.filter(word => !a.ticked.includes(word)));
    return { estimate, listSize: ranks.words.length, bands, falseAlarms: Math.round(falseAlarms * 100) / 100, unknown };
  }

  /**
   * Words to mark as known: every word of the leading bands known at least MARK_FROM, except words left
   * unticked in the test and the words in `skip` (already known, being learned, or un-marked by the user).
   */
  function wordsToMark(ranks, result, skip = []) {
    const firstWeak = result.bands.findIndex(share => share < MARK_FROM);
    const bandCount = firstWeak === -1 ? result.bands.length : firstWeak;
    const skipped = new Set([...skip, ...result.unknown]);
    return ranks.words.slice(0, bandCount * ranks.bandSize).filter(word => !skipped.has(word));
  }

  /**
   * Estimated share (percent, one decimal) of a book's running words the reader knows: function words, plus
   * each band's words times the share of that band known. Null when the book was not measured.
   * @param {{stop:number, bands:number[], rare:number}} spread per mille, from word-ranks.js
   */
  function bookCoverage(spread, bands) {
    if (!spread || !Array.isArray(spread.bands) || !Array.isArray(bands)) return null;
    const perMille = spread.stop + spread.bands.reduce((sum, share, band) => sum + share * (bands[band] || 0), 0);
    return Math.round(perMille) / 10;
  }

  const VocabTestCore = Object.freeze({
    MADE_UP_WORDS, REAL_PER_STEP, FAKE_PER_STEP, MARK_FROM, planTest, isFinished, scoreTest, wordsToMark, bookCoverage,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = VocabTestCore;
  else root.VocabTestCore = VocabTestCore;
})(typeof window !== 'undefined' ? window : globalThis);
