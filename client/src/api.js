const STORAGE_KEY = 'myanmar-reader-api-origin';

export function normalizeApiOrigin(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  let parsed;
  try { parsed = new URL(trimmed); }
  catch { throw new Error('Enter a valid server origin beginning with https://, or use http://localhost for local development.'); }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('The server origin must use http:// or https://.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Do not include a username or password in the server URL.');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || /[?#]/.test(trimmed)) {
    throw new Error('Enter the server origin only; do not include a path, query, or fragment.');
  }

  const hostname = parsed.hostname.toLowerCase();
  const unwrappedHostname = hostname.replace(/^\[|\]$/g, '');
  const isLoopback = hostname === 'localhost' || hostname.endsWith('.localhost') || unwrappedHostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (parsed.protocol === 'http:' && !isLoopback) {
    throw new Error('Use HTTPS for non-local servers to protect sign-in details.');
  }

  return parsed.origin;
}

export function apiOrigin() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const configured = import.meta.env.VITE_API_BASE_URL || '';
  return (saved || configured).replace(/\/$/, '');
}

export function setApiOrigin(value) {
  const origin = normalizeApiOrigin(value);
  if (origin) localStorage.setItem(STORAGE_KEY, origin);
  else localStorage.removeItem(STORAGE_KEY);
  return origin;
}

export async function checkApiHealth(value = '') {
  const origin = normalizeApiOrigin(value) || window.location.origin;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${origin}/api/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
    if (result?.ok !== true) throw new Error('The server responded but did not confirm a healthy app API.');
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('The connection check timed out. Check the address and try again.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function apiUrl(path) {
  return `${apiOrigin()}/api${path.startsWith('/') ? path : `/${path}`}`;
}

export async function api(path, options = {}) {
  const { body, ...rest } = options;
  const headers = new Headers(rest.headers || {});
  let payload = body;
  if (body !== undefined && !(body instanceof FormData) && typeof body !== 'string') {
    headers.set('Content-Type', 'application/json');
    payload = JSON.stringify(body);
  }
  const response = await fetch(apiUrl(path), { ...rest, headers, body: payload, credentials: 'include' });
  if (response.status === 204) return null;
  const type = response.headers.get('content-type') || '';
  const result = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(typeof result === 'object' ? result.error || `Request failed (${response.status}).` : result || `Request failed (${response.status}).`);
  return result;
}

export async function downloadText(path, filename) {
  const response = await fetch(apiUrl(path), { credentials: 'include' });
  if (!response.ok) throw new Error('The export could not be downloaded.');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  URL.revokeObjectURL(url);
}
