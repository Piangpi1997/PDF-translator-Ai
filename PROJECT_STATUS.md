# Project validation status

Validated locally on 2026-10-02 against base commit `75a64770c6c40ca414ca95e3d33fcae12252a16c`. This remains a working implementation, not a fully complete translation platform: OCR and live translation/TTS services are not configured here. The current UI and settings changes are local and unpublished; no commit or push has been made.

## PASS

- `npm test`: **13 passed, 0 failed**. This includes the existing document, ownership, reader, translation, audio, and security integration coverage plus backend-origin validation and health-check request tests.
- `npm run build`: backend syntax checks and optimized Vite build pass. Latest client output: JavaScript 360.70 KB (109.86 KB gzip), CSS 27.85 KB (6.89 KB gzip), and the lazy PDF.js chunk 415.93 KB (123.51 KB gzip).
- Production smoke check returns HTTP 200 for `/` and `/api/health`; health reports `{ "ok": true, "service": "myanmar-ebook-reader" }`.
- Chromium visual review covered the sign-in screen at 1440×1000 and 390×844, plus the signed-in Settings screen at desktop and 390 px mobile width. The server health-check control responded successfully; no horizontal overflow was observed at 390 px.
- `npm run android:debug` passes, including the production web build, Capacitor sync, and `assembleDebug`. `testDebugUnitTest` and `assembleDebugAndroidTest` also pass.
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`, **4,913,848 bytes**, package `com.piangpi.myanmarebookreader`, min SDK 23, target SDK 35. ZIP integrity passes; Android Build Tools 35.0.0 `apksigner` verifies v1 and v2 signatures. SHA-256: `05b6a501f4d46c5123e14e78a1df7fa02e4c06da33506dfa5e84645095d56443`.

## PARTIAL / not live-tested

Translation adapters and resumable job behavior are implemented and tested with deterministic responses, but **no InvokeLLM endpoint or Kimi API key is configured**, so no live translation request or translation-quality claim was made. Audio requires a compatible server-side `TTS_API_URL`, which is also not configured. Approval gating, playback routes, and preservation of prior audio after a failed regeneration are tested; live speech and Myanmar voice quality were not tested.

No `adb` device or emulator is available, so APK installation and on-device runtime behavior were not tested. The APK contains the client only and requires a reachable API/database backend. TXT export works; PDF/EPUB/DOCX/MP3 exports are unavailable.

## NOT IMPLEMENTED

**OCR recognition is not implemented.** PDF pages without extractable text remain `ocr_required`; translation and approval are blocked, and a book is never marked fully translated while such pages remain unresolved. Mixed text/image pages warn that image text may be missing.

## Publication state

The public repository target remains `main`, based on commit `75a64770c6c40ca414ca95e3d33fcae12252a16c`. The local changes are **not staged, committed, or pushed** and await approval of the exact change set and target. The existing `LICENSE` is unchanged.
