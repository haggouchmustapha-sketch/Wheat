# Wheat local update feed

The **rehearsal** channel. Wheat's real releases go to the GitHub Releases of
https://github.com/haggouchmustapha-sketch/Wheat — see
`docs/wheat-release-process.md`. This folder is how a release is tried
end-to-end before anybody publishes it, and how a machine with no connection at
all is serviced.

An **unpackaged** Wheat reads this folder. A **packaged** Wheat reads GitHub.

```powershell
npm run dist:standard
npm run update:package -- --notes-file docs/wheat-<version>-release-notes.md --sign ..\wheat-release-key.pem
```

Do not hand-edit checksums or release metadata. The generated layout is:

```text
updates/
  latest.json
  <semver>/
    Wheat-Standard-<semver>-Setup.exe
    release.json
```

A local feed serves **one edition**, declared in the manifest's `editions` map.
Pass `--edition lightweight` (after `npm run dist:lightweight`) to rehearse the
other one. A development build of one edition reading a feed that publishes only
the other finds nothing to install — which is the intended behaviour: Wheat
never crosses editions during an update. See `docs/wheat-editions.md`.

Note the shape difference from a GitHub release, which is a flat set of assets:
here `artifact` is `<version>/<installer>`, there it is just the file name.
`buildReleaseManifest` in `scripts/lib/releaseManifest.mjs` takes a `layout` for
exactly that reason, and the value is signed either way.

Development builds read this directory but never execute installers. On Windows
the packaging command also publishes the same release to `%APPDATA%\Wheat\updates`,
which is the packaged application's local feed when no GitHub repository is
configured.
