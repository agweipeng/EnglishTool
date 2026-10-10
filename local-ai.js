/* Local model transport: through the optional same-origin local server, or — on the
   hosted site, where that server doesn't exist — straight to Ollama on this computer. */
(function (root) {
  'use strict';
  const core = typeof module !== 'undefined' && module.exports ? require('./paragraph-core.js') : root.ParagraphCore;
  const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const string = { type: 'string' };
  const bilingual = object({ en: string, cn: string });
  const list = (items, maxItems, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
  const item = object({ text: string, meaning: bilingual, example: string });
  const schema = object({ simplified: bilingual, mainPoint: bilingual, words: list(item, core.MAX_WORDS), phrases: list(item, core.MAX_PHRASES),
    sentences: list(object({ original: string, core: bilingual, parts: list(object({ text: string, explanation: bilingual }), core.MAX_PARTS) }), core.MAX_SENTENCES, 1),
    speaking: bilingual });
  const messages = {
    unavailable: 'Start your selected local AI server, then try again. / 请启动所选本地 AI 服务后重试。',
    authentication: 'LM Studio requires a token. Set LM_STUDIO_API_TOKEN when starting the EnglishTool server. / LM Studio 需要令牌，请在启动 EnglishTool 服务器时设置 LM_STUDIO_API_TOKEN。',
    timeout: 'The local model took too long. Try a shorter passage. / 本地模型响应超时，请尝试较短的段落。',
    upstream: 'The local AI server rejected the request. Check that your selected model is available and supports structured output. / 本地 AI 服务拒绝了请求，请检查所选模型是否可用并支持结构化输出。',
    missing: 'Start EnglishTool with scripts/serve-local-ai.py to connect local AI. / 请使用 scripts/serve-local-ai.py 启动 EnglishTool，以连接本地 AI。',
    invalid: 'The local model returned an incomplete reply. Try again. / 本地模型返回了不完整的回复，请重试。',
    model: 'This local chat model is no longer installed. Check the connection and choose an available model. / 此本地聊天模型已不可用，请检查连接并选择可用模型。',
    direct: 'Could not reach Ollama on this computer. Check that Ollama is running, that this site is allowed (OLLAMA_ORIGINS, then restart Ollama), and that the browser may access your local network. / 无法连接本机的 Ollama。请确认 Ollama 正在运行、已允许本网站（设置 OLLAMA_ORIGINS 后重启 Ollama），并允许浏览器访问本地网络。',
  };
  function fail(message) { const error = new Error(message); error.name = 'LocalAIError'; return error; }
  const defaultFetch = () => root.fetch.bind(root);

  // ---------- Through scripts/serve-local-ai.py ----------

  async function fetchJSON(path, options, fetchImpl) {
    let response;
    try { response = await fetchImpl(path, options); }
    catch (error) { if (error.name === 'AbortError') throw error; throw fail(messages.missing); }
    let body;
    try { body = await response.json(); }
    catch { throw fail(messages.missing); }
    if (!response.ok) throw fail(messages[body?.error?.code] || messages.upstream);
    return body;
  }
  async function proxyModels(provider, signal, fetchImpl) {
    const body = await fetchJSON(provider === 'ollama' ? '/local-ai/models?provider=ollama' : '/local-ai/models', { signal }, fetchImpl);
    if (!Array.isArray(body?.data)) throw fail(messages.invalid);
    return body.data.filter(model => typeof model?.id === 'string' && model.id.trim()).map(model => model.id);
  }
  async function proxyChat(model, provider, prompt, signal, fetchImpl, format, schemaName) {
    const body = await fetchJSON('/local-ai/chat', { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, provider,
        messages: [{ role: 'user', content: prompt }], stream: false, temperature: 0.2, max_tokens: 8192,
        response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: format } },
      }) }, fetchImpl);
    const choice = body?.choices?.[0];
    if (choice?.finish_reason === 'length') throw fail(messages.invalid);
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw fail(messages.invalid);
    return content;
  }

  // ---------- Straight to Ollama (hosted site) ----------
  // Needs a one-time OLLAMA_ORIGINS setting so Ollama accepts this site.

  const OLLAMA_URL = 'http://127.0.0.1:11434';
  const CHAT_DEADLINE_MS = 300000;
  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

  // Pages served by serve-local-ai.py (loopback) keep using it
  function usesDirectOllama(location = root.location) {
    return !!location && /^https?:$/.test(location.protocol) && !LOOPBACK_HOSTS.has(location.hostname);
  }

  async function ollamaFetch(path, options, fetchImpl) {
    let response;
    try { response = await fetchImpl(OLLAMA_URL + path, options); }
    catch (error) { if (error.name === 'AbortError') throw error; throw fail(messages.direct); }
    if (response.status === 403) throw fail(messages.direct);
    if (!response.ok) throw fail(messages.upstream);
    return response;
  }

  // Same rule as the local server: installed local chat models only, never cloud ones
  async function ollamaModels(signal, fetchImpl) {
    const response = await ollamaFetch('/api/tags', { signal }, fetchImpl);
    let body;
    try { body = await response.json(); } catch { throw fail(messages.invalid); }
    if (!Array.isArray(body?.models)) throw fail(messages.invalid);
    return body.models.filter(model => typeof model?.name === 'string' && model.name.trim()
      && !model.remote_host && !model.remote_model && !/[-:]cloud$/.test(model.name)
      && (!model.capabilities?.length || model.capabilities.includes('completion'))).map(model => model.name);
  }

  async function ollamaAnswer(response) {
    let body;
    try { body = await response.json(); } catch { throw fail(messages.invalid); }
    const content = body?.message?.content;
    if (body?.done !== true || body.done_reason === 'length' || typeof content !== 'string' || !content.trim()) {
      throw fail(messages.invalid);
    }
    return content;
  }

  // Asks for one complete answer rather than a stream: if a tab stopped reading a
  // stream (e.g. a frozen background tab), Ollama would stall for every later request.
  async function ollamaChat(model, prompt, signal, fetchImpl, format) {
    if (!(await ollamaModels(signal, fetchImpl)).includes(model)) throw fail(messages.model);
    // Aborting the fetch closes the connection, which makes Ollama stop generating
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort);
    const deadline = setTimeout(() => controller.abort(), CHAT_DEADLINE_MS);
    try {
      const response = await ollamaFetch('/api/chat', { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model,
          messages: [{ role: 'user', content: prompt }], stream: false, think: false, format,
          options: { temperature: 0.2, num_ctx: 16384, num_predict: 8192 } }) }, fetchImpl);
      return await ollamaAnswer(response);
    } catch (error) {
      if (error.name === 'AbortError' && !signal?.aborted) throw fail(messages.timeout);
      throw error;
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  // ---------- Public API ----------

  async function models({ signal, provider = 'lmstudio', direct = usesDirectOllama(), fetchImpl = defaultFetch() } = {}) {
    const ids = direct && provider === 'ollama' ? await ollamaModels(signal, fetchImpl) : await proxyModels(provider, signal, fetchImpl);
    return [...new Set(ids)];
  }
  // Passage analysis uses the default schema; other features (the Quiz) pass their own JSON shape
  function request(model, { provider = 'lmstudio', direct = usesDirectOllama(), fetchImpl = defaultFetch() } = {}) {
    return ({ prompt, signal, schema: format = schema, schemaName = 'reading_analysis' }) => (direct && provider === 'ollama'
      ? ollamaChat(model, prompt, signal, fetchImpl, format)
      : proxyChat(model, provider, prompt, signal, fetchImpl, format, schemaName));
  }
  const api = { models, request, schema, usesDirectOllama };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LocalAI = api;
})(typeof window !== 'undefined' ? window : globalThis);
