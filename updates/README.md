# Wheat local update feed

The **rehearsal** channel. Wheat's real releases go to the GitHub Releases of
https://github.com/haggouchmustapha-sketch/Wheat — see
`docs/wheat-release-process.md`. This folder is how a release is tried
end-to-end before anybody publishes it, and how a machine with no connection at
all is serviced.

An **unpackaged** Wheat reads this folder. A **packaged** Wheat reads GitHub.

```powershell
npm run update:package -- --notes-file docs/wheat-<version>-release-notes.md --sign ..\wheat-release-key.pem
```

Do not hand-edit checksums or release metadata. The generated layout is:

```text
updates/
  latest.json
  <semver>/
    WheatSetup-<semver>.exe
    release.json
```

Note the shape difference from a GitHub release, which is a flat set of assets:
here `artifact` is `<version>/WheatSetup-<version>.exe`, there it is just the
file name. `buildReleaseManifest` in `scripts/lib/releaseManifest.mjs` takes a
`layout` for exactly that reason, and the value is signed either way.

Development builds read this directory but never execute installers. On Windows
the packaging command also publishes the same release to `%APPDATA%\Wheat\updates`,
which is the packaged application's local feed when no GitHub repository is
configured.
