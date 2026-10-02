import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import PDFDocument from 'pdfkit';
import JSZip from 'jszip';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myanmar-reader-test-'));
process.env.APP_DATA_DIR = tempRoot;
process.env.NODE_ENV = 'test';
process.env.TRANSLATION_PAGES_PER_CHUNK = '1';
process.env.COOKIE_SAMESITE = 'strict';
delete process.env.TTS_API_URL;

const { db, dataPath } = await import('../server/db.js');
const { authMiddleware } = await import('../server/security.js');
const { createApiRouter } = await import('../server/routes.js');
const { createTranslationJob, runQueuedJobs, retryJob, resumeStaleJobs, emitNotification, bookTranslationState, translationFingerprint } = await import('../server/jobs.js');
const { parseDocument, parseEpub, parseDocx, parsePdf, parseTxt } = await import('../server/importers.js');
const { providerAvailability, translateWithProvider } = await import('../server/providers.js');
const { isPublicIp, validateOnlinePdfUrl, fetchPublicPdf } = await import('../server/onlinePdf.js');

const app = express();
app.use(express.json());
app.use(authMiddleware(db));
app.use('/api', createApiRouter({ db }));
const api = request(app);
let alice;
let bob;
let storyBook;

function signup(name, email) {
  return api.post('/api/auth/signup').send({ name, email, password: 'correct horse battery staple' });
}
function cookieOf(response) { return response.headers['set-cookie']?.[0]?.split(';')[0]; }
function pdfFixture() {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ autoFirstPage: false });
    const chunks = [];
    document.on('data', chunk => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    document.addPage();
    document.fontSize(14).text('Readable source text appears on this first page.');
    const imageFixture = fs.readFileSync(new URL('./fixtures/mixed-content.jpg', import.meta.url));
    document.image(imageFixture, 400, 50, { width: 24 }); // Text plus a real image is mixed content.
    document.addPage(); // Deliberately blank: this must remain OCR-required.
    document.end();
  });
}
async function docxFixture() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter heading</w:t></w:r></w:p><w:p><w:r><w:t>DOCX paragraph content.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
async function epubFixture() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/book.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>EPUB title</dc:title><dc:creator>Test author</dc:creator></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>');
  zip.file('OPS/chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h1>EPUB heading</h1><p>EPUB paragraph.</p></body></html>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
async function upload(ownerCookie, fileName, buffer, mimeType, fields = {}) {
  let call = api.post('/api/books/import').set('Cookie', ownerCookie);
  for (const [key, value] of Object.entries(fields)) call = call.field(key, value);
  return call.attach('file', buffer, { filename: fileName, contentType: mimeType });
}

after(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('importers preserve real document structure and mark unreadable PDF pages', async t => {
  const txt = parseTxt(Buffer.from('First paragraph.\n\nSecond paragraph.'));
  assert.equal(txt.pages.length, 1);
  assert.equal(txt.pages[0].structure.length, 2);
  assert.equal(txt.pages[0].original_text, 'First paragraph.\n\nSecond paragraph.');

  const pdf = await pdfFixture();
  const parsedPdf = await parsePdf(pdf);
  assert.equal(parsedPdf.pages.length, 2);
  assert.match(parsedPdf.pages[0].original_text, /Readable source text/);
  assert.equal(parsedPdf.pages[0].content_state, 'mixed');
  assert.equal(parsedPdf.pages[1].content_state, 'ocr_required');

  const docx = await docxFixture();
  const parsedDocx = await parseDocx(docx);
  assert.ok(parsedDocx.pages.length >= 1);
  assert.match(parsedDocx.pages.map(page => page.original_text).join('\n'), /DOCX paragraph content/);
  assert.ok(parsedDocx.pages.flatMap(page => page.structure).some(item => item.heading_level));

  const epub = await epubFixture();
  const parsedEpub = await parseEpub(epub);
  assert.equal(parsedEpub.title, 'EPUB title');
  assert.equal(parsedEpub.author, 'Test author');
  assert.match(parsedEpub.pages.map(page => page.original_text).join('\n'), /EPUB paragraph/);
  assert.ok(parsedEpub.pages.flatMap(page => page.structure).some(item => item.heading_level));

  await t.test('extensions cannot disguise unrelated bytes as supported formats', async () => {
    await assert.rejects(parseDocument(Buffer.from('not a pdf'), 'fake.pdf', 'application/pdf'), /contents do not match/);
    await assert.rejects(parseDocument(Buffer.from('x'), 'other.bin'), /Supported formats/);
  });
});

test('authenticated book APIs enforce ownership and expose no server paths', async t => {
  const anonymous = await api.get('/api/books');
  assert.equal(anonymous.status, 401);
  const aliceResponse = await signup('Alice Reader', 'alice@example.test');
  assert.equal(aliceResponse.status, 201);
  alice = { user: aliceResponse.body.user, cookie: cookieOf(aliceResponse) };
  assert.match(aliceResponse.headers['set-cookie'][0], /HttpOnly/);
  const bobResponse = await signup('Bob Reader', 'bob@example.test');
  assert.equal(bobResponse.status, 201);
  bob = { user: bobResponse.body.user, cookie: cookieOf(bobResponse) };

  const content = Buffer.from('Book text for reading.\n\nA second meaningful paragraph.');
  const imported = await upload(alice.cookie, 'story.txt', content, 'text/plain', { provider: 'kimi_k3', owner_id: bob.user.id, title: 'My Story' });
  assert.equal(imported.status, 201, imported.text);
  storyBook = imported.body.book;
  assert.equal(storyBook.translation_provider, 'kimi_k3');
  assert.equal(storyBook.title, 'My Story');
  assert.equal(storyBook.total_pages, 1);
  assert.equal('file_path' in storyBook, false);
  assert.equal('content_hash' in storyBook, false);
  assert.equal('owner_id' in storyBook, false);
  assert.equal(db.prepare('SELECT owner_id,created_by_id FROM books WHERE id=?').get(storyBook.id).owner_id, alice.user.id);
  assert.equal(db.prepare('SELECT owner_id FROM pages WHERE book_id=? AND page_number=1').get(storyBook.id).owner_id, alice.user.id);

  const initialEvents = await api.get('/api/notifications').set('Cookie', alice.cookie);
  const importKinds = initialEvents.body.notifications.map(item => item.kind);
  assert.ok(importKinds.includes('import_started'));
  assert.ok(importKinds.includes('import_completed'));
  emitNotification(db, alice.user.id, 'test:dedupe:event', 'chunk_failed', 'first');
  emitNotification(db, alice.user.id, 'test:dedupe:event', 'chunk_failed', 'duplicate');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE owner_id=? AND event_key=?').get(alice.user.id, 'test:dedupe:event').count, 1);
  const invalidUpload = await upload(alice.cookie, 'invalid.pdf', Buffer.from('not a PDF'), 'application/pdf');
  assert.equal(invalidUpload.status, 400);
  const lifecycle = await api.get('/api/notifications').set('Cookie', alice.cookie);
  assert.ok(lifecycle.body.notifications.some(item => item.kind === 'import_failed'));
  assert.equal((await api.get('/api/notifications').set('Cookie', bob.cookie)).body.notifications.length, 0);
  const firstEvent = lifecycle.body.notifications[0];
  assert.equal((await api.post(`/api/notifications/${firstEvent.id}/read`).set('Cookie', alice.cookie)).status, 204);
  assert.ok((await api.get('/api/notifications').set('Cookie', alice.cookie)).body.notifications.find(item => item.id === firstEvent.id).read_at);
  assert.equal((await api.post('/api/notifications/read-all').set('Cookie', alice.cookie)).status, 204);
  assert.equal((await api.get('/api/notifications').set('Cookie', alice.cookie)).body.unread_count, 0);
  assert.equal((await api.delete(`/api/notifications/${firstEvent.id}`).set('Cookie', alice.cookie)).status, 204);
  assert.ok(!(await api.get('/api/notifications').set('Cookie', alice.cookie)).body.notifications.some(item => item.id === firstEvent.id));

  const details = await api.get(`/api/books/${storyBook.id}`).set('Cookie', alice.cookie);
  assert.equal(details.status, 200);
  const forbidden = await api.get(`/api/books/${storyBook.id}`).set('Cookie', bob.cookie);
  assert.equal(forbidden.status, 404);
  const list = await api.get('/api/books').set('Cookie', bob.cookie);
  assert.equal(list.body.books.length, 0);
  const wrongOwnerMutation = await api.patch(`/api/books/${storyBook.id}`).set('Cookie', bob.cookie).send({ is_favorite: true });
  assert.equal(wrongOwnerMutation.status, 404);
  const maliciousOwner = await api.get(`/api/books/${storyBook.id}`).set('Cookie', alice.cookie);
  assert.equal(maliciousOwner.body.book.owner_id, undefined);

  const toc = await api.get(`/api/books/${storyBook.id}/toc`).set('Cookie', alice.cookie);
  assert.equal(toc.status, 200);
  assert.equal(toc.body.items[0].title, 'Page 1');
  const previews = await api.get(`/api/books/${storyBook.id}/page-previews?offset=0&limit=1`).set('Cookie', alice.cookie);
  assert.equal(previews.status, 200);
  assert.match(previews.body.pages[0].preview, /Book text/);
  const search = await api.get(`/api/books/${storyBook.id}/search?q=meaningful&scope=original`).set('Cookie', alice.cookie);
  assert.equal(search.status, 200, search.text);
  assert.equal(search.body.count, 1);

  await t.test('bookmarks, notes, highlights, and glossary records are persisted per account', async () => {
    const bookmark = await api.post(`/api/books/${storyBook.id}/bookmarks`).set('Cookie', alice.cookie).send({ page_number: 1, label: 'Start' });
    assert.equal(bookmark.status, 201);
    assert.equal(bookmark.body.bookmarks.length, 1);
    const note = await api.post(`/api/books/${storyBook.id}/notes`).set('Cookie', alice.cookie).send({ page_number: 1, body: 'Review this paragraph.', owner_id: bob.user.id });
    assert.equal(note.status, 201);
    assert.equal((await api.get(`/api/books/${storyBook.id}/notes`).set('Cookie', alice.cookie)).body.notes.length, 1);
    assert.equal(db.prepare('SELECT owner_id FROM notes WHERE id=?').get(note.body.note.id).owner_id, alice.user.id);
    const editedNote = await api.patch(`/api/notes/${note.body.note.id}`).set('Cookie', alice.cookie).send({ body: 'Updated private reference note.' });
    assert.equal(editedNote.body.note.body, 'Updated private reference note.');
    assert.equal((await api.get(`/api/books/${storyBook.id}/notes?q=reference`).set('Cookie', alice.cookie)).body.notes.length, 1);
    assert.equal((await api.patch(`/api/notes/${note.body.note.id}`).set('Cookie', bob.cookie).send({ body: 'Should not edit Alice note.' })).status, 404);
    assert.equal((await api.delete(`/api/notes/${note.body.note.id}`).set('Cookie', alice.cookie)).status, 204);
    assert.equal((await api.get(`/api/books/${storyBook.id}/notes`).set('Cookie', alice.cookie)).body.notes.length, 0);
    const highlight = await api.post(`/api/books/${storyBook.id}/highlights`).set('Cookie', alice.cookie).send({ page_number: 1, selected_text: 'Book text', color: 'mint' });
    assert.equal(highlight.status, 201);
    assert.equal((await api.get(`/api/books/${storyBook.id}/highlights`).set('Cookie', alice.cookie)).body.highlights.length, 1);
    assert.equal((await api.get(`/api/books/${storyBook.id}/notes`).set('Cookie', bob.cookie)).status, 404);
    const glossary = await api.post('/api/glossary').set('Cookie', alice.cookie).send({ source_term: 'runtime', target_term: 'အသုံးပြုချိန်', owner_id: bob.user.id });
    assert.equal(glossary.status, 201);
    assert.equal(db.prepare('SELECT owner_id FROM glossary_terms WHERE id=?').get(glossary.body.term.id).owner_id, alice.user.id);
    assert.equal((await api.get('/api/glossary').set('Cookie', bob.cookie)).body.terms.length, 0);
    const progress = await api.post(`/api/books/${storyBook.id}/read-progress`).set('Cookie', alice.cookie).send({ page_number: 1, seconds_delta: 130 });
    assert.equal(progress.status, 200);
    const stats = await api.get('/api/statistics').set('Cookie', alice.cookie);
    assert.equal(stats.status, 200);
    assert.equal(stats.body.total_pages_read, 1);
    assert.equal(stats.body.estimated_reading_minutes, 2);
  });
});

test('OCR-required PDF pages remain blocked and prevent a full-translation status', async () => {
  const pdf = await pdfFixture();
  const imported = await upload(alice.cookie, 'scan.pdf', pdf, 'application/pdf', { provider: 'kimi_k3' });
  assert.equal(imported.status, 201, imported.text);
  const book = imported.body.book;
  const page2 = await api.get(`/api/books/${book.id}/pages/2`).set('Cookie', alice.cookie);
  assert.equal(page2.body.page.content_state, 'ocr_required');
  const attemptedApproval = await api.patch(`/api/books/${book.id}/pages/2/review`).set('Cookie', alice.cookie).send({ translation_text: 'လိမ်လည်မည့်စာ', approve: true });
  assert.equal(attemptedApproval.status, 409);

  const job = createTranslationJob(db, { bookId: book.id, ownerId: alice.user.id, provider: 'kimi_k3' });
  await runQueuedJobs(db, async (provider, { pages }) => {
    assert.equal(provider, 'kimi_k3');
    return pages.map(page => `မြန်မာစာ: ${page.original_text}`);
  });
  const savedJob = db.prepare('SELECT * FROM document_jobs WHERE id=?').get(job.id);
  assert.equal(savedJob.status, 'ocr_required');
  assert.equal(savedJob.completed_chunks, 1);
  assert.equal(savedJob.total_chunks, 2);
  const state = bookTranslationState(db, book.id, alice.user.id);
  assert.equal(state.status, 'ocr_required');
  assert.equal(state.ocr_required, 1);
  assert.equal(state.translated, 1);
  assert.notEqual(state.status, 'completed');
});

test('translation failures preserve provider choice and completed chunks for explicit retry', async () => {
  const content = Buffer.from('first source page\fsecond source page\fthird source page');
  const imported = await upload(alice.cookie, 'retry.txt', content, 'text/plain', { provider: 'kimi_k3' });
  assert.equal(imported.status, 201, imported.text);
  const book = imported.body.book;
  const job = createTranslationJob(db, { bookId: book.id, ownerId: alice.user.id, provider: 'kimi_k3' });
  let attempts = 0;
  let failOnce = true;
  await runQueuedJobs(db, async (provider, { pages }) => {
    assert.equal(provider, 'kimi_k3');
    attempts++;
    if (failOnce && attempts === 2) { failOnce = false; throw new Error('temporarily unavailable'); }
    return pages.map(page => `မြန်မာဘာသာ: ${page.original_text}`);
  });
  let saved = db.prepare('SELECT * FROM document_jobs WHERE id=?').get(job.id);
  assert.equal(saved.provider, 'kimi_k3');
  assert.equal(saved.status, 'failed');
  assert.equal(saved.completed_chunks, 1);
  const beforeRetry = db.prepare('SELECT attempts FROM chunk_jobs WHERE document_job_id=? AND chunk_number=1').get(job.id).attempts;
  assert.equal(beforeRetry, 1);

  assert.equal(retryJob(db, job.id, alice.user.id).provider, 'kimi_k3');
  await runQueuedJobs(db, async (provider, { pages }) => { attempts++; return pages.map(page => `မြန်မာဘာသာ: ${page.original_text}`); });
  saved = db.prepare('SELECT * FROM document_jobs WHERE id=?').get(job.id);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.completed_chunks, 3);
  assert.equal(saved.provider, 'kimi_k3');
  assert.equal(attempts, 4, 'the already completed first page must not be translated again');
  assert.equal(db.prepare('SELECT attempts FROM chunk_jobs WHERE document_job_id=? AND chunk_number=1').get(job.id).attempts, 1);
  assert.equal(db.prepare('SELECT attempts FROM chunk_jobs WHERE document_job_id=? AND chunk_number=2').get(job.id).attempts, 2);
  assert.equal(bookTranslationState(db, book.id, alice.user.id).status, 'completed');
  assert.equal((await api.get(`/api/jobs/${job.id}`).set('Cookie', bob.cookie)).status, 404);
});

test('650-page structural translation is complete, ordered, idempotent, and recovers stale work', async () => {
  const pageCount = 650;
  const content = Buffer.from(Array.from({ length: pageCount }, (_, index) => `Page ${index + 1} source text.`).join('\f'));
  const imported = await upload(alice.cookie, 'large-650-pages.txt', content, 'text/plain', { provider: 'kimi_k3' });
  assert.equal(imported.status, 201, imported.text);
  const book = imported.body.book;
  assert.equal(book.total_pages, pageCount);
  const job = createTranslationJob(db, { bookId: book.id, ownerId: alice.user.id, provider: 'kimi_k3' });
  assert.equal(job.total_chunks, pageCount);
  let calls = 0;
  await runQueuedJobs(db, async (provider, { pages }) => {
    assert.equal(provider, 'kimi_k3');
    calls++;
    return pages.map(page => `Myanmar: ${page.original_text}`);
  });
  const saved = db.prepare('SELECT * FROM document_jobs WHERE id=?').get(job.id);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.total_chunks, pageCount);
  assert.equal(saved.completed_chunks, pageCount);
  const manifest = db.prepare('SELECT COUNT(*) AS count,COUNT(DISTINCT page_number) AS distinct_pages,MIN(page_number) AS first_page,MAX(page_number) AS last_page FROM pages WHERE book_id=? AND owner_id=?').get(book.id, alice.user.id);
  assert.deepEqual(manifest, { count: pageCount, distinct_pages: pageCount, first_page: 1, last_page: pageCount });
  const chunks = db.prepare(`SELECT COUNT(*) AS count,COUNT(DISTINCT chunk_number) AS distinct_chunks,MIN(chunk_number) AS first_chunk,MAX(chunk_number) AS last_chunk,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed FROM chunk_jobs WHERE document_job_id=? AND owner_id=?`).get(job.id, alice.user.id);
  assert.deepEqual(chunks, { count: pageCount, distinct_chunks: pageCount, first_chunk: 1, last_chunk: pageCount, completed: pageCount });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM elements WHERE book_id=? AND owner_id=?').get(book.id, alice.user.id).count, pageCount);
  assert.equal(bookTranslationState(db, book.id, alice.user.id).status, 'completed');
  const callsBeforeRerun = calls;
  const rerun = createTranslationJob(db, { bookId: book.id, ownerId: alice.user.id, provider: 'kimi_k3' });
  await runQueuedJobs(db, async () => { calls++; throw new Error('completed pages must not be retranslated'); });
  assert.equal(db.prepare('SELECT status FROM document_jobs WHERE id=?').get(rerun.id).status, 'completed');
  assert.equal(calls, callsBeforeRerun);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pages WHERE book_id=?').get(book.id).count, pageCount);

  const staleImport = await upload(alice.cookie, 'stale-job.txt', Buffer.from('Recover this page.'), 'text/plain', { provider: 'free_ai' });
  const staleBook = staleImport.body.book;
  const staleJob = createTranslationJob(db, { bookId: staleBook.id, ownerId: alice.user.id, provider: 'free_ai' });
  const ancient = '2000-01-01T00:00:00.000Z';
  db.prepare("UPDATE document_jobs SET status='processing',updated_at=? WHERE id=?").run(ancient, staleJob.id);
  db.prepare("UPDATE chunk_jobs SET status='processing',updated_at=? WHERE document_job_id=?").run(ancient, staleJob.id);
  assert.equal(resumeStaleJobs(db, 1000), 1);
  assert.equal(db.prepare('SELECT status,provider FROM document_jobs WHERE id=?').get(staleJob.id).status, 'queued');
  await runQueuedJobs(db, async (provider, { pages }) => { assert.equal(provider, 'free_ai'); return pages.map(page => `Recovered: ${page.original_text}`); });
  assert.equal(db.prepare('SELECT status,provider FROM document_jobs WHERE id=?').get(staleJob.id).status, 'completed');
  assert.ok(db.prepare("SELECT id FROM notifications WHERE owner_id=? AND kind='resume' AND entity_id=?").get(alice.user.id, staleBook.id));
});

test('online-PDF import stores a local copy, persists its provider, deduplicates, and keeps lifecycle events private', async () => {
  const pdf = await pdfFixture();
  let downloads = 0;
  const onlineApp = express();
  onlineApp.use(express.json());
  onlineApp.use(authMiddleware(db));
  onlineApp.use('/api', createApiRouter({ db, downloadOnlinePdf: async url => { downloads++; return { buffer: pdf, finalUrl: url }; } }));
  const onlineApi = request(onlineApp);
  const url = 'https://public.example.test/path/online-book.pdf';
  const imported = await onlineApi.post('/api/books/import-online-pdf').set('Cookie', alice.cookie).send({ url, provider: 'kimi_k3', owner_id: bob.user.id });
  assert.equal(imported.status, 201, imported.text);
  assert.equal(imported.body.book.source_type, 'online_pdf');
  assert.equal(imported.body.book.source_url, url);
  assert.equal(imported.body.book.translation_provider, 'kimi_k3');
  assert.equal(db.prepare('SELECT owner_id FROM books WHERE id=?').get(imported.body.book.id).owner_id, alice.user.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pages WHERE book_id=?').get(imported.body.book.id).count, 2);
  const original = await onlineApi.get(`/api/books/${imported.body.book.id}/original`).set('Cookie', alice.cookie);
  assert.equal(original.status, 200);
  assert.match(original.headers['content-type'], /application\/pdf/);
  assert.equal(original.headers['cache-control'], 'private, no-store');
  assert.equal((await onlineApi.get(`/api/books/${imported.body.book.id}/original`).set('Cookie', bob.cookie)).status, 404);
  assert.equal(downloads, 1);
  const duplicate = await onlineApi.post('/api/books/import-online-pdf').set('Cookie', alice.cookie).send({ url, provider: 'free_ai' });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.book.translation_provider, 'kimi_k3');
  assert.equal(downloads, 1);
  const invalid = await onlineApi.post('/api/books/import-online-pdf').set('Cookie', alice.cookie).send({ url: 'http://127.0.0.1/private.pdf', provider: 'free_ai' });
  assert.equal(invalid.status, 400);
  const events = (await onlineApi.get('/api/notifications').set('Cookie', alice.cookie)).body.notifications;
  assert.ok(events.some(item => item.kind === 'import_completed' && item.entity_id === imported.body.book.id));
});

test('audio requires approved text and failed regeneration preserves the previous audio file', async () => {
  const book = db.prepare('SELECT * FROM books WHERE id=? AND owner_id=?').get(storyBook.id, alice.user.id);
  const page = db.prepare('SELECT * FROM pages WHERE book_id=? AND page_number=1').get(book.id);
  db.prepare("UPDATE pages SET translation_text=?,translation_status='completed' WHERE id=?").run('Myanmar approved sentence.', page.id);
  const approval = await api.patch(`/api/books/${book.id}/pages/1/review`).set('Cookie', alice.cookie).send({ approve: true });
  assert.equal(approval.status, 200);
  const blocked = await api.post(`/api/books/${book.id}/pages/1/audio`).set('Cookie', bob.cookie).send({});
  assert.equal(blocked.status, 404);

  const audioFile = path.join(dataPath, 'audio', 'previous-audio.mp3');
  fs.writeFileSync(audioFile, Buffer.from('existing audio bytes'));
  const audioId = 'previous-audio-test-id';
  db.prepare(`INSERT INTO audio_files(id,book_id,owner_id,page_number,status,file_path,mime_type,translation_fingerprint,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(audioId, book.id, alice.user.id, 1, 'ready', audioFile, 'audio/mpeg', '0'.repeat(64), new Date().toISOString(), new Date().toISOString());
  const response = await api.post(`/api/books/${book.id}/pages/1/audio`).set('Cookie', alice.cookie).send({});
  assert.equal(response.status, 503);
  assert.equal(fs.existsSync(audioFile), true);
  const stored = db.prepare('SELECT * FROM audio_files WHERE id=?').get(audioId);
  assert.equal(stored.status, 'outdated');
  assert.equal(stored.file_path, audioFile);
  const listing = await api.get('/api/audio').set('Cookie', alice.cookie);
  assert.equal(listing.status, 200);
  const row = listing.body.audio.find(item => item.id === audioId);
  assert.equal(row.has_file, 1);
  assert.equal('file_path' in row, false);
});

test('provider availability is honest and online PDF validation rejects private network targets', async () => {
  const availability = providerAvailability({});
  assert.equal(availability.free_ai.available, false);
  assert.equal(availability.kimi_k3.available, false);
  assert.equal(availability.audio.available, false);
  await assert.rejects(translateWithProvider('kimi_k3', { pages: [{ page_number: 1, original_text: 'Source' }] }, {}), /API key not configured/);
  await assert.rejects(translateWithProvider('free_ai', { pages: [{ page_number: 1, original_text: 'Source' }] }, {}), /not configured/);

  for (const ip of ['0.0.0.0','10.1.2.3','127.0.0.1','169.254.1.1','172.16.2.3','192.168.1.4','::1','fc00::1','fe80::1']) assert.equal(isPublicIp(ip), false, `${ip} must be private or reserved`);
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.throws(() => validateOnlinePdfUrl('http://127.0.0.1/private.pdf'), /Private or reserved/);
  assert.throws(() => validateOnlinePdfUrl('http://localhost/file.pdf'), /Private or internal/);
  assert.throws(() => validateOnlinePdfUrl('file:///etc/passwd'), /HTTP or HTTPS/);
  assert.throws(() => validateOnlinePdfUrl('https://user:password@example.org/book.pdf'), /embedded credentials/);
  assert.equal(validateOnlinePdfUrl('https://example.org/book.pdf').hostname, 'example.org');
  await assert.rejects(fetchPublicPdf('https://example.org/book.pdf', { resolveHost: async () => [{ address: '127.0.0.1', family: 4 }] }), /private or reserved/);
  const safeResolver = async () => [{ address: '8.8.8.8', family: 4 }];
  const pdfBytes = await pdfFixture();
  const fetched = await fetchPublicPdf('https://example.org/verified.pdf', { resolveHost: safeResolver, request: async () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: pdfBytes }) });
  assert.deepEqual(fetched.buffer, pdfBytes);
  assert.equal(fetched.finalUrl, 'https://example.org/verified.pdf');
  let redirectedRequests = 0;
  await assert.rejects(fetchPublicPdf('https://example.org/redirect.pdf', { resolveHost: safeResolver, request: async () => { redirectedRequests++; return { status: 302, location: 'http://169.254.169.254/latest/meta-data/' }; } }), /Private or reserved/);
  assert.equal(redirectedRequests, 1, 'the private redirect is rejected before a second request');
  await assert.rejects(fetchPublicPdf('https://example.org/not-pdf', { resolveHost: safeResolver, request: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>not a PDF</html>') }) }), /valid PDF/);
  await assert.rejects(fetchPublicPdf('https://example.org/oversized.pdf', { maxBytes: 2, resolveHost: safeResolver, request: async () => ({ status: 200, body: pdfBytes }) }), /valid PDF/);
  await assert.rejects(fetchPublicPdf('https://example.org/timeout.pdf', { resolveHost: safeResolver, request: async () => { throw new Error('The PDF download timed out.'); } }), /timed out/);
});
