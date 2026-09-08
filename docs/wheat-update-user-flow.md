# What a Wheat update looks like to the person using it

Publishing a release is `docs/wheat-release-process.md`. This document is the
other side of it: what appears on screen between a release being published and
the accountant working in the new version, and what Wheat deliberately does not
claim to know.

The whole flow is three decisions, and Wheat makes none of them. A check may run
unattended and downloads nothing. A download happens because somebody pressed
*Mettre à jour* and installs nothing. An installation happens because somebody
pressed *Redémarrer et installer*, which is the only moment Wheat closes.

Every state below is one status object (`UpdateStatus`) travelling
`UpdateService` → `wheat:update:status` → the renderer → `WheatUpdateNotices`.
The same object drives the Réglages → *Mises à jour* card, so the modal and the
settings page can never disagree.

## 1. A version is found — *Une mise à jour de Wheat est disponible*

Shortly after launch, and whenever *Rechercher les mises à jour* is pressed.
The dialog names the version and lists its release notes. Two answers:

- **Plus tard** keeps the offer and stops interrupting. It stays visible in
  Réglages, and the same version will not interrupt again; a newer one will.
- **Mettre à jour** starts the download.

Nothing has been fetched at this point beyond the signed manifest.

## 2. Downloading — *Téléchargement de la mise à jour…*

- The target version is in the dialog subtitle.
- A determinate progress bar, plus the figures beside it: percentage, amount
  received, total size (`48 Mo / 120 Mo`).
- The bar is driven by `UpdateDownloadProgress.transferredBytes`, which is the
  count of bytes actually written to the staging file. There is no timer and no
  animation standing in for a transfer.
- If a release declares no size, there is no bar and no percentage — only the
  amount received so far. A gauge with nothing behind it would tell the person
  less than an honest byte count.
- Work continues normally underneath; the dialog says so.

**A second download cannot be started by accident.** The offer dialog is gone
for the whole of the download, the Réglages *Mettre à jour* button only exists
while a version is merely `available`, and both buttons disable themselves while
a request from this window is in flight. Underneath all three, `UpdateService`
holds a single in-flight download promise, so even a repeated call joins the
running download rather than starting a rival one.

**There is no cancel button.** The updater has no cancellation path: a download
in progress owns a staging directory and a partially written `.part` file, and
the service exposes no way to abandon them safely mid-write. Adding a button
that only appeared to cancel would be worse than not having one. An interrupted
download — a closed window, a lost connection — is cleaned up on the next
attempt, and the offer is still there to retry.

## 3. Verifying — *Vérification de la mise à jour…*

The signature and the SHA-256 of the downloaded artifact are checked before it
is accepted. Unchanged by any of this work: a failure here discards the bytes,
keeps the offer, and reports why.

## 4. Ready — *La mise à jour est prête*

- Version and release notes.
- **Redémarrer et installer**, and **Plus tard** which keeps the verified update
  staged for whenever the person is ready.
- A warning that forms in progress are saved but import and analysis windows are
  not.

The verified installer stays on disk. A check that runs later finds it and asks
for a restart rather than downloading again.

## 5. Installing — *Installation de la mise à jour…*

Shown from the moment *Redémarrer et installer* is pressed until Wheat exits,
which is a few seconds later: the update helper must pass its readiness guards
before Wheat will close, and Wheat stays fully alive until it does.

- The version being installed.
- An **indeterminate** bar, and this is the honest limitation: **the NSIS
  installer publishes no progress of its own.** It is launched by a hidden
  PowerShell helper (`electron/updater/windowsInstaller.ts`) in silent mode and
  reports nothing back until it has finished, by which time Wheat itself is no
  longer running. There is no percentage to show, so none is invented — the bar
  says only that the step is running. Under `prefers-reduced-motion` it stops
  moving entirely.
- The text states plainly that Wheat will close and reopen automatically.

The helper stays hidden. Everything the person is told comes from Wheat's own
window, never from a console.

## 6. If the installation cannot start

The helper is launched and *awaited* before Wheat drains its work or closes
anything. If it cannot start, or cannot confirm readiness within its timeout,
nothing has been touched:

- Wheat stays open and usable.
- The dialog becomes **L'installation n'a pas pu démarrer**, stating that
  *Wheat <version> n'a pas été modifié*, and carrying the reason from the
  helper.
- The button becomes **Réessayer l'installation** — the verified installer is
  still staged, so a retry costs no download.
- The phase returns to `ready`. It never sticks on "installing".

The same message appears in Réglages → *Mises à jour* for anyone who dismissed
the dialog.

## 7. After a successful installation

The helper replaces the program files, keeps a rollback copy, and relaunches
Wheat. On that first launch the running version is compared against the version
that was being installed, and if they match, **Wheat a été mis à jour** is shown
once, with the release notes and a reminder that only the program changed.
Dismissing it marks the notice consumed; it does not come back on later
launches.

`%APPDATA%\Wheat\` is never touched by any of this — that guarantee is tested in
`tests/updater-user-data.spec.cjs`.

## Where this is covered by tests

| Behaviour | Test |
| --- | --- |
| Real, moving download figures on screen; downloading → ready | `tests/updater-ui-flow.spec.cjs` |
| Installing announced before shutdown, with an indeterminate bar | `tests/updater-ui-flow.spec.cjs` |
| A helper that cannot start leaves Wheat open, explains itself, keeps the staged installer | `tests/updater-ui-flow.spec.cjs`, `tests/updater.spec.cjs` |
| Relaunch, startup confirmation, notice shown once | `tests/updater-ui-flow.spec.cjs`, `tests/updater-electron.spec.cjs` |
| Accounting data preserved across the whole lifecycle | `tests/updater-ui-flow.spec.cjs`, `tests/updater-user-data.spec.cjs` |
| Offer-and-wait consent, "Plus tard" | `tests/updater-electron.spec.cjs` |

The install path can only be driven in a real window by a build that is allowed
to replace program files. `WHEAT_UPDATE_ALLOW_INSTALL=1` grants that to an
**unpackaged** build only (`resolveAutomaticInstallationEnabled` in
`electron/updater/channel.ts`), which is what the UI tests use. It weakens
nothing: a development build has no packaged helper script, so the attempt fails
at the readiness gate — which is the failure those tests need to observe. A
packaged Wheat ignores the variable entirely, exactly as it ignores an update
source or signing key from the environment.
