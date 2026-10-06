# Myanmar Ebook Reader — validation status

Validated on 2026-10-06 from the existing `main` commit `55aea8a2167614985f4ed4dd929e3dceffc4e89e` (the prior UI-polish commit). The React/Vite, Express, SQLite and Capacitor Android architecture, repository identity, Git history, `LICENSE`, and user-data locations were preserved. Changes remain uncommitted and unpublished; no commit or push was made.

## Build, tests, and clean source archive

**PASS — regression tests:** `npm test` completed with 17 passed and 0 failed. The suite covers the local document formats, owner isolation, book/reader features, OCR safeguards, review actions, notification handling, audio failure preservation, AI provider settings, provider persistence, retries, and large-document structure.

**PASS — production build:** `npm run build` passed backend syntax checks (including the provider-credential, provider HTTP, and online-PDF modules) and Vite production compilation. **PASS — local development smoke:** `npm run dev` started the API and Vite on disposable temporary data; `/api/health` returned `{"ok":true,"service":"myanmar-ebook-reader"}` and Vite returned HTTP 200. The temporary directory was removed afterward.

**PASS — clean source ZIP:** the 92-file archive was extracted to a fresh temporary directory; `npm install --no-audit --no-fund` completed, and `npm run dev` then passed the API health and Vite HTTP checks. The ZIP includes source, configs, docs, tests, Capacitor/Gradle wrapper, `.env.example`, and `LICENSE`; it excludes `.git`, `node_modules`, `dist`/build/cache, `.env`, local Android SDK properties, signing material, databases, private files, and generated audio. The archive hash and exact path are delivered separately.

**PASS — large-document structure:** a deterministic 650-page simulation verified complete ordered manifests, unique pages/chunks, progress/completion, completed-page skipping, and stale-work recovery. This is not a live 650-page AI translation claim.

## Import, online PDF, reader, and library

**PASS — local imports:** authenticated route tests imported PDF, DOCX, EPUB, and TXT files and verified parsed pages. **PASS — public PDF:** the default server-side import route fetched the real public W3C sample `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf` (13,264 bytes, one page), stored a private copy, reopened it through the authenticated original-file endpoint, and returned page data. Reopen used the stored copy rather than refetching the remote URL. Private/reserved IPv4 and IPv6, loopback/internal hosts, unsafe redirects, invalid/oversized PDF content, and timeouts are covered by safety tests. A multi-address DNS callback defect found during the live check was fixed without weakening validation.

**PASS — reader data and existing tools:** progress read-back, search, TOC, previews, bookmarks, notes CRUD/search, highlights, glossary records, statistics, ownership, and provider persistence/retry paths passed API tests. **PARTIAL — Original Reader visual flow:** after online import the UI navigates to `/reader/:id?page=1&mode=original`; the stored PDF and reader endpoints passed, and the production UI compiled. A signed-in visual check was not completed because browser safeguards blocked automated password entry. Signed-in mobile/desktop overflow checks therefore remain unverified.

## AI providers and security

**PASS — settings/API security:** authenticated save, masked key status, Test Connection, Clear/Delete, missing-key errors, invalid URL rejection, and User A/User B isolation passed with a test-only encryption key and a local OpenAI-compatible HTTP fixture. Full keys were absent from responses and SQLite plaintext; caller-supplied `owner_id` was ignored. User keys use AES-256-GCM with random IVs and owner/provider associated data. Without the server master key, saves are refused rather than stored unencrypted.

**PASS — custom adapter contract:** a backend `/models` test and `/chat/completions` request to the local fixture verified provider/model/key wiring and book/job/chunk/retry persistence. The fixture response tests plumbing only; it is not claimed as real translation. **PARTIAL — deployment readiness:** this workspace has no configured `INVOKE_LLM_URL`, live Kimi key, TTS service, or persistent `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`. A deployment must set and securely back up the stable 32-byte encryption key described in `SETUP.md`; it is deliberately absent from the source ZIP. **NOT TESTED — live translation:** no real InvokeLLM, Kimi K3, or external custom-provider credential/service was available, so live connection, Kimi, and translation-quality claims are not made.

**PASS — provider/job safety:** provider choice persisted on books, document jobs, and chunks; retry/resume preserves it. Tests cover failed-chunk retry, stale-work recovery, completed-page skipping, no duplicate pages, and preserving previous translation on provider failure. The 650-page test is structural only.

## OCR, review, audio, notifications, and export

**PASS — OCR safeguards:** text, mixed, and empty PDF pages are distinguished; OCR-required pages cannot be translated/approved by guessing and prevent a fully translated state. OCR recognition itself is unavailable. **PASS — review behavior:** edit, approve, flag/unflag, and regeneration request paths were tested; absent provider credentials fail honestly while preserving the existing translation.

**PASS — notification API:** owner isolation, duplicate event-key suppression, read/read-all, and dismissal passed. **PARTIAL — audio:** approval gating, unavailable-service behavior, existing-file preservation after failure, and outdated marking were tested; live TTS and Myanmar voice support were not available. **PARTIAL — export:** TXT remains the implemented export; PDF/EPUB/DOCX/MP3 exports are unavailable and no placeholder files are produced.

## Android and publication

**PASS — Android build/tests:** `npm run android:debug` produced `android/app/build/outputs/apk/debug/app-debug.apk`; `./gradlew testDebugUnitTest assembleDebugAndroidTest` succeeded. APK archive integrity and v1/v2 debug-signature verification passed. Application ID is `com.piangpi.myanmarebookreader`, min SDK 23, target SDK 35. **NOT TESTED — device runtime:** `adb` is unavailable, so install and interactive device/emulator behavior were not tested. The APK contains the client only and needs a reachable HTTPS backend; it does not include the Node API or SQLite service.

**PASS — publication boundary:** branch remains `main` at the existing commit; no staging, commit, or push occurred. The source ZIP leaves the existing project data untouched and excludes generated/private data. **PARTIAL — responsive UI:** responsive provider-form styles compile, but signed-in mobile/desktop visual inspection remains unverified in this run.
