import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { nowIso, makeId } from './db.js';

const cookieName = 'reader_session';
const sessionLifetimeMs = 14 * 24 * 60 * 60 * 1000;

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
    const error = new Error('Password must be between 10 and 200 characters.');
    error.status = 400;
    throw error;
  }
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password, encoded) {
  try {
    const [scheme, saltHex, hashHex] = encoded.split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export const digestToken = token => createHash('sha256').update(token).digest('hex');

export function createSession(db, userId, res, secure = process.env.NODE_ENV === 'production') {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString();
  const configured = String(process.env.COOKIE_SAMESITE || 'strict').toLowerCase();
  const sameSite = configured === 'none' ? 'None' : configured === 'lax' ? 'Lax' : 'Strict';
  const isSecure = secure || sameSite === 'None';
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run(digestToken(token), userId, expiresAt, nowIso());
  const attributes = [`${cookieName}=${token}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`, `Max-Age=${Math.floor(sessionLifetimeMs / 1000)}`];
  if (isSecure) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

export function clearSessionCookie(res, secure = process.env.NODE_ENV === 'production') {
  const configured = String(process.env.COOKIE_SAMESITE || 'strict').toLowerCase();
  const sameSite = configured === 'none' ? 'None' : configured === 'lax' ? 'Lax' : 'Strict';
  const isSecure = secure || sameSite === 'None';
  const attributes = [`${cookieName}=`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`, 'Max-Age=0'];
  if (isSecure) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

export function authMiddleware(db) {
  const lookup = db.prepare(`SELECT u.id,u.name,u.email,s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`);
  const remove = db.prepare('DELETE FROM sessions WHERE token_hash=?');
  return (req, _res, next) => {
    const token = readCookie(req, cookieName);
    if (!token) return next();
    const tokenHash = digestToken(token);
    const session = lookup.get(tokenHash);
    if (!session) return next();
    if (Date.parse(session.expires_at) <= Date.now()) {
      remove.run(tokenHash);
      return next();
    }
    req.user = { id: session.id, name: session.name, email: session.email };
    req.sessionTokenHash = tokenHash;
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

export function requestOriginGuard(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let parsed;
  try { parsed = new URL(origin); } catch { return res.status(403).json({ error: 'Request origin is not allowed.' }); }
  const configured = String(process.env.APP_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean).map(value => {
    try { return new URL(value).origin; } catch { return ''; }
  }).filter(Boolean);
  if (configured.length) {
    if (!configured.includes(parsed.origin)) return res.status(403).json({ error: 'Request origin is not allowed.' });
  } else if (process.env.NODE_ENV === 'production' && parsed.host !== req.get('host')) {
    return res.status(403).json({ error: 'Request origin is not allowed.' });
  } else if (process.env.NODE_ENV !== 'production' && parsed.hostname !== req.hostname) {
    return res.status(403).json({ error: 'Request origin is not allowed.' });
  }
  next();
}

export function deleteCurrentSession(db, req) {
  if (req.sessionTokenHash) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionTokenHash);
}

export const createUserId = makeId;
