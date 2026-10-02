import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { isIP } from 'node:net';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15000;

function ipv4Number(address) {
  return address.split('.').reduce((value, part) => (value << 8n) + BigInt(Number(part)), 0n);
}
function inV4(address, base, bits) {
  const shift = BigInt(32 - bits);
  return (ipv4Number(address) >> shift) === (ipv4Number(base) >> shift);
}
function ipv6Bytes(address) {
  let source = address.toLowerCase().split('%')[0];
  if (source.includes('.')) {
    const index = source.lastIndexOf(':');
    const ipv4 = source.slice(index + 1).split('.').map(Number);
    if (ipv4.length !== 4 || ipv4.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
    source = `${source.slice(0,index)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return Buffer.from(groups.flatMap(part => { const n = parseInt(part,16); return [n >> 8, n & 255]; }));
}

export function isPublicIp(address) {
  const version = isIP(address);
  if (version === 4) {
    const blocked = [
      ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
      ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
      ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]
    ];
    return !blocked.some(([base,bits]) => inV4(address, base, bits));
  }
  if (version === 6) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return false;
    const allZero = bytes.every(byte => byte === 0);
    const loopback = bytes.slice(0,15).every(byte => byte === 0) && bytes[15] === 1;
    const isMapped = bytes.slice(0,10).every(byte => byte === 0) && bytes[10] === 255 && bytes[11] === 255;
    if (isMapped) return isPublicIp(Array.from(bytes.slice(12)).join('.'));
    const first = bytes[0];
    const documentation = bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
    return !(allZero || loopback || (first & 0xfe) === 0xfc || (first === 0xfe && (bytes[1] & 0xc0) === 0x80) || first === 0xff || documentation || (first === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00));
  }
  return false;
}

export function validateOnlinePdfUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid public PDF URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only public HTTP or HTTPS URLs are allowed.');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal' || host.endsWith('.internal')) {
    throw new Error('Private or internal hosts are not allowed.');
  }
  const ipVersion = net.isIP(host);
  if (ipVersion && !isPublicIp(host)) throw new Error('Private or reserved IP addresses are not allowed.');
  return url;
}

async function resolvePublic(host) {
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicIp(record.address))) throw new Error('The host resolves to a private or reserved address.');
  return records;
}

function requestOnce(url, addresses, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(result);
    };
    let index = 0;
    const options = {
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { accept: 'application/pdf, application/octet-stream;q=0.9', 'user-agent': 'MyanmarEbookReader/1.0' },
      lookup: (_hostname, _options, callback) => {
        const item = addresses[index++ % addresses.length];
        callback(null, item.address, item.family);
      },
      servername: net.isIP(url.hostname) ? undefined : url.hostname,
      timeout: timeoutMs
    };
    const request = transport.request(options, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        return done(null, { status, location: response.headers.location, headers: response.headers });
      }
      if (status < 200 || status >= 300) {
        response.resume();
        return done(new Error(`The PDF server returned HTTP ${status}.`));
      }
      const type = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
      if (type && !['application/pdf','application/octet-stream','binary/octet-stream'].includes(type)) {
        response.resume();
        return done(new Error('The URL did not return a PDF file.'));
      }
      const sizeHeader = Number(response.headers['content-length'] || 0);
      if (sizeHeader > maxBytes) {
        response.resume();
        return done(new Error('The PDF exceeds the 25 MB import limit.'));
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error('The PDF exceeds the 25 MB import limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => done(null, { status, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', error => done(error));
    });
    request.on('timeout', () => request.destroy(new Error('The PDF download timed out.')));
    request.on('error', error => done(error));
    request.end();
  });
}

export async function fetchPublicPdf(input, options = {}) {
  const maxBytes = Math.min(Number(options.maxBytes) || MAX_BYTES, MAX_BYTES);
  const timeoutMs = Math.min(Number(options.timeoutMs) || TIMEOUT_MS, 60000);
  const resolveHost = options.resolveHost || resolvePublic;
  const request = options.request || requestOnce;
  let url = validateOnlinePdfUrl(input);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const addresses = await resolveHost(url.hostname.replace(/^\[|\]$/g, ''));
    if (!addresses.length || addresses.some(record => !isPublicIp(record.address))) throw new Error('The host resolves to a private or reserved address.');
    const response = await request(url, addresses, maxBytes, timeoutMs);
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (redirect === MAX_REDIRECTS) throw new Error('The PDF URL redirected too many times.');
      url = validateOnlinePdfUrl(new URL(response.location, url).toString());
      continue;
    }
    const body = response.body;
    if (!Buffer.isBuffer(body) || body.length === 0 || body.length > maxBytes || !body.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      throw new Error('The URL did not contain a valid PDF file.');
    }
    return { buffer: body, finalUrl: url.toString(), headers: response.headers || {} };
  }
  throw new Error('The PDF URL could not be safely resolved.');
}
