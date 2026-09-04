# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Wheat is a Windows-first, local-first Electron desktop accounting app for Moroccan small businesses and fiduciaires. Stack: Electron + React 19 + TypeScript + Vite + Prisma/SQLite. No cloud account, no subscription — everything runs on the user's machine. The app is not certified by the DGI; it doesn't replace review by a qualified accountant.

The profile directory is `%APPDATA%\Wheat\`. An installation created before the rename keeps its data: on first launch `electron/profileMigration.ts` moves `%APPDATA%\Wheat\` across with a single atomic directory rename, then renames `atlas-ledger.sqlite` to `wheat.sqlite` and the log files to match. The rename is re-attempted every launch, and `resolveProfileDatabaseFile` opens the old database name meanwhile, so an interrupted migration is always recoverable. If both directories exist the new one wins and the old one is left untouched.

`window.wheat` is the only renderer bridge — the former `window.atlas` alias is gone.

Values written into user data before the rename are never rewritten: `AuditEvent.action` is hashed into the SHA-256 audit chain, and backups and PDF artifacts are immutable. `electron/legacyDomainValues.ts` owns every old/new pair — Wheat writes the new value and reads both. `electron/runtimeEnvironment.ts` does the same for `WHEAT_*` environment variables, which still fall back to their old `ATLAS_*` names until Wheat 2.3.

One Wheat string deliberately remains: `build.appId` / `WINDOWS_INSTALL_IDENTITY` = `ma.atlasledger.desktop`. That is the Windows AppUserModelID and NSIS install key, not branding; changing it would orphan existing installs and their shortcuts. It never reaches the UI.

## Commands

```powershell
npm install
npm run dev              # prisma generate + vite --host 127.0.0.1 (Electron dev app)
npm run build             # clean + prisma generate + tsc -b + vite build
npm run lint               # eslint .
npm run db:push            # prisma db push
npm run db:seed            # tsx prisma/seed.ts
npm run db:reset           # prisma migrate reset --force --skip-seed && db:seed
npm run icon:ico           # regenerate build/icon.ico from source art
```

Packaging (each does db:reset + icon:ico + build first):

```powershell
npm run installer   # electron-builder --win nsis --x64
npm run portable     # electron-builder --win portable --x64
npm run pack          # electron-builder --dir (unpacked, for quick inspection)
```

Tests use Playwright against the packaged/built Electron app (`.spec.cjs` files under `tests/`). Most require a build first:

```powershell
npm run test:desktop    # db:reset + build, then tests/electron-smoke.spec.cjs
npm run test:ocr           # db:reset + build, then tests/ocr-meaningful.spec.cjs
npm run test:updater      # tests/updater.spec.cjs + tests/updater-electron.spec.cjs (no rebuild)
```

To run a single spec directly after a build:

```powershell
npx playwright test tests/wheat-reconciliation-unit.spec.cjs --reporter=line
```

PaddleOCR sidecar (optional local OCR engine, used for scanned bank-statement PDFs):

```powershell
npm run paddle:setup   # scripts/setup-paddleocr.ps1
npm run paddle:check    # health-check the bundled python runtime
```

Releasing to users (see **Releases and updates** below — never run these unless explicitly told to publish):

```powershell
npm run release:prepare -- --notes docs/wheat-<version>-release-notes.md --sign ..\wheat-release-key.pem
npm run release:publish
```

## Architecture

**Process split.** `electron/main.ts` is the privileged main process: it owns the Prisma/SQLite connection, all business logic, and file/OS access. `src/` is the React renderer — it never touches Prisma or the filesystem directly. The only bridge between them is `electron/preload.ts`, which exposes a flat `window.wheat` object of `ipcRenderer.invoke` calls (one method per IPC channel, channels named `wheat:<domain>:<action>`). When adding a feature: add/extend an IPC handler in the relevant `electron/*.ts` module, register it in `main.ts`, expose it in `preload.ts`, then call it from a component via `window.wheat`.

**Domain modules live in `electron/`, one file per subsystem**, e.g. `accounting.ts`, `subledger.ts`, `reconciliation.ts`, `reporting.ts` / `reporting21.ts`, `fiscal21.ts`, `compliance14.ts`, `chartOfAccounts21.ts`, `bankStatementImporter.ts`, `smartOcr.ts` / `paddleOcr.ts`, `archive.ts` (backup/restore), `localSecurity.ts` (PIN lock), `securityBoundary.ts` (IPC/frame/navigation hardening), `updater/` (self-update subsystem, its own directory — see **Releases and updates**), and the `wheatAi*.ts` files (local/OpenRouter/Groq-backed assistant: provider registry, capability registry, domain gateway, secrets). Numeric suffixes on filenames (`13`, `14`, `21`) mark the release iteration a module was introduced/reworked in — they are historical, not a versioning scheme to imitate for new files.

**Money is exact-integer centimes.** Prisma models store amounts as `BigInt` centimes, never floats. `src/lib/exactDecimal.ts` and the electron-side equivalents parse/format exact decimal strings; new subledger/accounting inputs must reject JS floating-point and go through exact-decimal parsing at the service boundary.

**Everything is append-only / audit-chained.** Posting, voiding, reconciling, and archiving never hard-delete or silently mutate history: corrections happen via linked reversal/extourne/credit-note entries, and operational changes append to a company-local SHA-256 audit chain (see `audit13.ts`). Keep this invariant when touching any posting/void/reversal path.

**Prisma schema** (`prisma/schema.prisma`, ~1300 lines) is the single source of truth for the domain model — read it before assuming a shape for companies, fiscal years, accounts, journals, entries, invoices, payments, bank movements/reconciliation, tax/TVA configurations, or the audit chain. Regenerate the client (`npm run prisma:generate`, or just `npm run dev`/`build` which does it for you) after any schema change; generated client output lives at `src/generated/prisma` and should not be edited by hand.

**Renderer structure.** `src/App.tsx` is the shell/router; feature screens are large per-workspace components in `src/components/` (e.g. `BooksWorkspace13`, `FiscalWorkspace`, `ComplianceWorkspace14`, `OperationalAccounting`, `WheatAiWorkspace`), each typically paired with its own `.css` file rather than a shared stylesheet. Design tokens (color, type, spacing, radii, shadows) are centralized in `src/styles/tokens.css` and drive both light and dark mode — prefer tokens over ad hoc values when styling.

**Document fields.** `src/lib/smartFields.ts` owns how an extraction is shown and edited. The extraction pipeline decides which fields exist; this module only orders, labels and converts them, and any key it does not recognise is still displayed and still preserved on save. `vatRate` travels as basis points (2000 = 20 %) because `documentInvoiceDraft.ts` reads it back that way, so the module converts in both directions at the edge. Saving a correction sends only the fields that actually changed — the main process stamps confidence 100 on everything it receives and names it in the audit chain.

**Shared review layer.** `electron/wheatWorkflowRegistry.ts` classifies every channel `preload.ts` exposes as `REVIEW_REQUIRED`, `DETERMINISTIC_ONLY` or `EXEMPT`, each with a written reason; `tests/wheat-workflow-coverage.spec.cjs` parses the preload source and fails if a channel is missing, so a new IPC channel cannot be added without deciding what review it gets. `electron/wheatReview.ts` runs that review: a deterministic domain preflight first (double-entry balance, HT + TVA = TTC, allocation bounds, period locks, dossier-scoped ids, duplicate identities), then — only if a model is genuinely reachable — a bounded contextual reading whose findings are dropped unless corroborated in the context supplied, capped at 70 % confidence, never able to emit a blocker and never allowed to propose a new date, rate, account or legal identifier. The review reads and returns an opinion; it never mutates, and the owning domain service re-validates everything inside its own transaction exactly as before. Model resolution is local-first (`resolveReviewModel` in `main.ts`): a healthy installed Ollama model, else a configured remote provider *with* the `assistedReviewRemoteConsent` preference, else an honest "AI review unavailable". A model reading is not attempted on every save: it runs when the deterministic pass already found something, when the workflow's `riskLevel` is 2 or 3, or when the person asked for a review rather than pressing save (`requested: true` on the payload) — otherwise the result carries `model.status: "NOT_NEEDED"`. The deterministic pass always runs, so the checks that can refuse an operation are unaffected. Provider and model identifiers never appear in the ordinary reading path: `model.message` is written without them and `model.detail` carries them for settings, diagnostics and the disclosure on the result dialog. The renderer reaches it through `window.wheat.reviewBeforeMutation` and shows one shared surface (`src/components/WheatReview.tsx`, driven by `src/lib/useWheatReview.tsx`).

**Guided journey.** `electron/wheatJourney.ts` derives the fifteen-stage dossier journey from the records that already exist — counts and statuses — rather than from a stored checklist, which is why there is no migration for it. It marks a stage `NEEDS_ANSWER` exactly where Wheat must not guess (VAT filing rhythm, bank-to-ledger mapping) and returns the one focused question with why it is being asked and where the answer lives.

**Unfinished work.** `electron/formDrafts.ts` + the `FormDraft` model hold what somebody has typed into a form and not yet submitted. It is deliberately not accounting data: no domain service reads it, nothing is posted or numbered from it, and it is not appended to the audit chain — typing is not something that happened to the books. A draft's identity is `(companyId, entity, draftKey)`, so concurrent unfinished items never overwrite each other, and the row cascades with its company so drafts cannot leak between dossiers. Edit drafts carry `baseVersion`; a draft started against a record that has since changed comes back `stale: true` and is shown rather than applied. The renderer uses one hook — `src/lib/useFormDraft.ts` (`useFormDraft`, and `useDraftedForm` for the open/type/submit pattern). The rule every caller follows: `clear()` is called *after* the domain service confirms a write, never in a `finally`, and never on unmount — unmounting flushes what is queued instead. Navigation must never delete a person's work.

**Dossier setup gate.** `electron/wheatDossierSetup.ts` keeps a brand-new dossier in guided work until it has a fiscal year, a chart, journals and a VAT configuration, and the accountant has approved that foundation. Progress is derived from the records, as in `wheatJourney.ts`; only the two facts no record can show are stored, and they reuse `GuidedStepDecision` (`setup:situation`, `setup:unlocked`) rather than a new table. The gate is narrow on purpose: it never applies to a dossier that already holds entries, invoices or documents (so an update cannot lock existing installations out of live client files), never to a dossier whose company name is exactly `TEST`, opens permanently once approved, and fails open if its state cannot be read. The renderer restricts the rail to `guided`, `companies` and `settings` while `mode === "SETUP"` (`src/components/DossierSetupGate.tsx`).

**Releases and updates.** Wheat updates itself from the GitHub Releases of
**https://github.com/haggouchmustapha-sketch/Wheat** (default branch `main`). Source and published builds share
that one repository, but a release binary is never a commit: `release/` is build output, installers reach users as
release assets, and neither is committed. `docs/wheat-release-process.md` is the full runbook.

*Where it is configured.* One place — the `repository` field of `package.json`. `electron/updater/releaseSource.ts`
derives owner/repo/URLs for the application and `scripts/lib/releaseRepository.mjs` does the same for the tooling,
so the two can never point at different repositories. Do not write the owner, the repo or a release URL anywhere else.

*What Wheat trusts.* An Ed25519 signature over the release manifest, verified against `WHEAT_UPDATE_PUBLIC_KEY` compiled
into `electron/updater/signature.ts`; then SHA-256 and size over the downloaded bytes. GitHub is infrastructure, not
authority — it serves the bytes and cannot choose them. The artifact URL is *built by Wheat* from the repository, the
tag and the manifest's file name; a manifest never supplies a location. Redirects are followed only to GitHub's own
download hosts. The key is empty until generated, and an empty key means every network update is refused — unconfigured
fails closed. **No GitHub credential of any kind is ever compiled into Wheat.exe**; publishing uses the operator's own
`gh` login on the release machine, and the Ed25519 private key lives outside the repository.

*Three decisions, never one.* `electron/updater/service.ts` deliberately separates check, download and install, because
each is the accountant's call: a check may run unattended and downloads nothing; `downloadOfferedUpdate()` runs because
somebody pressed "Mettre à jour"; `installStagedUpdate()` runs because somebody pressed "Redémarrer et installer", and
is the only thing that closes Wheat. Never restore an escalation from one to the next — somebody halfway through an
invoice must not lose it to a background update. Phases are `idle → checking → up-to-date | available → downloading →
verifying → ready → installing → updated`, surfaced by `src/components/WheatUpdate.tsx` with copy and units in
`src/lib/updateStatus.ts`. Download progress is real transferred bytes; when no size was declared there is no percentage
and no bar rather than an invented one. Before restarting, the renderer calls `flushAllFormDrafts()` from
`src/lib/useFormDraft.ts` — the existing draft system, never a second one.

*Failure is always survivable.* Update checking is auxiliary: no connection, an unreachable GitHub, a rate limit, a
malformed manifest or a deleted release all leave Wheat completely usable, and an unattended check that could not reach
the server stays silent (a check somebody asked for reports plainly). A failed install returns to `ready` with the
verified artifact intact, and `resources/updater/update-helper.ps1` snapshots program files and rolls back.

*User data is never part of an update.* An update replaces `Wheat.exe`, `app.asar` and bundled runtime files under the
install directory. Dossiers, the database, documents, drafts, settings and backups live in `%APPDATA%\Wheat\`, which the
installer never writes to. Schema changes go through the existing startup engine (`migrateAndValidateDatabase` in
`electron/database.ts`): a copy before every pending migration, transactional apply, and a refusal that names the backup
path on failure. Never add `prisma migrate reset` or any database recreation to an update path.

*Source pushes and releases are different things.* Committing and pushing source is ordinary work, done when asked.
Publishing a release is a separate, explicit instruction ("Publish the Wheat update"). Do not bump the version, create a
tag, or publish a release merely because updater code changed. When told to publish: run `npm run release:prepare`
with written release notes and the signing key, read the printed plan, then `npm run release:publish`. Publish fails
closed on skipped tests, an unsigned manifest, a changed artifact, a signature the compiled-in key does not verify, an
existing tag, or a version that is not newer.

*Testing.* `npm run test:updater` covers the provider contracts (`updater-github`, `updater-https`), the signature
(`updater-signature`), the service and Windows helper (`updater`), the release tooling's refusals
(`updater-release-tooling`), user-data survival across the whole lifecycle (`updater-user-data`), and the consent flow in
a real window (`updater-electron`). Adding an IPC channel also requires an entry in `electron/wheatWorkflowRegistry.ts`.

**Security boundary.** `electron/securityBoundary.ts` enforces a single trusted app instance, validates the main frame for IPC, and blocks popups/navigation/webview creation/permission requests. Any change touching window creation, navigation, or IPC registration should be checked against this module.

**Wheat AI.** Providers (local model, OpenRouter, Groq) are abstracted behind `wheatAiProviderService.ts`/`wheatAiProviders.ts`; credentials go through the OS credential vault via `wheatAiSecrets.ts` and are never returned to the renderer — only masked metadata crosses the IPC bridge. `wheatAiCapabilityRegistry.ts` and `wheatAiDomainGateway.ts` define what the assistant is allowed to see/do against the accounting domain.
