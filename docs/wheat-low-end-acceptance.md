# Accepting Wheat Lightweight on the machines it exists for

**Status: NOT YET VERIFIED.**

Wheat Lightweight was built for old, slow office computers. Every number
published about it so far comes from a fast development workstation — a
Ryzen 5 7600, 16 GB, NVMe — which is the one machine that cannot answer the
question the edition exists to answer.

Nothing in this document may be treated as evidence that Lightweight is usable
on a weak computer. It is the procedure for finding out.

---

## Not a substitute

Lowering process priority, filling memory, pinning to one core or opening a
hundred browser tabs produce information, and that information is worth having
— but label it **STRESS TEST**. It is not "verified on low-end hardware". A
2012 laptop is slow in ways a throttled fast machine is not: an HDD seeking,
an integrated GPU with no video memory of its own, a CPU without the
instruction sets a modern build assumes, a 1366×768 screen, and a cold Windows
that has not been reinstalled in eight years.

---

## Target machines

These are **test targets, not requirements**. Wheat must not be locked to them.

| | Realistic low-end | Stress target |
|---|---|---|
| Windows | 10 or 11 | 10 |
| RAM | 8 GB | 4 GB |
| CPU | 2–4 logical cores | 2 logical cores |
| Graphics | Intel HD 4000-era integrated | the same |
| Disk | old SATA SSD | HDD |
| Display | 1366×768 | 1280×720 |

Test **both editions** on the same machine where possible. The comparison is
the point: Lightweight only earns its existence if it is noticeably better
there.

---

## The measured half

Run this on the machine, once per edition:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\wheat-field-report.ps1
```

It writes one plain-text file to the Desktop and sends nothing anywhere. It
records the machine's specifications, the installed size and edition, the
signature state, how long the window took to appear, total memory across every
Wheat process at t+5/10/20/30 s, whether Wheat closed cleanly, and whether any
recognition process was left behind.

It identifies Wheat's recognition processes by the executable path inside the
Wheat installation directory, never by the name `python` — this computer may be
running Python for something else entirely, and the first version of the script
blamed Wheat for a gigabyte that belonged to another program.

There is no telemetry in Wheat and this adds none. The file stays on the
tester's Desktop until they choose to send it.

## The half a script cannot measure

The report ends with a short questionnaire, because "did it feel usable" has no
API. Answer it in the file, in plain words.

- seconds from double-click until you could actually start work (stopwatch);
- scrolling a long list of entries: smooth, jerky, or unusable;
- opening a dialog and typing in it;
- switching to a screen for the first time (Wheat loads each one on first visit);
- resizing the window;
- whether the screen ever went black, white or torn;
- importing a scanned document, start to result;
- whether the computer became unusable for anything else while Wheat ran;
- anything that made you stop and wait.

---

## The full acceptance run

### Installation

1. Install from the website download, not from a copied folder — this is also
   where SmartScreen is observed. Record exactly what Windows said, and whether
   the publisher was named. Record how long the installer took.
2. Note the installed size (`%LOCALAPPDATA%\Programs\Wheat`) and the free space
   left on the system drive. On a 128 GB laptop, Standard's 3.2 GB matters.

### First run

3. Cold start — reboot first, then launch. This is the number that decides
   whether somebody likes Wheat.
4. Second start, without rebooting, for the warm figure.
5. Create a dossier and enter the company identity. Watch for dropped
   keystrokes.

### Ordinary accounting

6. Enter ten journal entries by hand. Every field, every combobox.
7. Open the journal, the ledger, a balance and a report.
8. Import a bank statement — CSV first, then a PDF.
9. Reconcile a few movements.

### Large data

10. Open the entries screen on a dossier with a few thousand rows. Filter, sort
    and page through it. Watch memory while you do.

### Recognition

11. Lightweight: import a scanned invoice, authorise the cloud when asked, and
    time from import to extracted fields. Watch whether the interface stays
    responsive *while* the request is in flight — that is the whole design
    claim, and the machine should be nearly idle during it.
12. Standard, on the same machine: the same document, read locally. Record the
    time and the CPU. If Standard is unusable here and Lightweight is not, say
    so plainly — that is the finding the edition exists for.

### Network

13. Throttle the connection, or use a real slow one. Import a document.
14. Disconnect the network mid-import. Confirm Wheat recovers or falls back
    rather than losing the document.

### Updates

15. Let Wheat check for updates. Record what it shows and how long it took.

### Graphics

16. Look for a black or white window, flicker, a crashed GPU process, torn
    rendering, or scrolling that tears. Old Intel drivers are where this
    happens.

### Shutdown

17. Close Wheat. Confirm the window closes promptly and no Wheat process
    survives — the script checks this, but check Task Manager too.

---

## Reporting

One file per machine per edition. Include the field report, the answered
questionnaire, and anything that surprised you.

A result of "Lightweight is fine, Standard is not, on this machine" is a
success for this exercise, not a failure. So is "both are too slow" — that is
worth knowing before anyone is asked to rely on it for their books.

---

## Until then

`docs/wheat-editions.md` and every release note must keep saying that low-end
hardware validation has not happened. Do not write "verified on older PCs"
anywhere until a real one has been through the list above.
