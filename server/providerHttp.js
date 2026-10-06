import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { isPublicIp } from './onlinePdf.js';
import { ProviderConfigError } from './providerSecrets.js';

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const stripBrackets = host => String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
const loopbackHost = host => ['localhost', '127.0.0.1', '::1'].includes(stripBrackets(host));

async function resolveSafe(host) {
  const normalized = stripBrackets(host);
  if (loopbackHost(normalized)) {
    if (net.isIP(normalized)) return [{ address: normalized, family: net.isIP(normalized) }];
    const records = await dns.lookup(normalized, { all: true, verbatim: true });
    if (!records.length || records.some(record => !['127.0.0.1', '::1'].includes(stripBrackets(record.address)))) {
      throw new ProviderConfigError('The local provider host did not resolve only to loopback addresses.', 400, 'PROVIDER_URL_BLOCKED');
    }
    return records;
  }
  if (net.isIP(normalized)) {
    if (!isPublicIp(normalized)) throw new ProviderConfigError('Private or reserved provider IP addresses are blocked.', 400, 'PROVIDER_URL_BLOCKED');
    return [{ address: normalized, family: net.isIP(normalized) }];
  }
  let records;
  try { records = await dns.lookup(normalized, { all: true, verbatim: true }); }
  catch { throw new ProviderConfigError('The provider host could not be resolved.', 502, 'PROVIDER_DNS_ERROR'); }
  if (!records.length || records.some(record => !isPublicIp(record.address))) {
    throw new ProviderConfigError('The provider host resolves to a private or reserved address.', 400, 'PROVIDER_URL_BLOCKED');
  }
  return records;
}

export async function requestProviderJson(input, { method = 'GET', headers = {}, body, timeoutMs = 60000 } = {}) {
  const url = input instanceof URL ? input : new URL(input);
  if (!['https:', 'http:'].includes(url.protocol)) throw new ProviderConfigError('Provider requests must use HTTP or HTTPS.');
  if (url.protocol === 'http:' && !loopbackHost(url.hostname)) throw new ProviderConfigError('Use HTTPS for non-local provider APIs.');
  const addresses = await resolveSafe(url.hostname);
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const host = stripBrackets(url.hostname);
    let settled = false;
    const done = (error, value) => { if (settled) return; settled = true; if (error) reject(error); else resolve(value); };
    const options = {
      protocol: url.protocol,
      hostname: host,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers: { accept: 'application/json', ...headers },
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) return callback(null, addresses.map(item => ({ address: item.address, family: item.family })));
        const item = addresses[0];
        callback(null, item.address, item.family);
      },
      servername: net.isIP(host) ? undefined : host
    };
    const request = transport.request(options, response => {
      const status = response.statusCode || 0;
      if (status < 200 || status >= 300) {
        response.resume();
        return done(new ProviderConfigError(`Provider returned HTTP ${status}.`, 502, 'PROVIDER_HTTP_ERROR'));
      }
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      if (contentType && !contentType.includes('application/json')) {
        response.resume();
        return done(new ProviderConfigError('Provider returned a non-JSON response.', 502, 'PROVIDER_RESPONSE_ERROR'));
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) request.destroy(new Error('Provider response exceeded the size limit.'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try { done(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { done(new ProviderConfigError('Provider returned invalid JSON.', 502, 'PROVIDER_RESPONSE_ERROR')); }
      });
      response.on('error', error => done(error));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new ProviderConfigError('Provider request timed out.', 504, 'PROVIDER_TIMEOUT')));
    request.on('error', error => {
      if (error instanceof ProviderConfigError) done(error);
      else done(new ProviderConfigError(error.code === 'ECONNREFUSED' ? 'The provider connection was refused.' : 'The provider request failed.', 502, error.code || 'PROVIDER_REQUEST_ERROR'));
    });
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}
