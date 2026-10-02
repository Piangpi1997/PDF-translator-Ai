import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.APP_DATA_DIR || '.data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(dataDir, 'audio'), { recursive: true, mode: 0o700 });

export const db = new Database(path.join(dataDir, 'reader.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Every child record carries owner_id; APIs derive it from the authenticated user and book.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Other' CHECK(category IN ('Fiction','Non-Fiction','Religion','Education','Children','Other')),
  source_type TEXT NOT NULL DEFAULT 'upload' CHECK(source_type IN ('upload','online_pdf')),
  source_url TEXT,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  translation_provider TEXT NOT NULL DEFAULT 'free_ai' CHECK(translation_provider IN ('free_ai','kimi_k3')),
  translation_status TEXT NOT NULL DEFAULT 'not_started',
  total_pages INTEGER NOT NULL DEFAULT 0,
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0,1)),
  added_at TEXT NOT NULL,
  last_opened_at TEXT,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS books_owner_online_url ON books(owner_id, source_url) WHERE source_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS books_owner_added ON books(owner_id, added_at DESC);
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL CHECK(page_number > 0),
  original_text TEXT NOT NULL DEFAULT '',
  translation_text TEXT,
  content_state TEXT NOT NULL DEFAULT 'normal' CHECK(content_state IN ('normal','ocr_required','mixed')),
  structure_json TEXT NOT NULL DEFAULT '[]',
  translation_status TEXT NOT NULL DEFAULT 'not_started',
  approved_at TEXT,
  flagged INTEGER NOT NULL DEFAULT 0 CHECK(flagged IN (0,1)),
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, page_number)
);
CREATE INDEX IF NOT EXISTS pages_owner_book ON pages(owner_id, book_id, page_number);
CREATE TABLE IF NOT EXISTS elements (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  element_order INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'paragraph',
  original_text TEXT NOT NULL DEFAULT '',
  translated_text TEXT,
  heading_level INTEGER,
  formatting_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(page_id, element_order)
);
CREATE INDEX IF NOT EXISTS elements_owner_page ON elements(owner_id, page_id, element_order);
CREATE TABLE IF NOT EXISTS document_jobs (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('free_ai','kimi_k3')),
  status TEXT NOT NULL DEFAULT 'queued',
  total_chunks INTEGER NOT NULL DEFAULT 0,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  failed_chunks INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS document_jobs_owner_status ON document_jobs(owner_id, status, updated_at);
CREATE TABLE IF NOT EXISTS chunk_jobs (
  id TEXT PRIMARY KEY,
  document_job_id TEXT NOT NULL REFERENCES document_jobs(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chunk_number INTEGER NOT NULL,
  start_page INTEGER NOT NULL,
  end_page INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('free_ai','kimi_k3')),
  status TEXT NOT NULL DEFAULT 'queued',
  force_regenerate INTEGER NOT NULL DEFAULT 0 CHECK(force_regenerate IN (0,1)),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(document_job_id, chunk_number)
);
CREATE INDEX IF NOT EXISTS chunk_jobs_status ON chunk_jobs(status, updated_at);
CREATE TABLE IF NOT EXISTS glossary_terms (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_term TEXT NOT NULL,
  normalized_source TEXT NOT NULL,
  target_term TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, normalized_source)
);
CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, book_id, page_number)
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_number INTEGER,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_owner_book ON notes(owner_id, book_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  selected_text TEXT NOT NULL,
  color TEXT NOT NULL CHECK(color IN ('amber','rose','mint','sky')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS highlights_owner_page ON highlights(owner_id, book_id, page_number);
CREATE TABLE IF NOT EXISTS audio_files (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('generating','ready','failed','outdated')),
  file_path TEXT,
  mime_type TEXT,
  translation_fingerprint TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, book_id, page_number)
);
CREATE INDEX IF NOT EXISTS audio_owner_status ON audio_files(owner_id, status, updated_at DESC);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_id TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT,
  dismissed_at TEXT,
  UNIQUE(owner_id, event_key)
);
CREATE INDEX IF NOT EXISTS notifications_owner_time ON notifications(owner_id, created_at DESC);
CREATE TABLE IF NOT EXISTS reading_progress (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, book_id)
);
CREATE TABLE IF NOT EXISTS reading_activity (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  activity_date TEXT NOT NULL,
  seconds_read INTEGER NOT NULL DEFAULT 0,
  UNIQUE(owner_id, book_id, page_number, activity_date)
);
`);

// Preserve existing reader data while applying additive schema upgrades.
const chunkJobColumns = db.pragma('table_info(chunk_jobs)').map(column => column.name);
if (!chunkJobColumns.includes('force_regenerate')) {
  db.exec("ALTER TABLE chunk_jobs ADD COLUMN force_regenerate INTEGER NOT NULL DEFAULT 0 CHECK(force_regenerate IN (0,1))");
}

export const dataPath = dataDir;
export const nowIso = () => new Date().toISOString();
export const makeId = () => randomUUID();
