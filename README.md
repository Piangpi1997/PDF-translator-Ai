# PDF-translator-Ai
AI-powered ebook translator and reader for translating PDF, EPUB, DOCX, TXT, and online PDFs into Myanmar with AI translation, review, audio, notes, highlights, and smart reading tools.

## What is in this repository

A full-stack reader workspace built as a React/Vite client with an Express API and persistent SQLite database. It keeps user libraries isolated and stores source files/audio on the configured private server data volume. The existing repository, README, license, and Git history are retained.

Implemented workflows include:

- Account sign-up/sign-in with salted scrypt password hashes and private cookie sessions.
- Import of PDF, DOCX, EPUB, TXT, and server-fetched public PDF URLs, with duplicate checks and preserved page/heading/paragraph records.
- Owner-private library, favorites, categories, filters, sorting, saved reading progress, reading-time/activity statistics, and TXT export.
- Side-by-side original/Myanmar reader modes, page navigation, full-screen and keyboard controls, configurable Myanmar fonts/themes, book search, TOC, lazy PDF page-image previews, text previews for other formats, bookmarks, editable/searchable private notes, and colored highlights.
- Resumable, idempotent translation jobs with provider persisted per book/job, bounded page chunks, retries, review/edit/approval, and owner-private notifications.
- Owner-private glossary CRUD/search/JSON import/export, plus page-level audio records and playback routes when a speech provider is configured.
- Secure server-side provider adapters for host-managed InvokeLLM, Kimi K3, and optional TTS; credentials are not placed in browser code.
- A Capacitor Android wrapper that packages the web client.

## Run locally

Requirements: Node.js 22 or newer.

```bash
npm install
cp .env.example .env
npm run dev
```

Open the Vite URL printed by the development server (port 5173 by default), create an account, and import a book. Local settings in `.env.example` allow the Vite origin. Keep `.env` and `.data/` private; neither is tracked by Git.

## Verify and build

```bash
npm test
npm run build
```

To build the Android debug APK, install Android SDK Platform 35, Build Tools 35, and a compatible JDK (17+), then run:

```bash
npm run android:debug
```

The APK is produced at `android/app/build/outputs/apk/debug/app-debug.apk`. It contains the web client, not the Node/SQLite server; set the reachable HTTPS API origin in app Settings before expecting library/authentication to work on a device.

## Important limitations

- OCR is **not implemented**. A PDF page with no extractable text remains explicitly `ocr_required`, cannot be translated or approved, and prevents the book from being reported fully translated. Image text on mixed text/image pages may also require OCR.
- Translation is real only when a service is configured. Free AI requires a host-managed InvokeLLM-compatible `INVOKE_LLM_URL`; Kimi K3 requires a server-only `KIMI_API_KEY`. Without them the UI reports unavailable and jobs fail honestly rather than inventing translations.
- Audio generation requires a compatible server-side `TTS_API_URL`. The adapter does not claim Myanmar pronunciation or send an unsupported language code.
- TXT export is available. PDF, EPUB, DOCX, and MP3 export are not implemented.
- The Android package is a client wrapper that requires a backend; it is not a standalone offline app. A device/emulator runtime install test is separate from a successful APK build.

See [SETUP.md](SETUP.md) for deployment, provider, data-storage, and security details. See [notes/EXTERNAL-FACTS.md](notes/EXTERNAL-FACTS.md) for provider/platform documentation checked during implementation.
