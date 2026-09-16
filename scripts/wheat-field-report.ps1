<#
.SYNOPSIS
  Measures how Wheat behaves on this computer and writes one local text file.

.DESCRIPTION
  Wheat Lightweight exists for old, slow office computers. Nothing in this
  repository can tell us whether it is actually pleasant to use on one, so this
  script exists to be run *on such a machine* by whoever has it.

  It is deliberately not telemetry:

    * it sends nothing, anywhere, ever;
    * it writes one plain-text file on the Desktop, which you can read;
    * it collects machine specifications and timings, never accounting data,
      never a dossier, never a document, never a credential;
    * it needs no administrator rights.

  Sending the file to whoever asked for it is your decision and your action.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File wheat-field-report.ps1

.NOTES
  Close Wheat before running this. The script starts and stops it itself.
#>

[CmdletBinding()]
param(
  # Where Wheat is installed. The default is the per-user location its
  # installer uses.
  [string] $WheatPath = (Join-Path $env:LOCALAPPDATA 'Programs\Wheat\Wheat.exe'),
  # How long to watch Wheat after its window appears, in seconds.
  [int] $ObserveSeconds = 30,
  [string] $OutputPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) ("wheat-field-report-{0:yyyyMMdd-HHmmss}.txt" -f (Get-Date)))
)

$ErrorActionPreference = 'Stop'
$report = [System.Collections.Generic.List[string]]::new()
function Say([string] $line) { $report.Add($line); Write-Host $line }
function Section([string] $title) { Say ''; Say ('== ' + $title + ' ' + ('=' * [Math]::Max(0, 58 - $title.Length))) }

function Get-WheatOcrProcess([string] $InstallDirectory) {
  # Wheat Standard runs its recognition pool from an interpreter inside its own
  # installation directory, so that path is what identifies its processes.
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object {
      $exe = $null
      try { $exe = $_.Path } catch { }
      $exe -and $exe.StartsWith($InstallDirectory, [StringComparison]::OrdinalIgnoreCase) -and $exe -notlike '*\Wheat.exe'
    }
}

Say "Wheat field report"
Say ("generated  {0:yyyy-MM-dd HH:mm:ss zzz}" -f (Get-Date))
Say  "This file contains machine specifications and timings only."
Say  "It contains no accounting data and has been sent nowhere."

# ------------------------------------------------------------------ machine
Section 'This computer'
$os   = Get-CimInstance Win32_OperatingSystem
$cs   = Get-CimInstance Win32_ComputerSystem
$cpu  = @(Get-CimInstance Win32_Processor)[0]
Say ("windows        : {0} (build {1})" -f $os.Caption, $os.BuildNumber)
Say ("cpu            : {0}" -f $cpu.Name.Trim())
Say ("cores/threads  : {0} / {1}   max {2} MHz" -f $cpu.NumberOfCores, $cpu.NumberOfLogicalProcessors, $cpu.MaxClockSpeed)
Say ("memory         : {0:N1} GB total, {1:N1} GB free at start" -f ($cs.TotalPhysicalMemory/1GB), ($os.FreePhysicalMemory*1KB/1GB))
foreach ($gpu in Get-CimInstance Win32_VideoController) {
  Say ("graphics       : {0}   driver {1}   {2}x{3}" -f $gpu.Name, $gpu.DriverVersion, $gpu.CurrentHorizontalResolution, $gpu.CurrentVerticalResolution)
}
# Spinning disk or solid state changes cold-start more than anything else here.
try {
  foreach ($disk in Get-PhysicalDisk) {
    Say ("disk           : {0}  {1}  {2:N0} GB  bus {3}" -f $disk.FriendlyName, $disk.MediaType, ($disk.Size/1GB), $disk.BusType)
  }
} catch { Say  "disk           : not readable on this Windows edition" }
$systemDrive = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':'))
Say ("system drive   : {0:N1} GB free of {1:N1} GB" -f ($systemDrive.Free/1GB), (($systemDrive.Free + $systemDrive.Used)/1GB))

# ------------------------------------------------------------------- install
Section 'This Wheat'
if (-not (Test-Path -LiteralPath $WheatPath)) {
  Say ("NOT FOUND      : {0}" -f $WheatPath)
  Say  "Install Wheat first, or pass -WheatPath with the location you chose."
  $report | Set-Content -LiteralPath $OutputPath -Encoding utf8
  Write-Host ''; Write-Host ("Saved to {0}" -f $OutputPath)
  exit 1
}
$installDirectory = Split-Path -Parent $WheatPath
$installedFiles = Get-ChildItem $installDirectory -Recurse -File -ErrorAction SilentlyContinue
$paddle = Join-Path $installDirectory 'resources\paddleocr'
Say ("path           : {0}" -f $WheatPath)
Say ("version        : {0}" -f (Get-Item $WheatPath).VersionInfo.ProductVersion)
Say ("edition        : {0}" -f $(if (Test-Path -LiteralPath $paddle) { 'Standard (local recognition packaged)' } else { 'Lightweight (no local recognition)' }))
Say ("installed size : {0:N0} MB in {1:N0} files" -f (($installedFiles | Measure-Object Length -Sum).Sum/1MB), $installedFiles.Count)
$signature = Get-AuthenticodeSignature -LiteralPath $WheatPath
Say ("signature      : {0}{1}" -f $signature.Status, $(if ($signature.SignerCertificate) { ' — ' + $signature.SignerCertificate.Subject } else { '' }))

# --------------------------------------------------------------- measurement
Section ('Starting Wheat and watching it for {0} s' -f $ObserveSeconds)
if (Get-Process -Name 'Wheat' -ErrorAction SilentlyContinue) {
  Say  'Wheat is already running. Close it and run this again.'
  $report | Set-Content -LiteralPath $OutputPath -Encoding utf8
  exit 1
}

$watch = [Diagnostics.Stopwatch]::StartNew()
$process = Start-Process -FilePath $WheatPath -PassThru
# MainWindowHandle becomes non-zero when the native window exists. It is not
# "the interface is usable" — nothing outside Wheat can see that — so the
# questionnaire below asks you for that one with a watch.
$windowAt = $null
while ($watch.Elapsed.TotalSeconds -lt 120) {
  $process.Refresh()
  if ($process.HasExited) { break }
  if ($process.MainWindowHandle -ne 0) { $windowAt = $watch.Elapsed.TotalSeconds; break }
  Start-Sleep -Milliseconds 100
}
Say ("window appeared: {0}" -f $(if ($windowAt) { '{0:N2} s' -f $windowAt } else { 'NOT within 120 s — record this' }))

$samples = [System.Collections.Generic.List[object]]::new()
$deadline = (Get-Date).AddSeconds($ObserveSeconds)
while ((Get-Date) -lt $deadline) {
  # Every Wheat process together: Electron is a main process plus a renderer,
  # a GPU process and utility processes, and on Standard a Python recognition
  # pool. Only the total means anything on a 4 GB machine.
  #
  # Matched by *where the executable lives*, never by the name "python": this
  # computer may well be running Python for something that has nothing to do
  # with Wheat, and counting those would blame Wheat for a gigabyte it never
  # allocated. (It did, in the first run of this script.)
  $all = @(Get-Process -Name 'Wheat' -ErrorAction SilentlyContinue)
  $python = @(Get-WheatOcrProcess $installDirectory)
  if ($all.Count) {
    $samples.Add([pscustomobject]@{
      At        = $watch.Elapsed.TotalSeconds
      Processes = $all.Count
      WorkingMB = [math]::Round((($all + $python | Measure-Object WorkingSet64 -Sum).Sum)/1MB, 0)
      PythonProcs = $python.Count
    })
  }
  Start-Sleep -Milliseconds 1000
}

foreach ($mark in @(5, 10, 20, 30)) {
  $sample = $samples | Where-Object { $_.At -ge $mark } | Select-Object -First 1
  if ($sample) { Say ("memory t+{0,-3}s : {1,6:N0} MB across {2} Wheat process(es){3}" -f $mark, $sample.WorkingMB, $sample.Processes, $(if ($sample.PythonProcs) { " + $($sample.PythonProcs) recognition process(es)" } else { '' })) }
}
if ($samples.Count) {
  Say ("peak memory    : {0:N0} MB" -f ($samples | Measure-Object WorkingMB -Maximum).Maximum)
}
$os2 = Get-CimInstance Win32_OperatingSystem
Say ("free memory now: {0:N1} GB" -f ($os2.FreePhysicalMemory*1KB/1GB))

# ------------------------------------------------------------------ shutdown
Section 'Shutting down'
$closed = $false
try { $closed = $process.CloseMainWindow() } catch { }
for ($i = 0; $i -lt 30 -and -not $process.HasExited; $i++) { Start-Sleep -Milliseconds 500; $process.Refresh() }
Say ("closed cleanly : {0}" -f $(if ($process.HasExited) { 'yes' } else { 'NO — still running after 15 s' }))
if (-not $process.HasExited) { try { $process.Kill() } catch { } }
Start-Sleep -Seconds 5
# An orphaned recognition process keeps a gigabyte on a machine that has four.
$orphans = @(Get-Process -Name 'Wheat' -ErrorAction SilentlyContinue) + @(Get-WheatOcrProcess $installDirectory)
Say ("orphan processes after close: {0}" -f $(if ($orphans.Count) { ($orphans | ForEach-Object { '{0} (pid {1})' -f $_.ProcessName, $_.Id }) -join ', ' } else { 'none' }))

# ------------------------------------------------------------ questionnaire
Section 'To fill in by hand'
Say @'
Nothing outside Wheat can measure whether it *felt* usable, so please answer
these in the file, in your own words. "It was fine" is a useful answer.

  seconds until you could actually start work (stopwatch) :
  scrolling a long list of entries                        : smooth / jerky / unusable
  opening a dialog, and typing in it                      :
  switching between screens the first time                :
  resizing the window                                     :
  the screen ever went black, white or torn               : yes / no — where
  importing a scanned document, start to result           :      s
  the computer became unusable for other work             : yes / no
  anything that made you stop and wait                    :
'@

$report | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Host ''
Write-Host ("Saved to {0}" -f $OutputPath)
Write-Host  'Read it, add your answers at the bottom, and send it only if you want to.'
