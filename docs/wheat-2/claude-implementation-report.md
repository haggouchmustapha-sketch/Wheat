# Wheat 2.0 — implementation report

Canonical version: **2.0.0** (`package.json`). The interface presents itself as **Wheat 2.0**.

This release is an **interface release**. The accounting engine, TVA rules, fiscal logic,
reconciliation, imports, exports, OCR behaviour, database meaning, validation and permissions are
unchanged. One new capability was added, as authorised: **Wheat AI provider settings** (OpenRouter
and Groq). No feature was removed, disabled or hidden.

---

## 1. Screens reviewed and reworked

Every reachable screen was opened, read and rebuilt. The checklist below is the complete set.

| # | Screen | Route | Status | What changed |
|---|--------|-------|--------|--------------|
| 1 | Startup / loading | boot | Rebuilt | Named progress steps instead of a bare spinner, breathing brand mark, local-data reassurance. |
| 2 | First-run onboarding | first launch | Rebuilt | Two-column layout: what Wheat prepares (3 numbered steps) beside the form; searchable legal-form / exercise / VAT pickers; demo-dossier card moved into the flow. |
| 3 | Local PIN lock | locked | Rebuilt | Explains what the lock does **and does not** do (it is not encryption); throttling and configuration-error states are separate callouts. |
| 4 | Database recovery | load failure | Rebuilt | States what Wheat did *not* do, shows the technical cause, and orders the three recovery actions by safety (retry → back up the damaged file → restore). |
| 5 | Accueil | `home` | Rebuilt | Next-step banner, four explained KPIs, the six steps of an accounting month as feature tiles, a "where everything else lives" directory, and reset/demo cards. |
| 6 | Production du jour | `production` | Rebuilt | Five step cards each with state, tone badge and its own action; two work queues; "aller plus loin" tiles. |
| 7 | Tableau de bord | `dashboard` | Rebuilt | Searchable filter bar, four KPI tiles with tooltips, TVA donut + key/value legend, aged-receivable meters, actionable alert list, bank tiles. |
| 8 | Dossiers | `companies` | Rebuilt | One card per dossier with ICE/IF tooltips, fiscal-year list, and visible Open / Copy ICE / Configure / Delete buttons (previously right-click only). |
| 9 | Écritures | `entries` | Rebuilt | Status + journal comboboxes, period-lock card with a confirmation dialog, explained debit/credit help, rebuilt ledger table. |
| 10 | Documents & OCR | `documents` | Rebuilt | Import card with drop zone, OCR stats, searchable type filter, list/detail split, per-field uncertainty markers, collapsible OCR text and detected tables. |
| 11 | Factures & paiements | `billing` | Reframed + dropdowns | New page header, guide and "how this screen works" help; counterparty, account, VAT-rule, bank and invoice pickers converted to the searchable dropdown. |
| 12 | Paie | `payroll` | Rebuilt | Four payroll KPIs, period/export card, salary table with visible row actions, brut/net explanation. |
| 13 | Banque & rapprochement | `reconciliation` | Reframed + dropdowns | Page header with a plain-language explanation of what reconciliation is; bank-account filter converted. |
| 14 | TVA | `vat` | Reframed + dropdowns | Header explains collectée/déductible/crédit; configuration, evidence-document and workpaper pickers converted. |
| 15 | Comptes & états | `statements` | Rebuilt tabs | Card tabs with per-tab explanations; PCGE class, parent-account, balance-view, exercise and retained-earnings pickers converted; version-stamped kicker removed. |
| 16 | Liasse fiscale | `fiscal` | Reframed | Header explains what a liasse and a retraitement are; workpaper evidence picker converted. |
| 17 | Rapports comptables | `reports` | Reframed + dropdowns | Account, journal and counterparty pickers converted; "which report do I need" help. |
| 18 | Contrôles & imports | `books` | Rebuilt tabs | Card tabs with explanations; import sheet/column mapping, bank-ledger account, draft and draft-line pickers converted. |
| 19 | Export Sage & FEC | `sage` | Rebuilt | Settings / correspondences / controls / preview as four explained cards; blocking errors and warnings separated; export disabled with a stated reason. |
| 20 | Analyse locale | `assistant` | Rebuilt | Conversation card, example-question chips, and an explanation of how it differs from Wheat AI. |
| 21 | Wheat AI | `wheat-ai` | Rebuilt | Model card (with the free remote models), permission card, conversation panel, starter questions, proposal/result cards. |
| 22 | Réglages | `settings` | Rebuilt | Profile, preferences, **Wheat AI providers**, security, backups, bank↔ledger mapping, reset, updates, licence and activity log, each as its own card. |
| 23 | Entry dialog | modal | Rebuilt | Field-level help, searchable journal/account pickers, live balance strip with a status badge. |
| 24 | Company dialog | modal | Rebuilt | ICE/IF/VAT tooltips, searchable exercise and VAT pickers. |
| 25 | Employee dialog | modal | Rebuilt | Grouped identity/remuneration fields, brut→net explanation, live net strip. |
| 26 | Bank-statement import dialog | modal | Rebuilt | Detection stats, explained column mapping with searchable pickers, source preview, control results, duplicate confirmation. |
| 27 | Update-installed dialog | modal | Rebuilt | Reassurance that data is untouched, release notes list. |
| 28 | Command palette | Ctrl+K | Rebuilt | Grouped (Actions / Aller à), per-entry description, arrow-key navigation, keyboard legend, no-result state. |
| 29 | Context menus | right-click | Rebuilt | Design-system styling; every entry also exists as a visible button. |
| 30 | Toasts | global | Rebuilt | Tone-specific icon and left border, polite live region. |
| 31 | Navigation rail | global | New | Eight labelled groups, per-entry tooltip, collapsible, profile + local-data footer. |
| 32 | Workspace header | global | New | Searchable dossier switcher, global search with Ctrl+K, primary actions, update indicator, theme and help. |
| 33 | Mobile navigation | ≤860 px | Rebuilt | Ten most-used destinations with labels and tooltips. |

Dead code removed: `DocumentsPageLegacy` — an unreachable, superseded copy of the Documents
screen that the rebuilt page replaces.

---

## 2. Design-system changes

Three ordered layers, loaded before any screen style (`src/App.tsx` imports them in this order):

1. **`src/styles/tokens.css`** — the single authority. Brand ramp from `Wheat Design/Color Palette.png`
   (Terracotta `#C85A3A`, Rust `#A6402A`, Clay `#D78A63`, Cream `#F7EFE6`, Dark Brown `#2B1E17`),
   then semantic tokens for canvas, surfaces, text, lines, brand interaction, selection, focus,
   semantic feedback, charts and elevation — defined once for light (`:root`) and again for dark
   (`.dark`). Typography (9-step scale, tabular figures), spacing (12 steps), radii, borders,
   control heights, motion (with `prefers-reduced-motion`), z-index and layout metrics.
2. **`src/styles/components.css`** — buttons (7 variants × 3 sizes), badges, chips, cards, sections,
   fields, switches, the searchable select, tables, dialogs, tooltips, disclosures, callouts,
   empty/loading/error states, skeletons, progress, tabs (underline and card), segmented controls,
   filter bars, search inputs, toasts, stats, meters, key-value lists, code chips, plus responsive,
   forced-colors and print rules.
3. **`src/styles/shell.css`** — rail, workspace header, page scaffolding, page header with purpose
   and guide, next-step banner, feature tiles, split layouts, mobile nav, command palette, context
   menu, brand marks, and the full-screen boot/lock/recovery/onboarding shells.

`src/App.css` previously carried its own `:root` and `.dark` token blocks, which would have
overridden the new system; those blocks were removed and the file now contains only screen rules
that resolve through tokens.

**No stylesheet outside `tokens.css` contains a literal colour.** This is enforced by
`tests/wheat-design-system-unit.spec.cjs`.

React primitives live in `src/components/ui/`:
`index.tsx` (Button, IconButton, Badge, Card, Section, Field, Switch, InfoTip, Explainer,
HelpDisclosure, Callout, EmptyState, LoadingState, ErrorState, InlineLoading, Stat, Dialog,
ConfirmDialog, PageHeader, NextStep, FeatureTile, Tabs, TabPanel, SearchInput, TableWrap),
`WheatSelect.tsx`, `brand.tsx`.

Brand assets are used exactly as supplied. `scripts/make-wheat-assets.cjs` derives
`public/brand/*` from `Wheat Design/` by trimming to the alpha bounding box and letterboxing into a
transparent square — aspect ratio and transparency preserved, nothing recoloured or redrawn.
`main light.png` → light mark, `Main Dark.png` → dark mark, `Wheat AI.png` → the Wheat AI icon.

---

## 3. Feature visibility

- All **18 destinations** keep their own labelled rail entry, grouped into eight named sections
  (Pilotage, Dossiers, Saisie & pièces, Banque, Fiscalité & clôture, Rapports & contrôles,
  Assistance, Configuration).
- Every destination has a one-sentence `pagePurpose` (shown in the rail tooltip, the command
  palette and the page header) and a short `pageShortHelp` label.
- Nothing was moved into an unlabelled overflow menu. Right-click menus were **narrowed to
  duplicates** of buttons that are already visible: dossier actions (open, copy ICE, configure,
  delete) and payroll actions (edit, delete) are now visible buttons as well.
- The collapsed rail hides labels visually but keeps the accessible name (`aria-label`) and the
  full explanation (`title`).
- Screens that need an open dossier now render an explicit empty state with two actions instead of
  rendering nothing.
- `tests/wheat-design-system-unit.spec.cjs` asserts that every pre-2.0 destination still exists,
  belongs to exactly one navigation group, has a purpose sentence, and is actually rendered.

Two page identifiers were renamed for clarity — `atlas21` → `statements`, `atlas-ai` → `wheat-ai`.
Both are internal route keys; neither is persisted.

---

## 4. Searchable dropdowns

`src/components/ui/WheatSelect.tsx` is the single dropdown. It renders in a portal with viewport
clamping, and supports:

- integrated search with diacritic-insensitive, multi-term matching;
- full keyboard control (`ArrowUp/Down`, `Home`, `End`, `Enter`, `Escape`, `Tab`);
- `role="combobox"` / `role="listbox"` / `role="option"` with `aria-expanded`, `aria-selected`,
  `aria-activedescendant`, `aria-invalid`, `aria-required`;
- visible focus ring, explicit selected state with a check mark, search icon, clear button;
- **no-result**, **no-option**, **loading** and **error** states (the error state offers a retry);
- option groups, secondary notes, badges;
- a 120-row rendering cap with a "N more — refine your search" footer, so a 1,100-account PCGE
  stays responsive;
- an optional hidden input so native form submission is unchanged.

The search bar appears automatically at **8 or more options**, or whenever the list is loading or
errored. Small fixed selectors (2–5 options: payment direction, method, counterparty kind, VAT
rate direction, evidence role, bilan variant, fiscal regime) stay native and are styled through
`#root select` so they match the rest of the system.

**Converted (28 dropdowns):**

| File | Dropdowns |
|------|-----------|
| `src/App.tsx` | dossier switcher, dashboard period / status / domain, entries status + journal, document type filter, document corrected type, Sage output kind / account length / encoding, bank→ledger account, lock delay, settings language, entry journal + per-line account, company exercise + VAT, onboarding legal form + exercise + VAT |
| `OperationalAccounting.tsx` | invoice counterparty, VAT configuration version, invoice line account, VAT rate rule, payment counterparty, payment bank account, allocation invoice, default receivable account, default payable account, reconciliation bank filter |
| `BooksWorkspace13.tsx` | general-ledger account, journal, counterparty, import sheet, import column mapping, bank ledger account, draft picker, draft journal, draft line account, account class |
| `ComplianceWorkspace14.tsx` | VAT rate account, active VAT configuration, evidence document, filing receipt, adjustment document |
| `FiscalWorkspace.tsx` | PCGE class, parent account, balance view, target exercise, retained-earnings account, workpaper evidence document, Wheat AI model, Wheat AI permission mode |
| `WheatAiProviderSettings.tsx` | preferred provider, pinned free model |

Submitted values are byte-identical to what the previous `<select>` emitted — `onChange` receives
the option's `value` unchanged. `tests/wheat-design-system-unit.spec.cjs` fails if any remaining
`<select>` is data-driven or carries eight or more options without the explicit
`wt-native-select` opt-out.

---

## 5. Wheat AI provider architecture

Three new main-process modules:

- **`electron/wheatAiSecrets.ts`** — the vault. Keys are encrypted with Electron `safeStorage`
  (DPAPI on Windows, Keychain on macOS, the desktop keyring on Linux) and written to a `0600`
  file in the profile directory, atomically via a temp file + rename.
- **`electron/wheatAiProviders.ts`** — provider adapters, free-model rules, ranking, HTTP failure
  mapping, redaction and bounded failover.
- **`electron/wheatAiProviderService.ts`** — preferences file, discovery cache, connection test,
  status assembly and the IPC surface.

### Free-model selection

- **OpenRouter** — a model is eligible only when the official `/models` metadata reports a prompt
  price *and* a completion price that both parse to exactly zero. Missing, partial, non-numeric or
  non-zero pricing is rejected with a stated reason, never assumed free; a non-zero `request`,
  `image`, `web_search` or `internal_reasoning` fee also disqualifies it. Unknown context length is
  rejected.
- **Groq** — the account's own `/models` listing defines what the key can reach, so Wheat uses only
  what it returns, minus non-conversational models (whisper/tts/guard/embed/rerank/vision) and
  models the provider marks inactive. **No model identifier is ever invented or hard-coded.**

### Ranking (`Automatic — free models`, the default)

Weighted by Wheat AI compatibility (tool calling, +500 — a model that cannot call a typed capability
can answer but cannot prepare an action), context capacity (up to +300), instruction-tuned and
proven-family bonuses, minus penalties for preview/experimental tags and a large penalty for
specialised non-conversational models. Each model carries a human-readable `rankingReason` that the
Settings card shows.

### Failover

Bounded at **4 attempts**, never revisiting a model, de-duplicated on provider+id.

- **Retryable** (move to the next eligible free model): `RATE_LIMITED` (429), `QUOTA_EXHAUSTED`
  (402), `MODEL_UNAVAILABLE` (404), `TIMEOUT`, `PROVIDER_ERROR` (5xx), `EMPTY_RESPONSE`.
- **Not retryable** (stop immediately, so a configuration problem surfaces): `INVALID_KEY` (401),
  `UNAUTHORIZED` (403), `BAD_REQUEST` (400/422), `SAFETY_REFUSAL` (`finish_reason:
  content_filter`), `CANCELLED`.

Cross-provider fallback happens only when both keys are configured; with a single key the candidate
list stays inside that provider. There is no path to a paid model: the candidate list is built only
from verified-free discoveries.

### Integration

`electron/wheatAi.ts` exposes the free remote models alongside local ones (ids prefixed
`remote:<provider>:<model>`, plus `remote:auto` for automatic mode) and routes the chat to
`runRemoteChat` when a remote model is selected. Wheat AI's existing accounting knowledge, bounded
dossier context, typed capability registry, permission modes, confirmation flow and audit events
are unchanged — the remote runner produces the same result shape as the Ollama and llama.cpp
runners. With no key configured, behaviour is exactly as before: local models only.

---

## 6. API-key security

| Requirement | How it is met |
|---|---|
| Never hard-coded | A test walks `src/` and `electron/` and fails on any key-shaped literal. |
| Never committed | Keys live only in the OS-encrypted vault inside the user profile directory. |
| Never logged | No `console` call in the provider modules receives a key; `redactSecrets()` scrubs `sk-or-…`, `gsk_…` and `Bearer …` from any provider text before it can reach an error, a log or IPC. |
| Never in plaintext | `setKey` refuses outright when `safeStorage.isEncryptionAvailable()` is false and writes nothing — there is no plaintext fallback. |
| Never in `localStorage` | The renderer holds the typed key only in component state until submission, then clears the draft; nothing is persisted client-side. |
| Not exposed to the renderer | IPC returns only `{ configured, maskedKey, keyUpdatedAt, lastTest* }`. The masked form is `sk-or••••••••4f2a`, computed in the main process. A test asserts the serialized status contains neither the key nor the ciphertext. |
| Never in error messages | The `set-key` handler redacts before rethrowing, so a mistyped key cannot echo back. |
| Displayed masked | The Settings card shows `••••••••••••••••` and reveals only the masked fingerprint. |
| Requests stay in the main process | All provider HTTP happens in `electron/wheatAiProviders.ts`. The renderer CSP still forbids external `connect-src`. |
| Minimal, validated IPC | Six channels; every payload is validated (`asProviderId` rejects anything but `openrouter`/`groq`), and all of them pass through the existing `assertTrustedIpcSender` guard. |

Key shape is validated before a key is stored, so a key pasted from the wrong service is caught
without a network call. "Test the connection" **lists models rather than sending a prompt**, so a
test can never consume the user's free quota.

One real defect was found and fixed by these tests: `WheatAiSecretStore` used a shared `EMPTY_FILE`
constant with a shallow copy, so every store instance mutated the same `secrets` object — a deleted
key could reappear, and one vault's metadata could leak into another. It now returns a fresh object.

---

## 7. Rebranding

Renamed: `package.json` name/description/`productName`, `app.setName("Wheat")`, the app version
constant (`WHEAT_APP_VERSION`, `WHEAT_RELEASE_LABEL`), every navigation label and page title, all
user-facing copy, the AI system prompt ("Tu es Wheat AI…"), the product-knowledge module and its
version (`WHEAT-PRODUCT-KNOWLEDGE-4`), the OCR engine name (`Wheat Vision OCR`), 4 electron modules,
4 renderer modules/stylesheets, ~40 exported identifiers, 13 preload bridge methods, the
`atlas:` → `wheat:` IPC channel prefix (~350 strings across 18 files), 29 test files, and the README.

The renderer bridge is now `window.wheat`; `window.wheat` remains as a hidden alias published by
`electron/preload.ts` so packaged renderer bundles and existing automated tests keep working. It is
never referenced in the interface.

The French copy was reviewed end-to-end and accents restored (`Réglages`, `Écritures`, `société`,
`période`, `contrôle`, `déjà`, `à jour`, …) after an automated pass introduced unaccented forms.

### Remaining `Atlas` occurrences (case-insensitive repository search)

Grouped and justified. Every one is either persisted data, an OS/installer identity, or a
historical record — **none appears in the interface.**

| Kind | Examples | Why it stays |
|---|---|---|
| Profile directory | `app.setPath("userData", …"Wheat")` | Renaming moves every existing installation's database, documents, backups and updater state. Pinned deliberately with a comment; the app name shown to the OS is "Wheat". |
| Installer identity | `appId: ma.atlasledger.desktop`, `setAppUserModelId` | Changing them makes 2.0 a *separate* install rather than an upgrade, and breaks the existing update path. |
| Database file | `wheat.sqlite`, `atlas-ledger-startup.log` | Existing user data. Renaming requires a migration this release does not perform. |
| Prisma models | `atlasAiSettings`, `atlasAiAuditEvent`, `AtlasKnowledgePattern` | Database table/column identifiers. Changing them is a schema migration, which is out of scope for an interface release. |
| Persisted enum values | `"ATLAS_AI"` (entry source, audit origin), `ATLAS_AI_*` audit actions | Written into historical rows. Rewriting them would rewrite user data. |
| Persisted contract versions | `ATLAS_INVOICE_1`, `ATLAS_BANK_1`, `ATLAS_LOCAL_MODELS_1`, `ATLAS_CAPABILITIES_2_1_1`, `ATLAS_FISCAL_*` | Stamped into stored OCR/reconciliation/fiscal records; used to interpret existing data. |
| Backup format | `WHEAT_BACKUP_FORMAT = "atlas-ledger-backup"`, `database/wheat.sqlite`, `.atlasbackup` | Archive-format identifiers. The constants were renamed; the literals are frozen so older backups still restore. Wheat 2.0 **writes** `.wheatbackup` and reads both. |
| Artifact schemas | `ma.atlasledger.credit-note-artifact.v1`, `…invoice-artifact.v1` | Embedded in hashed, immutable PDF artifacts; changing them breaks verification of existing ones. |
| Migration directories | `prisma/migrations/2026…_atlas_1_1_data_safety/…` | Applied migration names recorded in `_prisma_migrations`. Renaming would corrupt migration history. |
| Legacy storage keys | `atlas-ledger-language`, `atlas-ledger-sage-profile-*`, `atlas:fiscal:view:*` | Read once as a fallback so an existing install keeps its language, Sage profile and workpaper view. Wheat writes the new `wheat.*` keys. |
| Env vars | `WHEAT_CWD`, `WHEAT_USER_DATA_DIR`, `WHEAT_UPDATES_DIR`, `WHEAT_PADDLEOCR_*` | Developer/test contract read by the runtime and by 30 spec files; not user-facing. |
| Hidden bridge alias | `window.wheat` in `preload.ts` and specs | Documented compatibility alias for the same object as `window.wheat`. |
| Historical documents | `docs/wheat-1.x-release-notes.md`, `ATLAS_LEDGER_*.md` | Records of past releases. Renaming them would misstate history; the README links them by their real names. |
| Test fixtures | `atlas-bank.csv`, `ATLAS-TEST` in MT940 fixtures, temp-dir prefixes | Fixture content and scratch paths; no product surface. |

---

## 8. Tests

### Added

- **`tests/wheat-ai-providers-unit.spec.cjs`** — 27 tests, fully mocked (`fetchImpl` injected,
  `safeStorage` doubled). No real key, no network. Covers: OpenRouter zero-price eligibility and
  every rejection reason; `isZeroPrice`; Groq listing filtering; ranking order; retryable vs
  non-retryable failover; bounded, non-repeating, non-looping failover; cross-provider fallback only
  with two keys; candidate de-duplication and pinning; HTTP→failure-kind mapping; safety refusal;
  tool-call parsing with malformed arguments dropped; ciphertext-only storage and masked metadata;
  refusal when the vault is unavailable; key-shape validation; redaction; the connection test not
  issuing a chat; automatic mode as default; pin/automatic mutual exclusion; pinned-model cleanup on
  key deletion; the IPC surface registered once per channel; no key in a rejection message; and no
  hard-coded key anywhere in `src/` or `electron/`.
- **`tests/wheat-design-system-unit.spec.cjs`** — 11 tests: layer order, both themes defined, no
  literal colour outside `tokens.css`, every nav entry grouped/described/rendered, no destination
  dropped, dropdown contract (search threshold, ARIA, keyboard, all states, cap, unchanged value),
  searchable pickers present per workspace, no data-driven native `<select>` left, every
  `PageHeader` sets a purpose, confirm/error components state question–consequence–reversibility,
  dialog focus trap and restore, brand assets used unmodified, and no Atlas branding in the UI.
- **`tests/wheat-dialog-dropdown.spec.cjs`** — regression cover for the focus-containment defect
  below: a combobox opened inside a modal must accept typing in its search bar, filter, select by
  keyboard, keep its keystrokes out of the dialog's autofocused field, and close on Escape without
  closing the dialog.
- **`tests/wheat-ui-helpers.cjs`** — shared `chooseOption` / `optionValues` / `switchCompany`
  helpers so specs can drive either a Wheat combobox or a native `<select>`.

### Updated

29 spec files renamed from `atlas-*` to `wheat-*`; identifiers, IPC channels, navigation labels,
page copy, dialog names, placeholders and combobox interactions updated throughout.

### Run

```
npx tsc -b                     # clean
npx eslint . --max-warnings=0  # clean
npm run build                  # clean (prisma generate + tsc -b + vite build)
npx playwright test            # 53 spec files
```

**Final full-suite result: 217 passed, 14 skipped, 2 failed** (both failures are environmental and
explained below; a third, `ocr-meaningful`, failed once under parallel load and passes on its own).

Suites confirmed green include every unit and integration spec (`wheat-archive-unit`,
`wheat-audit-unit`, `wheat-reporting-unit`, `wheat-subledger-unit`, `wheat-operations-unit`,
`wheat-compliance-unit`, `wheat-foundations`, `wheat-ai-agent`, `dashboard-unit`, `sage-txt-unit`,
`wheat-credit-artifacts-unit`, `wheat-reconciliation-unit`, `wheat-security-boundary-unit`,
`wheat-bounded-reads`, `wheat-managed-file-provenance`, `wheat-database-restore-unit`,
`wheat-local-security-unit`, `bank-statement-importer-2.0`, `updater`, `wheat-ai-providers-unit`,
`wheat-design-system-unit`, `wheat-fiscal-workpapers`, the four `wheat-migration-*` suites) and
every end-to-end UI suite: `accountant-runtime-2.0`, `bank-import-electron-2.0`,
`ui-reliability-followup`, `wheat-ai-fiscal-inputs`, `wheat-dialog-dropdown`,
`viewport-layout-regression`, `whole-app-regression`, `wheat-integrity`, `wheat-electron-security`,
`app-context-menu`, `electron-smoke`, `ocr-scan-preview`, `ocr-meaningful`,
`reset-input-reliability`, `wheat-runtime-restart`, `wheat-fiscal-workpapers-ui`.

The two standing failures:

- **`wheat-electron-integration`** asserts `ollamaModelCount > 0`. It needs a local Ollama server,
  which this machine does not have. Pre-existing environment dependency, not a regression.
- **`wheat-migration-compliance:185`** shells out to `prisma migrate reset --force --skip-seed`.
  Prisma refuses that command when it detects an AI agent, so it cannot be run from this session;
  it needs to be run by a person. The other three migration suites pass.

Accessible-interaction coverage: `wheat-dialog-dropdown` (new — combobox search, keyboard selection
and Escape scoping inside a modal), `reset-input-reliability` (focus, dropdowns and text fields
after a workspace reset), `whole-app-regression` (modal focus, `body.overflow`, keyboard entry),
`wheat-runtime-restart` (stale modal focus cleared across a real relaunch), and the dialog
focus-trap assertions in `wheat-design-system-unit`.

---

## 9. Defects found and fixed during the rebuild

1. **Shared secret vault** — `EMPTY_FILE` was a module constant copied shallowly, so every
   `WheatAiSecretStore` mutated the same `secrets` object.
2. **Dialog ignored `data-autofocus`** — the new `Dialog` focused the first interactive element
   (the close button) instead of the field a screen nominates.
3. **Collapsed rail lost accessible names** — hiding the label span made the computed name fall
   back to the long tooltip; each entry now sets `aria-label` explicitly.
4. **Topbar could not shrink** — `flex: none` on the actions pushed content outside the viewport at
   small windows or high zoom; the header now wraps and its regions shrink.
5. **Charts overflowed their card** — Recharts' `ResponsiveContainer` rounded past its parent at
   fractional zoom. The metric sparkline is now a CSS-sized inline SVG, and the VAT donut sits in a
   bounded grid column.
6. **Combobox note widened its trigger** — the secondary note now truncates and drops out below
   1100 px.
7. **Evidence pickers lost their filter** — the converted workpaper/adjustment pickers briefly
   offered all documents instead of only content-hashed ones; restored.
8. **Accounting-correctness fix** — the PCGE class notes added to the class picker were initially
   off by one (class 0 is *Comptes spéciaux*, class 1 is *Comptes de financement permanent*).
9. **Searchable dropdowns were unusable inside every dialog.** `useAccessibleDialog` pulled focus
   back whenever it left the dialog element, and a Wheat combobox renders its panel through a
   portal on `<body>`. The search bar therefore lost focus on its first keystroke and the typed
   characters landed in the dialog's autofocused field instead. The panel is now marked
   `data-wheat-portal`, and both the hook and the `Dialog` primitive treat it as part of the
   dialog's own surface — including for Tab and for Escape, which now closes the panel alone.
   Covered by `tests/wheat-dialog-dropdown.spec.cjs`.
10. **Dangling `aria-controls` on an empty dropdown.** The trigger and the search bar both point at
    the option list, but the list was replaced (not merely emptied) by the loading, error, no-option
    and no-result states, leaving the reference pointing at nothing. The listbox is now always
    rendered beside the status block.
11. **A corrupted `id`.** The accent pass had rewritten `id="entry-piece"` to `id="entry-pièce"`,
    breaking every selector that targeted it. All `id`, `htmlFor`, `className`, `name`, `form` and
    `aria-*` attribute values were re-scanned for non-ASCII characters; this was the only one.
12. **A renamed SQL table in a test.** The rebranding sweep had rewritten the literal
    `"AtlasAiSettings"` to `"WheatAiSettings"` inside `wheat-migration-fiscal`'s table list. The
    table itself was never renamed; the test string was reverted, and every quoted `Wheat*`
    identifier in `tests/` was cross-checked against `prisma/schema.prisma`.
13. **Mis-accented and unaccented French copy.** The earlier accent sweep left a set of words wrong
    (`Filtrès`, `Détecté les desequilibres`) or untouched (`Import termine`, `montant signe`,
    `Prets à importer`, `Les 20 premieres lignes`, `Votre question a Wheat AI`, `Debit`/`Credit`
    field labels). Repaired across the entry dialog, the bank-statement import dialog, the reports
    guide and the Wheat AI panel.

---

## 10. Confirmations

- **No feature was removed, disabled or hidden.** All 18 destinations remain, each with its own
  labelled navigation entry and description. Actions previously reachable only by right-click are
  now also visible buttons. The only deletion was `DocumentsPageLegacy`, unreachable dead code
  superseded by the rebuilt Documents screen.
- **The auto-update system is preserved exactly.** `electron/updater/**` is unchanged. The update
  service registration, local provider, state directory, staging, Windows helper, rollback and
  status events all behave as before; only the IPC channel prefix was renamed on both sides and the
  Settings card was restyled. `updates/latest.json` was **not** regenerated, and the
  `updates/` directory still contains only its `README.md`. `tests/updater.spec.cjs` (18 tests) and
  `tests/updater-electron.spec.cjs` pass; the packaging test writes only to a temp directory.
- **The release build was produced only after an explicit later instruction.** Throughout the
  implementation work no installer, portable build, packaged distributable or published update was
  created. The user then asked for the installer directly, and a single Windows NSIS build was
  produced: `release/2.0.0/WheatSetup-2.0.0.exe` (plus its blockmap and `builder-debug.yml`), via
  `npm run icon:ico`, `npm run build` and `electron-builder --win nsis --x64`.
  `npm run update:package` was **not** run, `updates/latest.json` was **not** regenerated, the
  `updates/` directory still contains only its `README.md`, the auto-update feed was not changed,
  and nothing was uploaded or published. `npm run portable` and `npm run pack` were never run.
- **The bundled demo database was reseeded, not reset.** `prisma/dev.db` still held pre-rebrand
  demo company names (`ATLAS TRADING`, `SOCIÉTÉ ATLAS SARL`) that would have shipped inside the
  installer and appeared to anyone using the demo-reset action. It was backed up and regenerated
  with `npm run db:seed` from the already-rebranded `prisma/seed.ts`; the record counts are
  identical (2 companies, 2308 accounts, 10 entries, 28 lines, 8 invoices, 4 payments, 4 documents,
  12 journals, 4 fiscal years) and the names are now `SOCIÉTÉ ARGANE SARL` and `MAGHREB TRADING`.
  `npm run db:reset` — which `npm run installer` normally runs first — was **not** used: it invokes
  `prisma migrate reset --force`, which Prisma refuses to run for an AI agent.
- **No accounting behaviour changed.** No edits to accounting calculations, TVA rules, fiscal logic,
  reconciliation, imports/exports, OCR behaviour, database schema or meaning, validation, or
  permissions. The Prisma schema is untouched; Wheat AI provider settings are stored in the profile
  directory, not the database.

---

## 11. Known limitations

1. **Partial translation.** As before Wheat 2.0, only navigation labels and a subset of shell copy
   are translated to English and Arabic; the new explanatory copy, page purposes and help text are
   French only. This matches the pre-existing behaviour and was not expanded.
2. **RTL is direction-only.** `dir="rtl"` is set for Arabic, but the new layouts were not audited
   for mirrored spacing.
3. **`wheat-electron-integration` requires a local Ollama server.** Its
   `ollamaModelCount > 0` assertion cannot pass on a machine without Ollama installed; this is a
   pre-existing environment dependency, not a regression. The same dependency makes the Wheat AI
   model picker legitimately empty here, so `wheat-ai-fiscal-inputs` now asserts the documented
   "Aucun modèle disponible sur ce poste" state when nothing is installed and drives a real model
   when one is.
4. **`wheat-migration-compliance:185` cannot be run from an agent session.** It shells out to
   `prisma migrate reset --force --skip-seed`, and Prisma blocks that command when it detects an AI
   agent. Running it destroys and recreates the local development database, so it needs to be run
   deliberately by a person: `npx playwright test tests/wheat-migration-compliance.spec.cjs`.
5. **The demo seed database is regenerated, not migration-reset.** `npm run db:seed` rewrites
   `prisma/dev.db` in place from `prisma/seed.ts`. It does not re-apply the migration history the
   way `npm run db:reset` would; the schema in that file is whatever the last real migration run
   produced. Before cutting a further release it is worth running `npm run db:reset` once by hand.
6. **Live provider calls are untested by design.** OpenRouter and Groq are covered only by mocked
   tests. A real key would be needed to verify against the live APIs, which the brief excludes.
7. **Groq free-tier detection is listing-based.** Groq does not publish per-model pricing in its
   `/models` response, so eligibility relies on the account's own listing (which reflects the key's
   access) plus a conversational-model filter. OpenRouter's stricter zero-price proof is not
   available there.
8. **The legacy `.atlasbackup` extension is still accepted.** New backups are written as
   `.wheatbackup`; both are readable so older archives keep working.
8. **`src/App.css` still holds screen-level rules.** They resolve entirely through tokens and carry
   no literal colours, but they have not all been folded into the component layer.
9. **A second copy of the project appeared at `<repo>/Wheat 2/` during this session** (with its own
   `.git`). It was not created by this work and was left untouched. It does confuse Playwright's
   default test discovery — runs need an explicit `testDir`, or that directory should be moved
   outside the repository.
