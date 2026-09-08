# Windows updater startup fix — 2026-09-08

## Failure reproduced

On this Windows host, a minimal PowerShell `-File` script launched by Node with `detached: true` exits with code 0 without executing the script or writing its marker. Removing `detached` executes the script, but a separate parent-exit regression demonstrated that the shared console can then terminate it when the parent exits.

## Repair

The Electron launcher starts a short hidden PowerShell bootstrap. Windows `Start-Process -WindowStyle Hidden` gives the actual helper an independent console lifetime. The helper validates its existing installation and rollback guards, atomically writes a per-attempt readiness marker containing its PID, and waits for Wheat to exit before modifying program files. Electron compares that marker with the worker PID reported by the bootstrap and checks process liveness before accepting the handoff.

Readiness has a 15-second deadline. Early exit, parse/binding failures, missing files, guard refusals and incorrect acknowledgements reject the launch. Timeout terminates the bootstrap/worker tree before retry is allowed. Startup stdout/stderr and bootstrap errors remain in per-attempt logs beside updater.log. The existing service failure path restores `ready`, retains the verified installer and exposes the error. The renderer receives its restart notification only after readiness succeeds. Old-version startup now diagnoses both abandoned `installing` and `awaiting-confirmation` states.

A broader updater test also exposed an existing race where asynchronous state reads dropped the final download progress event. Progress now emits synchronously in transfer order, without reading or writing disk for every event.

## Automated proof and limits

The Windows regressions exercise real PowerShell parsing, argument binding, paths with spaces, valid and incorrect readiness, early exit, timeout/tree termination, refusal, parent-process exit, program snapshot/rollback and preserved profile bytes. A disposable C# installer replaces a versioned executable; the replacement writes a relaunch marker with `--updated`, and startup confirmation records success. Existing updater tests cover signed feeds, checksum validation, GitHub transport, release tooling, Electron UI and accounting/profile preservation.

This is not a claim that an old production NSIS installation was upgraded on this workstation. No existing Wheat installation or real accounting profile is used by the lifecycle fixtures. A full old-production-installer to new-production-installer acceptance drill remains separate from these automated fixtures.

Existing versions with the broken launcher may need one manual installation of the new release to receive the repair. The requested version 2.1.260908 would compare lower than published 2.1.2609051; the user approved 2.1.2609081 instead, preserving the downgrade safeguards.

Validation for release 2.1.2609081: `npm run build`, `npm run lint` and `npm run test:updater` passed; the updater suite contains 121 passing tests. Logs are stored outside the test output directory in the Windows temporary directory (`wheat-release-build.log`, `wheat-updater-final-lint.log`, `wheat-updater-final.log`). Earlier failed experiments are retained separately and led to the final console-lifetime and cleanup fixes.
