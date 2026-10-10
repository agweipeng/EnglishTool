/* Finds the JSON object in an AI reply. Chat apps wrap it in prose or code fences, and copying on a phone
   can bring curly quotes, invisible characters or unescaped line breaks. Shared by passage analysis and the Quiz. */
(function (root) {
  'use strict';
  const MAX_JSON_STARTS = 8;

  // Copying on a phone can add a byte-order mark, zero-width characters or non-breaking spaces
  const withoutInvisibles = text => text.replace(/[​-‍⁠﻿]/g, '').replace(/[   ]/g, ' ');
  const withoutFences = text => text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  // The {…} object starting at `start`, found by matching braces outside strings; null when it never closes
  function balancedObject(text, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{' || c === '[') depth++;
      else if ((c === '}' || c === ']') && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  // Fixes the usual slips in hand-copied JSON: curly quotes used as JSON quotes, unescaped quotes or line
  // breaks inside text, and trailing commas. Only used when the reply isn't valid JSON as it is.
  const CLOSES_STRING = /^\s*(?:[}\]:]|,\s*["“”{[]|$)/;
  const TRAILING_COMMA = /^\s*[}\]]/;
  function repairJSON(text) {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const next = () => text.slice(i + 1, i + 40);
      if (!inString) {
        if (c === '"' || c === '“' || c === '”') { out += '"'; inString = true; }
        else if (!(c === ',' && TRAILING_COMMA.test(next()))) out += c;
        continue;
      }
      if (c === '\\') { out += c + (text[i + 1] ?? ''); i++; }
      else if (c === '"' || c === '“' || c === '”') {
        if (CLOSES_STRING.test(next())) { out += '"'; inString = false; }
        else out += c === '"' ? '\\"' : c;
      }
      else if (c === '\n') out += '\\n';
      else if (c === '\t') out += '\\t';
      else if (c !== '\r') out += c;
    }
    return out;
  }

  const jsonObject = text => {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };

  // Tries the strictest reading first, so a valid reply is never changed by the repairs, and outer
  // objects before inner ones, so a small {"en","cn"} pair is never taken for the whole analysis
  function* jsonCandidates(reply) {
    for (const text of [reply, withoutInvisibles(reply)]) {
      yield withoutFences(text);
      for (let at = text.indexOf('{'), tried = 0; at >= 0 && tried < MAX_JSON_STARTS; at = text.indexOf('{', at + 1), tried++) {
        yield balancedObject(text, at);
        yield balancedObject(repairJSON(text.slice(at)), 0);
      }
    }
  }

  // The first object in the reply that `accept` approves; null when there is none
  function findReplyJSON(reply, accept) {
    for (const candidate of jsonCandidates(String(reply ?? ''))) {
      const value = candidate && jsonObject(candidate);
      if (value && accept(value)) return value;
    }
    return null;
  }

  const api = { findReplyJSON };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReplyJSON = api;
})(typeof window !== 'undefined' ? window : globalThis);
