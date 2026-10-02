const safeMessage = error => {
  const message = String(error?.message || error || 'Provider request failed.');
  return message.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]').replace(/(api[_-]?key|authorization)(["'\s:=]+)[^\s,;"']+/gi, '$1$2[redacted]').slice(0, 300);
};

export function providerAvailability(env = process.env) {
  return {
    free_ai: { available: Boolean(env.INVOKE_LLM_URL), label: 'Free AI Translation', detail: env.INVOKE_LLM_URL ? 'Uses the host-managed InvokeLLM service; no user API key is required.' : 'InvokeLLM is not connected in this deployment.' },
    kimi_k3: { available: Boolean(env.KIMI_API_KEY), label: 'Kimi K3', detail: env.KIMI_API_KEY ? 'Server-side Kimi K3 key configured.' : 'Kimi K3 unavailable / API key not configured.' },
    audio: { available: Boolean(env.TTS_API_URL), label: 'Audio generation', detail: env.TTS_API_URL ? 'Server-side speech service configured.' : 'Audio generation service is not configured.' }
  };
}

async function postJson(url, headers, body, timeoutMs = 60000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    const text = await response.text();
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { throw new Error('Provider returned an invalid response.'); }
  } finally { clearTimeout(timeout); }
}

export async function invokeFreeLLM({ prompt, pages, glossary = [] }, env = process.env) {
  if (!env.INVOKE_LLM_URL) {
    const error = new Error('Free AI Translation unavailable: the host-managed InvokeLLM service is not configured.');
    error.code = 'PROVIDER_UNAVAILABLE';
    throw error;
  }
  const input = {
    task: 'Translate the provided book passages accurately into Myanmar (Burmese). Preserve paragraph boundaries, names, numbers, lists, quotes, and technical meaning. Return JSON with a translations array in the same order. Never invent missing or unreadable source text.',
    prompt,
    pages: pages.map(page => ({ page_number: page.page_number, text: page.original_text })),
    glossary: glossary.map(term => ({ source: term.source_term, target: term.target_term, note: term.note }))
  };
  try {
    const response = await postJson(env.INVOKE_LLM_URL, env.INVOKE_LLM_TOKEN ? { authorization: `Bearer ${env.INVOKE_LLM_TOKEN}` } : {}, input);
    const translations = response.translations || response.data?.translations;
    if (!Array.isArray(translations) || translations.length !== pages.length || translations.some(text => typeof text !== 'string' || !text.trim())) {
      throw new Error('InvokeLLM response did not include a translation for every requested page.');
    }
    return translations;
  } catch (error) {
    const safe = new Error(safeMessage(error));
    safe.code = error.code || 'PROVIDER_ERROR';
    throw safe;
  }
}

export async function translateWithProvider(provider, { pages, glossary = [] }, env = process.env) {
  if (!['free_ai', 'kimi_k3'].includes(provider)) {
    const error = new Error('Unsupported translation provider.');
    error.code = 'INVALID_PROVIDER';
    throw error;
  }
  if (provider === 'free_ai') return invokeFreeLLM({ pages, glossary }, env);
  if (!env.KIMI_API_KEY) {
    const error = new Error('Kimi K3 unavailable / API key not configured.');
    error.code = 'PROVIDER_UNAVAILABLE';
    throw error;
  }
  const base = (env.KIMI_API_BASE || 'https://api.moonshot.ai/v1').replace(/\/$/, '');
  try {
    const data = await postJson(`${base}/chat/completions`, { authorization: `Bearer ${env.KIMI_API_KEY}` }, {
      model: env.KIMI_MODEL || 'kimi-k3',
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'Translate the source passages into Myanmar (Burmese). Preserve structure and meaning. Keep each page separate and return only valid JSON of the form {"translations":["..."]}. Do not invent text for unreadable pages.' },
        { role: 'user', content: JSON.stringify({ pages: pages.map(page => ({ page_number: page.page_number, text: page.original_text })), glossary: glossary.map(term => ({ source: term.source_term, target: term.target_term, note: term.note })) }) }
      ],
      response_format: { type: 'json_object' }
    });
    const content = data.choices?.[0]?.message?.content;
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    const translations = parsed?.translations;
    if (!Array.isArray(translations) || translations.length !== pages.length || translations.some(text => typeof text !== 'string' || !text.trim())) {
      throw new Error('Kimi K3 did not return a translation for every requested page.');
    }
    return translations;
  } catch (error) {
    const safe = new Error(safeMessage(error));
    safe.code = error.code || 'PROVIDER_ERROR';
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
