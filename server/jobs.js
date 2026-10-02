import { randomUUID, createHash } from 'node:crypto';
import { db as defaultDb, nowIso } from './db.js';
import { translateWithProvider } from './providers.js';

const PAGE_BATCH = Math.max(1, Math.min(8, Number(process.env.TRANSLATION_PAGES_PER_CHUNK) || 5));
const validProvider = value => value === 'free_ai' || value === 'kimi_k3';
const needsOcr = page => page.content_state === 'ocr_required' || !String(page.original_text || '').trim();

export function emitNotification(db, ownerId, eventKey, kind, message, entityId = null) {
  db.prepare(`INSERT OR IGNORE INTO notifications(id,owner_id,event_key,kind,message,entity_id,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), ownerId, eventKey, kind, message, entityId, nowIso());
}

export function bookTranslationState(db, bookId, ownerId) {
  const total = db.prepare('SELECT COUNT(*) AS count FROM pages WHERE book_id=? AND owner_id=?').get(bookId, ownerId).count;
  const translated = db.prepare("SELECT COUNT(*) AS count FROM pages WHERE book_id=? AND owner_id=? AND translation_text IS NOT NULL AND translation_status='completed'").get(bookId, ownerId).count;
  const ocr = db.prepare("SELECT COUNT(*) AS count FROM pages WHERE book_id=? AND owner_id=? AND (content_state='ocr_required' OR trim(original_text)='')").get(bookId, ownerId).count;
  const missing = db.prepare("SELECT COUNT(*) AS count FROM pages WHERE book_id=? AND owner_id=? AND content_state!='ocr_required' AND trim(original_text)!='' AND (translation_text IS NULL OR translation_status!='completed')").get(bookId, ownerId).count;
  const latest = db.prepare('SELECT status FROM document_jobs WHERE book_id=? AND owner_id=? ORDER BY created_at DESC LIMIT 1').get(bookId, ownerId);
  let state = 'not_started';
  if (latest?.status === 'processing' || latest?.status === 'queued') state = 'processing';
  else if (missing > 0 && translated > 0) state = 'partially_translated';
  else if (missing > 0) state = latest?.status === 'failed' ? 'failed' : 'not_started';
  else if (ocr > 0) state = 'ocr_required';
  else if (total > 0 && translated === total) state = 'completed';
  db.prepare('UPDATE books SET translation_status=?, finished_at=? WHERE id=? AND owner_id=?')
    .run(state, state === 'completed' ? (db.prepare('SELECT finished_at FROM books WHERE id=? AND owner_id=?').get(bookId, ownerId)?.finished_at || nowIso()) : null, bookId, ownerId);
  return { total, translated, ocr_required: ocr, missing, status: state, percent: total ? Math.floor((translated / total) * 100) : 0 };
}

export function createTranslationJob(db, { bookId, ownerId, provider, pageNumber = null, force = false }) {
  if (!validProvider(provider)) { const error = new Error('Select Free AI or Kimi K3 as the translation provider.'); error.status = 400; throw error; }
  const book = db.prepare('SELECT id,title FROM books WHERE id=? AND owner_id=?').get(bookId, ownerId);
  if (!book) { const error = new Error('Book not found.'); error.status = 404; throw error; }
  if (pageNumber == null) {
    const active = db.prepare("SELECT id,provider,status FROM document_jobs WHERE book_id=? AND owner_id=? AND status IN ('queued','processing') ORDER BY created_at DESC LIMIT 1").get(bookId, ownerId);
    if (active) return { id: active.id, provider: active.provider, status: active.status, reused: true };
  }
  const id = randomUUID();
  const now = nowIso();
  const pages = pageNumber == null
    ? db.prepare('SELECT page_number,content_state,original_text,translation_text FROM pages WHERE book_id=? AND owner_id=? ORDER BY page_number').all(bookId, ownerId)
    : db.prepare('SELECT page_number,content_state,original_text,translation_text FROM pages WHERE book_id=? AND owner_id=? AND page_number=?').all(bookId, ownerId, Number(pageNumber));
  if (!pages.length) { const error = new Error('Page not found.'); error.status = 404; throw error; }
  db.prepare(`INSERT INTO document_jobs(id,book_id,owner_id,provider,status,total_chunks,created_at,updated_at)
    VALUES(?,?,?,?,'queued',0,?,?)`).run(id, bookId, ownerId, provider, now, now);
  const insertChunk = db.prepare(`INSERT INTO chunk_jobs(id,document_job_id,book_id,owner_id,chunk_number,start_page,end_page,provider,status,force_regenerate,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const grouped = pageNumber == null
    ? Array.from({ length: Math.ceil(pages.length / PAGE_BATCH) }, (_, index) => pages.slice(index * PAGE_BATCH, (index + 1) * PAGE_BATCH))
    : [pages];
  db.transaction(() => {
    grouped.forEach((group, index) => {
      const actionable = group.some(page => !needsOcr(page) && (force || !page.translation_text));
      const hasOcr = group.some(needsOcr);
      const allAlreadyDone = group.every(page => needsOcr(page) || Boolean(page.translation_text && !force));
      const status = actionable ? 'queued' : hasOcr ? 'ocr_required' : allAlreadyDone ? 'completed' : 'failed';
      insertChunk.run(randomUUID(), id, bookId, ownerId, index + 1, group[0].page_number, group[group.length - 1].page_number, provider, status, force ? 1 : 0, now, now);
    });
    const totalChunks = grouped.length;
    const completedChunks = db.prepare("SELECT COUNT(*) AS count FROM chunk_jobs WHERE document_job_id=? AND owner_id=? AND status='completed'").get(id, ownerId).count;
    db.prepare('UPDATE document_jobs SET total_chunks=?,completed_chunks=?,updated_at=? WHERE id=? AND owner_id=?').run(totalChunks, completedChunks, now, id, ownerId);
    db.prepare('UPDATE books SET translation_provider=?,translation_status=?,finished_at=NULL WHERE id=? AND owner_id=?').run(provider, 'processing', bookId, ownerId);
  })();
  emitNotification(db, ownerId, `job:${id}:started`, 'translation_started', `Translation started with ${provider === 'free_ai' ? 'Free AI' : 'Kimi K3'}.`, id);
  const ocrPages = pages.filter(needsOcr).length;
  if (ocrPages) emitNotification(db, ownerId, `job:${id}:ocr`, 'ocr_required', `${ocrPages} page(s) need OCR. No translation will be invented for unreadable pages.`, bookId);
  return { id, provider, status: 'queued', total_chunks: grouped.length, reused: false };
}

function finalizeJob(db, job) {
  const counts = db.prepare(`SELECT
    SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN status='ocr_required' THEN 1 ELSE 0 END) AS ocr,
    SUM(CASE WHEN status IN ('queued','processing') THEN 1 ELSE 0 END) AS pending
    FROM chunk_jobs WHERE document_job_id=? AND owner_id=?`).get(job.id, job.owner_id);
  const status = counts.failed > 0 ? 'failed' : counts.pending > 0 ? 'queued' : counts.ocr > 0 ? 'ocr_required' : 'completed';
  const now = nowIso();
  db.prepare('UPDATE document_jobs SET status=?,completed_chunks=?,failed_chunks=?,error_message=?,updated_at=?,finished_at=? WHERE id=? AND owner_id=?')
    .run(status, counts.completed || 0, counts.failed || 0, counts.failed ? 'One or more chunks need retry.' : null, now, ['completed','failed','ocr_required'].includes(status) ? now : null, job.id, job.owner_id);
  const bookState = bookTranslationState(db, job.book_id, job.owner_id);
  if (status === 'completed' && bookState.status === 'completed') emitNotification(db, job.owner_id, `job:${job.id}:completed`, 'translation_completed', 'Translation completed for all readable pages.', job.book_id);
  if (status === 'failed') emitNotification(db, job.owner_id, `job:${job.id}:failed:${counts.failed}`, 'translation_failed', 'Translation could not finish. Review the provider configuration and retry failed chunks.', job.book_id);
  if (status === 'ocr_required' || bookState.ocr_required > 0) emitNotification(db, job.owner_id, `job:${job.id}:ocr`, 'ocr_required', `${bookState.ocr_required} page(s) need OCR before translation can be complete.`, job.book_id);
  return status;
}

let workerRunning = false;
export async function runQueuedJobs(db = defaultDb, translate = translateWithProvider) {
  if (workerRunning) return;
  workerRunning = true;
  try {
    let turns = 0;
    while (turns++ < 1000) {
      const job = db.prepare("SELECT * FROM document_jobs WHERE status IN ('queued','processing') ORDER BY created_at LIMIT 1").get();
      if (!job) break;
      db.prepare("UPDATE document_jobs SET status='processing',updated_at=? WHERE id=? AND owner_id=?").run(nowIso(), job.id, job.owner_id);
      const chunk = db.prepare("SELECT * FROM chunk_jobs WHERE document_job_id=? AND owner_id=? AND status='queued' ORDER BY chunk_number LIMIT 1").get(job.id, job.owner_id);
      if (!chunk) { finalizeJob(db, job); continue; }
      const pages = db.prepare('SELECT * FROM pages WHERE book_id=? AND owner_id=? AND page_number BETWEEN ? AND ? ORDER BY page_number').all(job.book_id, job.owner_id, chunk.start_page, chunk.end_page);
      const selected = pages.filter(page => !needsOcr(page) && String(page.original_text).trim() && (chunk.force_regenerate || !page.translation_text));
      if (!selected.length) {
        const status = pages.some(needsOcr) ? 'ocr_required' : 'completed';
        db.prepare('UPDATE chunk_jobs SET status=?,updated_at=? WHERE id=? AND owner_id=?').run(status, nowIso(), chunk.id, job.owner_id);
        finalizeJob(db, job);
        continue;
      }
      db.prepare("UPDATE chunk_jobs SET status='processing',attempts=attempts+1,updated_at=? WHERE id=? AND owner_id=?").run(nowIso(), chunk.id, job.owner_id);
      try {
        const glossary = db.prepare('SELECT source_term,target_term,note FROM glossary_terms WHERE owner_id=?').all(job.owner_id);
        const translations = await translate(job.provider, { pages: selected, glossary });
        if (!Array.isArray(translations) || translations.length !== selected.length || translations.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Provider did not return complete translations.');
        const changed = [];
        db.transaction(() => {
          selected.forEach((page, index) => {
            const translation = translations[index].trim();
            if (page.translation_text !== translation) changed.push(page.page_number);
            db.prepare("UPDATE pages SET translation_text=?,translation_status='completed',updated_at=? WHERE id=? AND book_id=? AND owner_id=?")
              .run(translation, nowIso(), page.id, job.book_id, job.owner_id);
            if (page.translation_text !== translation) {
              db.prepare("UPDATE audio_files SET status='outdated',updated_at=?,error_message='Translation changed; regenerate this audio.' WHERE book_id=? AND owner_id=? AND page_number=? AND status IN ('ready','generating')")
                .run(nowIso(), job.book_id, job.owner_id, page.page_number);
            }
          });
          const hasOcr = pages.some(needsOcr);
          db.prepare('UPDATE chunk_jobs SET status=?,last_error=NULL,updated_at=? WHERE id=? AND owner_id=?')
            .run(hasOcr ? 'ocr_required' : 'completed', nowIso(), chunk.id, job.owner_id);
        })();
        if (changed.length) emitNotification(db, job.owner_id, `job:${job.id}:audio-outdated:${changed.join(',')}`, 'audio_outdated', 'Audio for changed translations must be regenerated.', job.book_id);
        finalizeJob(db, job);
      } catch (error) {
        const message = String(error?.message || 'Translation provider failed.').replace(/(?:key|token|authorization|bearer)\s*[:=]?\s*\S+/gi, '[redacted]').slice(0, 240);
        db.prepare("UPDATE chunk_jobs SET status='failed',last_error=?,updated_at=? WHERE id=? AND owner_id=?").run(message, nowIso(), chunk.id, job.owner_id);
        emitNotification(db, job.owner_id, `job:${job.id}:chunk-failed:${chunk.id}:${chunk.attempts + 1}`, 'chunk_failed', `A translation chunk failed: ${message}`, chunk.id);
        finalizeJob(db, job);
        break; // Do not hammer an unavailable provider; explicit retry resumes failed and queued chunks.
      }
    }
  } finally {
    workerRunning = false;
  }
}

export function retryJob(db, jobId, ownerId) {
  const job = db.prepare('SELECT * FROM document_jobs WHERE id=? AND owner_id=?').get(jobId, ownerId);
  if (!job) { const error = new Error('Translation job not found.'); error.status = 404; throw error; }
  const result = db.prepare("UPDATE chunk_jobs SET status='queued',last_error=NULL,updated_at=? WHERE document_job_id=? AND owner_id=? AND status='failed'").run(nowIso(), jobId, ownerId);
  if (!result.changes) { const error = new Error('This job has no failed chunks to retry.'); error.status = 409; throw error; }
  db.prepare("UPDATE document_jobs SET status='queued',error_message=NULL,finished_at=NULL,updated_at=? WHERE id=? AND owner_id=?").run(nowIso(), jobId, ownerId);
  db.prepare("UPDATE books SET translation_status='processing',translation_provider=? WHERE id=? AND owner_id=?").run(job.provider, job.book_id, ownerId);
  emitNotification(db, ownerId, `job:${jobId}:retry:${nowIso()}`, 'retry', 'Translation retry queued; completed chunks are skipped.', jobId);
  return { id: jobId, provider: job.provider, status: 'queued' };
}

export function resumeStaleJobs(db, staleAfterMs = 10 * 60 * 1000) {
  const staleBefore = new Date(Date.now() - staleAfterMs).toISOString();
  const stale = db.prepare("SELECT id,owner_id,book_id FROM document_jobs WHERE status='processing' AND updated_at<?").all(staleBefore);
  db.prepare("UPDATE chunk_jobs SET status='queued',updated_at=? WHERE status='processing' AND updated_at<?").run(nowIso(), staleBefore);
  db.prepare("UPDATE document_jobs SET status='queued',updated_at=? WHERE status='processing' AND updated_at<?").run(nowIso(), staleBefore);
  for (const job of stale) emitNotification(db, job.owner_id, `job:${job.id}:resume:${staleBefore}`, 'resume', 'A paused translation job was recovered and can resume.', job.book_id);
  return stale.length;
}

export function translationFingerprint(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}
