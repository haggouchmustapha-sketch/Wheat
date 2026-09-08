# Wheat product and accounting audit — 8 September 2026

## Assessment

Wheat has substantial accounting infrastructure: exact-centime subledgers, transactional posting, linked reversals and credit notes, fiscal locks, reconciliation, traceable documents, local backups, and bounded AI tools. It is more developed than the older 2.0.1 feature matrix suggests. This audit repaired three reproduced defects, including cross-dossier AI draft leakage, and corrected weaknesses in the regression harness.

The evidence supports further controlled use and accountant acceptance testing. It does **not** establish statutory compliance or certify unrestricted production readiness. Tax/payroll rule approval, real-document OCR acceptance, packaged recovery/update testing, and production-volume performance remain material acceptance work.

Scope: repository `atlas-ledger`, application version `2.1.2609051`, Windows. Installed core versions: Electron 42.9.0, React 19.2.6, TypeScript 6.0.3, Vite 8.2.1, Prisma 6.19.3, Playwright 1.60.0. The existing modified `package-lock.json` and untracked `AGENTS.md` were preserved. No schema changes, production-data resets, packaging, commits, or publishing were performed.

The user subsequently requested **automated tests only**. Windows Computer Use stopped at that point; remaining verification uses automated tests and read-only inspection. The manual workflow was not completed end to end and is not represented as such below.

## Reproduced defects and repairs

| Severity | Defect and root cause | Repair | Evidence |
| --- | --- | --- | --- |
| P0 | A draft typed in Wheat AI for dossier A appeared in dossier B and was saved under B. The workspace reused React component state during company changes; persistence effects received a new company ID with old draft text. | Key the workspace by company and page, clear transient UI during switching, and wait for the new bootstrap before changing the active company. | The new Electron regression failed before the fix. It checks independent A/B drafts, an in-flight reply during switching, an enabled B composer, and absence of A's draft in B's provider request. |
| P1 | Impossible accounting dates rolled into another month: `2026-02-31` became March 3. JavaScript's permissive date parser also accepted ambiguous locale strings. | Validate ISO calendar days before parsing; require an explicit timezone for timestamp strings; retain UTC normalization for existing timestamp/Date callers. | New date tests reproduced two failures before the fix, then passed. They cover leap days, invalid dates, ambiguous inputs, timestamps, and rejection before storage in entry/invoice/payment commands. |
| P1 | Invoices with unknown due dates could not be corrected through the normal invoice service/editor, even though the schema and OCR support a nullable date. | Accept null/omitted/empty due dates in the owning subledger validator and make the editor field optional. Supplied deadlines still cannot precede the invoice. | New Prisma regression creates, edits, posts and reconnects sale/purchase invoices without inventing terms. It also checks duplicates, optimistic versions, immutable artifacts and independently calculated ledger/trial totals. Windows UI separately saved, reopened, cleared the deadline, saved and posted a 1,000.01 MAD invoice. |

Implementation files: `electron/accounting.ts`, `electron/subledger.ts`, `src/App.tsx`, `src/components/OperationalAccounting.tsx`. Regression files: `tests/wheat-accounting-dates.spec.cjs`, `tests/wheat-invoice-optional-due-date.spec.cjs`, `tests/wheat-ai-dossier-isolation.spec.cjs`.

No inference of historical exploitation was made for the AI defect. Existing drafts or records were not rewritten. The fix prevents the reproduced state-transfer path; it does not claim that every possible cross-dossier path has been formally proven safe.

## Test-harness improvements

- The accountant scenario compared two absent fields, so `undefined === undefined` falsely appeared to validate balance. It now checks `periodDebitCents` and `periodCreditCents` against the independent expected value **230,000 centimes each**, rather than only against each other.
- Image-gating and Electron integration tests depended on an installed Ollama model. They now use `tests/fixtures/ollama-server.cjs`, a loopback HTTP protocol fixture advertising text and vision models. Unsupported image input must produce a refusal without sending a chat request.
- The image refusal assertion accepts the application's current French wording. No product refusal or image safeguard was weakened.
- The existing UI reliability scenario now waits for the new dossier's initial Reports tab after asynchronous switching. Its first final-suite run clicked the outgoing form before the workspace transition finished; the empty-form isolation assertion remains intact.
- The protocol fixture supplies deterministic responses and delayed completion. It is **not actual model inference** and does not establish remote-provider availability or model quality.

## Architecture and invariants reviewed

| Area | Ownership and observed safeguards | Practical limit |
| --- | --- | --- |
| Desktop boundary | Electron main owns Prisma, files, OCR, provider credentials, updates and business commands; preload exposes classified IPC. Main-frame trust validation, sandbox, context isolation and disabled Node integration are present. | This is a local desktop trust model, not a server with independent multi-user authorization. |
| Money and posting | `accounting.ts`, `entryCommands21.ts`, `subledger.ts`: integer centimes/BigInt, balanced lines, company ownership, journal state and fiscal date checks; related writes are transactional. | Legacy numeric MAD compatibility remains in `madToCents`; strict newer command paths should remain the preferred boundary. |
| Corrections | Posted records use reversals/credits and linked evidence; draft edits use optimistic versions. Posted invoice artifacts are immutable. | Historical data cleanup should never be treated as a reason to delete posted evidence. |
| Reports | `reporting.ts`, `reporting21.ts`: company/period filters, exact-centime outputs, stable cursors and posted-evidence rules. Ageing accounts for cutoff dates and linked corrections. | Missing deadlines are explicitly excluded/reported by ageing rather than assigned invented dates. Large advanced reports reject more than 100,000 lines. |
| Bank/imports | Parser review, currency and duplicate checks, exact normalized amounts, allocation/reconciliation evidence, and exclusions preserving import history. | Sage/FEC output validation is not proof of successful import into every external Sage version. |
| OCR | Local recognition/extraction, company-aware invoice direction, editable proposals, and explicit handoff into draft accounting. | Synthetic extraction/recognition fixtures do not replace an accuracy study on the firm's actual scans. |
| AI | Bounded dossier context, provider/model configuration, capability gating, mutation previews/confirmation and local secret protection. | Conversations are session-memory state across navigation, not durable full-chat history across process restart. No real remote provider was exercised with client data. |
| Audit/recovery | `audit13.ts`, `archive.ts`, `databaseRestore.ts`, `compliance14.ts`: hash-chain evidence, archive validation and protected restore/rollback paths. | Local audit hashes are neither external timestamping nor protection against a fully privileged attacker rewriting all local evidence. |
| Updates | Signed manifests/packages, Ed25519 verification, download validation and Windows recovery/helper tests. | No production update was installed during this audit. |

The suspected stale Prisma `Document.revision` mismatch was not reproduced with the generated client and current schema. Prisma validation and migration status are current; deleting the database was unnecessary.

## Workflow evidence

The full suite combines unit tests, real isolated SQLite integration tests and Playwright Electron tests. These categories are not interchangeable: several Electron tests invoke the preload API to set up or verify data, while the accountant scenario enters its transactions through rendered forms.

| Scenario | Evidence and coverage |
| --- | --- |
| Representative accountant dossier | `accountant-runtime-2.0.spec.cjs`: first-company form, customer and supplier creation, sale/purchase draft edit and posting, customer receipt allocation, settlement, report UI, dashboard and close/relaunch persistence. |
| Independent totals | Accountant scenario: 1,000 MAD sale + 300 MAD purchase + 1,000 MAD receipt = **2,300 MAD debit and credit turnover**; customer balance zero, supplier balance 300 MAD. New optional-date integration: 100,001 + 30,002 = **130,003 centimes per side**. |
| Manual dossier, before automated-only instruction | `AMANAR AUDIT TEST SARL`: identity input/save, customer creation, searchable account selection, sale draft/save/edit, removal of deadline and posting. A read-only Prisma query found invoice `FA-2026-000001`, POSTED, `dueDate=null`, 100,001 centimes TTC; account 342100 debited 100,001 and 712400 credited 100,001. A partial-payment form was started but **not saved or posted**. |
| Bank formats | `bank-import-electron-2.0`, `bank-statement-importer-2.0`: review/import/deduplicate/persist supported formats; CSV/TSV, XLSX, OFX, QIF, MT940, CAMT.053, recognizable text-PDF tables; malformed and image-only inputs fail safely. |
| Reconciliation/cash/corrections | Existing reconciliation, subledger, operational, posting and compliance suites exercise matching, allocation limits, bank/cash mappings, reversals, credits and locks. These were automated rather than manually repeated for every combination. |
| OCR | Existing extraction/classification, source review, invoice-direction and atomic-handoff suites cover active-company issuer/recipient attribution, uncertain direction and correction. Existing local OCR suites exercise available runtimes; unavailable/private/packaged cases remain conditional. |
| Fiscal/closing | Migration, fiscal workpaper and compliance suites cover versioned workpapers, locks, close/reopen controls and audit history. They do not establish current Moroccan legal approval. |
| Backup/recovery | Archive, restore and Electron backup tests include awkward attachment paths, repeated backups, restart, manifest validation and rollback failure paths. This is narrower than a full disaster drill on another Windows installation. |
| UI and AI | Existing launch/session/layout suites plus the new dossier-isolation test cover input usability, provider/model selection, unsupported images, navigation and delayed replies. Layout evidence includes automated theme/window cases; manual observation was at approximately 1466 × 973 in light mode. |

## Verification results

Final full run: **846 passed, 14 skipped, 1 failed / 861 tests in 9.3 minutes**. The only failure was `ui-reliability-followup.spec.cjs`, which clicked the outgoing workspace during asynchronous dossier switching. After adding state-based synchronization, its focused rerun **passed (1/1, 29.9 seconds)**. Thus 847 distinct scenarios have passing final evidence; the complete suite was not rerun after that test-only synchronization change. No product code changed after the full run.

All three new regression files and the corrected accountant/image/provider tests passed in the final full run. The first full-run bank-import failure did not recur.

Other final checks:

| Command | Result |
| --- | --- |
| `npm run build` | Passed, including Prisma generation and `tsc -b`. Renderer and Electron production bundles built. |
| `npm run lint` | Passed. |
| `npm ls --depth=0` | Passed; two extraneous optional WASM/runtime packages remain. |
| `npx prisma validate` | Passed. |
| `npx prisma migrate status` | 15 migrations, database up to date. |
| `npm audit --omit=dev --json` | Zero reported production-dependency advisories. This is not proof of absence of application vulnerabilities. |
| `git diff --check` | Passed; only repository line-ending notices. |

Build warnings remain: renderer main chunk **1,016.95 kB** (298.11 kB gzip), ExcelJS chunk **929.58 kB**, and a deprecated `inlineDynamicImports` build option. These are not build failures, and the audit did not hide them by changing warning thresholds.

Skipped coverage is conditional on packaged OCR, private/reference documents, historical backup availability, and opt-in live model tests. No private samples, real provider keys or multi-gigabyte model downloads were obtained to turn those skips green.

Reproduction commands (PowerShell, from the repository):

```powershell
npx playwright test --reporter=line --output="$env:TEMP\wheat-audit-final-output"
npx playwright test tests/ui-reliability-followup.spec.cjs --reporter=line --output="$env:TEMP\wheat-audit-final-retest-output"
```

Local evidence logs are retained in `C:\Users\Adam\AppData\Local\Temp`: `wheat-audit-final.log`, `wheat-audit-final-retest.log`, `wheat-audit-final-build.log`, `wheat-audit-final-lint.log`, `wheat-audit-final-dependencies.log`, and `wheat-audit-final-security.json`. Earlier reproduction/baseline logs use the `wheat-audit-` prefix in the same directory. Temporary logs may be cleared by Windows; this report records their material results.

Baseline full run: **839 passed, 14 skipped, 3 failed** (856 tests). The bank-import Electron context-destruction failure passed a focused rerun. The two model-dependent failures led to the deterministic local provider fixture described above. A subsequent focused run passed 14/15; its remaining failure was the image-refusal text assertion, since corrected.

Commands avoid `test:desktop`, `test:ocr` and packaging wrappers because those scripts reset the development database. Playwright is invoked directly after building, with disposable test profiles. Test output and logs are separate directories to avoid Windows file locking during Playwright output cleanup.

## Remaining accounting and product concerns

### Essential before a broad production claim

1. **Professional fiscal/payroll sign-off.** Validate effective-dated TVA rules, rates, account mappings, CNSS/AMO/IR inputs, fiscal workpaper mappings and required invoice identity with a qualified Moroccan accountant using approved examples. Statutory finalization is explicitly unavailable; do not market workpaper generation as DGI filing/certification.
2. **Real-data recovery and migration acceptance.** Exercise representative historical backups and documents on a clean machine with the packaged build. Missing historical fixtures and packaged-runtime skips constrain this audit's evidence.
3. **Define the cabinet security model.** The local PIN is a privacy screen; it is not database encryption, per-dossier access control, or accountant/reviewer roles. This matters before sharing a workstation/profile among users with different permissions.

### High-value improvements

1. **Grouping-account policy.** `postable=false` is not consistently a posting prohibition. The invoice account selector exposes grouping accounts; entry/subledger validators accept active same-company accounts, and `wheatReview.ts` intentionally emits a warning rather than blocking them. This is an existing documented compatibility choice. Establish a policy for new postings, legacy imports, openings and exact reversals before enforcing a new global rule. The audit did not silently reinterpret historical accounts.
2. **Performance acceptance on firm-scale data.** Measure startup, dossier switching, imports, OCR queues and report latency on representative large dossiers. The renderer build emits an approximately 1 MB main chunk warning. Advanced reporting has an explicit 100,000-line bound and closing checks also impose a large-volume limit. No production-scale SLA is proven here.
3. **Dossier-specific OCR acceptance set.** Maintain authorized clear/poor scans, Arabic/French layouts, multi-rate invoices, missing identity and ambiguous issuer/recipient cases. Track extraction and direction accuracy separately; confidence must remain reviewable.
4. **Durable chat policy.** Decide whether full conversations should survive restarts, with explicit retention/clearing behavior and company scoping. Navigation persistence already exists; full restart persistence should not be implied.
5. **External interoperability sign-off.** Verify exported files against the actual Sage installation and firm workflows, including account subdivisions, auxiliary codes and accented text.

### Optional/future

Use measured accountant workload to prioritize saved filters, recurring templates and further batch-entry shortcuts. Existing review/anomaly, reconciliation, ageing, credit-note and backup facilities should be extended when necessary, not duplicated in new modules. No unrelated large module or visual redesign was added.

## Priorities

Keep the new regressions in CI, then complete professional fiscal acceptance and a packaged recovery drill. Next establish the grouping-account and shared-workstation policies, benchmark realistic large dossiers, and validate real OCR/Sage samples. Treat live AI provider checks as a separate credentialed integration exercise with deliberately bounded synthetic data.
