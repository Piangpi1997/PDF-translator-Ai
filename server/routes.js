import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { db as defaultDb, dataPath, nowIso } from './db.js';
import { hashPassword, verifyPassword, createSession, clearSessionCookie, deleteCurrentSession, requireAuth } from './security.js';
import { parseDocument, parsePdf } from './importers.js';
import { fetchPublicPdf, validateOnlinePdfUrl } from './onlinePdf.js';
import { generateSpeech, providerAvailability } from './providers.js';
import { bookTranslationState, createTranslationJob, emitNotification, retryJob, runQueuedJobs, translationFingerprint } from './jobs.js';

const supportedCategories = ['Fiction','Non-Fiction','Religion','Education','Children','Other'];
const supportedProviders = ['free_ai','kimi_k3'];
const validId = value => /^[0-9a-f-]{36}$/i.test(String(value || ''));
const safeError = error => String(error?.message || 'Request failed.').replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]').replace(/(api[_-]?key|authorization)(["'\s:=]+)[^\s,;"']+/gi, '$1$2[redacted]').slice(0, 300);
const contentHash = buffer => createHash('sha256').update(buffer).digest('hex');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

function requireBook(db, ownerId, bookId) {
  return db.prepare('SELECT * FROM books WHERE id=? AND owner_id=?').get(bookId, ownerId);
}
function requirePage(db, ownerId, bookId, pageNumber) {
  return db.prepare('SELECT * FROM pages WHERE book_id=? AND owner_id=? AND page_number=?').get(bookId, ownerId, Number(pageNumber));
}
function publicBook(db, row) {
  const state = bookTranslationState(db, row.id, row.owner_id);
  const progress = db.prepare('SELECT page_number,updated_at FROM reading_progress WHERE book_id=? AND owner_id=?').get(row.id, row.owner_id);
  const latestJob = db.prepare('SELECT id,status,provider,total_chunks,completed_chunks,failed_chunks,updated_at FROM document_jobs WHERE book_id=? AND owner_id=? ORDER BY created_at DESC LIMIT 1').get(row.id, row.owner_id);
  const audioCount = db.prepare("SELECT COUNT(*) AS count FROM audio_files WHERE book_id=? AND owner_id=? AND status IN ('ready','outdated','generating')").get(row.id, row.owner_id).count;
  return { id: row.id, title: row.title, author: row.author, category: row.category, source_type: row.source_type, source_url: row.source_url, file_name: row.file_name, mime_type: row.mime_type, translation_provider: row.translation_provider, translation_status: state.status, total_pages: row.total_pages, is_favorite: Boolean(row.is_favorite), added_at: row.added_at, last_opened_at: row.last_opened_at || progress?.updated_at || null, finished_at: row.finished_at, translation: state, reading_progress: progress?.page_number || 0, latest_job: latestJob || null, has_audio: audioCount > 0 };
}

function insertParsedBook(db, { ownerId, parsed, title, author, fileName, buffer, sourceType = 'upload', sourceUrl = null, mimeType, provider = 'free_ai' }) {
  if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) throw new Error('The document did not contain any pages.');
  const id = randomUUID();
  const hash = contentHash(buffer);
  const extension = path.extname(fileName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12) || '.bin';
  const filePath = path.join(dataPath, 'files', `${id}${extension}`);
  fs.writeFileSync(filePath, buffer, { flag: 'wx', mode: 0o600 });
  const now = nowIso();
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO books(id,owner_id,created_by_id,title,author,category,source_type,source_url,file_name,file_path,mime_type,content_hash,translation_provider,translation_status,total_pages,added_at)
        VALUES(?,?,?,?,?,'Other',?,?,?,?,?,?,?,'not_started',?,?)`).run(id, ownerId, ownerId, String(title || parsed.title || fileName.replace(/\.[^.]+$/, '')).slice(0, 250), String(author || parsed.author || '').slice(0, 250), sourceType, sourceUrl, fileName.slice(0, 250), filePath, mimeType || parsed.mime_type, hash, provider, parsed.pages.length, now);
      const insertPage = db.prepare(`INSERT INTO pages(id,book_id,owner_id,page_number,original_text,content_state,structure_json,translation_status,updated_at)
        VALUES(?,?,?,?,?,?,?,'not_started',?)`);
      const insertElement = db.prepare(`INSERT INTO elements(id,page_id,book_id,owner_id,element_order,kind,original_text,heading_level,formatting_json)
        VALUES(?,?,?,?,?,?,?,?,?)`);
      for (const page of parsed.pages) {
        const pageId = randomUUID();
        const pageText = String(page.original_text || '');
        const contentState = page.content_state === 'ocr_required' || !pageText.trim() ? 'ocr_required' : (page.content_state === 'mixed' ? 'mixed' : 'normal');
        insertPage.run(pageId, id, ownerId, page.page_number, pageText, contentState, JSON.stringify(page.structure || []), now);
        for (const [index, element] of (page.structure || []).entries()) {
          insertElement.run(randomUUID(), pageId, id, ownerId, index, element.kind || 'paragraph', String(element.original_text || ''), element.heading_level || null, JSON.stringify(element.formatting || {}));
        }
      }
      emitNotification(db, ownerId, `import:${id}:completed`, 'import_completed', `${String(title || parsed.title || fileName).slice(0, 100)} was imported.`, id);
      const ocrPages = parsed.pages.filter(page => page.content_state === 'ocr_required' || !String(page.original_text || '').trim()).length;
      if (ocrPages) emitNotification(db, ownerId, `import:${id}:ocr`, 'ocr_required', `${ocrPages} page(s) need OCR. No translation will be invented for unreadable pages.`, id);
    })();
  } catch (error) {
    fs.unlinkSync(filePath);
    throw error;
  }
  return db.prepare('SELECT * FROM books WHERE id=? AND owner_id=?').get(id, ownerId);
}

export function createApiRouter({ db = defaultDb, downloadOnlinePdf = fetchPublicPdf } = {}) {
  const router = express.Router();
  router.get('/health', (_req, res) => res.json({ ok: true, service: 'myanmar-ebook-reader' }));
  router.get('/auth/me', (req, res) => res.json({ authenticated: Boolean(req.user), user: req.user || null }));
  router.post('/auth/signup', (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 100);
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!name || name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a name and valid email address.' });
    try {
      const passwordHash = hashPassword(req.body?.password);
      const user = { id: randomUUID(), name, email, password_hash: passwordHash, created_at: nowIso() };
      db.prepare('INSERT INTO users(id,name,email,password_hash,created_at) VALUES(?,?,?,?,?)').run(user.id, user.name, user.email, user.password_hash, user.created_at);
      createSession(db, user.id, res);
      res.status(201).json({ user: { id: user.id, name, email } });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'An account with this email already exists.' });
      res.status(error.status || 400).json({ error: safeError(error) });
    }
  });
  router.post('/auth/login', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = db.prepare('SELECT id,name,email,password_hash FROM users WHERE email=? COLLATE NOCASE').get(email);
    if (!user || !verifyPassword(req.body?.password, user.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
    createSession(db, user.id, res);
    res.json({ user: { id: user.id, name: user.name, email: user.email } });
  });
  router.post('/auth/logout', (req, res) => {
    deleteCurrentSession(db, req);
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.use(requireAuth);

  router.get('/config/providers', (_req, res) => res.json(providerAvailability()));

  router.get('/books', (req, res) => {
    const ownerId = req.user.id;
    const rows = db.prepare(`SELECT b.* FROM books b WHERE b.owner_id=? ORDER BY COALESCE(b.last_opened_at,b.added_at) DESC`).all(ownerId).map(row => publicBook(db, row));
    res.json({ books: rows });
  });

  router.post('/books/import', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a PDF, DOCX, EPUB, or TXT file.' });
    const provider = req.body?.provider || 'free_ai';
    if (!supportedProviders.includes(provider)) return res.status(400).json({ error: 'Select Free AI or Kimi K3 as the translation provider.' });
    const fileName = path.basename(req.file.originalname || 'book').replace(/[\r\n\0]/g, '').slice(0, 250);
    const hash = contentHash(req.file.buffer);
    const duplicate = db.prepare('SELECT id,title FROM books WHERE owner_id=? AND content_hash=? LIMIT 1').get(req.user.id, hash);
    if (duplicate) return res.status(409).json({ error: 'This file is already in your library.', book_id: duplicate.id });
    const importEvent = randomUUID();
    emitNotification(db, req.user.id, `import:${importEvent}:started`, 'import_started', `Import started for ${fileName.slice(0, 100)}.`);
    try {
      const parsed = await parseDocument(req.file.buffer, fileName, req.file.mimetype);
      const book = insertParsedBook(db, { ownerId: req.user.id, parsed, title: req.body?.title, author: req.body?.author, fileName, buffer: req.file.buffer, mimeType: parsed.mime_type, provider });
      res.status(201).json({ book: publicBook(db, book) });
    } catch (error) {
      emitNotification(db, req.user.id, `import:${importEvent}:failed`, 'import_failed', `Import failed for ${fileName.slice(0, 100)}: ${safeError(error)}`);
      res.status(400).json({ error: safeError(error) });
    }
  });

  router.post('/books/import-online-pdf', async (req, res) => {
    const provider = req.body?.provider;
    if (!supportedProviders.includes(provider)) return res.status(400).json({ error: 'Select a translation provider before importing.' });
    let url;
    try { url = validateOnlinePdfUrl(req.body?.url).toString(); } catch (error) { return res.status(400).json({ error: safeError(error) }); }
    const duplicate = db.prepare('SELECT id,title FROM books WHERE owner_id=? AND source_url=?').get(req.user.id, url);
    if (duplicate) return res.status(200).json({ book: publicBook(db, requireBook(db, req.user.id, duplicate.id)), duplicate: true });
    const importEvent = randomUUID();
    emitNotification(db, req.user.id, `import:${importEvent}:started`, 'import_started', 'Online PDF import started.');
    try {
      const { buffer } = await downloadOnlinePdf(url);
      const parsed = await parsePdf(buffer);
      const pathname = new URL(url).pathname.split('/').filter(Boolean).pop() || 'online-book.pdf';
      const fileName = pathname.toLowerCase().endsWith('.pdf') ? pathname : 'online-book.pdf';
      const title = String(req.body?.title || parsed.title || decodeURIComponent(fileName.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' '))).slice(0, 250);
      const book = insertParsedBook(db, { ownerId: req.user.id, parsed, title, author: req.body?.author || parsed.author, fileName, buffer, sourceType: 'online_pdf', sourceUrl: url, mimeType: 'application/pdf', provider });
      res.status(201).json({ book: publicBook(db, requireBook(db, req.user.id, book.id)) });
    } catch (error) {
      emitNotification(db, req.user.id, `import:${importEvent}:failed`, 'import_failed', `Online PDF import failed: ${safeError(error)}`);
      res.status(400).json({ error: safeError(error) });
    }
  });

  router.get('/books/:bookId', (req, res) => {
    const book = requireBook(db, req.user.id, req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Book not found.' });
    res.json({ book: publicBook(db, book) });
  });

  router.patch('/books/:bookId', (req, res) => {
    const book = requireBook(db, req.user.id, req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Book not found.' });
    const changes = [];
    const values = [];
    if (Object.hasOwn(req.body || {}, 'category')) {
      if (!supportedCategories.includes(req.body.category)) return res.status(400).json({ error: 'Choose a supported category.' });
      changes.push('category=?'); values.push(req.body.category);
    }
    if (Object.hasOwn(req.body || {}, 'is_favorite')) { changes.push('is_favorite=?'); values.push(req.body.is_favorite ? 1 : 0); }
    if (Object.hasOwn(req.body || {}, 'title')) { changes.push('title=?'); values.push(String(req.body.title).trim().slice(0,250)); }
    if (Object.hasOwn(req.body || {}, 'author')) { changes.push('author=?'); values.push(String(req.body.author).trim().slice(0,250)); }
    if (!changes.length) return res.status(400).json({ error: 'No supported book fields were supplied.' });
    values.push(book.id, req.user.id);
    db.prepare(`UPDATE books SET ${changes.join(',')} WHERE id=? AND owner_id=?`).run(...values);
    res.json({ book: publicBook(db, requireBook(db, req.user.id, book.id)) });
  });

  router.delete('/books/:bookId', (req, res) => {
    const book = requireBook(db, req.user.id, req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Book not found.' });
    db.prepare('DELETE FROM books WHERE id=? AND owner_id=?').run(book.id, req.user.id);
    for (const filePath of [book.file_path]) if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const audio = db.prepare('SELECT file_path FROM audio_files WHERE book_id=? AND owner_id=?').all(book.id, req.user.id);
    for (const row of audio) if (row.file_path && fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
    res.status(204).end();
  });

  router.get('/books/:bookId/original', (req, res) => {
    const book = requireBook(db, req.user.id, req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Book not found.' });
    if (!fs.existsSync(book.file_path)) return res.status(410).json({ error: 'The stored original file is missing.' });
    res.type(book.mime_type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(book.file_name)}`);
    fs.createReadStream(book.file_path).pipe(res);
  });

  router.get('/books/:bookId/pages', (req, res) => {
    if (!requireBook(db, req.user.id, req.params.bookId)) return res.status(404).json({ error: 'Book not found.' });
    const pages = db.prepare('SELECT id,page_number,original_text,translation_text,content_state,translation_status,approved_at,flagged,structure_json FROM pages WHERE book_id=? AND owner_id=? ORDER BY page_number').all(req.params.bookId, req.user.id).map(page => ({ ...page, structure: JSON.parse(page.structure_json || '[]') }));
    res.json({ pages });
  });

  router.get('/books/:bookId/toc', (req, res) => {
    const book = requireBook(db, req.user.id, req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Book not found.' });
    const pages = db.prepare('SELECT page_number,original_text,structure_json FROM pages WHERE book_id=? AND owner_id=? ORDER BY page_number').all(book.id, req.user.id);
    const headings = [];
    for (const page of pages) for (const element of JSON.parse(page.structure_json || '[]')) {
      if (element.heading_level && element.original_text) headings.push({ page_number: page.page_number, title: String(element.original_text).slice(0, 300), level: Math.max(1, Math.min(6, Number(element.heading_level))) });
    }
    res.json({ items: headings.length ? headings : pages.map(page => ({ page_number: page.page_number, title: `Page ${page.page_number}`, level: 1 })) });
  });

  router.get('/books/:bookId/page-previews', (req, res) => {
    const book = requireBook(db, req.user.id, req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Book not found.' });
    const offset = Math.max(0, Math.min(book.total_pages, Number.parseInt(req.query.offset, 10) || 0));
    const limit = Math.max(1, Math.min(48, Number.parseInt(req.query.limit, 10) || 24));
    const pages = db.prepare('SELECT page_number,original_text,content_state FROM pages WHERE book_id=? AND owner_id=? ORDER BY page_number LIMIT ? OFFSET ?').all(book.id, req.user.id, limit, offset)
      .map(page => ({ page_number: page.page_number, content_state: page.content_state, preview: page.original_text.slice(0, 320) }));
    res.json({ pages, offset, next_offset: offset + pages.length < book.total_pages ? offset + pages.length : null });
  });

  router.get('/books/:bookId/pages/:pageNumber', (req, res) => {
    if (!requireBook(db, req.user.id, req.params.bookId)) return res.status(404).json({ error: 'Book not found.' });
    const page = requirePage(db, req.user.id, req.params.bookId, req.params.pageNumber);
    if (!page) return res.status(404).json({ error: 'Page not found.' });
    const elements = db.prepare('SELECT id,element_order,kind,original_text,translated_text,heading_level,formatting_json FROM elements WHERE page_id=? AND owner_id=? ORDER BY element_order').all(page.id, req.user.id).map(element => ({ ...element, formatting: JSON.parse(element.formatting_json || '{}') }));
    res.json({ page: { ...page, structure: JSON.parse(page.structure_json || '[]'), elements } });
  });

  router.post('/books/:bookId/read-progress', (req, res) => {
    const book = requireBook(db, req.user.id, req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Book not found.' });
    const pageNumber = Math.max(1, Math.min(book.total_pages, Number(req.body?.page_number) || 1));
    const now = nowIso();
    const activityDate = now.slice(0,10);
    const seconds = Math.max(0, Math.min(300, Math.round(Number(req.body?.seconds_delta) || 0)));
    db.transaction(() => {
      db.prepare(`INSERT INTO reading_progress(id,owner_id,book_id,page_number,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(owner_id,book_id) DO UPDATE SET page_number=excluded.page_number,updated_at=excluded.updated_at`).run(randomUUID(), req.user.id, book.id, pageNumber, now);
      db.prepare(`INSERT INTO reading_activity(id,owner_id,book_id,page_number,activity_date,seconds_read) VALUES(?,?,?,?,?,?)
        ON CONFLICT(owner_id,book_id,page_number,activity_date) DO UPDATE SET seconds_read=reading_activity.seconds_read+excluded.seconds_read`).run(randomUUID(), req.user.id, book.id, pageNumber, activityDate, seconds);
      db.prepare('UPDATE books SET last_opened_at=?,finished_at=? WHERE id=? AND owner_id=?').run(now, pageNumber >= book.total_pages ? now : book.finished_at, book.id, req.user.id);
    })();
    res.json({ page_number: pageNumber, updated_at: now });
  });

  router.get('/books/:bookId/search', (req, res) => {
    if (!requireBook(db, req.user.id, req.params.bookId)) return res.status(404).json({ error: 'Book not found.' });
    const query = String(req.query.q || '').trim().slice(0, 160);
    const scope = ['original','myanmar','both'].includes(req.query.scope) ? req.query.scope : 'both';
    if (!query) return res.json({ count: 0, results: [] });
    const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const terms = scope === 'both' ? ['original_text LIKE ? ESCAPE char(92) COLLATE NOCASE OR translation_text LIKE ? ESCAPE char(92) COLLATE NOCASE', [like, like]] : scope === 'original' ? ['original_text LIKE ? ESCAPE char(92) COLLATE NOCASE', [like]] : ['translation_text LIKE ? ESCAPE char(92) COLLATE NOCASE', [like]];
    const results = db.prepare(`SELECT page_number,original_text,translation_text FROM pages WHERE book_id=? AND owner_id=? AND (${terms[0]}) ORDER BY page_number LIMIT 250`).all(req.params.bookId, req.user.id, ...terms[1]).map(row => {
      const excerpt = value => {
        const text = String(value || '');
        const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
        const start = index < 0 ? 0 : Math.max(0, index - 70);
        const end = Math.min(text.length, start + 240);
        return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
      };
      return { page_number: row.page_number, original_text: excerpt(row.original_text), translation_text: excerpt(row.translation_text) };
    });
    res.json({ count: results.length, results });
  });

  router.get('/books/:bookId/export.txt', (req, res) => {
    const book = requireBook(db, req.user.id, req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Book not found.' });
    const pages = db.prepare('SELECT page_number,original_text,translation_text FROM pages WHERE book_id=? AND owner_id=? ORDER BY page_number').all(book.id, req.user.id);
    const body = pages.map(page => `--- Page ${page.page_number} ---\n${page.original_text || ''}\n\n${page.translation_text ? `မြန်မာဘာသာပြန်\n${page.translation_text}` : '[Translation not ready]'}${page.translation_text ? '' : ''}`).join('\n\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${book.title}.txt`)}`);
    res.send(body);
  });

  router.post('/books/:bookId/translate', (req, res) => {
    const provider = req.body?.provider;
    if (!supportedProviders.includes(provider)) return res.status(400).json({ error: 'Select Free AI or Kimi K3 before translating.' });
    try {
      const job = createTranslationJob(db, { bookId: req.params.bookId, ownerId: req.user.id, provider });
      queueMicrotask(() => runQueuedJobs(db).catch(() => {}));
      res.status(job.reused ? 200 : 202).json({ job });
    } catch (error) { res.status(error.status || 400).json({ error: safeError(error) }); }
  });

  router.post('/books/:bookId/pages/:pageNumber/regenerate', (req, res) => {
    const provider = req.body?.provider;
    if (!supportedProviders.includes(provider)) return res.status(400).json({ error: 'Select Free AI or Kimi K3 for regeneration.' });
    try {
      const job = createTranslationJob(db, { bookId: req.params.bookId, ownerId: req.user.id, provider, pageNumber: req.params.pageNumber, force: true });
      queueMicrotask(() => runQueuedJobs(db).catch(() => {}));
      res.status(202).json({ job });
    } catch (error) { res.status(error.status || 400).json({ error: safeError(error) }); }
  });

  router.get('/jobs/:jobId', (req, res) => {
    const job = db.prepare('SELECT * FROM document_jobs WHERE id=? AND owner_id=?').get(req.params.jobId, req.user.id);
    if (!job) return res.status(404).json({ error: 'Translation job not found.' });
    const chunks = db.prepare('SELECT chunk_number,start_page,end_page,provider,status,attempts,last_error FROM chunk_jobs WHERE document_job_id=? AND owner_id=? ORDER BY chunk_number').all(job.id, req.user.id);
    res.json({ job, chunks, book_translation: bookTranslationState(db, job.book_id, req.user.id) });
  });

  router.post('/jobs/:jobId/retry', (req, res) => {
    try {
      const job = retryJob(db, req.params.jobId, req.user.id);
      queueMicrotask(() => runQueuedJobs(db).catch(() => {}));
      res.status(202).json({ job });
    } catch (error) { res.status(error.status || 400).json({ error: safeError(error) }); }
  });

  router.patch('/books/:bookId/pages/:pageNumber/review', (req, res) => {
    const book = requireBook(db, req.user.id, req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Book not found.' });
    const page = requirePage(db, req.user.id, book.id, req.params.pageNumber);
    if (!page) return res.status(404).json({ error: 'Page not found.' });
    if (page.content_state === 'ocr_required' || !String(page.original_text || '').trim()) return res.status(409).json({ error: 'OCR or a verified text extraction is required before this page can be translated or approved.' });
    const body = req.body || {};
    const now = nowIso();
    let translation = page.translation_text;
    if (Object.hasOwn(body, 'translation_text')) {
      translation = String(body.translation_text).trim().slice(0, 100000);
      if (!translation) return res.status(400).json({ error: 'Translation cannot be empty.' });
      db.prepare("UPDATE pages SET translation_text=?,translation_status='completed',approved_at=NULL,updated_at=? WHERE id=? AND owner_id=?").run(translation, now, page.id, req.user.id);
      if (translation !== page.translation_text) {
        const outdated = db.prepare("UPDATE audio_files SET status='outdated',error_message='Translation changed; regenerate this audio.',updated_at=? WHERE book_id=? AND owner_id=? AND page_number=? AND status IN ('ready','generating')").run(now, book.id, req.user.id, page.page_number);
        if (outdated.changes) emitNotification(db, req.user.id, `audio:${book.id}:${page.page_number}:outdated:${translationFingerprint(translation)}`, 'audio_outdated', `Audio for ${book.title}, page ${page.page_number}, is outdated.`, book.id);
      }
    }
    if (Object.hasOwn(body, 'approve')) {
      if (!translation) return res.status(400).json({ error: 'Translate or edit this page before approving it.' });
      db.prepare('UPDATE pages SET approved_at=?,updated_at=? WHERE id=? AND owner_id=?').run(body.approve ? now : null, now, page.id, req.user.id);
    }
    if (Object.hasOwn(body, 'flagged')) db.prepare('UPDATE pages SET flagged=?,updated_at=? WHERE id=? AND owner_id=?').run(body.flagged ? 1 : 0, now, page.id, req.user.id);
    const updated = requirePage(db, req.user.id, book.id, page.page_number);
    res.json({ page: updated, translation: bookTranslationState(db, book.id, req.user.id) });
  });

  router.get('/books/:bookId/bookmarks', (req, res) => {
    if (!requireBook(db, req.user.id, req.params.bookId)) return res.status(404).json({ error: 'Book not found.' });
    const items = db.prepare('SELECT * FROM bookmarks WHERE book_id=? AND owner_id=? ORDER BY page_number').all(req.params.bookId, req.user.id);
    res.json({ bookmarks: items });
  });
  router.post('/books/:bookId/bookmarks', (req, res) => {
    const book = requireBook(db, req.user.id, req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Book not found.' });
    const pageNumber = Number(req.body?.page_number);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > book.total_pages) return res.status(400).json({ error: 'Choose a valid page.' });
    db.prepare('INSERT OR IGNORE INTO bookmarks(id,book_id,owner_id,page_number,label,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), book.id, req.user.id, pageNumber, String(req.body?.label || '').slice(0,160), nowIso());
    res.status(201).json({ bookmarks: db.prepare('SELECT * FROM bookmarks WHERE book_id=? AND owner_id=? ORDER BY page_number').all(book.id, req.user.id) });
  });
  router.delete('/bookmarks/:id', (req, res) => {
    const result = db.prepare('DELETE FROM bookmarks WHERE id=? AND owner_id=?').run(req.params.id, req.user.id);
    res.status(result.changes ? 204 : 404).end();
  });

  router.get('/books/:bookId/notes', (req, res) => {
    if (!requireBook(db, req.user.id, req.params.bookId)) return res.status(404).json({ error: 'Book not found.' });
    const query = String(req.query.q || '').trim().slice(0,160);
    const notes = query
      ? db.prepare('SELECT * FROM notes WHERE book_id=? AND owner_id=? AND (title LIKE ? OR body LIKE ?) ORDER BY updated_at DESC').all(req.params.bookId, req.user.id, `%${query}%`, `%${query}%`)
      : db.prepare('SELECT * FROM notes WHERE book_id=? AND owner_id=? ORDER BY updated_at DESC').all(req.params.bookId, req.user.id);
    res.json({ notes });
  });
  router.post('/books/:bookId/notes', (req, res) => {
    if (!requireBook(db, req.user.id, req.params.bookId)) return res.status(404).json({ error: 'Book not found.' });
    const body = String(req.body?.body || '').trim().slice(0,20000);
    if (!body) return res.status(400).json({ error: 'Note text is required.' });
    const page = req.body?.page_number == null ? null : Number(req.body.page_number);
    if (page !== null && !requirePage(db, req.user.id, req.params.bookId, page)) return res.status(404).json({ error: 'Page not found.' });
    const id = randomUUID(); const now = nowIso();
    db.prepare('INSERT INTO notes(id,book_id,owner_id,page_number,title,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, req.params.bookId, req.user.id, page, String(req.body?.title || '').slice(0,200), body, now, now);
    res.status(201).json({ note: db.prepare('SELECT * FROM notes WHERE id=? AND owner_id=?').get(id, req.user.id) });
  });
  router.patch('/notes/:id', (req, res) => {
    const note = db.prepare('SELECT * FROM notes WHERE id=? AND owner_id=?').get(req.params.id, req.user.id);
    if (!note) return res.status(404).json({ error: 'Note not found.' });
    const body = Object.hasOwn(req.body || {}, 'body') ? String(req.body.body).trim().slice(0,20000) : note.body;
    const title = Object.hasOwn(req.body || {}, 'title') ? String(req.body.title).slice(0,200) : note.title;
    if (!body) return res.status(400).json({ error: 'Note text is required.' });
    db.prepare('UPDATE notes SET title=?,body=?,updated_at=? WHERE id=? AND owner_id=?').run(title, body, nowIso(), note.id, req.user.id);
    res.json({ note: db.prepare('SELECT * FROM notes WHERE id=? AND owner_id=?').get(note.id, req.user.id) });
  });
  router.delete('/notes/:id', (req, res) => {
    const result = db.prepare('DELETE FROM notes WHERE id=? AND owner_id=?').run(req.params.id, req.user.id);
    res.status(result.changes ? 204 : 404).end();
  });

  router.get('/books/:bookId/highlights', (req, res) => {
    if (!requireBook(db, req.user.id, req.params.bookId)) return res.status(404).json({ error: 'Book not found.' });
    res.json({ highlights: db.prepare('SELECT * FROM highlights WHERE book_id=? AND owner_id=? ORDER BY created_at DESC').all(req.params.bookId, req.user.id) });
  });
  router.post('/books/:bookId/highlights', (req, res) => {
    if (!requireBook(db, req.user.id, req.params.bookId)) return res.status(404).json({ error: 'Book not found.' });
    const page = Number(req.body?.page_number); const text = String(req.body?.selected_text || '').trim().slice(0,5000); const color = String(req.body?.color || 'amber');
    if (!requirePage(db, req.user.id, req.params.bookId, page)) return res.status(404).json({ error: 'Page not found.' });
    if (!text || !['amber','rose','mint','sky'].includes(color)) return res.status(400).json({ error: 'Choose text and one of the four highlight colors.' });
    const id = randomUUID(); db.prepare('INSERT INTO highlights(id,book_id,owner_id,page_number,selected_text,color,created_at) VALUES(?,?,?,?,?,?,?)').run(id, req.params.bookId, req.user.id, page, text, color, nowIso());
    res.status(201).json({ highlight: db.prepare('SELECT * FROM highlights WHERE id=? AND owner_id=?').get(id, req.user.id) });
  });
  router.delete('/highlights/:id', (req, res) => {
    const result = db.prepare('DELETE FROM highlights WHERE id=? AND owner_id=?').run(req.params.id, req.user.id);
    res.status(result.changes ? 204 : 404).end();
  });

  router.get('/glossary', (req, res) => {
    const query = String(req.query.q || '').trim().slice(0,160);
    const terms = query ? db.prepare('SELECT * FROM glossary_terms WHERE owner_id=? AND (source_term LIKE ? OR target_term LIKE ?) ORDER BY source_term COLLATE NOCASE').all(req.user.id, `%${query}%`, `%${query}%`) : db.prepare('SELECT * FROM glossary_terms WHERE owner_id=? ORDER BY source_term COLLATE NOCASE').all(req.user.id);
    res.json({ terms });
  });
  router.post('/glossary', (req, res) => {
    const source = String(req.body?.source_term || '').trim().slice(0,500); const target = String(req.body?.target_term || '').trim().slice(0,500); const note = String(req.body?.note || '').trim().slice(0,1000);
    if (!source || !target) return res.status(400).json({ error: 'Source and Myanmar terms are required.' });
    const normalized = source.normalize('NFKC').toLocaleLowerCase(); const id = randomUUID(); const now = nowIso();
    db.prepare(`INSERT INTO glossary_terms(id,owner_id,source_term,normalized_source,target_term,note,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(owner_id,normalized_source) DO UPDATE SET source_term=excluded.source_term,target_term=excluded.target_term,note=excluded.note,updated_at=excluded.updated_at`).run(id, req.user.id, source, normalized, target, note, now);
    res.status(201).json({ term: db.prepare('SELECT * FROM glossary_terms WHERE owner_id=? AND normalized_source=?').get(req.user.id, normalized) });
  });
  router.patch('/glossary/:id', (req, res) => {
    const term = db.prepare('SELECT * FROM glossary_terms WHERE id=? AND owner_id=?').get(req.params.id, req.user.id);
    if (!term) return res.status(404).json({ error: 'Glossary term not found.' });
    const source = String(req.body?.source_term ?? term.source_term).trim().slice(0,500); const target = String(req.body?.target_term ?? term.target_term).trim().slice(0,500); const note = String(req.body?.note ?? term.note).trim().slice(0,1000);
    if (!source || !target) return res.status(400).json({ error: 'Source and Myanmar terms are required.' });
    try {
      db.prepare('UPDATE glossary_terms SET source_term=?,normalized_source=?,target_term=?,note=?,updated_at=? WHERE id=? AND owner_id=?').run(source, source.normalize('NFKC').toLocaleLowerCase(), target, note, nowIso(), term.id, req.user.id);
    } catch (error) { if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'A glossary entry for this source term already exists.' }); throw error; }
    res.json({ term: db.prepare('SELECT * FROM glossary_terms WHERE id=? AND owner_id=?').get(term.id, req.user.id) });
  });
  router.delete('/glossary/:id', (req, res) => {
    const result = db.prepare('DELETE FROM glossary_terms WHERE id=? AND owner_id=?').run(req.params.id, req.user.id);
    res.status(result.changes ? 204 : 404).end();
  });
  router.post('/glossary/import', (req, res) => {
    if (!Array.isArray(req.body?.terms) || req.body.terms.length > 5000) return res.status(400).json({ error: 'Upload a JSON array of at most 5,000 glossary terms.' });
    const insert = db.prepare(`INSERT INTO glossary_terms(id,owner_id,source_term,normalized_source,target_term,note,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(owner_id,normalized_source) DO UPDATE SET target_term=excluded.target_term,note=excluded.note,updated_at=excluded.updated_at`);
    let imported = 0;
    try {
      db.transaction(() => {
        for (const term of req.body.terms) {
          const source = String(term?.source_term || term?.source || '').trim().slice(0,500); const target = String(term?.target_term || term?.target || '').trim().slice(0,500);
          if (!source || !target) continue;
          insert.run(randomUUID(), req.user.id, source, source.normalize('NFKC').toLocaleLowerCase(), target, String(term.note || '').slice(0,1000), nowIso()); imported++;
        }
      })();
    } catch (error) { return res.status(400).json({ error: safeError(error) }); }
    res.json({ imported });
  });
  router.get('/glossary/export.json', (req, res) => {
    const terms = db.prepare('SELECT source_term,target_term,note FROM glossary_terms WHERE owner_id=? ORDER BY source_term COLLATE NOCASE').all(req.user.id);
    res.setHeader('Content-Type','application/json; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename="glossary.json"'); res.send(JSON.stringify(terms,null,2));
  });

  router.get('/notifications', (req, res) => {
    const notifications = db.prepare('SELECT * FROM notifications WHERE owner_id=? AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 100').all(req.user.id);
    res.json({ notifications, unread_count: notifications.filter(item => !item.read_at).length });
  });
  router.post('/notifications/:id/read', (req, res) => {
    const result = db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND owner_id=?').run(nowIso(), req.params.id, req.user.id);
    res.status(result.changes ? 204 : 404).end();
  });
  router.post('/notifications/read-all', (req, res) => {
    db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE owner_id=? AND dismissed_at IS NULL').run(nowIso(), req.user.id);
    res.status(204).end();
  });
  router.delete('/notifications/:id', (req, res) => {
    const result = db.prepare('UPDATE notifications SET dismissed_at=? WHERE id=? AND owner_id=?').run(nowIso(), req.params.id, req.user.id);
    res.status(result.changes ? 204 : 404).end();
  });

  router.get('/audio', (req, res) => {
    const audio = db.prepare(`SELECT a.id,a.book_id,a.owner_id,a.page_number,a.status,a.mime_type,a.translation_fingerprint,a.error_message,a.created_at,a.updated_at,(a.file_path IS NOT NULL) AS has_file,b.title AS book_title FROM audio_files a JOIN books b ON b.id=a.book_id
      WHERE a.owner_id=? AND b.owner_id=? ORDER BY a.updated_at DESC`).all(req.user.id, req.user.id);
    res.json({ audio });
  });
  router.post('/books/:bookId/pages/:pageNumber/audio', async (req, res) => {
    const book = requireBook(db, req.user.id, req.params.bookId);
    if (!book) return res.status(404).json({ error: 'Book not found.' });
    const page = requirePage(db, req.user.id, book.id, req.params.pageNumber);
    if (!page) return res.status(404).json({ error: 'Page not found.' });
    if (!page.approved_at) return res.status(409).json({ error: 'Approve the Myanmar translation before generating audio.' });
    const text = page.translation_text?.trim();
    if (!text) return res.status(409).json({ error: 'Translation not ready yet; audio cannot be generated for this page.' });
    const fingerprint = translationFingerprint(text);
    const existing = db.prepare('SELECT * FROM audio_files WHERE book_id=? AND owner_id=? AND page_number=?').get(book.id, req.user.id, page.page_number);
    if (existing?.status === 'ready' && existing.translation_fingerprint === fingerprint && existing.file_path && fs.existsSync(existing.file_path)) return res.json({ audio: existing, reused: true });
    if (existing?.status === 'generating' && existing.translation_fingerprint === fingerprint) return res.status(202).json({ audio: existing, generating: true });
    const id = existing?.id || randomUUID(); const now = nowIso();
    db.prepare(`INSERT INTO audio_files(id,book_id,owner_id,page_number,status,file_path,mime_type,translation_fingerprint,created_at,updated_at)
      VALUES(?,?,?,?,'generating',NULL,NULL,?,?,?) ON CONFLICT(owner_id,book_id,page_number) DO UPDATE SET status='generating',error_message=NULL,updated_at=excluded.updated_at`)
      .run(id, book.id, req.user.id, page.page_number, fingerprint, now, now);
    try {
      const generated = await generateSpeech(text);
      const extension = generated.mimeType === 'audio/wav' || generated.mimeType === 'audio/x-wav' ? '.wav' : generated.mimeType === 'audio/ogg' ? '.ogg' : generated.mimeType === 'audio/mp4' ? '.m4a' : '.mp3';
      const filePath = path.join(dataPath, 'audio', `${id}-${fingerprint.slice(0, 12)}${extension}`);
      fs.writeFileSync(filePath, generated.buffer, { mode: 0o600 });
      db.prepare("UPDATE audio_files SET status='ready',file_path=?,mime_type=?,translation_fingerprint=?,error_message=NULL,updated_at=? WHERE id=? AND owner_id=?").run(filePath, generated.mimeType, fingerprint, nowIso(), id, req.user.id);
      if (existing?.file_path && existing.file_path !== filePath && fs.existsSync(existing.file_path)) fs.unlinkSync(existing.file_path);
      emitNotification(db, req.user.id, `audio:${id}:ready:${fingerprint}`, 'audio_ready', `Audio is ready for ${book.title}, page ${page.page_number}.`, id);
      return res.status(201).json({ audio: db.prepare('SELECT * FROM audio_files WHERE id=? AND owner_id=?').get(id, req.user.id) });
    } catch (error) {
      const latest = db.prepare('SELECT file_path,translation_fingerprint FROM audio_files WHERE id=? AND owner_id=?').get(id, req.user.id);
      const status = latest?.file_path && fs.existsSync(latest.file_path) ? (latest.translation_fingerprint === fingerprint ? 'ready' : 'outdated') : 'failed';
      db.prepare('UPDATE audio_files SET status=?,error_message=?,updated_at=? WHERE id=? AND owner_id=?').run(status, safeError(error), nowIso(), id, req.user.id);
      emitNotification(db, req.user.id, `audio:${id}:failed:${fingerprint}`, 'audio_failed', `Audio generation failed for page ${page.page_number}: ${safeError(error)}`, id);
      return res.status(503).json({ error: safeError(error), audio: db.prepare('SELECT * FROM audio_files WHERE id=? AND owner_id=?').get(id, req.user.id) });
    }
  });
  router.get('/audio/:id/stream', (req, res) => {
    const audio = db.prepare('SELECT * FROM audio_files WHERE id=? AND owner_id=?').get(req.params.id, req.user.id);
    if (!audio || !audio.file_path || !fs.existsSync(audio.file_path)) return res.status(404).json({ error: 'Audio file not found.' });
    res.type(audio.mime_type || 'audio/mpeg');
    res.setHeader('Cache-Control','private, no-store');
    fs.createReadStream(audio.file_path).pipe(res);
  });

  router.get('/statistics', (req, res) => {
    const ownerId = req.user.id;
    const counts = db.prepare(`SELECT COUNT(*) AS total_books,
      SUM(CASE WHEN finished_at IS NOT NULL THEN 1 ELSE 0 END) AS books_finished,
      SUM(CASE WHEN finished_at IS NULL AND last_opened_at IS NOT NULL THEN 1 ELSE 0 END) AS books_in_progress
      FROM books WHERE owner_id=?`).get(ownerId);
    const pagesRead = db.prepare("SELECT COUNT(DISTINCT book_id || ':' || page_number) AS count FROM reading_activity WHERE owner_id=?").get(ownerId).count;
    const seconds = db.prepare('SELECT COALESCE(SUM(seconds_read),0) AS count FROM reading_activity WHERE owner_id=?').get(ownerId).count;
    const dates = db.prepare('SELECT DISTINCT activity_date FROM reading_activity WHERE owner_id=? ORDER BY activity_date DESC').all(ownerId).map(row => row.activity_date);
    let streak = 0;
    let cursor = new Date(); cursor.setUTCHours(0,0,0,0);
    const today = cursor.toISOString().slice(0,10);
    if (dates[0] && dates[0] !== today) cursor.setUTCDate(cursor.getUTCDate()-1);
    for (const date of dates) { if (date !== cursor.toISOString().slice(0,10)) break; streak++; cursor.setUTCDate(cursor.getUTCDate()-1); }
    const favoriteCategories = db.prepare('SELECT category,COUNT(*) AS count FROM books WHERE owner_id=? AND is_favorite=1 GROUP BY category ORDER BY count DESC').all(ownerId);
    const recentlyFinished = db.prepare('SELECT id,title,author,finished_at FROM books WHERE owner_id=? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 8').all(ownerId);
    res.json({ books_in_progress: counts.books_in_progress || 0, books_finished: counts.books_finished || 0, total_pages_read: pagesRead || 0, reading_streak_days: streak, estimated_reading_minutes: Math.round(seconds / 60), favorite_categories: favoriteCategories, recently_finished: recentlyFinished });
  });

  router.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Files must be 25 MB or smaller.' : 'The upload could not be processed.' });
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'This record already exists.' });
    if (!error.status) console.error('Unexpected API error:', safeError(error));
    return res.status(error.status || 500).json({ error: error.status ? safeError(error) : 'An unexpected server error occurred.' });
  });
  return router;
}
