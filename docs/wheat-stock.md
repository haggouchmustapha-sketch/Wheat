# Wheat Stock

Native inventory for Wheat: one catalogue, one register, one valuation engine,
one set of migrations, shared by every build of the product.

This document is the reference for how the module decides things. The code it
describes lives in `electron/stock*.ts` and `src/components/StockWorkspace.tsx`.

## The invariant everything else serves

A stock position is **`(quantity, value)`** — never `(quantity, rounded unit
cost)`. Unit cost is derived for display and never fed back in, because
`roundedUnitCost × quantity` accumulates a discrepancy that nothing downstream
can distinguish from a real one.

The consequence the module is tested against: when quantity reaches zero, value
reaches zero exactly. Receiving three units at 333,333333 and issuing them one
then two ends at `(0, 0)`, not at `(0, 0.01)`.

## Scales

| Scale | Value | Used for |
| --- | --- | --- |
| `QTY_SCALE` | 1e6 | quantities, six decimals |
| `MONEY_SCALE` | 1e6 | stock value, micro-dirham |
| `CENT_SCALE` | 1e2 | `EntryLine.debitCents`, what accounting already stores |

All three are `BigInt`. `electron/stockUnits.ts` owns every conversion between
them; no domain code divides by a scale directly. Stock value is carried at
micro-dirham for its whole life inside the module and converted to centimes
**once**, by `moneyMicroToCents`, at the boundary where a movement becomes an
accounting line. Rounding is half-up away from zero, applied at that boundary
and nowhere earlier.

Values are checked against the signed 64-bit range (`assertStoredRange`) before
they are persisted: BigInt arithmetic is unbounded, so an overflow would
otherwise surface months later as a balance Prisma cannot read back.

Across IPC, a quantity or a value travels as `{ raw, display }` — the scaled
integer as a string, and an exact decimal string beside it. The renderer formats
the text and never parses it into a JavaScript number.

## Valuation

Set per article, and refused once the article has movements — changing the
method mid-history would reprice movements already in the ledger.

**CMP.** A receipt adds quantity and value. An issue removes the position's value
in proportion to the quantity leaving it. Taking the whole position returns the
whole value rather than a recomputation of it.

**FIFO.** Every eligible receipt opens a layer. Issues consume layers oldest
first, ordered by `(documentDate, sequence)`. A layer consumed entirely releases
exactly what remains in it. **Every layer touched produces a consumption record**
— that record is what a reversal gives the value back to, and what answers
"which purchase did this sale consume" years later.

## The register

`StockMovement` is append-only, enforced by SQLite triggers that refuse `UPDATE`
and `DELETE`, following the pattern `InvoiceArtifact` already uses. An
application-layer rule binds only the code that remembers to ask it.
`StockFifoConsumption` is append-only for the same reason: a reversal appends a
`RESTORATION` row rather than editing the `CONSUMPTION` it undoes.

`StockBalance` is a cache of the current position. **Historical stock is always
rebuilt from movements**, never guessed backwards from today's balance.

Note that SQLite fires a child table's `BEFORE DELETE` trigger on a foreign-key
cascade only when `recursive_triggers` is on, and Wheat leaves it off. Deleting a
dossier therefore does not meet the register's trigger — which is why
`wheat:company:delete` refuses a dossier holding validated movements, exactly as
it already refuses one holding posted entries.

## Validation

Validation is the **only** operation that changes stock. Creating, editing and
deleting a draft change nothing.

One Prisma transaction does all of the following or none of it: permission and
dossier membership, the fiscal period, the document's own state, stock
availability, document numbering, valuation, landed-cost allocation, the
immutable movements, the balance cache, FIFO layers and consumption records, the
linked accounting draft, the audit event, and the status transition.

Double validation is prevented by claiming the document on the version that was
read (`updateMany … where status = DRAFT and version = n`), the same mechanism
`postDraftEntryInTransaction` uses. Disabling a button is not a concurrency
control.

### Numbering

Stock documents have their own sequences, per dossier, fiscal year and type
(`BR-2026-000001`). They never borrow `JournalPieceSequence`: an accounting piece
number answers to its journal, and sharing the sequence would make a stock
receipt consume a number the ledger was going to use.

A draft carries a `BROUILLON-…` placeholder and consumes no number. Validation
allocates the real one, so an abandoned draft leaves no gap.

### Backdating

**Refused.** A document dated before movements that already exist for the same
position is rejected, naming the blocking movement and offering the two real
corrections: re-date the document, or reverse the later movements and re-enter
them. Appending a row with an older date is not sufficient — every issue
validated after that date was valued against a position the new document would
have changed, and those costs are already in the ledger.

Same-day is allowed: the movement sequence gives it a defined place after what is
already there, so nothing earlier is repriced.

## Accounting

Stock generates exactly one leg: the movement of value on the article's stock
account against its variation account.

- Stock rises → debit stock, credit variation.
- Stock falls → debit variation, credit stock.

It never generates a supplier payable, a customer receivable, or VAT of either
direction. Those belong to the invoice that accompanies the goods, and a stock
module that also posted them would book the same commercial transaction twice.

The generated entry is a **DRAFT**, created inside the validating transaction
through `createEntryInTransaction` — the same machinery `wheat:entry:create`
uses, so the fiscal-period check, journal and account validation, piece numbering
and balance check all still apply. It was extracted from `createEntry` rather
than reimplemented: a second copy would be a second place for those rules to
drift.

### Account mapping

Resolved **article → family chain → dossier**. `StockAccountMapping.scopeKey`
carries the level in its value (`COMPANY`, `FAMILY:<id>`, `ARTICLE:<id>`) because
a unique index over nullable columns would not constrain anything — SQLite treats
every NULL as distinct.

**There is no fallback account.** An article nothing maps blocks accounting
generation with a message naming it. Defaulting to 3111 would post a raw-material
company's entire inventory to merchandise, silently.

The CGNC codes in `STOCK_ACCOUNT_SUGGESTIONS` (3111/6114, 3121/6124, 3122/6124,
3151/7132, and 3911/6196/7196 for impairment) are **suggestions shown while
configuring**, offered as candidates to an accountant. They have not been
verified against current Moroccan law by this implementation, they depend on the
dossier's own plan and on whether it applies permanent or periodic inventory, and
nothing in the module posts to one that was not explicitly configured.

### Transfers

A transfer conserves company quantity **and** value: the value leaving the source
is exactly the value entering the target, by construction rather than by a
recomputation that could round differently on each side.

Mapping is scoped to article, family and dossier — never to a warehouse — so both
halves of a transfer resolve to the same stock account, the two legs net to zero,
and **no accounting entry is generated**. The goods never left the company, and
inventing an entry to prove the module ran would be noise in the journal. A
dossier that genuinely needs different accounts per location would need mapping
extended to warehouses first; that is deliberately not supported rather than
silently approximated.

## Negative stock

Forbidden by default. The refusal names the article, the dépôt, what is available
and what was asked for.

`StockSettings.allowNegativeStock` relaxes it **for CMP only**, and only where the
position has an existing cost ratio to extrapolate from; an empty position worth
nothing offers no basis and is still refused, because inventing a cost would put
a number in the accounts that nothing in the dossier supports.

**FIFO always refuses.** There is no acquisition layer to consume.

## Reversal

Validated history is immutable; corrections are contrepassations. The original
keeps every row it wrote, and the reversal appends the opposite movements.

- **FIFO issue** — each consumption is returned to the exact layer it came from.
- **FIFO receipt** — allowed only while the layer it opened is untouched;
  otherwise refused, stating received, remaining and already-consumed quantities.
- **CMP receipt** — refused when the current position cannot absorb it.
- **Transfer** — the target receipt is removed before the source issue is
  restored, preserving the transferred value exactly.

## Permissions

Expressed against the roles Wheat already has, not a permission table of its own.
Reads are open to `VIEWER`; catalogue, documents, validation, reversal, inventory
and import need `ACCOUNTANT`; the accounting configuration needs `ADMIN`.

**Every IPC handler checks the role and the dossier membership in the main
process.** The `companyId` arrives from the renderer and is never trusted on its
own — the membership row is what grants access, so a forged id resolves to no
membership and the call stops before anything is read.

## One module, every build

Nothing in `stock.ts`, `stockUnits.ts`, `stockValuation.ts`, `stockDomain.ts`,
`stockValidation.ts`, `stockAccounting.ts`, `stockUnitConversion.ts`,
`stockInventory.ts`, `stockImpairment.ts`, `stockImport.ts` or
`stockReports.ts` reads the edition, and `tests/wheat-edition-unit.spec.cjs`
lists them alongside the accounting modules to keep it that way. The schema and its migration are edition-blind, so the same
dossier file opens in either build with the same catalogue, the same balances and
the same valuations. Visual differences belong to the shared token layer, which
this workspace uses and does not bypass.

## Units and conversions

An article is counted in exactly one unit — its base unit — and the register
only ever holds that. A document line may state its own unit, and
`stockUnitConversion.ts` resolves it once, when the line is written.

A conversion exists only because somebody configured it. `1 carton = 12 unité`
is a fact about a dossier's packaging, not about the words, and nothing here
assumes a kilogram is a thousand grams for a dossier that never said so.

- Conversions are **company-level** and follow chains: configuring
  `1 palette = 40 carton` and `1 carton = 12 unité` answers "how many unités in
  a palette" with 480, exactly.
- A chain is resolved as a **rational** — the product of the factors followed
  forwards over those followed backwards — and divided once, at the end.
- The resolved factor and the base quantity are **frozen on the line**
  (`unitFactor`, `baseQuantity`). Editing a conversion later changes what new
  lines resolve to and leaves every movement already in the ledger alone.
- A conversion that would close a cycle whose factors disagree is refused when
  it is saved, because the graph would then answer the same question two ways.
- A conversion that does not divide exactly at six decimals is **refused**, not
  rounded. `1 unité = 1/12 carton` is therefore not expressible, and the message
  says so; the line is entered in the article's own unit instead. Rounding would
  put a quantity into the register that nobody entered.

## Inventaire physique

A campaign is a freeze, a count, and an adjustment. `DRAFT` → `COUNTING` →
`REVIEWED` → `VALIDATED`, with `CANCELLED` available until an adjustment exists.

**The snapshot** rebuilds the theoretical position from the **movements** up to
the campaign date, never from `StockBalance`: the cache answers "now", and a
campaign dated at a year end has to answer "then". `warehouseId` may be null,
which means every active dépôt; each count row names its own dépôt either way.

**The basis cannot move underneath the count.** Validation recomputes the
theoretical position and compares it with what was frozen; if anything moved it
stops and names the article. The correction is to refresh the snapshot, which
keeps every counted quantity, and look at the variances again.

**The adjustment** is ordinary stock documents — `INVENTORY_SURPLUS` for what
was found, `INVENTORY_SHORTAGE` for what was missing — validated through
`validateStockDocumentInTransaction`. The period check, the numbering, the
immutable register, the FIFO layers and the balanced DRAFT entry are therefore
produced by the code that already does all of that.

A surplus landing on an existing position enters at what that position is worth.
One landing on a position the dossier holds nothing of has no such figure, so
the count carries a `unitValue`; without it validation refuses and names the
article. The count rows survive validation — the evidence is not consumed by it.

Under CMP the variance value the sheet shows is exactly what gets posted. **Under
FIFO it is the theoretical figure**: a manquant consumes the oldest layers, and
what those cost is not in general the average the position carries. The report
shows the implied figure before validation and the movement's own value after.

## Dépréciation

An impairment changes the accounts and nothing else: no movement, no balance, no
FIFO layer. The dossier still holds exactly what it held.

The row keeps the quantity, the value it was carried at and the recoverable
value the accountant entered; `amount` is the difference. Storing the difference
alone would leave a figure nobody could audit back to a judgement.

- One active provision per (article, dépôt). Raising, lowering or releasing one
  is a **reprise** — its own row, its own reference, its own entry — and the
  original keeps every value it was written with.
- **No account, no entry, no row.** Unlike a movement, an impairment has no
  existence outside the ledger, so a dossier that has not configured its
  provision, dotation and reprise accounts cannot record one at all. The refusal
  names the accounts that are missing.
- Dotation debits the charge account and credits the provision; a reprise
  reverses the pair. Both go through `createStockDraftEntry`, so the balance
  check and the single centime conversion are the ones the rest of stock uses.

## Import

`stockImport.ts` reads a catalogue (`ARTICLES`) or an opening stock
(`OPENING_STOCK`) from CSV, TXT or XLSX. Encoding, separator, quoted fields and
the XLSX sheet are read by `tabularSource.ts`, shared with the bank statement
importer so an accented désignation cannot decode one way in one import and
another way in the other.

**Preview, then confirm.** `planImport` reads the file, applies the mapping the
person chose, validates every row and returns the whole plan — every refusal
included — without opening a transaction. `confirmImport` re-reads the same
bytes, re-plans them against the catalogue as it now stands, and writes them all
or none. Trusting the plan that came back from the renderer would be trusting a
description of a file rather than the file.

- Column mapping is **suggested and confirmed**, never applied silently.
- A SKU that already exists is refused unless the person chose, for the whole
  import, to update or to skip. Duplicates *inside the file* are caught too.
- A row naming a unit or a family the dossier does not have is refused, naming
  it. Creating one to make the import succeed would put a code in the catalogue
  nobody chose.
- No account mapping is ever guessed, and a valuation method cannot change for
  an article that has already moved.
- `OPENING_STOCK` builds one document per dépôt and validates each through the
  ordinary path, so the opening position gets its movements, its layers and its
  accounting draft like anything else.

## Reports

`stockReports.ts`. Every figure is read from the register or derived from it by
the arithmetic the register uses; there is no estimate and no classification.

| Report | What it answers |
| --- | --- |
| Valorisation | The position at a date, grouped by article, dépôt, famille or méthode, with the derived unit cost, the active provisions and the net value. Rebuilt from movements, so it gives the same answer next year. |
| Journal des mouvements | The register filtered by period, article, dépôt, type, sens or reference, in `(documentDate, sequence)` order — the order FIFO consumes in. |
| Écarts d'inventaire | One campaign's theoretical, counted and variance figures, derived by the same `varianceOf` validation uses. |
| Anomalies | Negative quantity, negative value, value without quantity, quantity without value, and FIFO layers that do not total their position. Each is a property of the arithmetic, not a suspicion. |
| Rotation | Days since the last movement per held position, in stated day buckets, with positions that have never had an issue named as such. No prediction about whether goods will sell. |

A dossier-wide provision — one taken with no dépôt — is split across that
article's positions in proportion to their value by `allocateProportionally`,
so a report grouped by dépôt neither drops it nor counts it twice.

## Tests

| File | What it pins down |
| --- | --- |
| `tests/wheat-stock-arithmetic-unit.spec.cjs` | scales, parsing, rounding, the exact-zero case, the CMP and FIFO reference cases, allocation summing to the charge |
| `tests/wheat-stock-domain-unit.spec.cjs` | the acceptance scenarios against a real database, transfer conservation, raw-SQL immutability, atomic rollback, company isolation, period locks, backdating, reversal |
| `tests/wheat-stock-ipc-unit.spec.cjs` | the registered surface, permissions, membership, error wording, exact decimal transport |
| `tests/wheat-stock-ui.spec.cjs` | the workspace in a real Electron build: the named columns, and the acceptance figures on screen |
| `tests/wheat-stock-completion.spec.cjs` | unit conversion exactness and historical preservation, inventory variance, validation and its refusals, impairment and reprise, import validation, duplicates and atomic rollback, and the report set |
| `tests/wheat-stock-edition-parity.spec.cjs` | one dossier file written and read by both builds, alternating, with identical balances, valuations, references and drafts — including an inventory validated by one build and a provision recorded by the other |

## Deliberate limitations

These are chosen, not missing. Each one is a case where the honest answer is to
refuse rather than to approximate.

- **Conversions are per dossier, not per article.** `1 carton = 12 unité` holds
  for the whole dossier. A catalogue where a carton of one article holds twelve
  and another holds six needs two units, not two conversions of one unit.
- **A conversion factor that is not expressible at six decimals is refused.**
  This makes the reciprocal of an awkward factor unusable as a line unit; the
  line is entered in the article's own unit instead.
- **Backdating still applies to an inventory.** A campaign dated before
  movements that already exist is refused by `assertNoBackdatingConflict` like
  any other document, because validating it would reprice issues already in the
  ledger. Reverse the later movements, or date the campaign after them.
- **The FIFO variance value shown before validation is theoretical.** See
  Inventaire physique above.
- **Account mappings are never verified by Wheat.** The CGNC codes in
  `STOCK_ACCOUNT_SUGGESTIONS` and `STOCK_IMPAIRMENT_SUGGESTIONS` — 3111/6114,
  3121/6124, 3122/6124, 3151/7132 and 3911/6196/7196 — **have not been checked
  against current Moroccan requirements by this implementation**. They are shown
  while configuring, labelled as requiring an accountant's verification, and
  nothing posts to one that was not explicitly saved.
