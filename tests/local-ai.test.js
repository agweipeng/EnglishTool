'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../local-ai.js');
const fixture = require('./fixtures/paragraph-analysis.json');
const core = require('../paragraph-core.js');

test('LM Studio model discovery validates and deduplicates IDs', async () => {
  const result = await ai.models({ fetchImpl: async (url, options) => {
    assert.equal(url, '/local-ai/models');
    return { ok: true, json: async () => ({ data: [{id:'local-chat'}, {id:'local-chat'}, { id: null }] }) };
  } });
  assert.deepEqual(result, ['local-chat']);
});

test('Ollama selection routes discovery and inference to that provider', async () => {
  const fetchImpl = async (url, options) => {
    if (!options.body) {
      assert.equal(url, '/local-ai/models?provider=ollama');
      return {ok:true,json:async()=>({data:[{id:'qwen3.5:4b'}]})};
    }
    const body = JSON.parse(options.body);
    assert.equal(body.provider, 'ollama');
    return {ok:true,json:async()=>({choices:[{message:{content:'{}'}}]})};
  };
  assert.deepEqual(await ai.models({provider:'ollama',fetchImpl}),['qwen3.5:4b']);
  assert.equal(await ai.request('qwen3.5:4b',{provider:'ollama',fetchImpl})({prompt:'test'}),'{}');
});

test('local inference sends a structured bilingual request and returns validated model text', async () => {
  const controller = new AbortController();
  const prompt = core.buildPrompt({text:fixture.passage});
  const request = ai.request('local-chat', { fetchImpl: async (url, options) => {
    assert.equal(url, '/local-ai/chat');
    assert.equal(options.signal, controller.signal);
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'local-chat');
    assert.equal(body.messages[0].content, prompt);
    assert.equal(body.stream, false);
    assert.equal(body.response_format.type, 'json_schema');
    assert.deepEqual(body.response_format.json_schema.schema.required, ['simplified','mainPoint','words','phrases','sentences','speaking']);
    return { ok: true, json: async () => ({ choices: [{message:{content:JSON.stringify(fixture.analysis)}, finish_reason:'stop'}] }) };
  } });
  const result = core.validateResponse(await request({prompt,signal:controller.signal}), fixture.passage);
  assert.equal(result.phrases[0].text, 'keep watch');
});

test('an unavailable local service and missing proxy give actionable errors', async () => {
  await assert.rejects(ai.models({fetchImpl: async () => ({ok:false,json:async()=>({error:{code:'unavailable'}})})}), /Start your selected local AI/);
  await assert.rejects(ai.models({fetchImpl: async () => ({ok:false,json:async()=>{throw new Error('HTML')}})}), /serve-local-ai.py/);
});

test('truncated inference is rejected instead of displaying a partial analysis', async () => {
  const request = ai.request('local-chat', {fetchImpl:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})})});
  await assert.rejects(request({prompt:'test'}), /incomplete/);
});

test('aborting a model request propagates cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  const request = ai.request('local-chat', {fetchImpl:async(_,options)=>{
    if (options.signal.aborted) { const error = new Error('Aborted'); error.name='AbortError'; throw error; }
  }});
  await assert.rejects(request({prompt:'test',signal:controller.signal}), {name:'AbortError'});
});
