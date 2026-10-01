# Dashboard review and first UI pass

Reviewed main commit `11631ca2c785c1b67a95965d102f70908af23973` through GitHub source access.

## Changes in this draft

- Preserve the signs of class 7 credit-minus-debit and class 6 debit-minus-credit balances. A debit balance on a products account reduces products; a credit balance on an expenses account reduces expenses.
- Label the class 7 aggregate as products rather than sales turnover: class 7 includes more than sales.
- Remove dashboard period/status/domain controls that only updated labels and showed a toast. Products and result are explicitly identified as all-history posted totals; reports remain the destination for choosing a period. VAT retains its own displayed period.
- Remove metric sparklines sourced from a hard-coded six-month array.
- Give the dashboard a scoped, responsive layout with consistent spacing, calmer cards and tabular figures. Use existing Wheat tokens for light/dark themes and edition differences.

No accounting schema, posting workflow, or persisted history is changed.

## Remaining draft reliability findings

### Stale work can be overwritten by autosave

In `src/lib/useFormDraft.ts`, `useDraftedForm` calls `onStale` and then arms autosave for the identity anyway. The invoice, credit, payment and counterparty callers in `src/components/OperationalAccounting.tsx` only show a warning in their stale handlers. The current form is then autosaved under the same key, replacing the held stale payload and its base version.

Reproduction to validate: save unfinished edits to version 3 of an invoice; update the underlying invoice to version 4; reopen the composer; wait beyond the 700ms debounce; load the held draft. The previous unfinished payload should remain available for explicit recovery/discard.

Recommended fix: provide an explicit stale-work recovery decision before arming autosave, preserving the held payload until that decision.

### A failed autosave loses its queued retry payload

`useFormDraft.flush` removes `pendingValue` before awaiting `saveFormDraft`. Its catch only sets the error status. If saving fails and the user makes no further edit, closing the form or flushing before restart has no queued payload left to retry.

Reproduction to validate: reject the first `saveFormDraft` call, allow the next call, and navigate away without another keystroke. Reopening should recover the latest form state.

Recommended fix: retain the failed payload for retry without replacing a newer queued edit, and serialize writes/clear operations per draft identity.

These are source findings; they have not been reproduced in Electron in this session.

## Validation

Added a focused regression case to `tests/dashboard-unit.spec.cjs` with debit balances on class 7 accounts and credit balances on class 6 accounts. The former absolute-value behavior yields the wrong products, expenses and result.

Source checks verified removal of dashboard-only filter state and sample sparklines and use of shared tokens in the new stylesheet.

Runtime validation remains outstanding because this session has GitHub tools but no shell, Node/Electron runner or browser. Before merge:

```powershell
npm run lint
npm run build
npx playwright test tests/dashboard-unit.spec.cjs --reporter=line
```

Inspect the dashboard in both themes and editions, at laptop widths and 80–125% zoom; capture real application screenshots. Existing UI suites may need updates for removal of the ineffective dashboard controls. This draft is a dashboard starting point for the wider UI rework, not a completed redesign of every workspace.
