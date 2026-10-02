const STORAGE_KEY = 'myanmar-reader-api-origin';

export function apiOrigin() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const configured = import.meta.env.VITE_API_BASE_URL || '';
  return (saved || configured).replace(/\/$/, '');
}

export function setApiOrigin(value) {
  const trimmed = String(value || '').trim().replace(/\/$/, '');
  if (trimmed && !/^https?:\/\//i.test(trimmed)) throw new Error('Backend URL must begin with http:// or https://.');
  if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed);
  else localStorage.removeItem(STORAGE_KEY);
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
