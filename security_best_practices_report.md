# Wheat security best-practices report

Audit date: 2026-08-20  
Stack: Electron 42, React 19, TypeScript, Prisma 6, SQLite.

## Executive summary

Wheat has a well-hardened Electron renderer/IPC boundary and strong local archive, migration, exact-money, and evidence-integrity practices. No renderer raw-HTML injection, eval, dynamic third-party script, arbitrary network request, postMessage, or secret-in-client pattern was found in the audited source. The product accurately documents that it is a trusted single-user desktop app rather than a secure multi-user system.

The material residual risks are deployment-model limitations (plaintext data and no real authentication/authorization) and direct SQLite mutation of general posted ledger data. Sage configuration durability, membership uniqueness, and the Prisma tooling advisory were remediated in the post-audit pass. None was identified as an immediate remotely exploitable critical vulnerability in the packaged app.

## High severity

No confirmed remotely exploitable High/Critical application vulnerability was found.

The upstream advisory recorded as SEC-005 was limited to build/config tooling and is now resolved by a tested patched transitive dependency; the final `npm audit` is clean.

## Medium severity

### SEC-001 — No at-rest encryption or real authentication boundary

Rule ID: ELECTRON-LOCAL-TRUST-001  
Severity: Medium  
Location: `README.md` optional local PIN/known limitations; `electron/localSecurity.ts`; `prisma/schema.prisma` `LocalAppSecurity`.  
Evidence: the app stores SQLite and managed attachments locally in plaintext; the PIN is explicitly a UI privacy lock, not Windows authentication or encryption.  
Impact: another OS user/process with filesystem access, malware, an administrator, or offline database tooling can read or alter accounting data.  
Fix: retain honest product messaging; provide deployment guidance requiring protected Windows accounts, full-disk encryption, protected backups, and least privilege. A future multi-user/server architecture needs real identity, authorization, and encrypted secret/session design.  
Mitigation: current local PIN throttling, single trusted instance, audit checks, managed backups, and OS encryption.  
False positive notes: this is a documented architectural limitation, not a hidden password-storage defect.

### SEC-002 — General posted ledger rows are not immutable in SQLite

Rule ID: DATA-INTEGRITY-POSTED-001  
Severity: Medium  
Location: `prisma/schema.prisma` `Entry`/`EntryLine`; migrations; posting/reversal services in `electron/main.ts`, `electron/subledger.ts`, `electron/operations13.ts`.  
Evidence: services reject unsafe mutation and use reversals, but database triggers only protect `InvoiceArtifact`; no trigger prevents direct update/delete of posted Entry/EntryLine rows.  
Impact: direct database access can bypass correction history and alter books. The local audit/integrity checks may detect some consequences but do not prevent the mutation.  
Fix: design a reversible migration with narrowly scoped triggers or append-only storage that permits the legitimate draft-to-post transition and reversal metadata without blocking recovery/migration.  
Mitigation: OS access controls, protected backups, audit chain verification, accounting integrity checks, and restricted normal UI.  
False positive notes: this is not remotely reachable through the audited renderer IPC paths.

### SEC-003 — Sage profile is browser-local and unaudited

Status: Fixed and verified on 2026-08-20. This section records the pre-fix finding.

Rule ID: JS-STORAGE-001 / CONFIG-INTEGRITY-001  
Severity: Medium  
Location: `src/App.tsx` `loadSageProfile`, `saveProfile`, `sageProfileKey`.  
Evidence: profile JSON is read/written through `window.localStorage`. The post-fix loader validates allowed enums, account length, flags, and string mappings, and the Sage validator fails closed; the profile still has no trusted audit record or backup inclusion.  
Impact: local tampering or loss can change journal/account/export behavior without company-data evidence. This is configuration integrity rather than a secret leak.  
Fix applied: a company-unique, versioned SQLite model and checked migration now store validated mappings/options. Main-process IPC validates payloads, every save appends activity/audit evidence, backups include the profile, and Electron reload verification succeeds after deleting the browser copy.  
Mitigation: the new Sage validator blocks malformed/unsafe output even when configuration is tampered.  
False positive notes: no credential/token is stored in localStorage.

## Low severity

### SEC-004 — CSP permits inline styles

Rule ID: JS-CSP-002 / REACT-CSP-001  
Severity: Low  
Location: `index.html` CSP meta tag.  
Evidence: `style-src 'self' 'unsafe-inline'`; `script-src` remains restricted to `self` with no `unsafe-eval`/`unsafe-inline`.  
Impact: reduces CSP protection for style injection, but does not directly enable script execution in the current renderer and may be required by the styling stack.  
Fix: evaluate nonce/hash-compatible styling or generated static styles during a dedicated CSP hardening pass. Do not weaken script policy.  
Mitigation: no raw HTML sink was found; Electron navigation/IPC boundaries fail closed.  
False positive notes: meta-delivered CSP is appropriate for the packaged local file renderer; response headers are not available in the same way as a hosted web app.

### SEC-005 — Prisma toolchain dependency advisory

Status: Fixed and verified on 2026-08-20.

Rule ID: REACT-SUPPLY-001  
Severity: Low product-runtime risk (upstream audit severity: High)  
Location: `package.json`/`package-lock.json`: `prisma` -> `@prisma/config` -> `deepmerge-ts`.  
Evidence: `npm audit --json` reports GHSA-ggr8-5vv4-36mx, stack exhaustion on recursive merge graphs. Prisma CLI is a devDependency; no hostile runtime config ingestion was found in the packaged app.  
Impact: a hostile developer/CI configuration could cause build-tool denial of service.  
Fix applied: lockfile override to patched `deepmerge-ts` 8.0.1 while retaining Prisma 6.19.3. Prisma generation, clean build, isolated seven-migration reset/seed, migration regressions, and the full suite pass; `npm audit` is clean.  
Mitigation: trusted repository/config inputs, lockfile, reproducible installs, and CI resource limits.  
False positive notes: not shown to affect packaged accounting operations.

### SEC-006 — CompanyUser membership lacks uniqueness

Status: Fixed and verified on 2026-08-20.

Rule ID: AUTHZ-DATA-001  
Severity: Low  
Location: `prisma/schema.prisma` `CompanyUser`.  
Evidence: no `@@unique([companyId, userId])`.  
Impact: future multi-user permission code could see duplicate/ambiguous roles.  
Fix applied: schema plus checked migration add `@@unique([companyId, userId])`. A conflicting pre-existing role fails the transactional migration without deleting either record; dedicated migration tests cover both valid and conflict paths.  
Mitigation: current product is single-user and does not expose membership administration.  
False positive notes: not currently an authentication bypass because no real multi-user auth boundary exists.

## Verified secure controls

- Exact trusted renderer origin and main-frame IPC checks in `electron/securityBoundary.ts` and the wrapped `ipcMain` registration in `electron/main.ts`.
- Context isolation, sandboxing, no Node renderer integration, no webviews, no popups/external navigation, fail-closed permissions.
- No discovered `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, `document.write`, dynamic scripts, arbitrary `fetch`, or postMessage receiver.
- No Vite client secret variables; `.env` contains only `DATABASE_URL`, and no value is reproduced in this report.
- Managed archive traversal/collision/symlink/manifest/resource defenses with automated hostile-archive tests.
- Salted scrypt PIN verifier with persisted exponential throttling and secret-free renderer status.
- Packaged runtime removes environment-controlled renderer and user-data paths.
- Lockfile is present; lint/build pass, `npm audit` is clean, and the controlled post-audit suite passed 110 of 111 tests with one intentional skip.
