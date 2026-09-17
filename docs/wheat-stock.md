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
`stockValidation.ts` or `stockAccounting.ts` reads the edition, and
`tests/wheat-edition-unit.spec.cjs` lists them alongside the accounting modules
to keep it that way. The schema and its migration are edition-blind, so the same
dossier file opens in either build with the same catalogue, the same balances and
the same valuations. Visual differences belong to the shared token layer, which
this workspace uses and does not bypass.

## Tests

| File | What it pins down |
| --- | --- |
| `tests/wheat-stock-arithmetic-unit.spec.cjs` | scales, parsing, rounding, the exact-zero case, the CMP and FIFO reference cases, allocation summing to the charge |
| `tests/wheat-stock-domain-unit.spec.cjs` | the acceptance scenarios against a real database, transfer conservation, raw-SQL immutability, atomic rollback, company isolation, period locks, backdating, reversal |
| `tests/wheat-stock-ipc-unit.spec.cjs` | the registered surface, permissions, membership, error wording, exact decimal transport |
| `tests/wheat-stock-ui.spec.cjs` | the workspace in a real Electron build: the named columns, and the acceptance figures on screen |
| `tests/wheat-stock-edition-parity.spec.cjs` | one dossier file written and read by both builds, alternating, with identical balances, valuations, references and drafts |

## Not implemented yet

The schema carries these models and they are covered by the migration, but no
service or interface reaches them:

- physical inventory campaigns (`StockInventoryCampaign`, `StockInventoryCount`)
- impairments (`StockImpairment`) and their accounting
- CSV import of the catalogue and of opening stock
- unit conversions (`StockUnitConversion`)
- the dedicated report set and the printable stock card
  (the card exports CSV and prints through the browser today)
