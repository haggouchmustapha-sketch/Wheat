# Wheat — post-implementation regression, OCR, export & reliability pass

**Date:** 2 September 2026
**Scope:** the nine blocks of the 2026-09-02 brief, in its priority order.
**Guided Work engine:** not rewritten. Its gate semantics, progression, approval
model, unlock rule and 90/10 behaviour are unchanged; only the two targeted
defects named in §9 were fixed, and both are proved below.

---

## 18.1 Sage export

**Root cause.** `EntryLine.thirdParty` is a *display name* in Wheat's own domain
— `subledger.ts` writes `invoice.counterpartyNameSnapshot ?? counterparty.displayName`
into it, and `reporting21.ts` reads it as a label. The Sage exporter mapped that
field straight into Sage's `N° compte tiers`, which is an **account number** in
the target dossier (17 characters). So "ANOUAL HEALTH SOLUTIONS" arrived in an
identifier field, failed a length check, and blocked the export with an error
about a company name. The length was never the problem; the mapping was.

**Mapping changes.**
- `SageEntryLineInput` now carries `counterpartyId`, and `SageTxtProfile` carries
  `thirdPartyMappings` — counterparty id → the third-party account that already
  exists in the target Sage dossier. Keyed by **id**, never by name: two
  spellings of a name are not the same tiers.
- `resolveSageThirdParty()` decides each line: `MAPPED` (a code exists),
  `UNMAPPED` (a known counterparty with no code yet), `UNIDENTIFIED` (a
  free-text party name with no counterparty behind it), `NONE` (a general
  account line). The name is never written into the field in any of them.
- Rows now also carry `thirdPartyName` and `thirdPartyKey` — for the preview and
  the review list only; neither is exported.
- Persistence: `SageExportProfile.thirdPartyMappings` (migration
  `20260902160000_sage_third_party_accounts`, registered in
  `electron/database.ts` so an existing installation upgrades on launch).
  Empty for every existing profile — no dossier gains an account it did not have.
- UI: a **"Comptes tiers utilisés"** section lists every party carried by the
  prepared lines with a box for its Sage account, plus a callout naming any
  free-text parties that cannot be mapped at all.
- `wheat:entry:sage-export-set` now selects `counterpartyId`.

**Length / normalisation policy.**
- **Identifiers are never reshaped to fit.** A mapped third-party code that is
  too long, or that carries impossible characters, is reported *as itself*
  (`SAGE_FIELD_TOO_LONG_THIRDPARTY`, `SAGE_THIRD_PARTY_CODE_INVALID`). Piece
  numbers, account numbers and references keep their existing rules.
- **Descriptive labels are shortened, visibly.** `Libellé écriture` carries no
  accounting identity, so `fitSageLabel()` truncates deterministically at 35
  characters, sets `labelTruncated`, and the export preview shows exactly what
  will be written. A `SAGE_LABEL_TRUNCATED` warning names the affected lines and
  states that no account, amount or reference changed.
- A **missing** third-party account is a `REVIEW` item, not a blocker: the Sage
  field is optional and Wheat cannot know whether the target account is
  collective. The field is left empty, the party is named, and the remedy points
  at the correspondences section. It never becomes a length error about a name.

**Before / after, on the exact reported scenario.**

| | Before | After |
|---|---|---|
| Field 5 of the TXT line | `ANOUAL HEALTH SOLUTIONS` | empty (unmapped) or `C0001` (mapped) |
| Export state | blocked, 3 errors about a company name | not blocked; one review point naming the party |
| `Prestation — ANOUAL HEALTH SOLUTIONS` (36 chars) | blocked | truncated to 35, shown in the preview, one warning |

**Tests.** `tests/sage-txt-unit.spec.cjs` — 10 passing, including *"a legal name
never reaches the Sage third-party account field"* (the ANOUAL scenario as a
fixture, not a special case), *"a third-party account code is reported as itself,
never reshaped to fit"*, *"a free-text party name cannot be mapped and says so
once"*, and *"every issue carries the facts its explanation needs"*.

---

## 18.2 Bank / OCR

**The scanned Attijariwafa statement was run through the real path** —
`parseBankStatement` with the local PaddleOCR runtime, then
`normalizeStatementRows`, the same normalisation the importer uses.

**What the local reading actually got wrong.** Recognition was fine (PP-StructureV3,
95 % confidence). Two faults downstream:

1. **The debit column was lost.** On a Moroccan statement the two money columns
   sit under one centred title, `CAPITAUX`. The layout recogniser gave that
   title a column of its own, so every debit figure landed under a heading Wheat
   did not recognise while the word `DEBIT` sat over an empty strip. Three of
   five movements arrived with no amount at all — and, having no amount, were
   classified as page furniture rather than transactions.
2. **The bank's registration footer was read as a movement.** `carriesAmount`
   accepted "any cell containing a digit", and the footer is full of digits
   (share capital, RC, ICE, a decree number). It produced a movement with a
   credit of `ce Benguerir (0814 AiWaIA`.

**Local OCR changes.**
- `repairOcrMoneyColumns()` (new, `bankStatementImporter.ts`): cleans heading
  punctuation (`DEBIT::` → `DEBIT`), then — for a money column that carries no
  amount on any *movement* row, where **exactly one** unclaimed column between
  the DEBIT and CREDIT headings does — moves the heading onto its data and says
  so. Zero candidates is the ordinary one-sided page and is silent; two or more
  is ambiguous and is reported rather than guessed. Decided from evidence on the
  page; no bank is named anywhere in it.
- `looksLikeStatementAmount()` (new, exported from `reconciliation.ts`): a money
  cell must consist of digits, separators and an optional sign. Loose about
  scanner noise (`8.998.,00` passes), strict about prose (`ce Benguerir (0814
  AiWaIA`, `CREDITEUR`, `RC-333 -C.N.S.S.…` all rejected). `carriesAmount` now
  uses it.
- Date handling (`3006`, `$30 06`, bare `25 06` + statement-year inference,
  malformed value date not discarding a sound movement) was already correct and
  is now pinned against the real file rather than a fixture.

**Attijariwafa PDF, row by row (after):**

| # | Class | Date read | Debit | Credit | Label |
|---|---|---|---|---|---|
| 1 | TRANSACTION | 25 06 → 2026-06-25 | — | 18 334,42 | VIREMENT RECU DE 2 BRIGADE |
| 2 | TRANSACTION | 25 06 → 2026-06-25 | 600,00 | — | PAIEMENT CB CMH BENGUERIR |
| 3 | TRANSACTION | 29 06 → 2026-06-29 | 8.998.,00 → 8 998,00 | — | PAIEMENT CB ELECTROPLANET |
| 4 | TRANSACTION | 3006 → 2026-06-30 | — | 23 400,00 | VIREMENT FONDS COMPENSATION |
| 5 | TRANSACTION | $30 06 → 2026-06-30 | 10 000,00 | — | VIR AG EMIS VERS ETTAOUSSI |
| 6 | TOTAL | — | 142 180,48 | 157 320,02 | TOTAL MOUVEMENTS |
| 7 | CLOSING_BALANCE | — | — | — | SOLDE FINAL AU 30 06 2026 |
| 8–10 | FOOTER | — | — | — | bank registration text |

Before this pass, rows 2, 3 and 5 arrived with no amount and were classed
FOOTER; row 8 was classed TRANSACTION with a text "credit".

**Downstream.** `normalizeStatementRows` turns the page into exactly five
movements with signed centimes `+1 833 442 / −60 000 / −899 800 / +2 340 000 /
−1 000 000`, five distinct fingerprints, and `dateInferred` set on all of them
so every reading a person should confirm surfaces together in the review.

**Wheat AI fallback (§6.1).** New `electron/bankStatementAiFallback.ts`, reusing
the document reviewer's channel (`buildDocumentAiReviewer()`), its provider
choice, its consent rules and its corroboration gate — not a second AI
subsystem. It works from the recognised **text**, no page images, so any chat
model is compatible and the "send to a text-only model, fail afterwards" case
cannot arise. It runs **only** when a movement row is left with no date or no
amount after the local path; a statement Wheat read completely asks nothing.
Rules: it fills empty cells and never overwrites a local reading; every value
must be findable in the recognised text or it is discarded; a row proposed with
both a debit and a credit is left exactly as read locally; rows outside the
request are ignored; a provider failure leaves the local reading intact. Every
row it touched is named in the warnings for review.

**Remaining ambiguity.** The page's own `TOTAL MOUVEMENTS` (142 180,48 /
157 320,02) is much larger than the five visible movements — the file is one
page of a longer statement. Wheat reports the totals as read and does not
reconcile them; a totals cross-check that lowers confidence is **not**
implemented in this pass (see §18.11).

**Tests.** `tests/wheat-bank-scan-real.spec.cjs` (6, against the real PDF, skips
with a stated reason if the local runtime is absent) and
`tests/wheat-bank-ai-fallback.spec.cjs` (8, stubbed channel, all about refusal).

---

## 18.3 AI Reviewer

**Trigger points, before and after.** The gate is in `wheatReview.ts`:

```
before:  skip the model when  REVIEW_REQUIRED && !requested && riskLevel < 2 && no findings
after:   skip the model when  REVIEW_REQUIRED && !requested && riskLevel < 3 && no findings
```

Risk level 3 is where the ledger itself changes — posting, extourne, voiding,
confirming an import, activating a VAT configuration. Level 2 covers preparing
and configuring: a draft entry (`entry.create`, `entry.update_draft`), an
uploaded document (`document.import`), a bank account's settings, a journal, a
VAT draft. Those are saved dozens of times an hour, and a model has nothing to
add to a draft Wheat's own checks already accepted — which is what put a review
surface in front of ordinary bookkeeping. The registry's risk levels are
unchanged; only the threshold moved.

Unchanged: the deterministic pass runs on **every** review, and the owning
domain service still re-validates inside its own transaction. Nothing that can
refuse an operation was touched.

**`NOT_NEEDED` is silent.** `ModelProvenance` now renders **nothing** for
`NOT_NEEDED` and `NOT_APPLICABLE`. "Contrôles Wheat uniquement" and "Relecture
Wheat AI non exécutée" no longer appear on top of a dialog somebody opened to
read a real finding.

**Model compatibility and selection.** `chat()` now distinguishes an explicit
`null` pin ("automatic, and I mean it") from an omitted field. The reviewer's
automatic mode passes `pinnedModelId: null`, so Auto Free stays free-only and
can no longer inherit the assistant's pinned model. Candidate filtering by what
the request needs was already applied before the attempt limit in
`buildCandidateList`; the review sends text and no tools, so every chat model
qualifies and no incompatibility is discovered after the fact.

**Failure UX.** A failed reading now shows one concise line — *"La relecture par
Wheat AI n'a pas abouti. Les contrôles comptables de Wheat, eux, ont bien été
exécutés."* — with **Réessayer la relecture** and **Changer de modèle** (which
opens settings). The provider, the model id and the provider's own error text
moved to `model.detail`, behind the technical-details disclosure.

**Identifiers out of the reading path.** Every `resolveReviewModelSelection`
message was rewritten without model ids; each carries a new `detail` instead
(`OLLAMA · <model>`, `REMOTE · <model>`).

**Tests.** `tests/wheat-review-pipeline.spec.cjs` — 40 passing, including the
threshold in both directions (level 3 always read; a clean level-2 preparation
not read, `NOT_NEEDED`), explicit requests always read, failures reported as
failures, and no identifier in the ordinary path. `tests/wheat-review-electron.spec.cjs`,
`wheat-review-waiting-ui.spec.cjs` and `wheat-review-model-selection.spec.cjs`
pass unchanged.

---

## 18.4 Draft persistence

**Newly wired** (all through the shared `useDraftedForm`, all cleared only after
the domain service returned, never in a `finally`, never on unmount):

| Form | Entity | Draft identity |
|---|---|---|
| Dossier identity (référentiels) | `settings.company` | `current` |
| Fiscal year | `settings.fiscal_year` | record id, else `new` |
| Account | `settings.account` | record id, else `new` |
| Journal | `settings.journal` | record id, else `new` |
| Bank account + ledger mapping | `settings.bank_account` | record id, else `new` |
| VAT configuration (name, rhythm, dates, source, rate table) | `tax_configuration` | `new` |
| Reconciliation review (line, amount, note, reason) | `reconciliation.review` | the movement id |
| Opening balances (exercise, retained-earnings account, regime) | `fiscal.opening` | `current` |
| Fiscal adjustment (kind, label, amount, legal reference) | `fiscal.adjustment` | package id, else `new` |

**A real cross-dossier leak was found and fixed.** A form does not empty itself
the instant the dossier changes: for one render its state still holds what was
typed against the *previous* dossier while `companyId` already names the new
one — and the autosave effect filed it under the new dossier. `useDraftedForm`
now **arms writing per identity, and only after the read for that identity comes
back**. `tests/ui-reliability-followup.spec.cjs` (which asserts an unfinished
account does not follow the user into another dossier) caught it and now passes.

**Restart / navigation.** Drafts live in `FormDraft`, cascaded with the company,
so they survive navigation, tab changes, closing a composer, and restart.
Referential drafts are restored only after the workspace's initial read, so held
work is applied *on top of* the server seeding rather than under it. A draft
started against a record that has since changed comes back `stale` and is
reported, not applied.

**Remaining unwired surfaces:** the fiscal *evidence* attachment form
(`ComplianceWorkspace14`), the VAT *adjustment* form beside it, and small
one-field filters. Named here rather than claimed as done.

---

## 18.5 Guided Work

**Engine untouched.** No change to `wheatGuidedWork.ts`'s state machine, gate
semantics, `AUTOMATABLE_STEPS`, approval flow or unlock rule.
`tests/wheat-dossier-setup.spec.cjs` (28) and `tests/wheat-guided-work.spec.cjs`
pass unchanged, which is the proof that gate/unlock semantics were preserved.

**9.1 — "Compléter l'identité".** The journey step's action target changed from
the generic `settings` tab to `dossier-identity`, and the shell now routes that
to a dedicated **Identité du dossier** dialog which writes through the *same*
company service as the referentials form (same validation, same optimistic
version check, same audit entry — a second surface onto one operation, not a
second implementation). It names what is still missing field by field, and on
save it refreshes the dossier, the journey and guided work, leaving the person
where they were. A `refreshToken` prop was added to `GuidedWork` because it
derives its step from the dossier and had no way to be told the dossier changed.
Verified end to end in the real application:
`tests/wheat-guided-identity-electron.spec.cjs`.

**9.2 — "Reprendre" on a postponed step.** Root-caused against the real
application rather than the test. Instrumenting the bridge showed the product
behaviour was already correct:

```
BEFORE          next = identity (READY)
AFTER POSTPONE  next = vat-configuration ; identity decision = POSTPONED
AFTER RESUME    next = identity ; decision cleared
```

The failing click was landing on a different control. `getByRole("button",
{ name: "Reprendre" })` matches accessible names by substring, and the dossier
setup gate — on screen above guided work — offers two situation choices whose
text contains *"Aucun historique à reprendre"* and *"Wheat doit les reprendre"*.
`.first()` selected one of those. That is a genuine ambiguity in the interface,
not only in the test, so the step's control was renamed **"Reprendre l'étape"**
and given `data-testid="guided-resume-<step>"`; the test now targets it inside
the journey list. `tests/wheat-guided-work-electron.spec.cjs` — both tests pass.

---

## 18.6 Error explanations

**Design.** `src/lib/wheatIssues.ts` defines one `WheatIssue` shape — `code`,
`severity` (`BLOCKER` / `REVIEW` / `WARNING`), the concise `message`, and the
facts the check already knew: `what`, `value`, `reason`, `expected`, `remedy`,
`autoFix`, `blocking`, `technical`. `issueExplanation()` composes the bubble
text in the order a person reads it. Nothing is generated at display time and
nothing asks a model: the check that found the problem is the only thing that
knows why it is one. Absent facts stay absent — an invented rationale beside a
real refusal is worse than none.

**Component.** `IssueInfo` / `IssueList` in `src/components/ui/index.tsx`, built
on the existing `InfoTip` pattern: a real `<button>` with an `aria-label`, open
on hover, on focus and on click, bubble as `role="tooltip"`, technical detail in
a secondary line inside it. Primary UI stays one short line per finding.

**Surfaces covered in this pass:** the whole Sage export screen (blockers,
review points and warnings), and bank-import rejected rows — the latter through
`src/lib/bankImportIssues.ts`, which maps a refusal onto the rule it actually
broke (unreadable/absent-year date, both sides on one line, zero amount,
unreadable amount, missing label) and quotes the offending row back from the
parsed file. A reason it does not recognise keeps its own sentence and gains no
explanation.

**Not yet converted:** OCR confidence/total mismatches, invoice posting, VAT
validation, guided-work blockers, reconciliation, opening balances, backup
failures and draft-conflict notices still render plain text. The shared layer
they need now exists; the conversion is listed in §18.11.

---

## 18.7 OCR review UI

**Architecture.** `electron/documentPagePreview.ts` renders one page of one
managed document to an image, resolved *through the dossier* (the renderer sends
a document id, never a path; a document from another dossier is refused). PDFs
are rendered with `pdf-parse`'s screenshot path; images are returned as-is.
Pages cross the bridge as base64 and are shown as `data:` URLs — which is what
the content policy permits and, more to the point, keeps the renderer from being
able to load arbitrary local paths. Rendered pages are cached (keyed by path,
mtime, size, page and scale) and dropped when a document's file is deleted.

**Rendering a page is a read.** It touches no extraction and cannot re-run
recognition — asserted in the real application by comparing the stored
extraction before and after three renders at different scales.

**Surface.** `DocumentSourceViewer` sits in a two-column layout beside the
correction form: page back/forward with "Page X / Y", zoom out / fit / in, the
page in its own scrolling frame so zooming never moves the form. A file Wheat
cannot draw (a spreadsheet, a missing file, a page beyond the end) says so
plainly instead of showing an empty frame, and the fields stay editable.

**Fields shown / inline edits.** The correction form is unchanged — it already
comes from `src/lib/smartFields.ts`, which offers every field the pipeline reads
including **Débours**, keeps unknown keys, and preserves them on save. The test
asserts the Débours box is present in the split view.

**Bounding boxes.** Not implemented, deliberately. Wheat does not persist
per-word or per-field coordinates — the stored extraction keeps `wordCount` and
`textLength` per page, not geometry — so there is nothing to highlight from.
Faking coordinates was explicitly out of bounds; this is recorded in §18.11.

**Test.** `tests/wheat-ocr-source-review.spec.cjs`, in the real application with
a real PDF.

---

## 18.8 Backup

**Root cause.** Two different rules for the same thing. The recogniser's
`safeSegment` stripped accents and forbidden characters but truncated *after*
trimming (so a long counterparty name could end in a space), ignored Windows
device names, and emitted NFKD — while the archive's `assertSafeArchivePath`
rejects a trailing space or dot, reserved names, and any non-NFC form. Where
they disagreed, one attachment made the **whole dossier** unbackuppable. The
document did not even have to become an invoice; OCR ingestion alone staged it.

**Managed-path strategy.**
- The portability rule now lives once, in `archive.ts`, which owns the contract:
  `portableArchiveSegment()` / `portableArchiveRelativePath()` /
  `isPortableArchiveRelativePath()`. `smartOcr.ts`'s `safeSegment` delegates to
  it, so a file is named through the same rule that will later have to carry it.
  Accents, spaces, apostrophes, real Moroccan names and Arabic script all
  survive untouched — none of them is a portability problem.
- For files stored before that: `repairNonPortableManagedPaths()` in
  `managedFileProvenance.ts` renames the file and updates its row in one step
  (and rolls the rename back if the row cannot be updated, so a file is never
  orphaned). Collisions get distinct names. It is idempotent.
- `createFullWheatBackup()` runs the repair before verification. Anything that
  genuinely cannot be repaired **stops the backup with that exact file named** —
  a backup that claims to be complete never silently omits an attachment.

**Verification.** `tests/wheat-managed-path-repair.spec.cjs` (5) covers the
naming rule, repair of a real unsafe path with bytes and row moving together,
idempotence, collisions, and a missing file being left to the provenance check.
`tests/wheat-archive-unit.spec.cjs` and
`tests/wheat-managed-file-provenance.spec.cjs` pass unchanged, so restore and
portability guarantees are intact.

---

## 18.9 Tests

Final full run: **762 tests — 747 passed, 1 failed, 14 skipped** (8.3 min).
(Baseline in the brief: 727 total, 710 passed, 3 failed, 14 skipped. 35 tests
were added in this pass.)

**Failed — 1, blocked rather than broken.**
- `wheat-migration-compliance` — Prisma refuses `migrate reset --force` when it
  detects an AI agent, and demands explicit human consent. **I did not bypass
  it.** The command is
  `npx prisma migrate reset --force --skip-seed`; it would irreversibly destroy
  everything in the target database and is only ever meant for a development
  one. If you want this test run, say so explicitly and it can be re-run with
  the consent variable Prisma requires.

**Previously failing, now passing.**
- `wheat-guided-work-electron` — postpone/resume (§18.5).
- `wheat-electron-integration` — the rail click. Root cause: the dossier setup
  gate correctly still had the rail restricted, because everything before that
  click drove the domain through the IPC bridge and the shell was never told.
  Two fixes: the gate is now re-read when the dossier gains its first entries,
  invoices or documents (so creating a first entry from guided work or from
  Wheat AI opens the rail without navigating away and back), and the test
  reloads so the interface reads what the bridge did.
- `viewport-layout-regression` — two separate faults, both real. A startup race
  where the renderer's bootstrap landed inside exclusive maintenance and was
  refused outright: an ordinary operation now **waits** for maintenance, bounded
  at 15 s, instead of telling the person to retry by hand. And my own split
  layout overflowed at 1184 px because its grid columns had minimum widths; both
  tracks are now `minmax(0, 1fr)` and stack below 1320 px.
- `ui-reliability-followup` — caught the cross-dossier draft leak described in
  §18.4. Fixed in the shared hook.

**Skipped — 14, environment-gated, unchanged:** historical backup fixtures, live
AI/Ollama, the packaged executable, private samples. Reported as skipped, not
passed.

**New specs (35 tests):** `wheat-bank-scan-real`, `wheat-bank-ai-fallback`,
`wheat-managed-path-repair`, `wheat-issue-explanations`,
`wheat-ocr-source-review`, `wheat-guided-identity-electron`, plus additions to
`sage-txt-unit` and `wheat-form-drafts`.

**Real manual / Electron checks.** The scanned Attijariwafa PDF through the real
recognition path (repeatedly, before and after the fix, with row-by-row output);
the identity dialog end to end in a launched app; postpone/resume instrumented
through the live bridge; the OCR source viewer with a real invoice PDF in a
launched app.

---

## 18.10 Files changed

**New**
| File | Why |
|---|---|
| `src/lib/wheatIssues.ts` | One shape for a checked finding and its explanation |
| `src/lib/bankImportIssues.ts` | Rejected statement rows → structured findings |
| `electron/bankStatementAiFallback.ts` | Assisted completion of unreadable statement rows |
| `electron/documentPagePreview.ts` | Renders one document page for the review surface |
| `prisma/migrations/20260902160000_sage_third_party_accounts/` | `SageExportProfile.thirdPartyMappings` |
| `tests/wheat-bank-scan-real.spec.cjs` | The real scanned statement, end to end |
| `tests/wheat-bank-ai-fallback.spec.cjs` | The limits placed on the assisted pass |
| `tests/wheat-managed-path-repair.spec.cjs` | Backup path naming and repair |
| `tests/wheat-issue-explanations.spec.cjs` | The explanation layer and its control |
| `tests/wheat-ocr-source-review.spec.cjs` | Source page beside the fields, in the app |
| `tests/wheat-guided-identity-electron.spec.cjs` | "Compléter l'identité", in the app |

**Changed**
| File | Why |
|---|---|
| `src/lib/sageTxt.ts` | Third-party account resolution, label fitting, structured issues |
| `src/App.tsx` | Sage third-party mapping UI and issue lists; identity dialog and guided routing; `DocumentSourceViewer` and the split review layout; bank-import issue list; gate re-read on dossier content |
| `src/App.css` | Split review layout, source viewer |
| `src/components/ui/index.tsx` | `IssueInfo`, `IssueList` |
| `src/styles/components.css` | Issue list and explanation bubble |
| `src/lib/useFormDraft.ts` | Autosave armed per identity (cross-dossier leak) |
| `src/lib/useWheatReview.tsx` | Retry, model-settings route |
| `src/components/WheatReview.tsx`, `.css` | Silent `NOT_NEEDED`; failure actions |
| `src/components/GuidedWork.tsx` | `refreshToken`; unambiguous "Reprendre l'étape" |
| `src/components/BooksWorkspace13.tsx` | Five referential drafts |
| `src/components/ComplianceWorkspace14.tsx` | VAT configuration draft |
| `src/components/OperationalAccounting.tsx` | Reconciliation review draft |
| `src/components/FiscalWorkspace.tsx` | Opening-balance and adjustment drafts |
| `src/types/electron.d.ts` | Page preview bridge; model `detail` |
| `electron/main.ts` | Sage third-party persistence and selection; reviewer identifiers out of messages; Auto-Free pin; managed-path repair before backup; bounded maintenance wait; page preview handler |
| `electron/wheatReview.ts` | Model threshold; failure message and detail |
| `electron/bankStatementImporter.ts` | Money-column repair; AI fallback wiring |
| `electron/reconciliation.ts` | `looksLikeStatementAmount`; stricter `carriesAmount` |
| `electron/archive.ts` | Portable segment/path rule, exported |
| `electron/smartOcr.ts` | Managed names use that rule |
| `electron/managedFileProvenance.ts` | `repairNonPortableManagedPaths` |
| `electron/database.ts` | New migration registered |
| `electron/wheatJourney.ts` | Identity step targets the identity editor |
| `electron/wheatWorkflowRegistry.ts` | Page-preview channel classified |
| `electron/preload.ts` | `getDocumentPagePreview` |
| `electron/wheatAiProviderService.ts` | Explicit `null` pin means automatic |
| `prisma/schema.prisma` | `thirdPartyMappings` |
| `tests/sage-txt-unit.spec.cjs`, `wheat-form-drafts.spec.cjs`, `wheat-review-pipeline.spec.cjs`, `wheat-electron-integration.spec.cjs`, `wheat-guided-work-electron.spec.cjs` | Updated to the changed contracts, each with the reason in the test |

---

## 18.11 Remaining limitations

Stated plainly. None of the following is fixed, and none should be read as
validated.

1. **Per-field source highlighting is not implemented.** Wheat does not persist
   per-word or per-field coordinates, so there is nothing to highlight from.
   Doing it properly means storing word geometry from the recogniser at
   ingestion — a change to what an extraction contains, not a UI change.
2. **Statement totals are not cross-checked.** `TOTAL MOUVEMENTS` and
   `SOLDE FINAL` are read and excluded from movements, but Wheat does not
   compare them against the sum of imported movements or lower confidence on a
   mismatch. §6.2 asks for this; it is not done.
3. **The Wheat AI bank fallback has not been exercised against a live model.**
   Its gates are tested with a stubbed channel. No live provider run was made.
4. **The error-explanation affordance covers two surfaces, not all of them.**
   OCR mismatches, invoice posting, VAT validation, guided-work blockers,
   reconciliation, opening balances, backup failures, draft conflicts and
   migration errors still render plain sentences.
5. **The loading-state audit (§13) was not done systematically.** Two specific
   defects were fixed (the maintenance refusal, and the page viewer's own
   loading state). OCR, batch import, backup, export preparation and guided-work
   preparation were not individually reviewed for immediate visible state.
6. **`wheat-migration-compliance` is blocked, not passing.** See §18.9. My new
   migration therefore has **not** been proved to apply to a database built from
   scratch by `prisma migrate`; it *is* exercised by the runtime migration path
   in `electron/database.ts`, which every Electron test now goes through,
   including the legacy-database baselining test.
7. **Areas Sonnet did not cover, and neither did I:** mutating Wheat AI / chat
   flows, fiscal workpaper and VAT workpaper generation, and payroll. Untouched
   and unverified in this pass.
8. **The Sage third-party mapping is entered by hand.** Wheat deliberately does
   not derive or create third-party account codes: Sage refuses accounts that do
   not exist in its dossier, and inventing one would be the same class of error
   as writing the name into the field.
9. **No git history.** This repository is not a git working tree, so none of the
   above is available as a reviewable diff.
