# Repository Guidelines

## Project Structure & Module Organization

Wheat is a Windows-first Electron accounting application. `src/` contains the React renderer: workspace components live in `src/components/`, reusable hooks and helpers in `src/lib/`, and shared design tokens in `src/styles/tokens.css`. The privileged Electron main process and business domains live in `electron/`; `electron/preload.ts` is the only renderer bridge. Prisma schema and migrations are in `prisma/`; never hand-edit `src/generated/prisma/`. Playwright specifications and fixtures live in `tests/`. Source assets are in `public/` and `resources/`; release notes and operational documentation are in `docs/`.

## Build, Test, and Development Commands

Run commands from `atlas-ledger/`:

```powershell
npm install                 # install dependencies
npm run dev                 # generate Prisma client and start the Electron/Vite app
npm run build               # clean, generate, type-check, and build renderer/main output
npm run lint                # run ESLint on TypeScript/TSX
npm run db:reset            # recreate local database and load seed data
npx playwright test tests/wheat-reconciliation-unit.spec.cjs --reporter=line
```

Use `npm run test:desktop`, `npm run test:ocr`, or `npm run test:updater` for their focused suites. Packaging commands (`installer`, `portable`, `pack`) reset the database and build; do not use them for routine checks.

## Coding Style & Naming Conventions

Use TypeScript/TSX with the existing two-space indentation and ESLint configuration. Name React components in PascalCase (for example, `FiscalWorkspace.tsx`), hooks `useThing`, and domain modules in lower camel case (for example, `electron/bankStatementImporter.ts`). Pair feature components with their local CSS when that is the existing pattern; use tokens rather than ad hoc visual values.

Keep renderer code free of filesystem, Prisma, and privileged logic. Add domain work in the owning `electron/` module, register its IPC handler in `electron/main.ts`, expose it through `electron/preload.ts`, and classify each new channel in `electron/wheatWorkflowRegistry.ts`.

## Testing & Data Safety

Add or update a focused `tests/*.spec.cjs` test for behavior changes. Build before directly running most Playwright specs. Money is exact integer centimes: reject JavaScript floating-point values at boundaries. Preserve append-only accounting history: correct posted records through linked reversals or credits, never destructive edits. Schema changes require a Prisma migration and `npm run prisma:generate`.

## Commits & Pull Requests

Recent commits use concise release-oriented subjects such as `Wheat 2.1.2609051`; use an imperative, scoped summary for non-release changes. Keep commits focused. Pull requests should explain the user-visible and data-model impact, list validation commands, link the issue when applicable, and include screenshots for renderer changes. Never commit `.env` files, private keys, local databases, generated OCR runtimes, or build/release output.
