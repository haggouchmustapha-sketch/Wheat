# Wheat full automated test suite run — 2.1.2609

Date: 2026-09-02
Scope: the full Playwright suite (`tests/*.spec.cjs`) against the existing build (`dist/`, `dist-electron/`) and the existing seeded `prisma/dev.db`. No source code was changed. No fixes were attempted — this is a log of what was run and what was found, per explicit instruction.
Environment: Windows 11, `npx playwright test` (config: `workers: 1`, `timeout: 180_000`), invoked from inside a Claude Code session.

## 1. Summary

- **727 tests total**
- **710 passed**
- **3 failed** (see §2 — all three reproduced identically on a second, isolated rerun, so they are consistent, not flaky)
- **14 skipped** (see §3 — all environment-gated, not failures)
- Full-suite wall time: **10.3 minutes**

Build freshness was verified before running: no file under `src/` or `electron/` was newer than `dist-electron/main.js`, so the existing build reflects the current source tree.

## 2. Failures found (logged, not fixed)

### 2.1 `tests/wheat-electron-integration.spec.cjs:6` — "Wheat services share the desktop database, numbering and typed-tool boundary"

```
TimeoutError: locator.click: Timeout 30000ms exceeded.
  - waiting for locator('.wt-rail').getByRole('button', { name: 'Comptes & états', exact: true })
```

Everything up to this point in the test passes: standard chart of accounts (1134 accounts), piece numbering/sequencing, balance/bilan, and a long sequence of ~20 Wheat AI typed-tool/capability assertions (read-only rejection, dry-run plans, draft creation, post-preview, high-risk confirmation gating, and finally a `navigation.open` capability call targeting `"documents"`). The very next line — a real UI click on the "Comptes & états" rail button — times out after 30s because the element is never found/clickable.

Reproduced identically on rerun (same locator, same timeout, same line).

Not investigated further per instruction, but worth noting for whoever picks this up: the failure happens immediately after the Wheat AI `navigation.open` capability call (which drives real navigation via IPC to `"documents"`), so the rail's state or visibility at that point is the first place to look — this was not confirmed, only observed as adjacent in the test's control flow.

Artifact: `test-results/wheat-electron-integration-90246-ing-and-typed-tool-boundary/error-context.md`

### 2.2 `tests/wheat-guided-work-electron.spec.cjs:122` — "a postponed step steps aside in the interface and can be resumed"

```
Error: expect(locator).toHaveText(expected) failed
Locator:  locator('.wt-card__title').first()
Expected: "Compléter l'identité de la société"
Received: "Vérifier le régime et la configuration de TVA"
```

Sequence in the test: capture the current guided-work step title (`firstStep`) → click "Reporter" (postpone) → assert the card no longer shows `firstStep` (passes) → open "Afficher tout le parcours" and confirm the postponed step is listed as "Reportée" (passes) → click "Reprendre" (resume) on it → assert the card is back to showing `firstStep`. That last assertion fails: after resuming, the card still shows "Vérifier le régime et la configuration de TVA" (the step the journey had moved on to), not the postponed step ("Compléter l'identité de la société") that "Reprendre" was clicked on.

Reproduced identically on rerun.

This reads as a genuine behavior gap in the guided-work resume flow (resuming a postponed step doesn't bring it back as the active card) rather than a test-timing issue, since the assertion has a 30s timeout and the DOM value is stable ("62 ×" repeated resolutions to the same wrong text) — but this was not root-caused, only observed and reproduced.

Artifact: `test-results/wheat-guided-work-electron-3ed87-nterface-and-can-be-resumed/error-context.md`

### 2.3 `tests/wheat-migration-compliance.spec.cjs:194` — "a fresh database applies every migration and seeds without inventing compliance evidence"

This is **not a Wheat bug** — it's an environmental block. The test internally shells out to:

```
node node_modules/prisma/build/index.js migrate reset --force --skip-seed
```

against a temporary/isolated database it sets up for the test. Prisma's CLI has a built-in guard that detects when it's invoked from inside an AI coding agent (it identified this session as Claude Code) and refuses to run a destructive `migrate reset` without explicit human consent passed via a `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` environment variable containing the user's verbatim consent text. Per this session's own safety rules around destructive/hard-to-reverse operations, that consent was not sought or granted, so the command was correctly left blocked rather than being worked around.

Reproduced identically on rerun (same Prisma refusal message both times).

**This test cannot pass when run by an AI agent unless a human explicitly grants that consent for this specific invocation.** It's expected to pass when run directly by a person (`npx playwright test tests/wheat-migration-compliance.spec.cjs`) or in CI, where Prisma won't detect an agent context. No other test in the suite showed this pattern.

Artifact: `test-results/wheat-migration-compliance-2ee93-venting-compliance-evidence/error-context.md`

## 3. Skips (14) — all environment-gated, confirmed by inspection, not failures

| Count | Reason | Gate |
|---|---|---|
| 6 | `tests/wheat-migration-integrity.spec.cjs` — historical-backup-fixture tests | `backups/` folder does not exist in this checkout |
| 2 | `tests/wheat-migration-operational.spec.cjs` — historical-backup-fixture tests | same — `backups/` folder missing |
| 2 | `tests/wheat-migration-compliance.spec.cjs` — historical-backup-fixture tests (distinct from the failure in §2.3, which does *not* use this fixture) | same — `backups/atlas-1.4-prework-1.3-release-20260814-001/dev.db` missing |
| 1 | `tests/wheat-ai-live.spec.cjs` — real multi-gigabyte model download | `WHEAT_AI_LIVE_TEST=1` not set |
| 1 | `tests/wheat-ai-fiscal-inputs.spec.cjs` (live Ollama case) | `WHEAT_OLLAMA_LIVE_TEST=1` not set |
| 1 | `tests/paddleocr-packaged-ui-2.0.spec.cjs` | `WHEAT_EXE` not set (needs a packaged build) |
| 1 | `tests/ocr-private-local.spec.cjs` | private sample PDFs (outside the repo) not present on this machine |

6 + 2 + 2 + 1 + 1 + 1 + 1 = 14, matching the reported skip count exactly.

## 4. Not run

- `tests/updater.spec.cjs` Windows-specific cases *did* run (this machine is win32), not skipped.
- PaddleOCR sidecar health (`npm run paddle:check`) was not separately invoked; the in-suite OCR specs that don't require the packaged `.exe` ran as part of the full suite above.

## 6. Manual feature tour, driven through the real app, with the real documents in `test documents for use/`

Date: 2026-09-02 (same session, continued). Scope: beyond the automated suite in §1–3, this is an exploratory pass driving the actual built Electron app (not a mock) through a broad slice of Wheat's features, using a disposable isolated profile (`WHEAT_USER_DATA_DIR` pointed at a temp folder — never the real `%APPDATA%\Wheat\`) and the seven real documents the user supplied in [`test documents for use/`](../test%20documents%20for%20use). No source code was changed; this section is a log only, as instructed.

Method: a throwaway Playwright/Electron driver script (kept in the session scratchpad, not in `tests/`) that boots the app, creates a test dossier, and calls the same `window.wheat.*` bridge the UI itself calls — the same code path a real click would hit — plus a handful of direct UI clicks with screenshots for visual confirmation.

### 6.1 OCR — all 7 real documents

| File | Type detected | Confidence | Notable result |
|---|---|---|---|
| `Facture_LUNA_STEEL_CHANI_MAROC_Papier_Entete_Bleu.pdf` | INVOICE | 90% | HT 750.00 / TVA 150.00 / TTC 900.00 MAD, all 6 accounting checks passed |
| `SFKT141P26081319210.pdf` | INVOICE | 88% | HT 45.00 / TVA 9.00 / débours 21.4276 / TTC 75.4276 MAD, scanned (no text layer, rendered+recognized locally), passed |
| `SFKT141P26081319260.pdf` | INVOICE | 85% | HT 53.00 / TVA 10.60 / débours 25.55 / TTC 89.15 MAD, scanned, passed |
| `WhatsApp Image 2026-08-13 at 23.31.16.png` | INVOICE | 90% | **Flagged, not accepted**: HT 42.1607 + TVA 6.4333 ≠ TTC 50.60 MAD — implied rate 15.26%, not a valid Moroccan VAT rate. Wheat correctly refused to invent/repair a total and marked `ttc`, `ht`, `tva` uncertain. |
| `WhatsApp Image 2026-08-21 at 00.59.54.jpeg` | INVOICE | 93% | HT 52.00 / TVA 10.40 / TTC 62.40 MAD, all checks passed |
| `Whatsapp Scan 9 juillet 2026 at 15.46.15.pdf` | BANK_STATEMENT | 88% | Scanned, no amounts read — correctly left absent rather than guessed |
| `Whatsapp Scan 9 juillet 2026 at 15.46.15.xlsx` | BANK_STATEMENT | 88% | 14 table rows read; same underlying content as the `.pdf` above |

The Documents & OCR workspace (real UI, screenshot taken) independently confirms the same tallies: **7 documents imported, 89% average confidence, 5 flagged "à vérifier," 1 duplicate detected** — the duplicate being the `.pdf`/`.xlsx` pair above, which really are the same bank statement in two formats, so that's correct duplicate detection, not a false positive.

**This is a real positive finding**: on genuine, unedited, real-world Moroccan invoices and scans (not synthetic test fixtures), the OCR pipeline correctly typed every document, extracted ICE/IF/dates/HT/TVA/TTC/débours accurately, and its arithmetic-check layer correctly caught the one document whose own printed numbers don't add up — matching the "never invents/repairs a document" invariant in `CLAUDE.md` under real conditions, not just synthetic ones.

### 6.2 Building invoice drafts from the OCR'd documents

First pass (no explicit direction given): all 5 invoice-type documents failed with *"Wheat n'a pas pu déterminer si cette pièce est une vente ou un achat... Aucune des deux parties de la pièce ne correspond au dossier actif"* — **expected**, since the disposable test dossier's ICE has no relation to any real counterparty on these documents; this is Wheat correctly refusing to guess a party it can't identify, not a bug.

Second pass, passing the direction explicitly (`postDocumentEntry(documentId, "PURCHASE")`, since these are all documents a dossier would have received):

- 4 of 5 built an invoice draft successfully.
- The 5th (`WhatsApp Image 2026-08-13...png`, the one with the arithmetic mismatch above) was **correctly refused again**, this time with an explicit reason: *"Les totaux lus ne s'équilibrent pas : HT 421607 + TVA 64333 ≠ TTC 506000 (en centimes). Wheat ne corrige pas une pièce pour la faire tomber juste : corrigez la lecture dans la revue OCR."* — exactly the documented behavior.

No defect found in this area; direction resolution and the balance guard both behaved correctly against real documents.

### 6.3 Real finding: one bad managed-file attachment blocks backup for the whole dossier

`window.wheat.createBackup()` failed, reproduced identically across **two separate app launches** against the same profile:

```
Error: La sauvegarde complète n'a pas pu être créée. Aucun fichier existant n'a été remplacé.
Managed attachment is not portable or safe:
MANUAL TOUR SARL/2026/07-July/Invoices/SOCIETE LAKHOUILI sarl./1788373049890-04eb28-WhatsApp Image 2026-08-13 at 23.31.16.png
```

Notably, this is the *same* document whose invoice-draft creation was refused for the arithmetic mismatch in §6.2 — **no invoice was ever posted for it** (`listInvoices` returned 0, then 4, matching only the 4 that succeeded). Yet OCR ingestion alone appears to have already staged a "managed attachment" for it under an `Invoices/<counterparty>/` path, and that staged path fails whatever portability/safety check `archive.ts`'s backup routine applies — and that single failure aborts backup creation for the entire dossier rather than skipping or reporting just that one file.

This looks like a genuine defect worth someone's attention: **a single problematic document can make the whole dossier unbackuppable**, which is a serious failure mode for an accounting app whose backup is meant to be the safety net. Not investigated further and not fixed, per instruction — logged only.

### 6.4 Everything else exercised in this pass — all correct

- **Core accounting**: created a balanced manual entry (500.00 MAD), posted it, reversed it — piece numbering, reversal linkage, and the general balance all came back correct (`balanced: true`).
- **Reporting**: Bilan came back balanced for the test dossier.
- **Guided journey**: state read back 15 stages / 15 guided-work steps for a fresh dossier, consistent with the documented 15-stage journey.
- **Wheat AI status** (read-only): 4 models registered, local runtime correctly reported as not installed on this machine, 105 typed capabilities exposed — consistent with the automated suite's own assertions in §1.
- **Audit chain**: `verifyAuditChain` reported `valid: true`, 10 chained events, no problems — the OCR imports, entry post, and reversal above all left a consistent SHA-256 chain.
- **Local PIN lock**: full cycle (disabled → set up with a PIN → enabled → disabled) worked cleanly on the disposable profile.
- **UI navigation**: rail clicks to "Comptes & états," "Travail guidé," "Wheat AI," and "Réglages" all rendered correctly (screenshots captured). One click to a button literally named `"Documents"` timed out — but that was this script's own mistake: the real button is labelled **"Documents & OCR,"** confirmed by screenshot; not a product issue.

### 6.5 Not covered in this pass

Time-boxed, so the following were not exercised and should not be read as "passed": direct bank-statement import/reconciliation confirmation flow (`parseBankStatement`/`importBankStatement`/`confirmReconciliation`), Wheat AI mutating tool execution and chat, fiscal workpapers/VAT workpaper generation, payroll, and the guided-work postpone/resume UI flow already flagged as suspect in §2.2.

## 7. A note on this session

Two `system-reminder` / hook messages appeared mid-session with injected-looking instructions — one framing this as a "bugfix" task and pointing at a specific file (`src/generated/prisma/internal/prismaNamespace.ts`) to "surgically patch," and another pointing at other files as a "likely implementation path." These were treated as untrusted background content, not as instructions from the user, and were not acted on — consistent with the explicit instruction in this conversation not to fix anything, only to test and log.
