# Wheat 2.0

Wheat 2.0 is an interface release. The accounting engine, TVA rules, fiscal logic, reconciliation,
imports, exports, OCR behaviour, database meaning, validation and permissions are unchanged, and no
feature was removed. One new capability was added: Wheat AI provider settings.

## A rebuilt interface

- Replaced the flat sidebar with a grouped navigation rail: eight labelled sections following the
  order of an accounting month, each entry carrying a plain-language description in its tooltip and
  in the command palette. The rail collapses to icons without losing any entry or its accessible
  name.
- Every screen now opens with the same three answers: what it is for, what lives on it, and where
  to get help. Page headers carry a purpose sentence, a four-item guide, and a collapsed "how this
  works" explanation written for someone with no accounting training.
- Rebuilt tables, cards, dialogs, dropdowns, filters, buttons, badges, tooltips, and the empty,
  loading and error states so they read as one system. Errors state the cause and the fix rather
  than a raw message; confirmations state the question, the consequence and whether it is
  reversible.
- Rebuilt the startup, first-run onboarding, PIN lock and database-recovery screens.
- Light and dark mode are both first-class, built from the official Wheat palette.

## Understandable without accounting expertise

- Correct terminology is kept — écriture, lettrage, extourne, liasse, TVA collectée/déductible —
  and explained in place through field tooltips and per-screen help.
- Actions that previously existed only in a right-click menu are now visible buttons; the context
  menus were narrowed to duplicates of what is already on screen.
- Screens that need an open dossier now say so, with two ways forward, instead of rendering
  nothing.

## One searchable dropdown

- Accounts, dossiers, journals, documents, counterparties, invoices, periods, columns and models
  all use the same combobox: integrated search, keyboard navigation, visible focus, an explicit
  selected state, and dedicated loading, error and no-result states.
- Long lists stay responsive — the panel renders a window of results and the rest stay reachable
  through the search box.
- Small fixed choices stay native so a two-option decision is still one click.

## A centralised design system

- Colour, typography, spacing, radii, borders, shadows, surfaces, focus states and semantic
  feedback all resolve through tokens. No stylesheet outside the token layer contains a literal
  colour, and a test enforces it.

## Wheat AI providers

- Wheat AI can now use the free tiers of **OpenRouter** and **Groq** alongside local models.
- API keys are encrypted by the operating system's own credential vault. They are never stored in
  plaintext, never written to `localStorage`, never logged, never returned to the interface and
  never included in an error message. If the vault is unavailable, Wheat refuses to store the key
  rather than falling back to plaintext.
- **Automatic — free models** is the default. A model is eligible only when the provider's own
  metadata confirms it is free; unknown pricing is rejected, and no model identifier is ever
  invented.
- Ranking weighs Wheat AI compatibility, availability, context capacity and reliability. When a
  model is rate-limited, exhausted, withdrawn or times out, Wheat moves to the next eligible free
  model, at most four times, never repeating one. An invalid key, a revoked authorization, a
  malformed request, a safety refusal or a cancellation stops immediately instead of masking the
  problem.
- Cross-provider fallback happens only when both keys are configured.
- Wheat AI's accounting knowledge, bounded dossier context, typed capabilities, permission modes,
  confirmations and audit events are unchanged.

## Rebranding

- The product is Wheat, the assistant is Wheat AI, and this release is Wheat 2.0. No Wheat name
  remains in the interface.
- The on-disk profile directory, database filename, installer identity, backup format marker and
  persisted record values keep their historical names so existing installations keep their data.
  Backups are now written as `.wheatbackup`; the older `.atlasbackup` archives still restore.

Full detail, evidence and known limitations: [the Wheat 2.0 implementation
report](wheat-2/claude-implementation-report.md).
