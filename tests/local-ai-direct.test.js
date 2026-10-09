'use strict';
// On the hosted site (https://agweipeng.github.io) there is no local server, so the
// browser talks to Ollama on this computer directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../local-ai.js');

const OLLAMA = 'http://127.0.0.1:11434';
const TAGS = { models: [
  { name: 'qwen3.5:4b', capabilities: ['completion', 'thinking'] },
  { name: 'qwen3.5:4b', capabilities: ['completion'] },
  { name: 'nomic-embed-text', capabilities: ['embedding'] },
  { name: 'gpt-oss:120b-cloud', capabilities: ['completion'] },
  { name: 'remote-alias', remote_host: 'https://ollama.com' },
] };

// Ollama's non-streamed /api/chat reply
const answer = fields => new Response(JSON.stringify({ model: 'qwen3.5:4b', ...fields }));

function ollama({ chat, onChat } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === `${OLLAMA}/api/tags`) return new Response(JSON.stringify(TAGS));
    if (url === `${OLLAMA}/api/chat`) { onChat?.(options); return chat(); }
    throw new Error(`Unexpected ${url}`);
  };
  return { calls, fetchImpl };
}

test('the hosted site uses Ollama directly; the local server pages keep using the proxy', () => {
  assert.equal(ai.usesDirectOllama({ protocol: 'https:', hostname: 'agweipeng.github.io' }), true);
  assert.equal(ai.usesDirectOllama({ protocol: 'http:', hostname: '127.0.0.1' }), false);
  assert.equal(ai.usesDirectOllama({ protocol: 'http:', hostname: 'localhost' }), false);
  assert.equal(ai.usesDirectOllama({ protocol: 'file:', hostname: '' }), false);
  assert.equal(ai.usesDirectOllama(undefined), false);
});

test('direct discovery lists only installed local chat models', async () => {
  const { calls, fetchImpl } = ollama();
  assert.deepEqual(await ai.models({ provider: 'ollama', direct: true, fetchImpl }), ['qwen3.5:4b']);
  assert.equal(calls[0].url, `${OLLAMA}/api/tags`);
});

test('direct analysis asks Ollama for one complete structured answer', async () => {
  let body;
  const { fetchImpl } = ollama({
    onChat: options => { body = JSON.parse(options.body); },
    chat: () => answer({ message: { role: 'assistant', content: '{"a":1}' }, done: true, done_reason: 'stop' }),
  });
  const reply = await ai.request('qwen3.5:4b', { provider: 'ollama', direct: true, fetchImpl })({ prompt: 'Explain.' });
  assert.equal(reply, '{"a":1}');
  assert.equal(body.model, 'qwen3.5:4b');
  // Not streamed: a tab that stops reading a stream would stall Ollama for every later request
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Explain.' }]);
  assert.deepEqual(body.format, ai.schema);
});

test('direct analysis refuses models that are not installed locally', async () => {
  const { calls, fetchImpl } = ollama({ chat: () => assert.fail('must not run') });
  await assert.rejects(ai.request('gpt-oss:120b-cloud', { provider: 'ollama', direct: true, fetchImpl })({ prompt: 'x' }),
    error => error.name === 'LocalAIError' && /no longer installed/.test(error.message));
  assert.ok(calls.every(call => !call.url.endsWith('/api/chat')));
});

test('an unreachable or blocked Ollama explains the one-time setup', async () => {
  const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(ai.models({ provider: 'ollama', direct: true, fetchImpl }),
    error => error.name === 'LocalAIError' && /OLLAMA_ORIGINS/.test(error.message));
});

test('closing the panel aborts the direct Ollama request so the model stops', async () => {
  let chatSignal;
  const { fetchImpl } = ollama({
    onChat: options => { chatSignal = options.signal; },
    chat: () => new Promise((resolve, reject) => chatSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
  });
  const controller = new AbortController();
  const pending = ai.request('qwen3.5:4b', { provider: 'ollama', direct: true, fetchImpl })({ prompt: 'x', signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(chatSignal.aborted, true);
});

test('a truncated or broken direct answer is reported as incomplete', async () => {
  for (const reply of [
    () => answer({ message: { content: '{"a":' }, done: true, done_reason: 'length' }),
    () => answer({ message: { content: '{"a":' }, done: false }),
    () => answer({ message: { content: '  ' }, done: true }),
    () => new Response('not json'),
    () => new Response(JSON.stringify({ error: 'model crashed' }), { status: 500 }),
  ]) {
    const { fetchImpl } = ollama({ chat: reply });
    await assert.rejects(ai.request('qwen3.5:4b', { provider: 'ollama', direct: true, fetchImpl })({ prompt: 'x' }),
      error => error.name === 'LocalAIError');
  }
});
