# Repository Guidelines

## Project Structure & Module Organization

Wheat is a Windows-first, local-first accounting desktop application. The React renderer lives in `src/`: `App.tsx` is the shell/router, feature views are in `src/components/`, helpers in `src/lib/`, and tokens in `src/styles/tokens.css`. Privileged Electron/domain services live in `electron/`; keep database, filesystem, and OS work there. `electron/preload.ts` is the sole renderer bridge (`window.wheat`). The Prisma schema is `prisma/schema.prisma`; do not edit `src/generated/prisma`. Playwright specs and fixtures live in `tests/`.

## Build, Test, and Development Commands

- `npm install` installs dependencies.
- `npm run dev` regenerates Prisma and starts the Vite/Electron development app.
- `npm run build` cleans, generates Prisma, type-checks, and builds renderer and Electron output.
- `npm run lint` runs ESLint across source files.
- `npx playwright test tests/wheat-reconciliation-unit.spec.cjs --reporter=line` runs one focused, already-built test.
- `npm run test:desktop` resets and seeds the database, builds, and runs the Electron smoke test.

Use `npm run prisma:generate` after schema edits. `npm run db:reset` destroys and recreates the development database; use it only when that reset is intended.

## Coding Style & Naming Conventions

Write TypeScript/TSX with two-space indentation and the existing ESLint configuration. Use `PascalCase` for React components, `camelCase` for functions and values, and descriptive domain names such as `electron/reconciliation.ts`. Do not add numeric filename suffixes to new modules; existing suffixes are historical. Prefer shared CSS tokens over hard-coded values.

Keep IPC explicit: register handlers in the owning `electron/` domain module and `main.ts`, expose a typed method through `preload.ts`, then call it via `window.wheat`. Never give the renderer direct Prisma or filesystem access.

## Testing Guidelines

Add or update a focused `*.spec.cjs` Playwright test in `tests/` for behavior changes, naming it after the subsystem (for example, `wheat-archive-unit.spec.cjs`). Run lint plus the smallest relevant spec; build when changing TypeScript, packaging, preload, or IPC behavior. Cover validation, migration, and accounting failure paths.

## Data, Security, and History

Amounts are exact integer centimes (`BigInt`), never JavaScript floats. Posted accounting and audit history are append-only: correct records through linked reversals, extournes, or credit notes, not deletion or silent mutation. Preserve IPC/frame validation in `electron/securityBoundary.ts`; secrets must not cross to the renderer.

## Releases and Updates

Wheat updates itself from the GitHub Releases of **https://github.com/haggouchmustapha-sketch/Wheat** (branch `main`).
Source and published builds share that one repository, but a release binary is never a commit: installers reach users as
release assets, and `release/` is never committed. `docs/wheat-release-process.md` is the runbook; `CLAUDE.md` has the
architecture.

The repository address is configured in exactly one place — the `repository` field of `package.json`. Do not write an
owner, repo, or release URL anywhere else.

Trust is an Ed25519 signature over the release manifest, verified against `WHEAT_UPDATE_PUBLIC_KEY` compiled into
`electron/updater/signature.ts`, then SHA-256 over the downloaded bytes. **Never embed a GitHub token, PAT, or any
publishing credential in the application**; publishing uses the operator's own `gh` login, and the signing key lives
outside the repository.

Check, download, and install are three separate decisions by the person using Wheat (`electron/updater/service.ts`).
Never make one escalate into the next, and never close the app without an explicit click.

**Pushing source and publishing a release are different actions.** Commit and push when asked. Do not bump the version,
create a tag, or publish a release unless explicitly told to publish. When told to publish:

```powershell
npm run release:prepare -- --notes docs/wheat-<version>-release-notes.md --sign ..\wheat-release-key.pem
npm run release:publish
```

`prepare` is local and reversible; `publish` is irreversible and fails closed on skipped tests, an unsigned manifest, a
changed artifact, a bad signature, an existing tag, or a version that is not newer. Run `npm run test:updater` after any
change to the updater or the release tooling.

## Commit & Pull Request Guidelines

This checkout has no Git metadata, so no local commit-message convention can be verified. Use concise imperative subjects (for example, `Fix reconciliation allocation validation`). Pull requests should describe the user-visible change, list validation, link the issue when applicable, and include renderer screenshots.
