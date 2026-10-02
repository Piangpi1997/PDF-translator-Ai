import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { authMiddleware, requestOriginGuard } from './security.js';
import { createApiRouter } from './routes.js';
import { resumeStaleJobs, runQueuedJobs } from './jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const app = express();
const port = Number(process.env.PORT || 8787);
const allowedOrigins = String(process.env.APP_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
const loginAttempts = new Map();

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https: http:");
  const origin = req.get('origin');
  const allowed = origin && (allowedOrigins.includes(origin) || (process.env.NODE_ENV !== 'production' && (() => { try { return new URL(origin).hostname === req.hostname; } catch { return false; } })()));
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return allowed ? res.status(204).end() : res.status(403).end();
  next();
});
app.use(express.json({ limit: '2mb', type: ['application/json', 'application/*+json'] }));
app.use(requestOriginGuard);
app.use((req, res, next) => {
  if (!req.path.endsWith('/auth/login') || req.method !== 'POST') return next();
  const key = req.ip || 'unknown';
  const now = Date.now();
  let entry = loginAttempts.get(key);
  if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + 10 * 60 * 1000 };
  if (++entry.count > 20) {
    loginAttempts.set(key, entry);
    return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
  }
  loginAttempts.set(key, entry);
  if (loginAttempts.size > 5000) for (const [ip, value] of loginAttempts) if (value.resetAt <= now) loginAttempts.delete(ip);
  next();
});
app.use(authMiddleware(db));
app.use('/api', createApiRouter({ db }));

const dist = path.join(root, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
  app.get('*path', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}
app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  console.error('Unhandled request error:', String(error?.message || 'unknown').slice(0, 200));
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Myanmar Ebook Reader API listening on ${port}`);
  resumeStaleJobs(db);
  runQueuedJobs(db).catch(() => {});
});
const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
