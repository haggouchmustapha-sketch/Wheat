# Wheat AI capability audit

State of the typed capability registry after the reliability pass of 2026-08-31.
105 capabilities across 19 categories: 43 read, 1 navigation, 33 mutating at
level 1–2, 28 at level 3.

## How to read the classification

| Level | Mode | Confirmation | What it means |
|---|---|---|---|
| 0 | `READ` / `NAVIGATION` | never | Runs immediately. Reads dossier data through a typed, company-scoped service. |
| 1 | `SAFE_EDIT` | never after clear execution intent | A reversible draft or metadata edit. Runs immediately in assistant and automated modes; questions and previews still never mutate. |
| 2 | `ACCOUNTING_MUTATION` | unless the dossier is in `AUTOMATED` mode | Touches accounting or compliance data. Re-validated at execution. |
| 3 | `HIGH_IMPACT` | **always**, whatever the mode | Irreversible or destructive. Never runs without an explicit human confirmation immediately beforehand. |

Level 3 covers, exactly: posting, reversing, voiding, deleting a draft,
reclassifying a draft, archiving an account/journal/bank account/third party,
reviewing or reopening a VAT workpaper or fiscal table, removing evidence,
confirming or cancelling a ledger import, and voiding a payroll run.

Wheat still never files a declaration with the DGI. No capability submits
anything to an authority; `vat.review` and `fiscal.review_table` lock a working
paper inside Wheat and nothing more.

## What changed

| Wheat feature | UI can | AI before | AI after | Class | Remaining limitation |
|---|---|---|---|---|---|
| **Documents — search** | yes | crashed (`Document.revision`) | `documents.search` | read | — |
| **Documents — read OCR extraction** | yes | `documents.get` | unchanged | read | — |
| **Documents — correct a field** | yes | `documents.update_extraction` | unchanged | L1 | refused once the document is linked to a draft |
| **Documents — re-run OCR** | yes | `documents.rerun_ocr` | unchanged | L1 | refused once linked to a draft |
| **Documents — create invoice draft** | yes | purchase only | `documents.create_invoice_draft`, sale **or** purchase, `kind` only when a person settled it | L2 | — |
| **Invoices — reclassify a mis-filed draft** | new | none | `invoices.reclassify_draft` | **L3** | drafts only; a posted invoice is corrected by void + re-entry |
| **Third parties — find an existing one** | list only | `counterparties.list` (paginated, no search) | `counterparties.resolve` — ICE/IF/RC/normalised name, flags the dossier itself | read | — |
| **Third parties — read one** | yes | none | `counterparties.get` | read | — |
| **Third parties — create / update / archive / restore** | yes | yes | unchanged | L1 / L3 | — |
| **Accounts — choose one for a role** | manual | none | `accounts.suggest` (searches the dossier's own chart) | read | — |
| **Accounts — search / read / save / archive** | yes | yes | unchanged | read / L1 / L3 | — |
| **Payments — read one** | yes | list only | `payments.get`, with exact unallocated balance | read | — |
| **Payments — draft / post / void / allocate** | yes | yes | unchanged | L1–L3 | — |
| **Entries, reports, banking, VAT, fiscal, imports, payroll, audit** | yes | yes | unchanged | read / L1–L3 | — |
| **Navigation** | — | `navigation.open` | unchanged, always offered | read | — |

### Selection

The change with the widest effect is not a new tool. Tool selection scored on
keywords and, below four matches, fell back to five read-only capabilities —
which is why "corrige cette facture" arrived with nothing that could change an
invoice and the assistant answered that it had no typed tool. Now:

- ten orientation capabilities are offered on every turn, whatever the wording
  (`company.get`, `settings.get`, `navigation.open`, `accounts.search`,
  `counterparties.resolve`, `invoices.list`, `invoices.get`, `documents.search`,
  `documents.get`, `entries.search`);
- a category the request touched is offered whole, so an invoice question
  carries the tools that can act on an invoice;
- the list is capped at 34 (hard maximum 40) so a turn stays affordable.

## Still not exposed, deliberately

| Operation | Why |
|---|---|
| Duplicating an invoice | No `duplicateInvoice` service exists; the assistant composes `invoices.get` + `invoices.create_draft`, which goes through the same validation. Building a new service for it would duplicate subledger logic. |
| Linking a document to an existing invoice/payment/entry | No application service owns this today; the OCR hand-off is the only linking path, and it is transactional. Adding a second one needs the same atomicity guarantees. |
| Creating or deleting a company | Out of the dossier scope every capability is bound to. |
| Filing a tax declaration | Wheat does not file. Nothing to expose. |
| Raw SQL, raw Prisma, shell, arbitrary filesystem | Never. Asserted by test in `wheat-ai-capabilities.spec.cjs` and `wheat-electron-integration.spec.cjs`. |
