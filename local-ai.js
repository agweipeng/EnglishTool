/* Local model transport through the optional same-origin local server. */
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
  };
  function fail(message) { const error = new Error(message); error.name = 'LocalAIError'; return error; }
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
  async function models({ signal, provider = 'lmstudio', fetchImpl = root.fetch.bind(root) } = {}) {
    const body = await fetchJSON(provider === 'ollama' ? '/local-ai/models?provider=ollama' : '/local-ai/models', { signal }, fetchImpl);
    if (!Array.isArray(body?.data)) throw fail(messages.invalid);
    return [...new Set(body.data.filter(model => typeof model?.id === 'string' && model.id.trim()).map(model => model.id))];
  }
  function request(model, { provider = 'lmstudio', fetchImpl = root.fetch.bind(root) } = {}) {
    return async ({ prompt, signal }) => {
      const body = await fetchJSON('/local-ai/chat', { method: 'POST', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, provider,
          messages: [{ role: 'user', content: prompt }], stream: false, temperature: 0.2, max_tokens: 8192,
          response_format: { type: 'json_schema', json_schema: { name: 'reading_analysis', strict: true, schema } },
        }) }, fetchImpl);
      const choice = body?.choices?.[0];
      if (choice?.finish_reason === 'length') throw fail(messages.invalid);
      const content = choice?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw fail(messages.invalid);
      return content;
    };
  }
  const api = { models, request, schema };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LocalAI = api;
})(typeof window !== 'undefined' ? window : globalThis);
