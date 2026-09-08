# Publishing a Wheat release

Wheat's source and its published builds live in one repository:

**https://github.com/haggouchmustapha-sketch/Wheat** (default branch `main`)

Git history holds the source. **GitHub Releases** holds the installers. A release
binary is never a commit: `release/` is build output, and installers reach users
as release assets. Cloning the repository must never drag a hundred megabytes of
past installers with it.

An installed Wheat reads that repository's Releases directly. The accountant
never opens GitHub, never downloads an installer by hand, and never reinstalls a
dossier.

What that looks like from the accountant's side — every dialog between "a
version was found" and "Wheat has been updated", including what Wheat cannot
know about installer progress — is `docs/wheat-update-user-flow.md`.

---

## Where the repository is configured

One place: the `repository` field of `package.json`.

```json
"repository": { "type": "git", "url": "https://github.com/haggouchmustapha-sketch/Wheat.git" }
```

Both sides derive from it and cannot be aimed at different places:

| Consumer | Module |
|---|---|
| The running application | `electron/updater/releaseSource.ts` |
| The release tooling | `scripts/lib/releaseRepository.mjs` |

`tests/updater-github.spec.cjs` asserts the URL, the derived manifest URL and the
derived asset URL together, so a change to one that misses the other fails.

---

## The two commands

### Prepare — local, reversible, publishes nothing

```powershell
npm run release:prepare -- --notes docs/wheat-<version>-release-notes.md --sign ..\wheat-release-key.pem
```

In order it:

1. resolves the version (`package.json` is authoritative; `--version <semver>` rewrites it and refuses a downgrade);
2. reads what is already published and refuses a version that exists or is not newer;
3. reads the release notes — an accountant reads these, so they are written, never generated from commits;
4. runs `npm run lint` and `npm run test:updater`;
5. runs `npm run installer` (electron-builder, NSIS, x64);
6. writes and signs `latest.json`;
7. re-hashes the installer and **verifies the signature against the public key compiled into this build** — signing with the wrong key would otherwise publish a release every client silently refuses;
8. writes `release/<version>/publish-plan.json` and prints exactly what would be uploaded.

Useful flags: `--minimum-version <semver>`, `--skip-build` (reuse an installer),
`--skip-tests` (recorded in the plan; **publish then refuses it**).

### Publish — external, irreversible, fails closed

```powershell
npm run release:publish
```

It re-checks everything against the bytes on disk *now*, because prepare and
publish are separated by however long you spent reading the plan:

- the plan exists, is for this version, and targets this repository;
- tests were not skipped;
- the release is signed;
- every asset still matches its prepared size and SHA-256;
- the manifest names the installer it hashes, and its signature verifies against the key compiled into Wheat;
- `gh` is authenticated;
- the tag does not exist, and the version is newer than everything published.

Only then does it `gh release create`. Afterwards it lists the remote assets and
**fetches `latest.json` back with no credentials** — the way a client does — and
says plainly whether installed Wheat can actually see the release.

Any failure stops before anything is uploaded.

---

## Release assets

| File | Purpose | Read by |
|---|---|---|
| `WheatSetup-<version>.exe` | The NSIS installer. | Wheat's updater; a person doing a first install. |
| `latest.json` | The signed manifest: version, date, notes, artifact name, SHA-256, size, Ed25519 signature. | Wheat's updater, first, before anything else. |
| `WheatSetup-<version>.exe.blockmap` | electron-builder's block map. **Not** read by Wheat's updater; published so the installer can be diffed and verified externally. | Nothing in Wheat. |

Wheat does not use `latest.yml`: that is electron-updater's format, and Wheat
has its own signed manifest instead (see below).

---

## Artifact size

The installer is currently **~1.3 GB**, and almost all of it is
`resources/paddleocr` — an embedded Python runtime plus OCR models, ~2.1 GB on
disk, pulled in wholesale by the `extraResources` entry in `package.json`.

That was tolerable when Wheat was installed from a USB stick. It is a different
proposition now that the same file is the *update* payload: every accountant
downloads it in full for every release, over whatever connection they have, and
GitHub's per-asset ceiling is 2 GB — so there is not much headroom left either.

Nothing in the update path works around this, and deliberately so: Wheat
verifies whole artifacts, and a delta scheme would be a new trust surface. The
fix belongs in packaging, not in the updater. Worth considering, roughly in
order of payoff:

- ship PaddleOCR as an optional component downloaded on first use, rather than
  inside the installer — Tesseract already covers the default OCR path;
- prune the bundled Python runtime (`pip`, `setuptools` and their vendored
  binaries are packaged today and are not needed at runtime);
- keep the OCR models but drop the ones for languages Wheat does not offer.

Until then, expect a long upload during `release:publish` and tell users that
the first update is a large download.

## Security

**Trust anchor: an Ed25519 signature over the manifest, verified against a public
key compiled into the application.**

`electron/updater/signature.ts` holds `WHEAT_UPDATE_PUBLIC_KEY`. A manifest is
only acted on if it verifies against that key. The chain is:

```
Ed25519 signature  → this manifest was written by the release-key holder
manifest SHA-256   → these bytes are the bytes that were signed
```

GitHub is therefore infrastructure, not authority. Anyone who took over the
account, the repository or the CDN could publish a release; every installed Wheat
would still refuse it. That is strictly stronger than trusting TLS alone.

The download path is narrowed too: only HTTPS, only hosts GitHub serves downloads
from, and the artifact URL is **built by Wheat** from the repository, the tag and
the manifest's file name — the manifest never supplies a location.

### Secrets, and where they are not

| Secret | Lives | Never in |
|---|---|---|
| Ed25519 **private** release key | One file outside the repository, on the release machine. | Git, backups that leave your control, GitHub, Wheat.exe. |
| GitHub credential | The operator's `gh auth login`, on the release machine. | Wheat.exe, the repository, any build artifact. |

**No GitHub publishing credential is embedded in Wheat.exe.** An installed Wheat
makes anonymous HTTPS requests and holds no token of any kind.

Generate the key once:

```powershell
npm run update:keygen -- --out ..\wheat-release-key.pem
```

Then paste the printed public key into `WHEAT_UPDATE_PUBLIC_KEY` in
`electron/updater/signature.ts` and rebuild. Until you do, the constant is empty
and Wheat **refuses every network update** — unconfigured fails closed.

Paste the **whole PEM**, `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----`
lines included. `createPublicKey` rejects a bare base64 body, and it does so at
*runtime*, on the accountant's machine, where it reads as "every update refused"
with nothing to point at. This has already happened once. Two things now catch
it: `tests/updater-signature.spec.cjs` fails if the compiled key is present but
unusable, and `release:prepare` refuses to write a plan whose signature does not
verify against the compiled key.

Windows Authenticode code signing is not configured. It is orthogonal: it removes
the SmartScreen warning on the installer, and the Ed25519 manifest signature is
what actually decides whether Wheat runs an update. To add it, set
`win.certificateFile`/`certificatePassword` in `package.json`'s `build` block from
environment variables — never committed.

---

## Versioning

`package.json`'s `version` is the single authority. `src/appVersion.ts` reads it,
so the About panel, the installer file name, the manifest, the Git tag and the
updater cannot disagree.

The convention is `2.1.<YYMMDD><n>` — e.g. `2.1.260901`, valid SemVer with the
patch component carrying the build date. Comparison is `semver`, never string
comparison, so `2.10.0` is correctly newer than `2.9.0`.

Downgrades are refused in three independent places: `release-prepare` and
`release-publish` refuse to publish one, and `assertUpdateCompatibility` in the
client refuses to install one.

The Git tag is `v<version>`.

---

## The local rehearsal channel

An unpackaged Wheat reads a folder rather than GitHub, so a release can be tried
end-to-end before anyone publishes it:

```powershell
npm run update:package -- --notes-file docs/wheat-<version>-release-notes.md --sign ..\wheat-release-key.pem
```

This writes `updates/` and, on Windows, `%APPDATA%\Wheat\updates`. See
`updates/README.md`.

---

## Why not electron-updater or GitHub Actions

**electron-updater** would replace a working, signed, well-tested updater with a
weaker trust model: its `latest.yml` is unsigned, so its SHA-512 only binds a file
to a manifest that anyone who can serve the manifest can rewrite. Wheat's
manifest is signed by an offline key. It would also not solve the private-repo
problem — its GitHub provider needs a token for a private repository, which is
exactly what must not ship inside Wheat.exe.

**GitHub Actions** would require putting the Ed25519 private release key into
GitHub secrets, on the same platform that distributes the release, and a Windows
runner to package. Agent-driven publishing from the release machine keeps the
signing key off GitHub entirely. The architecture does not preclude CI later: the
prepare/publish split is exactly the boundary a workflow would use.
