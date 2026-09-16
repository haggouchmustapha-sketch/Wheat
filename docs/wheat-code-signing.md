# Signing Wheat for Windows

Wheat is an accounting application. An accountant downloads it, Windows says

> **Windows protected your PC**
> Publisher: **Unknown publisher**

and they are being asked to decide whether the program that will hold their
books is malware. That is not a decision Wheat may leave to them.

This document is how Wheat answers it.

---

## Two signatures, two different questions

Wheat carries two cryptographic signature systems. They are not alternatives and
neither may be dropped in favour of the other.

| | **Windows Authenticode** | **Wheat update signature** |
|---|---|---|
| Question | Who published this executable, and is it intact? | Did this release come from Wheat? |
| Asked by | Windows: SmartScreen, UAC, Smart App Control, Explorer's Digital Signatures tab | Wheat's own updater, before it installs anything |
| Algorithm | RSA/ECDSA over a certificate chain to a CA in the Microsoft Trusted Root Program | Ed25519 over a canonical payload |
| Key | A code signing certificate, held on hardware or by a signing service | `WHEAT_UPDATE_PUBLIC_KEY` in `electron/updater/signature.ts` |
| Implemented in | `scripts/lib/wheatSigning.mjs` | `scripts/lib/releaseManifest.mjs`, `electron/updater/signature.ts` |
| Documented in | this file | `docs/wheat-release-process.md` |

Authenticode says nothing about whether a release is the one Wheat meant to
publish — a stolen certificate signs anything. The Ed25519 manifest signature
says nothing to Windows — it is a field in a JSON file Windows has never heard
of. **Both are required and `release:publish` checks both.**

---

## What is signed, and what is deliberately not

| Artifact | Signed | Why |
|---|---|---|
| `Wheat.exe` | yes | What the Start menu launches and what Windows names in a UAC prompt. |
| `Wheat-Standard-<version>-Setup.exe` | yes | What SmartScreen inspects when it is downloaded. |
| `Wheat-Lightweight-<version>-Setup.exe` | yes | Same, and it must carry the *same* publisher. |
| `Uninstall Wheat.exe` | yes | Run from "Installed apps", and run by an incoming installer during an edition switch. |
| `resources/elevate.exe` | yes | The helper that requests elevation. An unsigned one is the worst of the set. |
| `resources/paddleocr/**/*.exe` | **no** | A third-party CPython runtime Wheat packages but did not write. |

The last row is not an omission. `resources/paddleocr/runtime` contains 53
executables; `python.exe` among them carries a valid Authenticode signature from
the **Python Software Foundation**. electron-builder hands every packaged `.exe`
to the signer by default, so signing them would *replace* the PSF's signature
with Wheat's — a false claim of authorship, 53 wasted signing operations, and on
a metered signing service, 53 paid ones.

`vendorBinaryNames()` in `scripts/lib/wheatSigning.mjs` walks that tree and emits
electron-builder `signExts` exclusions from what is actually there, so a runtime
that gains an executable is covered without anybody remembering to update a list.
`tests/wheat-code-signing.spec.cjs` asserts the coverage.

Vendor **DLLs** are likewise left alone. Authenticode on `Wheat.exe` and the
installer is what Windows shows the user and what SmartScreen scores.

---

## One publisher, both editions

Standard and Lightweight are one product. `editionBuilderConfig()` merges one
signing configuration, composed once in `wheatSigning.mjs`, into both editions'
electron-builder configuration. Two publisher identities would:

- tell a user switching edition that they are installing software from somebody
  else, and
- split SmartScreen publisher reputation in half, so each edition would have to
  earn trust separately.

`tests/wheat-code-signing.spec.cjs` fails if the two configurations ever differ,
and `verify-signatures.mjs` fails a release whose artifacts carry more than one
certificate subject.

---

## Development builds are unsigned, on purpose

```
npm run build              → unsigned. Always.
npm run dist:standard      → signed only if WHEAT_SIGNING_MODE says so
npm run release:prepare    → verifies, and refuses a broken signature
npm run release:publish    → refuses an unsigned release unless told otherwise
```

A developer must not need the production key to rebuild Wheat. So the default
signing mode is `off`, and `off` is expressed as `win.signExecutable: false`
rather than merely as an absent certificate — otherwise a stray `CSC_LINK` in
somebody's environment could sign a development build with a certificate nobody
in this repository chose. (`signExecutable` skips signing while keeping
resedit's icon, version metadata and execution level, which
`signAndEditExecutable: false` would not.)

---

## Configuring real signing

Everything is environment variables. **Nothing is ever written to a file in this
repository**, and `.gitignore` already refuses `*.pfx`, `*.p12`, `*.pem` and
`*.key`.

### `WHEAT_SIGNING_MODE=signtool`

Authenticode through `signtool.exe`. Pick **exactly one** certificate source:

| Variable | Use |
|---|---|
| `WHEAT_SIGNING_CERTIFICATE_SUBJECT` | Subject name of a certificate in the Windows certificate store. **This is the normal case**: a hardware token or cloud HSM presents its certificate through the store and the private key never leaves the device. |
| `WHEAT_SIGNING_CERTIFICATE_SHA1` | SHA-1 thumbprint of that certificate, when the subject is ambiguous. |
| `WHEAT_SIGNING_CERTIFICATE_FILE` | Path to a PFX. Only usable for test certificates — a publicly trusted code signing key may not live in a file (see below). |

Optional:

| Variable | Default |
|---|---|
| `WHEAT_SIGNING_PUBLISHER` | the certificate's common name |
| `WHEAT_SIGNING_TIMESTAMP_URL` | `http://timestamp.digicert.com` |
| `WHEAT_SIGNING_CERTIFICATE_PASSWORD` | — (PFX only; passed to the packaging child process as `WIN_CSC_KEY_PASSWORD` and never written down) |

### `WHEAT_SIGNING_MODE=azure`

Azure Artifact Signing (formerly Trusted Signing). The private key never exists
locally at all; the build authenticates to Microsoft Entra ID and the service
signs.

| Variable |
|---|
| `WHEAT_SIGNING_AZURE_ENDPOINT` |
| `WHEAT_SIGNING_AZURE_ACCOUNT` |
| `WHEAT_SIGNING_AZURE_PROFILE` |
| `WHEAT_SIGNING_PUBLISHER` (required — there is no local certificate to read a name from) |

Plus the standard Azure credential variables (`AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, or a federated/OIDC credential in CI).

Prefer OIDC federation in CI: it issues a short-lived token per run instead of
storing a long-lived secret.

---

## Algorithms and timestamping

- **SHA-256 only.** electron-builder still defaults to `["sha1", "sha256"]` for
  Windows 7. Wheat requires Windows 10, SHA-1 Authenticode has not been trusted
  for years, and a dual signature doubles the signing operations.
- **Every signature is RFC 3161 timestamped.** Without a countersignature a
  signature stops verifying the day the certificate expires — and code signing
  certificates last a year or three, while an installed Wheat may sit untouched
  for longer. `verify-signatures.mjs` treats *signed but not timestamped* as a
  failure, not a warning.

---

## Verifying

```powershell
npm run sign:verify                      # report on the built release
npm run sign:verify -- --require         # exit non-zero unless everything verifies
npm run sign:verify -- --version 2.1.x
```

It does **not** ask a signing tool whether it succeeded. It asks Windows —
`Get-AuthenticodeSignature`, the same API behind Explorer's *Digital Signatures*
tab — and reports the chain status, the certificate subject, the expiry and
whether a trusted timestamp is present. A PASS here is what a user's machine will
conclude.

By hand, on any copy including an installed one:

```powershell
Get-AuthenticodeSignature "C:\Program Files\Wheat\Wheat.exe" | Format-List *
& "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe" verify /pa /v "Wheat-Standard-2.1.x-Setup.exe"
```

---

## Where signing sits in the release pipeline

**Order is load-bearing.** A signature is written *into* the executable, so it
changes the bytes. A SHA-256 taken before signing describes a file that no longer
exists.

```
  build both editions (electron-builder signs during packaging)
        │
        ▼
  verify Authenticode ──── fails? stop. Nothing is hashed, nothing is published.
        │
        ▼
  SHA-256 of the final signed installers
        │
        ▼
  latest.json  →  Ed25519 release signature + editions signature
        │
        ▼
  verify both Ed25519 signatures against the key compiled into Wheat
        │
        ▼
  wheat-website-release.json,  publish-plan.json
        │
        ▼
  release:publish  → re-checks Authenticode and every digest against disk → GitHub Release
        │
        ▼
  website sync
```

`release-prepare.mjs` runs the Authenticode step between the build and the first
hash, writes `release/<version>/authenticode-report.json`, and records the result
in `publish-plan.json`. `release-publish.mjs` reads the files again rather than
trusting the plan.

### Failure is loud

If `WHEAT_SIGNING_MODE` is set and any expected artifact is unsigned, invalid,
untimestamped, or signed by a different publisher than the rest,
`release:prepare` **throws** and no manifest is written. The forbidden outcome —
signing failed, the build continued, an unsigned installer was published as an
official release — cannot occur.

If `WHEAT_SIGNING_MODE` is `off`, `release:publish` refuses unless you pass
`--allow-unsigned-windows`. That flag exists so shipping an unsigned Wheat is a
sentence somebody typed, not something that happened quietly.

Error messages name the artifact and the failing step. They never print a
password, a key or a token; certificate subject, issuer, thumbprint and expiry
are public data and are printed.

---

## Authenticode is not SmartScreen

These are constantly confused and the difference decides what to expect.

**Authenticode** is solved by a valid certificate. Once Wheat is signed, Windows
shows the publisher name instead of "Unknown publisher", Explorer's *Digital
Signatures* tab lists the certificate, UAC names the verified publisher, and
Smart App Control on Windows 11 will run the file at all.

**SmartScreen reputation** is not solved by a certificate. Per Microsoft's
current guidance ([SmartScreen reputation for Windows app
developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)):

- A newly signed binary **can still show a warning** until its hash or its
  publisher certificate has accumulated reputation. There is no threshold to
  meet and no submission process for consumer endpoints — "it can take several
  weeks and hundreds of clean installs from a wide audience".
- **EV certificates no longer bypass SmartScreen.** That behaviour was removed in
  2024. Paying the EV premium for this reason alone is no longer justified.
- Reputation accumulates against a **consistent signing identity**, which is why
  both editions must sign as one publisher and why changing certificate resets
  the signal.

So the honest statement after signing is configured is:

```
AUTHENTICODE:      PASS
PUBLISHER DISPLAY: <the certificate's common name>
SMARTSCREEN:       warning expected on early downloads; reputation accumulates
```

Anything stronger than that would be folklore.

---

## Getting a certificate

Wheat has **no** code signing certificate. The pipeline above is complete and
exercised; it is waiting on a credential. Current options, from Microsoft's
[code signing options for Windows app
developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options):

| Option | Cost | Availability | Notes |
|---|---|---|---|
| **SignPath Foundation** | **free** | worldwide, OSS only | Free OV-level signing for qualifying open source projects. Wheat is GPL-3.0-or-later with a public repository. The certificate is issued to *SignPath Foundation*, so that is the publisher name shown. Requires a verifiable automated build. |
| **OV certificate** (DigiCert, Sectigo, GlobalSign…) | $150–300/year | worldwide | The publisher name is Wheat's own legal identity. Since June 2023 the CA/Browser Forum requires the private key to live on a FIPS 140-2 Level 2 / Common Criteria EAL4+ hardware token or HSM — a USB token shipped by the CA, or a cloud HSM for CI. |
| **Azure Artifact Signing** | ~$9.99/month | organizations: USA, Canada, EU, UK — **individuals: USA and Canada only** | No hardware token; signs from CI. **A Morocco-based individual is not eligible.** |
| **EV certificate** | $400+/year | worldwide | Same SmartScreen behaviour as OV since 2024. Only worth it for enterprise procurement requirements. |
| **Self-signed** | free | — | Dev and testing only. To a public user it behaves the same as no signature. Never ship one. |

Whichever is chosen, it is set up once as described above and every subsequent
release is signed automatically.

### Signing from CI

There is no CI pipeline in this repository today; releases are built on a
Windows workstation. If one is added:

- store the credential as a repository secret or, better, use OIDC federation so
  no long-lived key is stored at all;
- a hardware token cannot be used from a hosted runner — use a cloud HSM or a
  signing service;
- never echo a secret, never pass a password on a command line (it lands in the
  process list), and never write one into a build config file. `signingChildEnvironment()`
  exists precisely so the PFX password reaches electron-builder as an environment
  variable of one child process and nowhere else.

---

## Renewal

A certificate expires. Because every Wheat signature is RFC 3161 timestamped,
releases signed while the certificate was valid keep verifying afterwards.

On renewal:

1. Install the new certificate (or update the signing service profile).
2. Update `WHEAT_SIGNING_CERTIFICATE_SUBJECT` / `_SHA1` if the subject changed.
3. Run `npm run sign:verify` on the next build and confirm the publisher name is
   unchanged — a changed publisher name resets SmartScreen reputation.

Keep the same subject name across renewals wherever the CA allows it.
