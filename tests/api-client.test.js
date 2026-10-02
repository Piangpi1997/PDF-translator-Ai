import test from 'node:test';
import assert from 'node:assert/strict';
import { checkApiHealth, normalizeApiOrigin } from '../client/src/api.js';

test('empty and valid server origins normalize to an origin only', () => {
  assert.equal(normalizeApiOrigin(''), '');
  assert.equal(normalizeApiOrigin('   '), '');
  assert.equal(normalizeApiOrigin('https://reader.example/'), 'https://reader.example');
  assert.equal(normalizeApiOrigin('https://reader.example:9443'), 'https://reader.example:9443');
  assert.equal(normalizeApiOrigin('http://localhost:8787/'), 'http://localhost:8787');
  assert.equal(normalizeApiOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(normalizeApiOrigin('http://[::1]:8787'), 'http://[::1]:8787');
});

test('server origins reject insecure remote hosts, paths, credentials, and URL suffixes', () => {
  assert.throws(() => normalizeApiOrigin('not a url'), /valid server origin/i);
  assert.throws(() => normalizeApiOrigin('ftp://reader.example'), /http:\/\/ or https/i);
  assert.throws(() => normalizeApiOrigin('http://reader.example'), /Use HTTPS/i);
  assert.throws(() => normalizeApiOrigin('https://reader.example/api'), /origin only/i);
  assert.throws(() => normalizeApiOrigin('https://user:pass@reader.example'), /username or password/i);
  assert.throws(() => normalizeApiOrigin('https://reader.example?mode=1'), /origin only/i);
  assert.throws(() => normalizeApiOrigin('https://reader.example#api'), /origin only/i);
});

test('health checks call the app API without sending cookies', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  let requestedUrl;
  let requestedOptions;
  globalThis.window = {
    location: { origin: 'https://web.example' },
    setTimeout,
    clearTimeout
  };
  globalThis.fetch = async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    return new Response(JSON.stringify({ ok: true, service: 'myanmar-ebook-reader' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    await checkApiHealth('https://api.example/');
    assert.equal(requestedUrl, 'https://api.example/api/health');
    assert.equal(requestedOptions.credentials, 'omit');
    assert.equal(requestedOptions.method, 'GET');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
