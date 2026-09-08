# CLAUDE.md

Wheat is a Windows-first, local-first Electron accounting app for Moroccan small businesses and fiduciaires.

**Stack:** Electron + React 19 + TypeScript + Vite + Prisma/SQLite.  
**User data:** `%APPDATA%\Wheat\`  
**Renderer bridge:** `window.wheat` only.

## Core rules

- `electron/main.ts` and `electron/*` own Prisma, filesystem/OS access, and business logic.
- `src/` is the renderer and must access privileged features only through `electron/preload.ts` IPC methods (`wheat:<domain>:<action>`).
- `prisma/schema.prisma` is the source of truth for domain models. Regenerate Prisma after schema changes.
- Money is stored as exact `BigInt` centimes. Never use JS floating-point for accounting amounts; use the existing exact-decimal helpers.
- Accounting history is append-only/audit-chained. Never hard-delete or silently rewrite posted history; corrections use the existing reversal/extourne/credit-note flows.
- Preserve dossier isolation, period locks, double-entry balance, and existing domain validation.
- Use `src/styles/tokens.css` for design tokens instead of ad-hoc styling where practical.
- Never edit generated Prisma client files.

## Before changing a subsystem

Read the existing implementation and its schema/types first. Prefer extending the current pattern over creating a parallel system.

Important areas:
- Accounting/domain logic: `electron/accounting.ts`, `subledger.ts`, `reconciliation.ts`, `reporting*.ts`, `fiscal*.ts`, `compliance*.ts`
- OCR/import: `bankStatementImporter.ts`, `smartOcr.ts`, `paddleOcr.ts`
- Audit: `audit13.ts`
- Security: `securityBoundary.ts`, `localSecurity.ts`
- AI: `wheatAi*.ts`
- Renderer workspaces: `src/components/`
- Field extraction/editing: `src/lib/smartFields.ts`

## Review / mutation safety

Every IPC channel exposed by `preload.ts` must be classified in `electron/wheatWorkflowRegistry.ts`; coverage tests enforce this.

`electron/wheatReview.ts` is advisory around deterministic validation. AI review must never replace or weaken domain validation, invent legal/accounting facts, or mutate data by itself.

## Drafts and guided setup

- Form drafts are unfinished UI state, not accounting records. Preserve them across navigation/unmount; clear only after a confirmed successful write.
- Respect stale-draft/version checks.
- Do not bypass the dossier setup gate for new dossiers. Existing dossiers with accounting data and the `TEST` dossier remain exempt according to the current implementation.

## Compatibility

Do not casually rewrite legacy persisted values or Windows install identity. Existing installations and immutable audit/PDF/backup data must remain readable.

If touching rename/profile migration compatibility, inspect:
- `electron/profileMigration.ts`
- `electron/legacyDomainValues.ts`
- `electron/runtimeEnvironment.ts`

## Updates and releases

Do **not** publish, tag, bump a version, or create a release unless explicitly asked.

For updater/release work, read `docs/wheat-release-process.md` and the existing `electron/updater/` implementation before changing anything.

Non-negotiable updater rules:
- User data in `%APPDATA%\Wheat\` must never be replaced or reset by an update.
- Never add `prisma migrate reset` or database recreation to update paths.
- Preserve signature/hash verification and the explicit check → download → install consent flow.
- Source pushes and releases are separate operations.
- Never embed GitHub credentials or release private keys in the app/repository.

## Security

Any change touching window creation, navigation, permissions, webviews, or IPC registration must preserve `electron/securityBoundary.ts`.

Secrets must stay behind the main-process boundary. Wheat AI credentials use the OS credential vault and must never be returned raw to the renderer.

## Commands

```powershell
npm install
npm run dev
npm run build
npm run lint
npm run db:push
npm run db:seed

npm run test:desktop
npm run test:ocr
npm run test:updater

npm run installer
npm run portable
npm run pack
```

Run the relevant tests after changes. Do not publish a release as part of ordinary development work.
