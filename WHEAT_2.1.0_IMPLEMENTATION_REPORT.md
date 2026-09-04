# Wheat 2.1.0 implementation report

Date: 2026-08-26  
Final application version: **2.1.0**  
Target: Windows x64 desktop, local-first Electron/React/TypeScript/Prisma/SQLite application

## Executive result

Wheat now identifies itself as version 2.1.0 in package metadata, the lockfile, runtime startup diagnostics, UI fallback, migration identity, and generated Windows metadata. The upgrade adds the complete shared PCGE hierarchy, journal/fiscal-year piece sequencing, a real restart repair, expanded exact-cent reporting, guarded opening/fiscal foundations, adaptive bank and invoice OCR, and an optional local Wheat AI runtime with typed accounting tools.

The ordinary application works without Wheat AI models. No multi-gigabyte LLM is bundled. A live, opt-in test downloaded the pinned Lite model, verified its exact byte count and SHA-256, installed llama.cpp, ran a CPU-only test inference, performed a normal local chat, and recoverably uninstalled it.

The statutory boundary is intentional: the accounting foundation and report engines are implemented, but Wheat does **not** claim verified final Moroccan statutory forms or a submission-ready liasse where an authoritative, versioned mapping/template was not available and verified.

## Authoritative inputs and provenance

- Primary accounting authority: [Moroccan Conseil National de la Comptabilité — normes](https://www.finances.gov.ma/fr/Nos-metiers/Pages/cnc-normes.aspx) and the linked [official CGNC PDF](https://www.finances.gov.ma/Publication/depp/2010/7004_recettes_priv_annee25_11_210.pdf). The 626-page scan was inspected visually; local SHA-256: `e42e7bfa4791abb4962cb78abf8396ded84878b3f0bcc3946a8a2e549095faa6`.
- `plancomptable.ma` was used only as a transcription/checking aid for difficult scan text. The official CGNC scan remains the authority recorded in generated data.
- OCR implementation follows the installed PaddleOCR 3.7 APIs, PP-OCR for ordinary text, PP-StructureV3 for layout/table parsing, and an optional PaddleOCR-VL 1.6 path when its local assets are installed.
- Local AI artifacts use immutable revisions and pinned hashes from official [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases), official Qwen GGUF repositories, and one explicitly identified Unsloth GGUF conversion of the official Qwen3 4B Instruct base model.

## 1. PCGE and shared account engine

- **Pre-fix state:** Companies had a small starter chart and no complete class 0–9 hierarchy, stable parent/depth metadata, official/custom distinction, or shared accent-insensitive PCGE lookup.
- **Root cause:** Account rows were treated as a flat operational seed rather than a versioned accounting reference dataset.
- **Files/components changed:** `scripts/build-pcge-data.mjs`, `electron/pcgeData.ts`, `electron/chartOfAccounts21.ts`, `electron/main.ts`, `prisma/seed.ts`, `prisma/schema.prisma`, `src/components/WheatAiWorkspace.tsx` and its styles.
- **Implementation:** Generated and validated 1,134 standard accounts across classes 0–9; added parent codes, hierarchy depth, postability, type/nature/report metadata, Arabic/search aliases, archive state, and custom subdivision inheritance. Official accounts cannot be rewritten; they can only be deactivated. New companies are seeded from the same source.
- **Schema/data impact:** `Account` gains parent/standard/source/search/report fields and indexes. Existing custom rows are preserved by the additive migration.
- **Tests added:** Exact account count and per-class counts; roots 0–9; source metadata; search normalization; desktop company seeding; typed-tool subdivision creation.
- **Runtime verification:** A new company displayed 1,134 official accounts in the expandable PCGE workspace and returned accent-insensitive matches.
- **Post-fix result:** PCGE-dependent UI, reports, fiscal logic, and Wheat AI use one account engine.
- **Remaining risk:** The source CGNC is a scan. Machine transcription was therefore checked structurally and against a secondary transcription aid, but users should still validate any firm-specific statutory mapping with a qualified professional.

## 2. Accounting integrity, schema migration, and numbering

- **Pre-fix state:** Piece numbers were largely caller-provided or based on journal `nextNumber`; there was no explicit journal/fiscal-year reservation record, configurable pattern, raw/search identifier split, or guaranteed no-reuse behavior across every posting path.
- **Root cause:** Number allocation was distributed across manual, invoice, payment, payroll, reversal, and import services.
- **Files/components changed:** `electron/pieceNumbering21.ts`, `electron/main.ts`, `electron/subledger.ts`, `electron/creditNotes14.ts`, `electron/operations13.ts`, `prisma/schema.prisma`, `prisma/migrations/20260825000000_atlas_2_1_foundations/migration.sql`, `electron/database.ts`, `src/App.tsx`.
- **Implementation:** Added transactional per-journal/per-fiscal-year sequences, preview, prefix/pattern/year/padding/separator configuration, historical sequence scanning, uniqueness checks, imported raw identifier preservation, and controlled manual override. Every ledger-producing workflow uses the allocator. Fresh starter journals keep controlled manual override enabled for backward-compatible data entry; a journal can disable it, at which point the generated number is read-only.
- **Schema/data impact:** Added `JournalPieceSequence`; expanded `Journal`, `Entry`, and import/movement trace fields. The additive migration checksum is `094cb89b2655de5b08b5e623ad3122f463ea1a2a4f1b81aeae19dc81950ea118`. Pre-existing journals are migrated with manual override enabled to avoid rejecting historical workflows.
- **Tests added:** Pattern rendering/extraction, exact increments, fiscal-year isolation, disabled-override rejection, duplicate protection, legacy 2.0 data/link/large-cent preservation, foreign-key and integrity checks.
- **Runtime verification:** Electron created sequential posted pieces from the preview, rejected a manual number after the journal setting was disabled, and preserved exact centime totals.
- **Post-fix result:** Numbers are allocated atomically and are never silently reused; manual replacement is an explicit journal policy.
- **Remaining risk:** Multi-process SQLite contention is bounded by the single trusted Electron instance and database transaction; a future server/multi-user edition would need a different allocation boundary.

## 3. Internal restart and global UI reliability

- **Pre-fix state:** Internal restart could leave stale modal/focus state, and the first repair attempt deadlocked because maintenance mode was included in its own drain predicate.
- **Root cause:** Restart entered maintenance before waiting for operations to drain; renderer modal cleanup was not a formal pre-relaunch step.
- **Files/components changed:** `electron/main.ts`, `electron/preload.ts`, `src/App.tsx`, `src/lib/useAccessibleDialog.ts`, `src/types/electron.d.ts`, `tests/atlas-2.1-runtime-restart.spec.cjs`.
- **Implementation:** Restart now blocks new work through shutdown state, drains active work, closes OCR, disconnects Prisma, relaunches, and exits without the self-deadlock. Renderer cleanup removes modal/inert/overflow residue. Shared dialogs synchronously establish focus, reinforce it after animation, trap external focus, restore the trigger, and select the first editable field according to numbering policy.
- **Schema/data impact:** None.
- **Tests added:** A real Electron/CDP relaunch test compares renderer target IDs and types into global search, command palette, PCGE search, and a newly opened entry modal after relaunch. Existing long keyboard/viewport regressions were retained.
- **Runtime verification:** Real process relaunch completed in about 15–22 seconds in repeated runs; no stale dialog, body inert state, pointer lock, or typing failure remained.
- **Post-fix result:** The reproduced P0 restart/input defect is fixed with an actual runtime test.
- **Remaining risk:** Relaunch timing depends on Windows process startup and endpoint security software; the test uses bounded waits rather than a fixed sleep.

## 4. Balance, bank position, Bilan, and drillable reports

- **Pre-fix state:** The app did not expose the complete requested Balance family, comparative prior-year values, shared Bilan aggregation, or currency-safe bank totals.
- **Root cause:** Existing reports were individually shaped and did not share the new PCGE report metadata.
- **Files/components changed:** `electron/reporting21.ts`, `electron/main.ts`, `electron/preload.ts`, `src/types/electron.d.ts`, `src/components/WheatAiWorkspace.tsx` and styles.
- **Implementation:** Added 14 named Balance views, exact opening/period/cumulative fields, journal/date/status filters, comparative N-1/variance values, bounded drill-down, normal three-digit and simplified two-digit Bilan aggregation, class-8 result preference with 6/7 fallback, and separate ledger/statement bank positions grouped by currency.
- **Schema/data impact:** Added `ReportConfiguration`; reused exact `BigInt` centime evidence and shared `Account.reportNature/type` mappings.
- **Tests added:** Exact-cent Balance/Bilan totals, comparative logic, bank grouping, filter behavior, and integration through the Electron preload boundary.
- **Runtime verification:** A posted 125.00 MAD balanced fixture returned exact `12500` debit/credit strings and a balanced Bilan; the Wheat 2.1 workspace rendered the results.
- **Post-fix result:** Reports no longer combine currencies or silently round ledger values.
- **Remaining risk:** “Balance analytique” currently exposes the shared exact account engine but there is no complete cost-center/analytic-allocation subledger in the historical schema.

## 5. Opening balances, fiscal package, and statutory boundary

- **Pre-fix state:** There was no repeat-safe opening workflow or explicit versioned fiscal-package foundation for normal/simplified regimes.
- **Root cause:** Fiscal close controls existed, but retained earnings assignment, opening provenance, package mappings, and adjustment evidence were not modeled together.
- **Files/components changed:** `electron/fiscal21.ts`, `prisma/schema.prisma`, the 2.1 migration, preload/main IPC, and the Clôture panel in `WheatAiWorkspace.tsx`.
- **Implementation:** Opening preview carries only balance-sheet accounts, never blindly carries P&L, requires a verified class-1 retained-earnings account when result exists, hashes the preview, requires explicit confirmation, posts through OD/shared numbering, records source/target lines, and blocks duplicate runs. Fiscal packages are versioned by regime/period, calculate accounting result, require referenced manual adjustments, and validate only verified mappings.
- **Schema/data impact:** Added `OpeningBalanceRun`, `OpeningBalanceLine`, `FiscalPackage`, `FiscalAdjustment`, and relations to company/fiscal years/entries.
- **Tests added:** Balance-sheet-only carry, unassigned-result blocker, exact fiscal package validation, adjustment references, duplicate protection, and additive migration checks.
- **Runtime verification:** The UI preview displayed blockers and required typed confirmation before posting.
- **Post-fix result:** The foundation is auditable and refuses unsupported statutory finalization.
- **Blocked/unverified evidence:** No authoritative, machine-verifiable current final statutory form/mapping package was available in the supplied material. `statutoryFinalizationAvailable` therefore remains `false`; Wheat does not fabricate a DGI/CNC-ready liasse or claim submission compliance.

## 6. Bank import, flexible dates, and raw traceability

- **Pre-fix state:** The 2.0 pipeline supported many formats but strict dates/layouts rejected common Moroccan statements; binary XLS was rejected; totals/carry rows could be mistaken for transactions; raw identifiers were not consistently separated from normalized search values.
- **Root cause:** Parsing assumed stable headers/columns and ISO-like dates.
- **Files/components changed:** `electron/dateNormalization21.ts`, `electron/bankStatementImporter.ts`, `electron/reconciliation.ts`, `resources/paddleocr/xls_reader.py`, `resources/paddleocr/requirements.txt`, schema/migration fields, and bank UI/error tests.
- **Implementation:** Accepts ISO, `DD/MM/YY`, `DD/MM/YYYY`, dash/dot/space variants, `DDMMYY`, `DDMMYYYY`, and `YYYYMMDD`; missing years require reliable statement context. Raw values, inferred flags, page/row class, source IDs, normalized keys, and confidence dimensions persist. Opening/closing/total/subtotal/carry/page rows are excluded from transactions. Binary XLS uses local pinned `xlrd==2.0.2`. Opening + net movement = closing balance is validated when available.
- **Schema/data impact:** Expanded `BankStatementImport` and `BankMovement` trace fields without rewriting prior rows.
- **Tests added:** Date ambiguity/calendar errors, raw retention, shifted/repeated headers, row classification, invalid/corrupt inputs, every supported bank format, deduplication, persistence, and reconciliation.
- **Runtime verification:** The full Electron bank flow reviewed, imported, deduplicated, persisted, and reconciled implemented formats; corrupt data failed with precise French guidance.
- **Post-fix result:** The canonical transaction schema is tolerant at input and strict before persistence.
- **Remaining risk:** Bank-specific proprietary encodings or encrypted/password-protected workbooks remain unsupported.

## 7. Adaptive bank OCR and invoice/document intelligence

- **Pre-fix state:** OCR confidence overrepresented text recognition, fixed bank layouts were brittle, and invoice extraction did not expose a stable exact-cent/evidence contract.
- **Root cause:** Text recognition, geometry, row reconstruction, field mapping, and accounting consistency were conflated.
- **Files/components changed:** `electron/paddleOcr.ts`, `electron/bankStatementImporter.ts`, `electron/smartOcr.ts`, `resources/paddleocr/worker.py`, OCR tests and fixtures.
- **Implementation:** Adaptive row clustering uses relative bounding boxes, semantic header scoring, repeated-page header handling, source pages, and multidimensional confidence (`textRecognition`, `layout`, `rowReconstruction`, `fieldMapping`, `accountingConsistency`, `finalDocument`). Invoice extraction emits `ATLAS_INVOICE_1` with supplier/customer identifiers, dates, currency/payment terms, exact HT/TVA/TTC centime strings, line items, confidence, raw evidence, bounding boxes, and review status. Optional local PaddleOCR-VL 1.6 is invoked only when its assets already exist and ordinary confidence warrants fallback.
- **Schema/data impact:** Existing document JSON remains compatible; the versioned extraction contract is stored inside `Document.extracted`.
- **Tests added:** Irregular shifted table fixture, repeated headers/pages, invoice schema fields/evidence/consistency, Paddle primary-engine behavior, scanned bank PDF, eight meaningful OCR fixtures, scan preview, and local-only behavior.
- **Runtime verification:** PaddleOCR 3.7.0 / PaddlePaddle 3.3.1 / Python 3.12.10 processed clean, rotated/noisy image, digital PDF, scanned PDF, and bank fixtures; all persisted outputs were reviewed through the app.
- **Post-fix result:** Low layout certainty can no longer masquerade as high table certainty.
- **Remaining risk:** PaddleOCR-VL code/API integration is present, but the optional VL 1.6 model weights were not downloaded for this release run; real VL inference is therefore not claimed as runtime-verified.

## 8. Wheat AI local runtime, tools, permissions, and audit

- **Pre-fix state:** No local model manager, hardware recommendation, controlled tool boundary, permission modes, or AI audit trail existed.
- **Root cause:** AI was not part of the prior architecture and direct database prompting would have violated local privacy/accounting controls.
- **Files/components changed:** `electron/wheatAi.ts`, `resources/models/wheat-model-manifest.json`, schema/migration models, main/preload/types IPC, `src/components/WheatAiWorkspace.tsx`, `src/components/Atlas21Ai.css`, and 2.1 AI tests.
- **Implementation:** Hardware profiling measures OS/arch/CPU/logical cores/RAM/free disk/GPU metadata; deterministic selection shows only the best eligible normal-user tier. The local benchmark is persisted. Downloads are HTTPS/host allow-listed, immutable-revision pinned, resumable, byte-counted, inactivity-bounded, SHA-256 verified, safely extracted, test-inferred before activation, and recoverably uninstalled. Known-good assets are not replaced on failed inference. The model never receives a SQLite path, Prisma, or SQL capability. Typed tools enforce company scope, read-only/assistant/automated modes, explicit confirmation for mutations, a hard dedicated-screen boundary for high-stakes posting, and per-call success/failure audit records. Local RAG patterns retain evidence and confidence. While chat inference is pending the renderer shows only `Thinking`; tagged, channel-based, delimited, and malformed reasoning is removed in the main process so only the final response crosses into the UI.
- **Schema/data impact:** Added `AtlasAiSettings`, `AtlasAiAuditEvent`, and `AtlasKnowledgePattern`. Removing all models leaves the accounting app and data intact.
- **Tests added:** Manifest/revision/hash validation, 20 GiB simulated recommendation, real hardware status, typed-tool read/mutation/high-stakes policy, confirmation/audit behavior, UI state, and conditional `atlas-2.1-ai-live.spec.cjs`.
- **Runtime verification:** On the physical test machine, the opt-in live test downloaded Qwen3 Lite, matched exact byte count/SHA, installed llama.cpp b10516, ran CPU-only inference, performed a local chat, and recoverably uninstalled in 57.5 seconds after the cached download. A stalled first transfer exposed and led to the new 60-second inactivity/resume behavior.
- **Post-fix result:** Wheat AI is optional, local, bounded by typed tools, and cannot silently post accounting or fiscal decisions.
- **Remaining risk:** Only Lite received a live inference run. Standard and Advanced share the same GGUF/runtime path and have pinned hashes, but their multi-gigabyte files were not downloaded. Model output quality remains probabilistic and must not substitute for professional review.

## Exact AI model/runtime versions and storage

| Component | Immutable source/revision | Quantization | Download bytes | Approximate installed footprint |
|---|---|---:|---:|---:|
| llama.cpp Windows CPU x64 | `b10516` | n/a | 18,506,923 (17.7 MiB archive) | about 0.08 GiB extracted plus cached archive |
| Wheat AI Lite — Qwen3 1.7B | `Qwen/Qwen3-1.7B-GGUF@90862c4b9d2787eaed51d12237eafdfe7c5f6077` | Q8_0 | 1,834,426,016 (1.71 GiB) | about 1.79 GiB including runtime/cache |
| Wheat AI Standard — Qwen3 4B Instruct 2507 | official base; Unsloth GGUF conversion `a06e946bb6b655725eafa393f4a9745d460374c9` | Q4_K_M | 2,497,281,120 (2.33 GiB) | about 2.41 GiB including runtime/cache |
| Wheat AI Advanced — Qwen3 8B | `Qwen/Qwen3-8B-GGUF@7c41481f57cb95916b40956ab2f0b139b296d974` | Q4_K_M | 5,027,783,488 (4.68 GiB) | about 4.76 GiB including runtime/cache |

The installer bundles only the small JSON manifest, never these model/runtime downloads. Wheat also requires temporary free-space reserve during safe installation.

## 9. UI/workspace and release identity

- **Pre-fix state:** There was no consolidated 2.1 workflow and current-release documentation/diagnostics still identified older builds.
- **Root cause:** New features spanned several old navigation areas and version markers were distributed.
- **Files/components changed:** `src/components/WheatAiWorkspace.tsx`, `src/components/WheatAiWorkspace.css`, `src/components/Atlas21Ai.css`, `src/App.tsx`, `src/App.css`, `package.json`, `package-lock.json`, `electron/database.ts`, `README.md`.
- **Implementation:** Added a restrained ledger-workspace UI with Plan comptable, Balances, Bilan, Trésorerie, Clôture, and Wheat AI tabs; progressive tree disclosure; exact-value tables; guarded fiscal actions; and responsive/shared dialog behavior. The frontend design skill influenced the compact paper-white rows, ink hierarchy, and restrained Wheat-green emphasis instead of adding card clutter. Versioned output is `release/2.1.0`.
- **Schema/data impact:** None beyond features already described.
- **Tests added:** 2.1 workspace UI, command/focus, viewport and zoom regression, shell navigation, and version assertions.
- **Runtime verification:** Tested at gradual desktop/laptop viewport sizes and 80–125% zoom in the existing suite.
- **Post-fix result:** The built/running application and package metadata identify as **Wheat 2.1.0**.
- **Remaining risk:** Vite reports large renderer chunks (`exceljs`, main UI) as a performance warning; functionality and renderer responsiveness tests pass, but future code splitting would reduce cold-load cost.

## 10. Packaging, migration safety, and privacy

- **Pre-fix state:** No 2.1 artifact or ninth runtime migration existed; multi-gigabyte model packaging had to be prevented.
- **Root cause:** The release pipeline and embedded migration list reflected 2.0.1.
- **Files/components changed:** `package.json`, `package-lock.json`, `electron/database.ts`, `prisma/schema.prisma`, the 2.1 migration, model manifest resources, packaging tests/docs.
- **Implementation:** Added exact embedded migration checksum validation, current schema marker `2.1.0`, migration-count-derived checkpoint retention, versioned output directory, and manifest-only Wheat AI packaging. Existing SQLite values/links are not rewritten to fit report mappings.
- **Schema/data impact:** Ninth additive migration; legacy 2.0 large integer-cent values, source identifiers, audit evidence, and relationships remain exact.
- **Tests added:** Upgrade from a reconstructed complete 2.0 schema; untracked legacy baseline migration; fresh nine-migration seed; corruption/newer-schema refusal; packaged smoke/restart/OCR checks.
- **Runtime verification:** SQLite `integrity_check` and `foreign_key_check` pass after migration/reset. Installer, portable, unpacked runtime, Windows metadata, and hashes are recorded below after generation.
- **Post-fix result:** Core accounting and OCR remain local. AI models are opt-in and local after download; model prompts receive only user text and typed-tool results.
- **Remaining risk:** Locally generated Windows artifacts are unsigned because no Authenticode publisher certificate is configured. The ordinary PaddleOCR runtime/models remain bundled for offline OCR and account for most installer size; optional PaddleOCR-VL and Wheat AI assets are not bundled.

## Hardware configurations tested

- **Physical runtime system:** MSI MS-7E28, AMD Ryzen 5 7600 (6 cores / 12 logical processors), 16,217,264,128 bytes physical RAM (about 15.1 GiB), Windows x64. WMI exposed NVIDIA GeForce RTX 3060 adapter RAM as 4,293,918,720 bytes and integrated AMD graphics as 536,870,912 bytes; Wheat does not assume unreported VRAM.
- **Live AI tier:** Lite on CPU (`-ngl 0`, 4 threads), including real model load/inference/chat.
- **Simulated deterministic policy fixture:** 20 GiB total / 10 GiB free RAM, 20 GiB free disk, 8 logical cores selects Standard and exposes only eligible tiers.
- **Not physically tested:** A separate 8 GiB office PC, Standard/Advanced live inference, or a GPU-offloaded model. The app’s normal recommendation uses actual current RAM/free disk and does not expose ineligible choices outside advanced settings.

## Test inventory and commands executed

New 2.1 tests:

- `tests/atlas-2.1-foundations.spec.cjs` — 9 PCGE/date/numbering/OCR/report/fiscal/AI/reasoning-privacy/invoice-contract tests.
- `tests/atlas-2.1-migration.spec.cjs` — complete 2.0-to-2.1 additive preservation test.
- `tests/atlas-2.1-electron-integration.spec.cjs` — shared database, numbering, report, AI tool/privacy, and UI integration.
- `tests/atlas-2.1-runtime-restart.spec.cjs` — real process relaunch and post-restart typing.
- `tests/atlas-2.1-ai-live.spec.cjs` — opt-in pinned multi-gigabyte download/inference/chat/uninstall test.

Commands executed during the final implementation pass (some repeated after fixes):

```powershell
node scripts/build-pcge-data.mjs
npx prisma format
npx prisma validate
npm run db:reset
npm run lint
npx eslint electron/wheatAi.ts tests/atlas-2.1-ai-live.spec.cjs
npm run build
npx playwright test tests/atlas-2.1-foundations.spec.cjs --reporter=line
npx playwright test tests/atlas-2.1-migration.spec.cjs --reporter=line
npx playwright test tests/atlas-2.1-electron-integration.spec.cjs --reporter=line
npx playwright test tests/atlas-2.1-runtime-restart.spec.cjs --reporter=line --workers=1
npx playwright test tests/app-context-menu.spec.cjs tests/atlas-1.1-integrity.spec.cjs tests/atlas-1.4-migration.spec.cjs tests/bank-import-electron-2.0.spec.cjs tests/bank-statement-importer-2.0.spec.cjs tests/paddleocr-sidecar-2.0.spec.cjs tests/ui-reliability-followup.spec.cjs tests/whole-app-regression.spec.cjs tests/atlas-2.1-electron-integration.spec.cjs --reporter=line --workers=2
npx playwright test --reporter=line --workers=2
$env:WHEAT_AI_LIVE_TEST='1'; npx playwright test tests/atlas-2.1-ai-live.spec.cjs --reporter=line --workers=1
Get-FileHash ...Qwen3-1.7B-Q8_0.gguf.partial -Algorithm SHA256
npm run installer
npm run portable
$env:WHEAT_EXE=(Resolve-Path 'release\\2.1.0\\win-unpacked\\Wheat.exe').Path; npx playwright test tests/electron-smoke.spec.cjs tests/paddleocr-packaged-ui-2.0.spec.cjs --reporter=line --workers=1
```

Release baseline regression result: **140 passed, 3 intentionally skipped, 0 failed** in 2.9 minutes. After the reasoning-privacy follow-up, lint, all 9 foundation tests, the production build, and the separately targeted unpacked-package launch and bundled-PaddleOCR checks passed (**2 packaged tests passed, 0 failed**). The three default skips are opt-in/environment-dependent checks, including the multi-gigabyte Wheat AI live download test; that AI test was enabled and passed separately during this release run.

## Final artifact evidence

- NSIS installer: `release/2.1.0/WheatSetup-2.1.0.exe` — 1,560,154,060 bytes; file/product version `2.1.0`; SHA-256 `427e670d8b21961b17235c67821911bb650dbd773351fd0c58c209a0e01016dd`; Authenticode status `NotSigned`.
- Portable executable: `release/2.1.0/AtlasLedgerPortable-2.1.0.exe` — 1,559,669,251 bytes; file/product version `2.1.0`; SHA-256 `47584faaa5e2af6bac2631335178320b123c208fa1ce4e66cc467cc6bc914a0c`; Authenticode status `NotSigned`.
- Unpacked packaged runtime: the generated `release/2.1.0/win-unpacked/Wheat.exe` had 222,424,576 bytes; file version `2.1.0`, product version `2.1.0.0`; SHA-256 `91dcfab5f83b7d4b487724e27dd0f48c8d83667aefa90d24bf6f7d4b33e1890`; Authenticode status `NotSigned`. It passed the complete packaged desktop smoke workflow and bundled offline PaddleOCR discovery check, then its reproducible 3.56 GiB staging directory was removed after release validation to reclaim storage.
- Source archive: `release/2.1.0/AtlasLedger-2.1.0-source.zip`. Its post-generation SHA-256 and the retained executable hashes are recorded in the adjacent `SHA256SUMS.txt`; the archive deliberately excludes `.env`, dependencies, generated build output, release output, transient test data, and the multi-gigabyte generated PaddleOCR runtime/model cache while retaining its setup scripts, requirements, worker, and source configuration.

## Honest completion boundary

No known P0 accounting, restart, input, migration, or privacy regression remains after the final suite. The following are deliberately not claimed as verified:

1. Final statutory/liasse forms whose current authoritative templates and mappings were not independently obtained and verified.
2. Real PaddleOCR-VL 1.6 inference without the optional VL weights installed.
3. Live Standard/Advanced LLM inference or performance on 8/32+ GiB hardware.
4. Sage 100 import into an external licensed Sage installation.
5. Authenticode signing without a publisher certificate.

These boundaries are visible behavior, not hidden TODO substitutions: unsupported statutory finalization is blocked, difficult OCR requests review/fallback, unavailable models remain unselected, and high-stakes fiscal/posting decisions remain in dedicated human-confirmed screens.
