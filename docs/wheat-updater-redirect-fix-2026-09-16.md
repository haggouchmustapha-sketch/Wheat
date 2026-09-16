# Windows updater redirect fix — 2026-09-16

## Failure reproduced

An installed Wheat 2.1.2609151 never finds an update. Its log says so on every
attempt:

```json
{"event":"check-started","source":"github","installedVersion":"2.1.2609151"}
{"event":"check-unreachable","reason":"The Wheat update server could not be reached: Redirect was cancelled","automatic":true}
```

2.1.2609151 moved the updater onto Chromium's network stack — `net.fetch` —
so that a machine whose TLS is inspected by an office gateway or an antivirus
could still reach GitHub. That change is right and stays.

But **`net.fetch` does not implement `redirect: "manual"`.** It rejects with
*Redirect was cancelled* instead of returning the 3xx. `requestRelease` asks for
manual redirects on every request, deliberately: the whole point is that each
hop is inspected and approved *before* Wheat goes there. GitHub answers 302
twice before a release manifest —
`releases/latest/download/latest.json` → `releases/download/v<tag>/latest.json`
→ `release-assets.githubusercontent.com` — so the first hop kills every request.

Measured in Electron 42 against the real repository:

| Transport | Result |
|---|---|
| `net.fetch` (what 2.1.2609151 ships) | FAILED — Redirect was cancelled |
| `createElectronReleaseFetch` (this fix) | OK — 2.1.2609151, both editions in the manifest |

It affects the check *and* the download, because both go through
`requestRelease`. No installed 2.1.2609151 can find, fetch or install anything.

No test in this repository could have caught it: every updater test injects a
`fetchImpl` double, and the doubles behave the way `fetch` is specified to.
Only the real Chromium stack differs, and only an installed build uses it.

## Repair

`createElectronReleaseFetch` in `electron/updater/releaseTransport.ts` builds the
same small `Response` shape on `net.request`, which *does* support manual
redirects: it emits a `redirect` event carrying the status and destination and
goes nowhere unless `followRedirect()` is called. Wheat never calls it.
`requestRelease` receives the 3xx, resolves the destination, and applies
`allowRedirectTo` exactly as before.

Nothing about trust changes:

- redirects are still vetted per hop, still refused off GitHub's own hosts, still
  refused over plain http;
- the Ed25519 manifest signature, the editions signature and the SHA-256 of the
  installer are verified exactly as before;
- Chromium's certificate store and proxy still carry the request, which is why
  `net` was adopted in the first place.

`tests/updater-github.spec.cjs` now drives a fake `net` that behaves the way
Electron's really does — the hop is announced and not taken — and asserts both
that the 3xx comes back as a response and that the destination was not fetched
until the provider approved it.

## How installed copies receive this

**Wheat 2.1.2609151 cannot deliver its own repair.** Its updater is the broken
component, so it will never discover the release that fixes it. There is no
fallback: a packaged build with a configured repository always uses the GitHub
channel, and the local-folder and self-hosted channels are compile-time
decisions an installed copy cannot be switched to.

| Installed version | What happens |
|---|---|
| **2.1.2609151** | **Requires one manual installation.** Download the next release from the website and run it. Afterwards, automatic updates work again permanently. |
| 2.1.2609082 and older | Unaffected — those builds use Node's `fetch`, which honours `redirect: "manual"`. They find and install the next release on their own. |

A manual installation is an ordinary in-place install: same install directory,
same `%APPDATA%\Wheat\`, dossiers, documents, backups and credentials untouched.
It is the same operation as an edition switch, and it was exercised five times
during release hardening — see `docs/wheat-installer-testing.md`.

### Publish this promptly

While 2.1.2609151 is the newest published release, it is also what
`latest.json` points at and what the website offers. Every installation still on
2.1.2609082 that updates itself today lands on 2.1.2609151 and *stops being able
to update*. Every new download from the website does the same.

Once the next release exists, older installations skip 2.1.2609151 entirely and
go straight to the fixed version, because `latest.json` names only the newest.
So the population that needs a manual install is exactly: whoever is on
2.1.2609151 when the fix ships. The sooner it ships, the smaller that group.

### What the release notes should say

In plain terms, for an accountant:

> Cette version corrige la recherche de mises à jour. Si vous utilisez la
> version 2.1.2609151, Wheat ne pouvait pas la trouver tout seul : installez
> celle-ci une fois depuis le site, et les mises à jour suivantes
> redeviendront automatiques. Vos dossiers, écritures, documents et sauvegardes
> ne sont pas touchés.

## Two other updater repairs in the same pass

- **Staged installers were never deleted.** Every update that installed left its
  own 300 MB – 1.4 GB installer in `%APPDATA%\Wheat\updater\staging` for good;
  1.39 GB of a superseded version was found sitting in a real profile.
  `pruneStagedInstallers` now runs on the confirmation that follows every
  launch. Verified on an installed build: `{"event":"staging-pruned","version":"2.1.2609051"}`,
  directory emptied.
- **An overtaken offer survived.** After a manual reinstall or an edition switch —
  both documented, supported actions — the state file still said
  "Update 2.1.2609151 available" to somebody already running 2.1.2609151, and
  accepting it produced a refusal. `discardOvertakenOffer` drops an offer the
  running version has already reached, in every phase except the ones that
  legitimately name it (`installing`, `awaiting-confirmation`, `updated`) or that
  somebody still needs to read (`error`).

## Validation

`npm run lint`, `npx tsc -b`, the full updater suite (111 tests) and the full
Playwright suite (998 passed, 14 skipped, 0 failed) all pass. The transport was
additionally driven against the real GitHub release from a real Electron main
process, which is the only place the fault was ever visible.
