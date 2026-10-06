import { requestProviderJson } from './providerHttp.js';
import { normalizeProviderBaseUrl, PROVIDER_DEFAULTS, ProviderConfigError } from './providerSecrets.js';

const safeMessage = error => {
  const message = String(error?.message || error || 'Provider request failed.');
  return message.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]').replace(/(api[_-]?key|authorization)(["'\s:=]+)[^\s,;"']+/gi, '$1$2[redacted]').slice(0, 300);
};

export function providerAvailability(env = process.env) {
  return {
    free_ai: { available: Boolean(env.INVOKE_LLM_URL), label: 'Free AI Translation', detail: env.INVOKE_LLM_URL ? 'Uses the host-managed InvokeLLM service; no user API key is required.' : 'InvokeLLM is not connected in this deployment.' },
    kimi_k3: { available: Boolean(env.KIMI_API_KEY), label: 'Kimi K3', detail: env.KIMI_API_KEY ? 'Server-side Kimi K3 key configured.' : 'Kimi K3 unavailable / API key not configured.' },
    custom_openai: { available: false, label: 'Custom OpenAI-compatible API', detail: 'Configure a provider key in user settings.' },
    audio: { available: Boolean(env.TTS_API_URL), label: 'Audio generation', detail: env.TTS_API_URL ? 'Server-side speech service configured.' : 'Audio generation service is not configured.' }
  };
}

async function postHostJson(url, headers, body, timeoutMs = 60000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new ProviderConfigError(`Provider returned HTTP ${response.status}.`, 502, 'PROVIDER_HTTP_ERROR');
    const text = await response.text();
    try { return JSON.parse(text); } catch { throw new ProviderConfigError('Provider returned an invalid response.', 502, 'PROVIDER_RESPONSE_ERROR'); }
  } finally { clearTimeout(timeout); }
}

function validateTranslations(translations, pages, label) {
  if (!Array.isArray(translations) || translations.length !== pages.length || translations.some(text => typeof text !== 'string' || !text.trim())) {
    throw new ProviderConfigError(`${label} did not return a translation for every requested page.`, 502, 'PROVIDER_RESPONSE_ERROR');
  }
  return translations;
}

function translationInput(pages, glossary = []) {
  return {
    pages: pages.map(page => ({ page_number: page.page_number, text: page.original_text })),
    glossary: glossary.map(term => ({ source: term.source_term, target: term.target_term, note: term.note }))
  };
}

export async function invokeFreeLLM({ prompt, pages, glossary = [] }, env = process.env) {
  if (!env.INVOKE_LLM_URL) throw new ProviderConfigError('Free AI Translation unavailable: the host-managed InvokeLLM service is not configured.', 503, 'PROVIDER_UNAVAILABLE');
  const input = {
    task: 'Translate the provided book passages accurately into Myanmar (Burmese). Preserve paragraph boundaries, names, numbers, lists, quotes, and technical meaning. Return JSON with a translations array in the same order. Never invent missing or unreadable source text.',
    prompt,
    pages: translationInput(pages, glossary).pages.map(page => ({ page_number: page.page_number, text: page.text })),
    glossary: translationInput(pages, glossary).glossary
  };
  try {
    const response = await postHostJson(env.INVOKE_LLM_URL, env.INVOKE_LLM_TOKEN ? { authorization: `Bearer ${env.INVOKE_LLM_TOKEN}` } : {}, input);
    return validateTranslations(response.translations || response.data?.translations, pages, 'InvokeLLM');
  } catch (error) {
    const safe = new Error(safeMessage(error));
    safe.code = error.code || 'PROVIDER_ERROR';
    safe.status = error.status;
    throw safe;
  }
}

function getOpenAIConfig(provider, config, env) {
  const fallback = provider === 'kimi_k3' ? {
    baseUrl: env.KIMI_API_BASE || PROVIDER_DEFAULTS.kimi_k3.baseUrl,
    model: env.KIMI_MODEL || PROVIDER_DEFAULTS.kimi_k3.model,
    apiKey: env.KIMI_API_KEY || ''
  } : {};
  const value = { ...fallback, ...(config || {}) };
  if (!value.apiKey) throw new ProviderConfigError(provider === 'kimi_k3' ? 'Kimi K3 API key not configured. Open AI Provider / API Settings to add a key.' : 'Custom API key not configured. Open AI Provider / API Settings to add a key.', 503, 'PROVIDER_UNAVAILABLE');
  if (!value.model) throw new ProviderConfigError('Provider model name is not configured.', 503, 'PROVIDER_UNAVAILABLE');
  value.baseUrl = normalizeProviderBaseUrl(value.baseUrl, provider);
  return value;
}

async function openAICompatibleTranslate(provider, config, pages, glossary, env) {
  const settings = getOpenAIConfig(provider, config, env);
  const base = settings.baseUrl.replace(/\/+$/, '');
  const data = await requestProviderJson(`${base}/chat/completions`, {
    method: 'POST',
    timeoutMs: Math.max(100, Math.min(90000, Number(env.PROVIDER_REQUEST_TIMEOUT_MS) || 60000)),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.apiKey}`
    },
    body: {
      model: settings.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'Translate the source passages into Myanmar (Burmese). Preserve structure and meaning. Keep each page separate and return only valid JSON of the form {"translations":["..."]}. Do not invent text for unreadable pages.' },
        { role: 'user', content: JSON.stringify(translationInput(pages, glossary)) }
      ],
      response_format: { type: 'json_object' }
    }
  });
  const content = data.choices?.[0]?.message?.content;
  let parsed;
  try { parsed = typeof content === 'string' ? JSON.parse(content) : content; }
  catch { throw new ProviderConfigError('Provider response did not contain valid translation JSON.', 502, 'PROVIDER_RESPONSE_ERROR'); }
  return validateTranslations(parsed?.translations, pages, provider === 'kimi_k3' ? 'Kimi K3' : 'Custom provider');
}

export async function translateWithProvider(provider, { pages, glossary = [], providerConfig = null }, env = process.env) {
  if (!['free_ai', 'kimi_k3', 'custom_openai'].includes(provider)) throw new ProviderConfigError('Unsupported translation provider.');
  if (provider === 'free_ai') return invokeFreeLLM({ pages, glossary }, env);
  try { return await openAICompatibleTranslate(provider, providerConfig, pages, glossary, env); }
  catch (error) {
    const safe = new Error(safeMessage(error));
    safe.code = error.code || 'PROVIDER_ERROR';
    safe.status = error.status;
    throw safe;
  }
}

export async function testProviderConnection(provider, config = null, env = process.env) {
  if (provider === 'free_ai') {
    const probe = [{ page_number: 1, original_text: 'Connection test. Return a faithful Myanmar translation.' }];
    await invokeFreeLLM({ pages: probe }, env);
    return { connected: true, provider, detail: 'The configured host InvokeLLM service returned a valid translation response.' };
  }
  if (!['kimi_k3', 'custom_openai'].includes(provider)) throw new ProviderConfigError('Unsupported provider.');
  try {
    const settings = getOpenAIConfig(provider, config, env);
    const data = await requestProviderJson(`${settings.baseUrl.replace(/\/+$/, '')}/models`, {
      timeoutMs: Math.max(100, Math.min(90000, Number(env.PROVIDER_REQUEST_TIMEOUT_MS) || 15000)),
      headers: { authorization: `Bearer ${settings.apiKey}` }
    });
    const models = Array.isArray(data.data) ? data.data.map(row => row?.id).filter(value => typeof value === 'string') : [];
    return { connected: true, provider, model_name: settings.model, model_available: models.length ? models.includes(settings.model) : null, detail: 'The provider authenticated and returned a valid models response.' };
  } catch (error) {
    const safe = new Error(safeMessage(error));
    safe.code = error.code || 'PROVIDER_ERROR';
    safe.status = error.status || 502;
    throw safe;
  }
}

export async function generateSpeech(text, env = process.env) {
  if (!env.TTS_API_URL) {
    const error = new Error('Audio generation is unavailable because no speech service is configured.');
    error.code = 'AUDIO_UNAVAILABLE';
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch(env.TTS_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg, audio/wav', ...(env.TTS_API_TOKEN ? { authorization: `Bearer ${env.TTS_API_TOKEN}` } : {}) },
      // Deliberately omit language_code: a configured provider may not support Myanmar.
      body: JSON.stringify({ text }),
      signal: controller.signal,
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`Speech provider returned HTTP ${response.status}.`);
    const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!['audio/mpeg','audio/wav','audio/x-wav','audio/mp4','audio/ogg'].includes(contentType)) throw new Error('Speech provider did not return supported audio.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error('Speech provider returned an empty or oversized audio file.');
    return { buffer, mimeType: contentType };
  } catch (error) {
    const safe = new Error(safeMessage(error));
    safe.code = error.code || 'AUDIO_ERROR';
    throw safe;
  } finally { clearTimeout(timeout); }
}
