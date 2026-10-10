'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {value:'',textContent:'',innerHTML:'',disabled:false,open:false,
      append() {},close(){this.open=false;},showModal(){this.open=true;},addEventListener(){}});
    return elements.get(id);
  };
  const saved = new Map();
  const context = vm.createContext({window:{},reader:{},paragraphContext:{text:'Test passage'},
    document:{readyState:'loading',addEventListener(){},getElementById:element,createElement:()=>({})},
    localStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},
    AbortController,setTimeout,clearTimeout,LocalAI:{request:()=>async()=>({}),models:async()=>['chat-model'],usesDirectOllama:()=>false},
    closeParagraphAnalysis:()=>element('readerAnalysisDialog').open=false,closeOnBackdropClick(){},openParagraphAnalysis(){},toast(){},
  });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync(require.resolve('../local-ai-settings.js'),'utf8'));
  return {context,run,element,saved};
}

test('saving a checked model connects it without automatic analysis and persists only preferences', async () => {
  const h = harness();
  h.run('openLocalAISettings()');
  await h.run('checkLocalAIConnection()');
  h.element('localAIModel').value='chat-model';
  h.element('localAIUse').disabled=false;
  h.run('saveLocalAIConnection()');
  assert.equal(typeof h.context.window.requestParagraphAI, 'function');
  assert.equal(h.context.window.autoParagraphAI, undefined, 'Local AI never starts by itself');
  assert.deepEqual(JSON.parse([...h.saved.values()][0]),{model:'chat-model',provider:'ollama'});
});

test('failed connection checks cannot apply a stale saved model', async () => {
  const h = harness();
  h.run('applyLocalAIConfig({model:"old-model",auto:true}); openLocalAISettings()');
  h.context.LocalAI.models=async()=>{throw new Error('Unavailable');};
  await h.run('checkLocalAIConnection()');
  h.element('localAIModel').value='old-model';
  h.element('localAIUse').disabled=false;
  h.run('saveLocalAIConnection()');
  assert.equal(h.saved.size,0);
  assert.equal(h.element('localAIDialog').open,true);
});

test('closing settings aborts discovery and ignores late model lists', async () => {
  const h = harness();
  let release;
  let signal;
  h.context.LocalAI.models=options=>{signal=options.signal;return new Promise(resolve=>release=resolve);};
  h.run('openLocalAISettings()');
  const pending=h.run('checkLocalAIConnection()');
  h.run('closeLocalAISettings()');
  release(['stale-model']);
  await pending;
  assert.equal(signal.aborted,true);
  assert.equal(h.run('localAIAvailableModels.length'),0);
});

test('existing LM Studio settings retain their provider when the app reloads', () => {
  const h = harness();
  h.saved.set('englishTrainerLocalAI_v1',JSON.stringify({model:'old-model',auto:true}));
  h.run('initLocalAISettings()');
  assert.equal(h.run('localAIConfig.provider'),'lmstudio');
  assert.equal(h.element('readerLocalAIBtn').textContent,'✓ LM Studio · 本地 AI');
});

test('a saved Ollama model stays connected after reload, but an old automatic-analysis setting is ignored', () => {
  const h = harness();
  h.saved.set('englishTrainerLocalAI_v1',JSON.stringify({provider:'ollama',model:'qwen3.5:4b',auto:true}));
  h.run('initLocalAISettings()');
  assert.equal(h.run('localAIConfig.provider'),'ollama');
  assert.equal(typeof h.context.window.requestParagraphAI,'function');
  assert.equal(h.context.window.autoParagraphAI,undefined);
  assert.equal(h.element('readerLocalAIBtn').textContent,'✓ Ollama · 本地 AI');
});

test('on the hosted site the dialog explains the one-time Ollama setup for this exact site', () => {
  const h = harness();
  h.context.LocalAI.usesDirectOllama = () => true;
  h.context.window.location = { origin: 'https://agweipeng.github.io' };
  h.run('openLocalAISettings()');
  assert.match(h.element('localAIHint').textContent, /launchctl setenv OLLAMA_ORIGINS "https:\/\/agweipeng\.github\.io"/);
});

test('LM Studio on the hosted site points to the local server instead of failing silently', async () => {
  const h = harness();
  let asked = false;
  h.context.LocalAI.usesDirectOllama = () => true;
  h.context.LocalAI.models = async () => { asked = true; return ['chat-model']; };
  h.context.window.location = { origin: 'https://agweipeng.github.io' };
  h.run('openLocalAISettings()');
  h.element('localAIProvider').value = 'lmstudio';
  await h.run('checkLocalAIConnection()');
  assert.equal(asked, false);
  assert.match(h.element('localAIStatus').textContent, /choose Ollama/);
});
