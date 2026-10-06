import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import net from 'node:net';
import { isPublicIp } from './onlinePdf.js';
import { nowIso } from './db.js';

export const USER_PROVIDERS = ['kimi_k3', 'custom_openai'];
export const PROVIDER_DEFAULTS = {
  kimi_k3: { baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3' },
  custom_openai: { baseUrl: '', model: '' }
};
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export class ProviderConfigError extends Error {
  constructor(message, status = 400, code = 'PROVIDER_CONFIG_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function normalizeProviderBaseUrl(value, provider) {
  if (!USER_PROVIDERS.includes(provider)) throw new ProviderConfigError('Choose Kimi K3 or Custom OpenAI-compatible.');
  const input = String(value || PROVIDER_DEFAULTS[provider].baseUrl).trim();
  if (!input) throw new ProviderConfigError('Enter the provider API base URL.');
  let url;
  try { url = new URL(input); } catch { throw new ProviderConfigError('Enter a valid provider API base URL.'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new ProviderConfigError('Provider API URLs must use HTTP or HTTPS.');
  if (url.username || url.password || url.search || url.hash) throw new ProviderConfigError('Do not include credentials, query parameters, or a fragment in the provider base URL.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal' || host.endsWith('.localhost')) {
    throw new ProviderConfigError('Private or internal provider hosts are not allowed.');
  }
  const loopback = LOOPBACK_HOSTS.has(host);
  if (url.protocol === 'http:' && !loopback) throw new ProviderConfigError('Use HTTPS for non-local provider APIs.');
  const ipVersion = net.isIP(host);
  if (ipVersion && !loopback && !isPublicIp(host)) throw new ProviderConfigError('Private or reserved provider IP addresses are not allowed.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function encryptionKey(env = process.env) {
  const value = String(env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY || '').trim();
  let key;
  if (/^[0-9a-f]{64}$/i.test(value)) key = Buffer.from(value, 'hex');
  else {
    try { key = Buffer.from(value, 'base64'); } catch { key = Buffer.alloc(0); }
  }
  if (key.length !== 32) throw new ProviderConfigError('Per-user API-key encryption is not configured on this server. Set PROVIDER_CREDENTIAL_ENCRYPTION_KEY to a private 32-byte key.', 503, 'CREDENTIAL_ENCRYPTION_NOT_CONFIGURED');
  return key;
}

function encryptApiKey(apiKey, ownerId, provider, env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(env), iv);
  cipher.setAAD(Buffer.from(`${ownerId}:${provider}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decryptApiKey(row, env) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(env), Buffer.from(row.api_key_iv, 'base64'));
    decipher.setAAD(Buffer.from(`${row.owner_id}:${row.provider}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(row.api_key_tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(row.api_key_ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof ProviderConfigError) throw error;
    throw new ProviderConfigError('The saved API key cannot be decrypted. Restore the matching server encryption key or replace this provider key.', 503, 'CREDENTIAL_DECRYPTION_FAILED');
  }
}

export function getSavedProviderConfig(db, ownerId, provider) {
  return db.prepare('SELECT * FROM ai_provider_configs WHERE owner_id=? AND provider=?').get(ownerId, provider) || null;
}

export function getProviderSecret(db, ownerId, provider, env = process.env) {
  if (provider === 'free_ai') return null;
  const row = getSavedProviderConfig(db, ownerId, provider);
  if (row) return {
    provider,
    baseUrl: row.base_url,
    model: row.model_name,
    apiKey: decryptApiKey(row, env),
    source: 'user'
  };
  if (provider === 'kimi_k3' && env.KIMI_API_KEY) return {
    provider,
    baseUrl: env.KIMI_API_BASE || PROVIDER_DEFAULTS.kimi_k3.baseUrl,
    model: env.KIMI_MODEL || PROVIDER_DEFAULTS.kimi_k3.model,
    apiKey: env.KIMI_API_KEY,
    source: 'server'
  };
  return null;
}

export function saveProviderSecret(db, { ownerId, provider, baseUrl, model, apiKey }, env = process.env) {
  if (!USER_PROVIDERS.includes(provider)) throw new ProviderConfigError('Only Kimi K3 and Custom OpenAI-compatible credentials are stored per user.');
  const normalizedBase = normalizeProviderBaseUrl(baseUrl, provider);
  const normalizedModel = String(model || PROVIDER_DEFAULTS[provider].model).trim().slice(0, 200);
  if (!normalizedModel) throw new ProviderConfigError('Enter a model name.');
  const secret = String(apiKey || '').trim();
  if (secret.length > 4096) throw new ProviderConfigError('The API key is too long.');
  const existing = getSavedProviderConfig(db, ownerId, provider);
  let encrypted;
  if (secret) encrypted = encryptApiKey(secret, ownerId, provider, env);
  else if (existing) encrypted = { ciphertext: existing.api_key_ciphertext, iv: existing.api_key_iv, tag: existing.api_key_tag };
  else if (provider === 'kimi_k3' && env.KIMI_API_KEY) {
    throw new ProviderConfigError('A server Kimi key is configured. To save separate per-user Kimi settings, enter that user’s API key.');
  } else throw new ProviderConfigError('Enter an API key before saving this provider.');
  const now = nowIso();
  db.prepare(`INSERT INTO ai_provider_configs(id,owner_id,provider,base_url,model_name,api_key_ciphertext,api_key_iv,api_key_tag,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,provider) DO UPDATE SET base_url=excluded.base_url,model_name=excluded.model_name,api_key_ciphertext=excluded.api_key_ciphertext,api_key_iv=excluded.api_key_iv,api_key_tag=excluded.api_key_tag,updated_at=excluded.updated_at`)
    .run(existing?.id || randomBytes(16).toString('hex'), ownerId, provider, normalizedBase, normalizedModel, encrypted.ciphertext, encrypted.iv, encrypted.tag, now);
  return { provider, base_url: normalizedBase, model_name: normalizedModel, has_api_key: true, api_key_masked: '••••••••', updated_at: now };
}

export function providerSettingsForUser(db, ownerId, env = process.env) {
  const freeAvailable = Boolean(env.INVOKE_LLM_URL);
  const kimi = getSavedProviderConfig(db, ownerId, 'kimi_k3');
  const custom = getSavedProviderConfig(db, ownerId, 'custom_openai');
  return {
    free_ai: {
      label: 'Free AI / host InvokeLLM',
      available: freeAvailable,
      detail: freeAvailable ? 'Uses the host-managed InvokeLLM-compatible backend. No user key is required.' : 'The host-managed InvokeLLM service is not connected in this deployment.',
      config_source: 'host'
    },
    kimi_k3: {
      label: 'Kimi K3',
      available: Boolean(kimi || env.KIMI_API_KEY),
      detail: kimi ? 'A per-user encrypted Kimi API key is saved.' : env.KIMI_API_KEY ? 'A server-managed Kimi API key is configured.' : 'Add a Kimi API key in AI Provider / API Settings.',
      base_url: kimi?.base_url || env.KIMI_API_BASE || PROVIDER_DEFAULTS.kimi_k3.baseUrl,
      model_name: kimi?.model_name || env.KIMI_MODEL || PROVIDER_DEFAULTS.kimi_k3.model,
      has_api_key: Boolean(kimi || env.KIMI_API_KEY),
      api_key_masked: kimi || env.KIMI_API_KEY ? '••••••••' : '',
      config_source: kimi ? 'user-encrypted' : env.KIMI_API_KEY ? 'server' : 'none'
    },
    custom_openai: {
      label: 'Custom OpenAI-compatible API',
      available: Boolean(custom),
      detail: custom ? 'A per-user encrypted API key and model are saved.' : 'Configure a base URL, model name, and API key in AI Provider / API Settings.',
      base_url: custom?.base_url || '',
      model_name: custom?.model_name || '',
      has_api_key: Boolean(custom),
      api_key_masked: custom ? '••••••••' : '',
      config_source: custom ? 'user-encrypted' : 'none'
    }
  };
}

export function credentialEncryptionReady(env = process.env) {
  try { encryptionKey(env); return true; } catch { return false; }
}
