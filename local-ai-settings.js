'use strict';
const LOCAL_AI_KEY = 'englishTrainerLocalAI_v1';
let localAIConfig = null;
let localAICheckRequest = null;
let localAISettingsReturn = null;
let localAISettingsReader = null;
let localAIAvailableModels = [];
const localAIName = provider => provider === 'ollama' ? 'Ollama' : 'LM Studio';

function applyLocalAIConfig(config) {
  localAIConfig = config;
  window.requestParagraphAI = config ? LocalAI.request(config.model, { provider: config.provider }) : undefined;
  window.autoParagraphAI = !!config?.auto;
  document.getElementById('readerLocalAIBtn').textContent = config
    ? `✓ ${localAIName(config.provider)} · 本地 AI` : 'Local AI · 本地 AI';
}

function closeLocalAISettings() {
  localAICheckRequest?.abort();
  localAICheckRequest = null;
  document.getElementById('localAIDialog').close();
}

function openLocalAISettings() {
  closeLocalAISettings();
  localAISettingsReturn = document.getElementById('readerAnalysisDialog').open ? paragraphContext?.text : null;
  localAISettingsReader = reader;
  localAIAvailableModels = [];
  document.getElementById('localAIProvider').value = localAIConfig?.provider || 'ollama';
  closeParagraphAnalysis();
  const model = document.getElementById('localAIModel');
  model.innerHTML = '<option value="">Choose a model / 选择模型</option>';
  if (localAIConfig) {
    const option = document.createElement('option');
    option.value = option.textContent = localAIConfig.model;
    model.append(option);
    model.value = localAIConfig.model;
  }
  document.getElementById('localAIAuto').checked = localAIConfig?.auto ?? true;
  document.getElementById('localAIStatus').textContent = 'Check the connection to list your models. / 检查连接以列出你的模型。';
  document.getElementById('localAICheck').disabled = false;
  document.getElementById('localAIUse').disabled = true;
  const hint = localAISetupHint();
  if (hint) document.getElementById('localAIHint').textContent = hint;
  document.getElementById('localAIDialog').showModal();
}

// On the hosted site the browser talks to Ollama itself, so the setup differs from the
// page's default instructions for scripts/serve-local-ai.py.
function localAISetupHint() {
  if (!LocalAI.usesDirectOllama()) return null;
  const origin = window.location.origin;
  return 'On this website, EnglishTool connects straight to Ollama on this computer. Use Chrome or Edge and allow local network access if asked. '
    + `Allow this site once in Terminal: launchctl setenv OLLAMA_ORIGINS "${origin}" — then quit and reopen Ollama. LM Studio needs the local server. / `
    + '在本网站上，EnglishTool 会直接连接本机的 Ollama。请使用 Chrome 或 Edge，如有提示请允许访问本地网络。'
    + `请在终端中运行一次：launchctl setenv OLLAMA_ORIGINS "${origin}"，然后退出并重新打开 Ollama。LM Studio 需要使用本地服务器。`;
}

async function checkLocalAIConnection() {
  localAICheckRequest?.abort();
  if (document.getElementById('localAIProvider').value === 'lmstudio' && LocalAI.usesDirectOllama()) {
    localAICheckRequest = null;
    document.getElementById('localAIStatus').textContent = 'On this website, choose Ollama. LM Studio works when you start EnglishTool with scripts/serve-local-ai.py. / 在本网站上请选择 Ollama；LM Studio 需要通过 scripts/serve-local-ai.py 启动 EnglishTool 才能使用。';
    return;
  }
  const controller = new AbortController();
  localAICheckRequest = controller;
  localAIAvailableModels = [];
  const timeout = setTimeout(() => controller.abort(), 10000);
  const status = document.getElementById('localAIStatus');
  const button = document.getElementById('localAICheck');
  const provider = document.getElementById('localAIProvider').value;
  const service = localAIName(provider);
  button.disabled = true;
  document.getElementById('localAIUse').disabled = true;
  status.textContent = `Connecting to ${service}… / 正在连接 ${service}…`;
  try {
    const models = await LocalAI.models({ signal: controller.signal, provider });
    if (localAICheckRequest !== controller || controller.signal.aborted) return;
    const select = document.getElementById('localAIModel');
    select.innerHTML = '<option value="">Choose a model / 选择模型</option>';
    models.forEach(id => {
      const option = document.createElement('option');
      option.value = option.textContent = id;
      select.append(option);
    });
    select.value = provider === localAIConfig?.provider && models.includes(localAIConfig?.model) ? localAIConfig.model : '';
    localAIAvailableModels = models;
    status.textContent = models.length ? 'Connected. Choose a chat model. / 已连接，请选择聊天模型。'
      : `No models available. Add a chat model in ${service}, then check again. / 没有可用模型，请在 ${service} 中添加聊天模型后再次检查。`;
    document.getElementById('localAIUse').disabled = !select.value;
  } catch (error) {
    if (localAICheckRequest === controller) status.textContent = error.name === 'AbortError'
      ? 'Connection timed out. Check that both local servers are running. / 连接超时，请检查两个本地服务器是否都已启动。'
      : error.message;
  } finally {
    clearTimeout(timeout);
    if (localAICheckRequest === controller) { localAICheckRequest = null; button.disabled = false; }
  }
}

function saveLocalAIConnection() {
  const model = document.getElementById('localAIModel').value;
  if (!localAIAvailableModels.includes(model) || document.getElementById('localAIUse').disabled) return;
  const config = { model, provider: document.getElementById('localAIProvider').value, auto: document.getElementById('localAIAuto').checked };
  try { localStorage.setItem(LOCAL_AI_KEY, JSON.stringify(config)); }
  catch { toast('Could not save the connection. / 无法保存连接设置。'); return; }
  applyLocalAIConfig(config);
  closeLocalAISettings();
  toast(`${localAIName(config.provider)} connected. / 已连接 ${localAIName(config.provider)}。`);
  if (localAISettingsReturn && localAISettingsReader === reader) openParagraphAnalysis(localAISettingsReturn);
  localAISettingsReturn = null;
}

function initLocalAISettings() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(LOCAL_AI_KEY)); } catch { /* Start without a connection. */ }
  applyLocalAIConfig(typeof saved?.model === 'string' && saved.model.trim()
    ? { model: saved.model, provider: saved.provider === 'ollama' ? 'ollama' : 'lmstudio', auto: saved.auto === true } : null);
  document.getElementById('readerLocalAIBtn').addEventListener('click', openLocalAISettings);
  document.getElementById('localAIClose').addEventListener('click', closeLocalAISettings);
  document.getElementById('localAIDialog').addEventListener('cancel', closeLocalAISettings);
  closeOnBackdropClick(document.getElementById('localAIDialog'), closeLocalAISettings);
  document.getElementById('localAICheck').addEventListener('click', checkLocalAIConnection);
  document.getElementById('localAIProvider').addEventListener('change', () => {
    localAICheckRequest?.abort(); localAICheckRequest = null; localAIAvailableModels = [];
    document.getElementById('localAIModel').innerHTML = '<option value="">Choose a model / 选择模型</option>';
    document.getElementById('localAIModel').value = '';
    document.getElementById('localAIUse').disabled = true;
    document.getElementById('localAICheck').disabled = false;
    document.getElementById('localAIStatus').textContent = 'Check the connection to list your models. / 检查连接以列出你的模型。';
  });
  document.getElementById('localAIModel').addEventListener('change', event => {
    document.getElementById('localAIUse').disabled = !localAIAvailableModels.includes(event.target.value) || !!localAICheckRequest;
  });
  document.getElementById('localAIUse').addEventListener('click', saveLocalAIConnection);
  document.getElementById('localAIDisconnect').addEventListener('click', () => {
    try { localStorage.removeItem(LOCAL_AI_KEY); } catch { toast('Could not save the change. / 无法保存更改。'); return; }
    applyLocalAIConfig(null); closeLocalAISettings(); localAISettingsReturn = null;
    toast('Local AI disconnected. / 已断开本地 AI 连接。');
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initLocalAISettings);
else initLocalAISettings();
