# The Wheat installer, tested on a real machine

Everything in this document was run against the genuine
`Wheat-Standard-2.1.2609151-Setup.exe` and
`Wheat-Lightweight-2.1.2609151-Setup.exe` from `release/2.1.2609151/`, on
Windows 11 Pro 26200, starting from a machine with **no Wheat installed** but a
real `%APPDATA%\Wheat\` profile containing a dossier, 585 documents and 16
backups.

Every install was run silently — `Setup.exe /S` — which is the same entry point
the updater's helper uses (`/S --updated`).

The database was fingerprinted before the first install and after every step:

```
SHA-256  9F72850B79A373CD4DDA8D738F90758CF5CAFC721FB8253B8BB763A4FF7129C0
bytes    2 899 968
```

**It was identical at every checkpoint below.** That is the single most important
line in this document.

---

## The matrix

| # | Step | Result |
|---|---|---|
| 1 | Clean install — Lightweight | PASS |
| 2 | Switch — Lightweight → Standard | PASS |
| 3 | Switch — Standard → Lightweight | PASS |
| 4 | Uninstall | PASS |
| 5 | Clean install — Standard | PASS |

Four edition transitions in total, each verified by launching the installed
application and asking it what it is.

---

## 1. Clean install — Lightweight

```
duration          52 s
exit code         0
install directory %LOCALAPPDATA%\Programs\Wheat   (per-user; no elevation)
files             404
size              1 074.5 MB
PaddleOCR         absent
uninstall entries 1   "Wheat 2.1.2609151"
Start menu        1 shortcut        Desktop  1 shortcut
```

Launched and interrogated through its own bridge:

```
edition           lightweight
dossier           IFCOF, 2 bank accounts     (the existing profile, untouched)
PaddleOCR status  available: false — "Cette édition de Wheat n'embarque pas le
                  moteur de reconnaissance local…"
engine order      cloud → tesseract
cloud             connected, safeStorage available
```

## 2. Switch — Lightweight → Standard

```
duration          193 s
files             27 455       size 3 149.6 MB
PaddleOCR         present — 27 051 files, 2 075 MB, python.exe present
uninstall entries 1            shortcuts 1 + 1
database          unchanged (same SHA-256)
documents         585, unchanged
profiles          one %APPDATA%\Wheat
```

```
edition           standard
PaddleOCR status  available: true — PaddleOCR 3.7.0, Python 3.12.10, cpu
engine order      paddle → cloud → tesseract
cloud             still connected; the credential survived the switch
```

## 3. Switch — Standard → Lightweight

This is the one that mattered most: 2 GB of recognition runtime had to disappear.

```
duration          52 s
files             404          size 1 074.5 MB
PaddleOCR         ABSENT — no resources\paddleocr, no orphaned python.exe
uninstall entries 1            shortcuts 1 + 1
database          unchanged
```

**No stale resources are left behind.** electron-builder's NSIS installer runs the
previous version's uninstaller with `/S /KEEP_APP_DATA --updated _?=$INSTDIR`
before it installs, and that uninstaller does `RMDir /r $INSTDIR`. The install
directory is therefore rebuilt from nothing on every install, while
`%APPDATA%\Wheat\` is explicitly kept. Switching to Lightweight really produces a
Lightweight installation — 404 files, byte for byte the same as a clean one.

## 4. Uninstall

Run as `"Uninstall Wheat.exe" /S`, 4.3 s, exit 0.

| | |
|---|---|
| install directory | **removed** |
| uninstall registry entry | **removed** |
| Start menu shortcut | **removed** |
| Desktop shortcut | **removed** |
| `%APPDATA%\Wheat\wheat.sqlite` | **kept**, unchanged |
| documents (585) | **kept** |
| backups (16) | **kept** |
| `updater\state.json` | **kept** |
| `wheat-ai\` credentials | **kept** |

This is the correct policy and it is the one already configured:
`nsis.deleteAppDataOnUninstall` is not set, so it defaults to false and the
uninstaller's `$isDeleteAppData` branch never runs. **Removing Wheat does not
remove an accountant's books.** Do not change this without giving the user a
separate, separately-confirmed "also delete my data" action.

## 5. Clean install — Standard

From the uninstalled state:

```
duration          183 s
files             27 455       size 3 149.6 MB
PaddleOCR         present
uninstall entries 1            shortcuts 1 + 1
database          unchanged
edition           standard, local PaddleOCR 3.7.0 working
```

---

## What never accumulated

Across five installs and four edition transitions:

- **one** entry in "Installed apps", never two;
- **one** Start menu shortcut and **one** desktop shortcut;
- **one** `%APPDATA%\Wheat` profile — no second profile under any name;
- no stale resources in the install directory;
- no duplicate application identity.

Both editions declare the same `appId` (`ma.atlasledger.desktop`) and the same
`productName` (`Wheat`), which is what makes an edition switch an ordinary
in-place install rather than a second program.

---

## Cloud authorisation from the installed build

`wheat:cloud:authorize` was started on the installed Wheat and its listeners
watched:

```
before authorize   127.0.0.1:64687          (the debugging port this probe added)
after authorize    127.0.0.1:64687
                   127.0.0.1:50222          ← the PKCE callback server
```

The callback server binds **127.0.0.1 on an ephemeral port**, never `0.0.0.0`.

```
Windows Firewall rules for Wheat.exe : NONE — before, during and after
Firewall profiles                    : Domain/Private/Public all enabled,
                                       NotifyOnListen = True
```

**No firewall prompt appeared and no rule was created**, because Windows Firewall
does not filter loopback listeners. No exception is needed, and none should ever
be added: an exception would be the symptom of binding something other than
127.0.0.1.

Completing the sign-in is a human step (a real OpenRouter account in a real
browser) and was not performed here; the flow end-to-end, including
`safeStorage` and the automatic resume of the interrupted import, is recorded in
`docs/wheat-editions.md` from the packaged build.

---

## What the installed build revealed about the updater

Watching the installed 2.1.2609151 check for updates found a fault that no test
in this repository could have found, because it only appears against Chromium's
real network stack:

```
updater.log  check-unreachable  "The Wheat update server could not be reached: Redirect was cancelled"
```

2.1.2609151 moved the updater onto `net.fetch` so that a machine behind a TLS
inspecting gateway could still reach GitHub. But `net.fetch` does not implement
`redirect: "manual"` — it rejects with *Redirect was cancelled* instead of
returning the 3xx — and Wheat asks for manual redirects on every request so it
can vet each hop before following it. GitHub answers 302 twice before a release
manifest, so **every installed 2.1.2609151 fails every update check.**

Measured directly, in Electron 42, against the real repository:

| | result |
|---|---|
| `net.fetch` (what 2.1.2609151 ships) | FAILED — Redirect was cancelled |
| `createElectronReleaseFetch` (the fix) | OK — 2.1.2609151, both editions |

The fix builds the same fetch shape on `net.request`, which does support manual
redirects: the hop is announced and **not taken** unless `followRedirect()` is
called, which Wheat never calls — `requestRelease` resolves and vets the
destination itself, exactly as before. Chromium's certificate store and proxy
are still what carries the request.
`tests/updater-github.spec.cjs` pins it.

This is fixed in the working tree and is **not** in any published build. The
next release is what delivers it.

---

## What the updater does, in installer terms

The update helper (`resources/updater/update-helper.ps1`) runs

```
Start-Process $installer -ArgumentList @("/S", "--updated") -Wait
```

which is the same command as the installs above, plus `--updated`. `--updated`
only tells the old uninstaller not to delete application data — which it would
not have done anyway, since `deleteAppDataOnUninstall` is off. The helper then
verifies that `Wheat.exe`'s product version and timestamp actually changed before
it relaunches, and restores its rollback snapshot if anything failed.

So the installer mechanics an update depends on are exactly the mechanics
exercised above. What is **not** covered here is a real machine finding,
downloading and installing a genuinely newer published release; that needs two
published versions and is listed as outstanding in `docs/wheat-editions.md`.

---

## Reproducing this

```powershell
# from release\<version>\
Start-Process .\Wheat-Lightweight-<version>-Setup.exe -ArgumentList '/S' -Wait
Start-Process .\Wheat-Standard-<version>-Setup.exe    -ArgumentList '/S' -Wait
Start-Process "$env:LOCALAPPDATA\Programs\Wheat\Uninstall Wheat.exe" -ArgumentList '/S' -Wait
```

After each step:

```powershell
$dir = "$env:LOCALAPPDATA\Programs\Wheat"
(Get-ChildItem $dir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Test-Path "$dir\resources\paddleocr"
(Get-FileHash "$env:APPDATA\Wheat\wheat.sqlite" -Algorithm SHA256).Hash
@(Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' |
  Where-Object DisplayName -like '*Wheat*').Count
Get-AuthenticodeSignature "$dir\Wheat.exe" | Format-List Status, SignerCertificate
```

The edition an installed copy believes it is can be read from the About panel,
or over the bridge as `document.documentElement.dataset.wheatEdition` and
`window.wheat.getPaddleOcrStatus()`.

---

## Two hundred and forty-two megabytes that were never meant to ship

Reading the installed `app.asar` found twelve copies of
`query_engine-windows.dll.node.tmp<pid>` — 242 MB of interrupted
`prisma generate` runs, packaged into **both** editions of the released
2.1.2609151 because `files` took `node_modules/.prisma` whole. The count depends
on how many times a generate was interrupted on the build machine, so the
installer size and its SHA-256 were not reproducible either.

`files` now excludes `**/*.node.tmp*`. Rebuilding both editions from the same
source:

| | before | after |
|---|---|---|
| `app.asar` | 672 MB | **430 MB** |
| Standard installer | 1 334 MB | **1 262 MB** |
| Standard installed | 3 150 MB | **2 907 MB** |
| Lightweight installer | 293 MB | **220 MB** |
| Lightweight installed | 1 074 MB | **832 MB** |

The rebuilt Lightweight was installed and driven: same edition, same dossier, no
PaddleOCR, cloud credential intact. `tests/wheat-edition-unit.spec.cjs` pins the
exclusion.

---

## Signature state during these tests

Every artifact was **unsigned**, which is the state this release-hardening pass
set out to fix:

```
Wheat-Standard-2.1.2609151-Setup.exe      NotSigned
Wheat-Lightweight-2.1.2609151-Setup.exe   NotSigned
Wheat.exe        (installed)              NotSigned
Uninstall Wheat.exe (installed)           NotSigned
```

See `docs/wheat-code-signing.md`. The pipeline that fixes this is implemented and
exercised; it is waiting on a certificate.
