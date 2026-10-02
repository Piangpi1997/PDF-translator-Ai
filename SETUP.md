# Myanmar Ebook Reader — setup

This repository contains a React/Vite reader and an Express + SQLite API in one app. The existing README, LICENSE, repository identity, and Git history are retained. User data is stored under `.data/` by default; no sample books or fake translations are inserted.

## Local development

1. Install Node.js 22+.
2. Run `npm install`.
3. Copy `.env.example` to `.env`. The checked-in example is configured for local Vite development at `http://localhost:5173`.
4. Run `npm run dev`; Vite listens on port 5173 and proxies `/api` to Express on port 8787.
5. Create an account and import a PDF, DOCX, EPUB, TXT, or a public PDF URL.

Run `npm test` for the Node integration suite and `npm run build` for server syntax checks plus the optimized web build. For production, run `npm run build` then `npm start`; Express serves `dist/` and the API from the same origin.

## Production deployment

Use HTTPS and set a persistent private `APP_DATA_DIR` volume for the SQLite database, original books, and audio. Change `NODE_ENV=production`, set `APP_ORIGIN` to the exact HTTPS application origin, and choose `COOKIE_SAMESITE=strict` for a same-origin application. `APP_ORIGIN` accepts comma-separated exact origins when required; never use a wildcard. Set `TRUST_PROXY=1` only behind a trusted one-hop reverse proxy. Configure encrypted backups, firewall rules, and operational monitoring. Never commit `.env`, `.data/`, originals, or generated audio.

A separate Android WebView/API deployment must allow the exact HTTPS app origins in `APP_ORIGIN`, use `COOKIE_SAMESITE=none` (Secure cookies are forced), and configure the API origin in app Settings. The deployment must still serve the server, database, and private user files; the APK does not contain these services.

## Translation providers

Provider choice is saved on the book and job and retained on retry. Free AI uses a host-managed InvokeLLM-compatible endpoint configured only on the server with `INVOKE_LLM_URL` and optionally `INVOKE_LLM_TOKEN`. No user API key is required, but the adapter is unavailable until the host supplies that endpoint; it fails the job rather than generating placeholder text. Kimi K3 reads `KIMI_API_KEY` only on the server, with model `kimi-k3` and default base `https://api.moonshot.ai/v1`. Never place provider credentials in Vite variables, browser storage, or a public repository.

## Import, OCR, and audio

Online PDF downloads are made by the server with public-address/DNS checks, redirect revalidation, a 25 MB ceiling, timeout, and PDF signature verification. The imported file is stored privately and duplicate URLs are checked per owner. PDF pages without extractable text are marked `ocr_required`; OCR is **not implemented**. Such pages are never guessed, approved, or counted toward a fully translated book. Pages containing both text and images are marked `mixed` and warn that image text may be missing. DOCX/EPUB ZIP expansion is limited to 120 MB.

For PDF sources, reader thumbnails are rendered lazily in the browser from the owner's authenticated original PDF. DOCX, EPUB, and TXT preview panels use page text excerpts; they do not reproduce original page layout or embedded-image previews.

Audio is page-level and requires an approved Myanmar translation plus an optional `TTS_API_URL` adapter. The adapter sends text only and deliberately does not force a Myanmar `language_code`; until a compatible speech service is configured, generation reports unavailable. Native Myanmar pronunciation is not asserted. Existing audio files are preserved if regeneration fails and are marked outdated when the approved translation changes.

Only TXT export is implemented. PDF/EPUB/DOCX/MP3 export is unavailable.

## Android APK

The repository includes a Capacitor Android wrapper. With Android SDK Platform 35, Build Tools 35, Platform Tools, and a supported JDK installed, run `npm run android:debug`. The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. It bundles the web client, **not** the Node API or SQLite database, so an Android installation needs a reachable configured backend. A successful APK build is not evidence of an install/run test on an Android device or emulator.

## Security boundaries

Authentication uses salted scrypt password hashes and opaque, hashed HttpOnly session cookies. Child records and notification queries are owner-scoped in SQL; the server ignores caller-supplied `owner_id`. Online-PDF requests are server-side with SSRF controls. Imported files and audio are stored locally with restrictive permissions; internal filesystem paths and content hashes are not exposed in public book/audio listing APIs. Production deployments must use HTTPS, exact trusted origins, persistent private storage/backups, edge rate limiting, and monitoring.
