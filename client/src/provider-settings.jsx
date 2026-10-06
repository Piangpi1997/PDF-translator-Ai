import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Check, KeyRound, ShieldAlert, Trash2 } from 'lucide-react';
import { api } from './api.js';

const providerNames = {
  free_ai: 'Free AI / host InvokeLLM',
  kimi_k3: 'Kimi K3',
  custom_openai: 'Custom OpenAI-compatible API'
};
const defaults = {
  free_ai: { base_url: '', model_name: '' },
  kimi_k3: { base_url: 'https://api.moonshot.ai/v1', model_name: 'kimi-k3' },
  custom_openai: { base_url: '', model_name: '' }
};

export default function AIProviderSettings({ ctx }) {
  const [provider, setProvider] = useState('kimi_k3');
  const [settings, setSettings] = useState(null);
  const [baseUrl, setBaseUrl] = useState(defaults.kimi_k3.base_url);
  const [model, setModel] = useState(defaults.kimi_k3.model_name);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await api('/settings/ai-providers');
      setSettings(result);
      return result;
    } catch (e) { setError(e.message); return null; }
  }, []);
  useEffect(() => { load(); }, [load]);

  const providerSettings = settings?.providers?.[provider] || {};
  const currentDefaults = useMemo(() => defaults[provider] || defaults.kimi_k3, [provider]);
  useEffect(() => {
    setBaseUrl(providerSettings.base_url || currentDefaults.base_url);
    setModel(providerSettings.model_name || currentDefaults.model_name);
    setApiKey('');
    setNotice(null);
    setError('');
  }, [provider, providerSettings.base_url, providerSettings.model_name, currentDefaults]);

  const testConnection = async () => {
    setBusy('test'); setError(''); setNotice(null);
    try {
      const body = provider === 'free_ai' ? {} : { base_url: baseUrl, model_name: model, api_key: apiKey };
      const result = await api(`/settings/ai-providers/${provider}/test`, { method: 'POST', body });
      setNotice({ ok: true, text: result.detail + (result.model_available === false ? ` The selected model “${result.model_name}” was not listed by the endpoint.` : '') });
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const save = async event => {
    event.preventDefault(); setBusy('save'); setError(''); setNotice(null);
    try {
      await api(`/settings/ai-providers/${provider}`, { method: 'PUT', body: { base_url: baseUrl, model_name: model, api_key: apiKey } });
      setApiKey('');
      const fresh = await load();
      await ctx.refreshProviders();
      setNotice({ ok: true, text: `${providerNames[provider]} settings saved. The API key is encrypted on the server and will not be shown again.` });
      if (!fresh) setNotice({ ok: true, text: 'Settings saved. Refreshing provider status failed; use Refresh provider status to retry.' });
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const clear = async () => {
    if (!providerSettings.has_api_key) return;
    setBusy('clear'); setError(''); setNotice(null);
    try {
      await api(`/settings/ai-providers/${provider}`, { method: 'DELETE' });
      setApiKey('');
      await load();
      await ctx.refreshProviders();
      setNotice({ ok: true, text: `${providerNames[provider]} user-saved credentials were deleted.` });
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  return <section className="card section-card ai-provider-settings">
    <div className="section-title"><div><h2>AI Provider / API Settings</h2><p>Choose the backend translation service and manage user-specific API credentials.</p></div><KeyRound size={18} color="var(--green)"/></div>
    <div className="field"><span className="form-label">Provider</span><select className="select" value={provider} onChange={event => setProvider(event.target.value)} aria-label="AI translation provider">
      {Object.entries(providerNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
    </select></div>
    <div className="provider-current-status"><span className={`pill ${providerSettings.available ? 'green' : 'outline'}`}>{providerSettings.available ? 'Configured' : 'Not configured'}</span><span className="small-text">{providerSettings.detail || 'Checking provider configuration…'}</span></div>
    {provider === 'free_ai' ? <>
      <div className="notice info"><Activity size={15}/><span>Free AI uses the host-managed InvokeLLM-compatible backend. No personal API key is collected here; test performs a real, small backend translation request.</span></div>
      <div className="toolbar"><button className="button secondary" type="button" onClick={testConnection} disabled={!!busy}>{busy === 'test' ? 'Testing…' : 'Test Connection'}</button></div>
    </> : <form className="form-grid" onSubmit={save}>
      <label className="field"><span className="form-label">API Base URL</span><input className="input" type="text" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck="false" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder={provider === 'kimi_k3' ? defaults.kimi_k3.base_url : 'https://api.example.com/v1'} required/><span className="caption">Use a public HTTPS API endpoint. Localhost HTTP is allowed for development; private/internal hosts are blocked by the backend.</span></label>
      <label className="field"><span className="form-label">Model Name</span><input className="input" value={model} onChange={event => setModel(event.target.value)} placeholder={provider === 'kimi_k3' ? defaults.kimi_k3.model_name : 'your-model-id'} maxLength={200} required/></label>
      <label className="field"><span className="form-label">API Key</span><input className="input" type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={providerSettings.has_api_key ? 'Saved key is masked; leave blank to keep it' : 'Enter API key'} aria-label={`${providerNames[provider]} API key`}/><span className="caption">{providerSettings.has_api_key ? `Saved key: ${providerSettings.api_key_masked || '••••••••'}. The full key is never returned to the browser.` : 'The key is sent only to this backend over the authenticated session.'}</span></label>
      <div className="provider-security"><ShieldAlert size={15}/><span>Keys are encrypted server-side with AES-256-GCM using a server environment secret. They are never placed in the Vite bundle, URL, database plaintext, or logs. {settings?.credential_encryption_ready === false ? 'This server still needs PROVIDER_CREDENTIAL_ENCRYPTION_KEY before a key can be saved.' : ''}</span></div>
      <div className="toolbar provider-settings-actions"><button className="button secondary" type="button" onClick={testConnection} disabled={!!busy}>{busy === 'test' ? 'Testing…' : 'Test Connection'}</button><button className="button" type="submit" disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save'}</button><button className="button ghost" type="button" onClick={clear} disabled={!!busy || !providerSettings.has_api_key}><Trash2 size={14}/>Clear/Delete</button></div>
    </form>}
    {notice && <div className={`notice ${notice.ok ? 'info' : 'error'}`} role="status">{notice.ok && <Check size={15}/>}<span>{notice.text}</span></div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {settings?.credential_encryption_ready === false && <div className="notice"><ShieldAlert size={15}/><span>Secure per-user key storage is unavailable until the backend administrator configures the encryption secret. Keys will not be stored unencrypted.</span></div>}
  </section>;
}
