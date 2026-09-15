# Wheat editions — Standard and Lightweight

Wheat ships as **one product in two editions**, built from one source tree:

| | Wheat Standard | Wheat Lightweight |
|---|---|---|
| Accounting features | all of them | **all of them** |
| Database and dossier format | identical | identical |
| Version number | shared | shared |
| Reads a scanned page | locally (PaddleOCR) | in the cloud, with the user's own provider |
| Local recognition runtime packaged | yes (~2075 MB installed) | no |
| Installer | 1 399 314 783 B (~1334 MB) | 307 208 736 B (~293 MB), **−78 %** |
| Installed footprint | ~3149 MB, 27 457 files | ~1074 MB, 402 files |
| Interface | full motion, blur, depth | economical: less motion, no backdrop blur, shallower depth |
| Documents recognised at once | up to 4 | 1 |
| Local recognition warmed at startup | yes | n/a |

> **Same Wheat. Same accounting. Same data. Same features. Different execution
> strategy.**

The edition decides *how expensive work is executed and what is packaged*. It
never decides what a number is. There is no version of this repository in which
an edition changes posting, balances, VAT, journals, reports, period locks or
the schema — and two test suites exist specifically to keep it that way
(`tests/wheat-edition-unit.spec.cjs`, `tests/wheat-edition-accounting-parity.spec.cjs`).

---

## Where the edition comes from

One module, shared by the main process and the renderer, exactly like
`src/appVersion.ts`:

**`src/wheatEdition.ts`** — `WHEAT_EDITION`, `WHEAT_EDITION_PROFILE`,
`wheatInstallerFileName()`.

The value is **compiled into the build**. `npm run build:<edition>` sets
`WHEAT_EDITION`, `vite.config.ts` turns it into the `__WHEAT_EDITION__` define
for the main process, the preload and the renderer, and the build writes
`dist-electron/wheat-edition.json` beside the bundle so the packaging step and
the tests can read it without parsing a bundle.

A packaged Wheat therefore states its own edition from its own bytes. No
variable in a user's shell can change what an installed build believes it is —
the same rule `electron/securityBoundary.ts` applies to the renderer location
and `electron/updater/channel.ts` applies to the update source.

`WHEAT_EDITION` in the environment is honoured **only** where nothing is
compiled in: an unbundled `tsx` run (the unit tests) and `npm run dev`.

An edition the module does not recognise **throws**. A build that silently ran
as Standard while its installer, its updater asset and the website's download
button all said Lightweight would be worse than a stop.

### Asking the profile, not the edition

Code asks the profile a capability question rather than comparing strings:

```ts
if (WHEAT_EDITION_PROFILE.hasBundledLocalOcr) …       // good
if (WHEAT_EDITION === "standard") …                   // avoid
```

Adding a third edition later should be a new row in `PROFILES`, not a search
through the source.

The renderer never reads the edition from an environment value. It crosses the
boundary through one channel, `wheat:app:edition`.

---

## Building and packaging

```powershell
npm run build:standard        # renderer + main, compiled as Standard
npm run build:lightweight     # renderer + main, compiled as Lightweight

npm run dist:standard         # db:reset, icon, build, package
npm run dist:lightweight
```

`npm run build` with no edition produces Standard, which is what Wheat has
always been. `npm run installer` is unchanged and also produces Standard.

`scripts/package-edition.mjs` composes the electron-builder configuration from
**package.json's `build` block** plus the edition's small declarative
difference (`scripts/lib/wheatEditions.mjs`). package.json stays the single
base, so a future change to signing, NSIS behaviour, the packaged file list or
`asarUnpack` is inherited by both editions without being written twice.

It refuses to package a build whose compiled edition does not match, because a
Lightweight installer wrapped around a Standard main process would look for a
recognition runtime its own installer left out.

### What differs in the package

Exactly one `extraResources` entry: `resources/paddleocr`, which is ~2 GB of
Python, wheels and recognition models. Everything else — the seed database, the
Tesseract data both editions use as their offline fallback, the model manifest,
the updater helper — is packaged in both. `tests/wheat-edition-unit.spec.cjs`
asserts the difference is exactly that one entry.

**PaddleOCR is excluded from the package, never deleted from the repository and
never installed-then-removed at runtime.** Standard builds the same commit and
packages it exactly as before.

### One Windows identity

Both editions keep `appId: ma.atlasledger.desktop`, `productName: Wheat`, the
same install directory, the same uninstall entry and the same
`%APPDATA%\Wheat\`. That is what makes switching edition an ordinary in-place
install: the dossier, the documents, the backups and the settings stay where
they are, and nothing is re-entered.

Only the artifact name differs:

```
Wheat-Standard-<version>-Setup.exe
Wheat-Lightweight-<version>-Setup.exe
```

The edition is a separate word in the name, **never a separate version number**.
`Wheat 2.7.0` and `Wheat Lite 1.4.2` would be two products; they are not.

---

## Reading a scanned page

`electron/cloudOcr.ts` owns the decision, in one function:

| build and settings | engines tried, in order |
|---|---|
| Standard, cloud reading off (default) | `paddle` → `tesseract` |
| Standard, cloud reading on | `paddle` → `cloud` → `tesseract` |
| Lightweight, cloud reading on (default) | `cloud` → `tesseract` |
| Lightweight, cloud reading off | `tesseract` |

Every plan ends at the local Tesseract fallback, so a machine with no
connection still reads what it can instead of refusing the document.

**The engines differ in where the work happens and in nothing else.** Each is
asked for the text of the same normalised image; whichever answers first with a
usable reading produces the page. Everything downstream — the field readers, the
totals arithmetic, the document understanding, the review screen, the accounting
validation — is identical whatever answered. That is what lets the two editions
share one document workflow rather than two.

### Cloud output is untrusted input

A provider produces **recognised text**, which is the *input* to Wheat's own
deterministic readers, never a substitute for them. On top of that the reply is
parsed defensively: JSON extracted from possible prose, `text` type-checked and
capped at 200 000 characters, `confidence` clamped (an absent one becomes a
deliberately middling 70 so the reading lands in review rather than sailing
past), tables normalised to strings and bounded in every dimension. A reply with
no usable transcription is a recognition **failure**, not an empty page — filing
a document as "read, and blank" is the one outcome nobody reviews.

`tests/wheat-cloud-ocr-unit.spec.cjs` covers each of those branches.

---

## Wheat Cloud AI

### No shipped credential, ever

Wheat ships **no** provider key: not in source, not in the installer, not in a
resource, not in CI, not in an env file. Cloud usage is the user's own account
or it does not happen. `tests/wheat-cloud-authorization-unit.spec.cjs` greps the
shipped source for anything key-shaped and fails if it finds one.

### No manual API keys either

The target user is an accountant, not a developer.
`electron/cloudAuthorization.ts` implements OpenRouter's own OAuth **PKCE** flow,
which is its documented mechanism for desktop and CLI applications: no client
secret, no registered application, a loopback callback on any port, and a key
that belongs to the user's account and is revocable from it.

```
Wheat                          system browser                  OpenRouter
  |  verifier + S256 challenge
  |  loopback server on 127.0.0.1:<free port>/<nonce>
  |-------- openExternal(/auth?callback_url&code_challenge) ------->|
  |                                   user authorises              |
  |<---------------- GET /<nonce>?code=... -------------------------|
  |-- POST /api/v1/auth/keys { code, code_verifier } ------------->|
  |<------------------------ { key } ------------------------------|
  |  stored through Electron safeStorage, never returned to the renderer
```

Security properties, each with a test:

- **PKCE S256.** An intercepted code is useless without the verifier.
- **Loopback only.** `127.0.0.1`, never a routable interface, and only for the
  duration of one authorisation.
- **A nonce in the callback path.** Anything on another path is answered 404, so
  a stray request from another page in the same browser cannot complete
  somebody else's flow.
- **Nothing logged.** The code and the key never reach a log line, an error
  message, a diagnostic file or an IPC payload.
- **No renderer-supplied URL.** `wheat:cloud:authorize` takes no payload; the
  URL is built inside the flow.
- **No vault, no write.** Without `safeStorage` the key is refused rather than
  downgraded to plaintext — and the browser never even opens.

### Reaching the provider at all

Every outbound call this feature makes — discovering the free models, the
authorisation exchange, the vision request — goes through **Electron's
`net.fetch`**, the same Chromium stack the application's own windows use, and
the updater does the same.

Node's `fetch` carries a compiled-in list of certificate authorities and knows
nothing about the machine's proxy. An office whose antivirus or gateway inspects
TLS — ordinary in the offices Wheat is for — presents a certificate signed by an
authority only *Windows* trusts, and Node refuses the connection outright
(`SELF_SIGNED_CERT_IN_CHAIN`). It surfaced here as an authorisation that failed
*after* the person had already authorised in their browser, and as an update
channel that could never reach its feed.

This trusts nothing the computer does not already trust: it verifies against the
Windows certificate store instead of a list compiled into Node, and the release
signature and SHA-256 checks on anything downloaded are untouched.

### Two surfaces, two audiences

`Réglages → Wheat Cloud AI` (`src/components/WheatCloudAccess.tsx`) is the
accountant's: connected or not, one switch, one button. No key, no model
identifier, no endpoint.

`Réglages → Wheat AI` (`src/components/WheatAiProviderSettings.tsx`) keeps every
advanced capability it had: pasting a key, pinning a model, free-tier
attestation, failover. Nothing was removed.

### The first cloud OCR, from the accountant's side

1. They import documents, exactly as always.
2. Wheat notices this build needs the cloud to read a scan and is not yet
   authorised. **Nothing is read and nothing is written.**
3. The selected file paths come back to the renderer as
   `cloudAuthorization: { required: true, reason, filePaths }`.
4. A Wheat-native dialog explains, in plain French, what is sent and what is
   not, and offers **Activer Wheat Cloud AI**.
5. Consent is recorded first — agreeing to send documents and connecting an
   account are two separate decisions — then the provider's page opens in the
   **system** browser.
6. They authorise and return. The dialog calls `processFiles` again **with the
   same paths**.

They never reselect the documents, never press Import again, never choose a
model and never paste a key. The authorisation is an interruption in their task,
not a replacement for it.

---

## The updater

An installed Wheat updates to **its own edition**, always, and never by reading a
file name.

The release manifest keeps its existing top-level `artifact`/`sha256` as the
**Standard** installer — that is what every Wheat released before editions
existed reads, and those installs must keep updating — and adds:

```json
"editions": {
  "standard":    { "artifact": "Wheat-Standard-2.7.0-Setup.exe",    "sha256": "…", "artifactSize": 0 },
  "lightweight": { "artifact": "Wheat-Lightweight-2.7.0-Setup.exe", "sha256": "…", "artifactSize": 0 }
},
"editionsSignature": { "algorithm": "ed25519", "value": "…" }
```

Two signatures rather than one enlarged payload: the bytes the existing
`signature` covers are already deployed, and changing them would make every
installed Wheat reject every future release. The editions map therefore carries
its own signature, bound to the release version so it cannot be lifted onto
another release.

`electron/updater/edition.ts` projects the release onto this edition after
verifying that signature; the download, the SHA-256 check and the installer
hand-off are unchanged and simply operate on the right file. A build that cannot
name its own artifact **refuses** — a Lightweight machine is never handed the
Standard installer.

`schemaVersion` stays `1`, and a manifest with no `editions` map is still
accepted, so old releases keep working.

---

## Releasing both editions

```powershell
npm run release:prepare -- --notes docs/wheat-<version>-release-notes.md --sign ..\wheat-release-key.pem
npm run release:publish
```

`release:prepare` now builds **both** editions in sequence from the same working
tree, so a release can never contain a Standard installer from one commit and a
Lightweight installer from another. It signs the manifest and the editions map,
verifies both against the public key compiled into this build, and writes:

| file | purpose |
|---|---|
| `Wheat-Standard-<version>-Setup.exe` | the Standard installer |
| `Wheat-Lightweight-<version>-Setup.exe` | the Lightweight installer |
| `latest.json` | the signed manifest an installed Wheat reads first |
| `publish-plan.json` | what `release:publish` may upload |
| `wheat-website-release.json` | what the website needs to offer this release |

`release:publish` re-checks every gate against the bytes on disk, and refuses a
release that names an edition it did not publish or whose editions map is
unsigned.

### The website

The Wheat website (`wheat-website/`) reads one generated file:

```powershell
node sync-release.mjs "..\atlas-ledger\release\<version>\wheat-website-release.json"
node prerender.mjs
node check.mjs
npx netlify-cli deploy --prod --dir=dist
```

`/download/` is the edition chooser: two cards, the parity statement above them,
and each card linking to **its own** installer with **its own** checksum. An
edition with no published installer shows as unavailable and links to the
releases page — it never falls back to the other edition's file.

The recommendation badge (`navigator.deviceMemory` / `hardwareConcurrency`) is a
hint and nothing else. Both downloads stay enabled whatever it concludes, and a
browser exposing neither figure simply gets no badge.

---

## Switching edition

Install the other edition over the current one. Same appId, same install
directory, same `%APPDATA%\Wheat\`:

- the dossier, the accounting entries and the documents stay where they are;
- backups, settings and the Wheat AI credential stay;
- nothing is converted, re-entered or rebuilt.

Going Standard → Lightweight removes the local recognition runtime, so scanned
pages are read in the cloud (or by the local Tesseract fallback when cloud
reading is off). Going Lightweight → Standard restores local reading.

**There is deliberately no in-app "switch edition" toggle.** The packaged
resources differ, so a toggle would be a button that claims to do something it
cannot. About states the edition; the website is where the other one is
obtained.

---

## Testing both editions

```powershell
npx playwright test tests/wheat-edition-unit.spec.cjs
npx playwright test tests/wheat-edition-visual.spec.cjs
npx playwright test tests/wheat-edition-database.spec.cjs
npx playwright test tests/wheat-edition-accounting-parity.spec.cjs   # runs the accounting suites under both editions
npx playwright test tests/wheat-cloud-ocr-unit.spec.cjs
npx playwright test tests/wheat-cloud-authorization-unit.spec.cjs
npx playwright test tests/wheat-cloud-security.spec.cjs
npx playwright test tests/updater-edition.spec.cjs
```

Any suite can be run under a chosen edition:

```powershell
cross-env WHEAT_EDITION=lightweight npx playwright test tests/wheat-reporting-unit.spec.cjs
```

---

## Real-machine testing still required

None of the following can be established from this repository. They are the
list to work through on hardware before calling a two-edition release done.

**Lightweight, on the machines it exists for**

- Windows 10, old Intel integrated graphics (HD 4000-era): startup, window
  resize, dialogs, the documents screen, a 30-document import.
- Windows 11, 4 GB RAM as a stress target: peak renderer and main-process
  memory during a batch import; whether the machine pages.
- 8 GB RAM, 2–4 logical cores as the realistic low-end target.
- HDD and slow SATA SSD: cold start, first paint, opening a heavy workspace
  (the lazy chunks now come off disk on first visit).
- 1366×768 and 1280×720 displays.

**Cloud reading**

- A packaged build completing the OpenRouter PKCE callback — the loopback
  server and `shell.openExternal` under NSIS install conditions, and with
  Windows Firewall prompting on first listen.
- A poor connection: slow upload of a page image, and a timeout mid-import.
- Disconnecting the network **during** an import, and confirming the Tesseract
  fallback takes over rather than the import failing.
- A real quota exhaustion and a real rate limit, and what the accountant is
  shown.
- Revoking the key at the provider and confirming Wheat reports it usefully.

**Both editions**

- Windows Defender and SmartScreen on both installers (neither is
  code-signed; the Lightweight one is new and has no reputation at all).
- Update Standard → Standard and Lightweight → Lightweight against a real
  published release.
- Manual switch Standard → Lightweight and back, confirming the dossier,
  documents, backups and settings survive both directions.
- An existing 2.1.x installation updated to the first two-edition release,
  confirming it lands on Standard.
