param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$CurrentExecutable,
  [Parameter(Mandatory = $true)][string]$StatePath,
  [Parameter(Mandatory = $true)][string]$RollbackDirectory,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [Parameter(Mandatory = $true)][string]$ReadyPath
)

$ErrorActionPreference = "Stop"

function Write-UpdaterLog {
  param([string]$EventName, [string]$Message = "")
  # Logging must never be the reason a refusal goes unrecorded, so a failure to
  # write is swallowed rather than allowed to abort the reporting path.
  try {
    $entry = [ordered]@{
      timestamp = [DateTime]::UtcNow.ToString("o")
      event = $EventName
    }
    if ($Message) { $entry.message = $Message }
    $directory = Split-Path -Parent $LogPath
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    Add-Content -LiteralPath $LogPath -Value (($entry | ConvertTo-Json -Compress)) -Encoding UTF8
  } catch { }
}

function Set-UpdaterState {
  param([string]$Phase, [string]$Message, [string]$Failure = "")
  try {
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return }
    $state = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
    $state.status | Add-Member -NotePropertyName phase -NotePropertyValue $Phase -Force
    $state.status | Add-Member -NotePropertyName message -NotePropertyValue $Message -Force
    if ($Failure) {
      $state.status | Add-Member -NotePropertyName error -NotePropertyValue $Failure -Force
    } else {
      $state.status.PSObject.Properties.Remove("error")
    }
    $temporary = "$StatePath.$([Guid]::NewGuid().ToString('N')).tmp"
    $json = ($state | ConvertTo-Json -Depth 20) + [Environment]::NewLine
    [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -Force -LiteralPath $temporary -Destination $StatePath
  } catch { }
}

# A refusal happens before anything has been modified, so there is nothing to
# roll back — but it must still be visible in the log and in the app.
function Stop-WithRefusal {
  param([string]$Reason)
  Write-UpdaterLog "installation-refused" $Reason
  [Console]::Error.WriteLine($Reason)
  Set-UpdaterState -Phase "error" -Message "Update refused; nothing was changed" -Failure $Reason
  exit 2
}

function Invoke-RobocopyChecked {
  param([string]$Source, [string]$Destination)
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  & robocopy.exe $Source $Destination /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "Program-file copy failed with robocopy exit code $LASTEXITCODE." }
}

# Identity of the executable we are replacing, used to prove afterwards that the
# installer actually wrote to this directory rather than somewhere else.
function Get-ExecutableFingerprint {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $item = Get-Item -LiteralPath $Path
  return [ordered]@{
    productVersion = [string]$item.VersionInfo.ProductVersion
    fileVersion = [string]$item.VersionInfo.FileVersion
    lastWriteUtc = $item.LastWriteTimeUtc.ToString("o")
    length = $item.Length
  }
}

function Test-FingerprintChanged {
  param($Before, $After)
  if ($null -eq $Before -or $null -eq $After) { return $true }
  foreach ($key in @("productVersion", "fileVersion", "lastWriteUtc", "length")) {
    if ($Before[$key] -ne $After[$key]) { return $true }
  }
  return $false
}

$installer = [IO.Path]::GetFullPath($InstallerPath)
$executable = [IO.Path]::GetFullPath($CurrentExecutable)
$installDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $executable))
$rollback = [IO.Path]::GetFullPath($RollbackDirectory)
$stateDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $StatePath))

Write-UpdaterLog "helper-started" "pid=$PID parent=$ParentPid target=$installDirectory"

# Every guard below now reports before exiting. Previously these threw above the
# first log call with stdio ignored, so a refusal produced no record anywhere.
if ([IO.Path]::GetFileName($executable) -ne "Wheat.exe") { Stop-WithRefusal "Unexpected Wheat executable name: $([IO.Path]::GetFileName($executable))." }
if ($installDirectory -eq [IO.Path]::GetPathRoot($installDirectory)) { Stop-WithRefusal "Refusing to update a drive root: $installDirectory." }
if (-not $rollback.StartsWith($stateDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { Stop-WithRefusal "Rollback directory escapes updater state: $rollback." }
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { Stop-WithRefusal "Staged installer is missing: $installer." }

# The NSIS installer only ever writes to a directory it previously installed
# into, which is the directory holding its own uninstaller. Without one, this is
# not an installed Wheat (an unpacked build, or a copied folder), the installer
# would write to its default location instead, and relaunching this executable
# afterwards would silently reopen the old version.
$uninstaller = Join-Path $installDirectory ("Uninstall " + [IO.Path]::GetFileNameWithoutExtension($executable) + ".exe")
if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
  Stop-WithRefusal "The running Wheat in $installDirectory was not put there by the installer (no uninstaller found), so the installer cannot replace it. Reinstall Wheat from the downloaded installer instead."
}

# All initialization and guards must succeed before Electron may close.
# A readiness failure must not restore an older rollback or relaunch Wheat.
try {
  $readyTemporary = "$ReadyPath.tmp"
  [IO.File]::WriteAllText($readyTemporary, [string]$PID)
  Move-Item -LiteralPath $readyTemporary -Destination $ReadyPath
  Write-UpdaterLog "helper-ready" "pid=$PID"
} catch {
  Stop-WithRefusal "Could not acknowledge helper readiness: $($_.Exception.Message)"
}

try {
  try { Wait-Process -Id $ParentPid -ErrorAction Stop } catch { }

  $before = Get-ExecutableFingerprint $executable
  Write-UpdaterLog "pre-install-version" "productVersion=$($before.productVersion) lastWriteUtc=$($before.lastWriteUtc)"

  if (Test-Path -LiteralPath $rollback) { Remove-Item -Recurse -Force -LiteralPath $rollback }
  Invoke-RobocopyChecked -Source $installDirectory -Destination $rollback
  Write-UpdaterLog "rollback-snapshot-created"
  $rollbackRoot = Split-Path -Parent $rollback
  Get-ChildItem -LiteralPath $rollbackRoot -Directory | Where-Object { $_.FullName -ne $rollback } | ForEach-Object {
    Remove-Item -Recurse -Force -LiteralPath $_.FullName
  }

  Set-UpdaterState -Phase "awaiting-confirmation" -Message "Installer running; waiting for Wheat startup confirmation"
  $installerProcess = Start-Process -FilePath $installer -ArgumentList @("/S", "--updated") -Wait -PassThru -WindowStyle Hidden
  if ($installerProcess.ExitCode -ne 0) { throw "NSIS installer exited with code $($installerProcess.ExitCode)." }

  Write-UpdaterLog "installer-completed"

  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "The updated Wheat executable was not found after installation." }

  # An installer can exit 0 having written to a different directory. Relaunching
  # blindly is what made a failed update look like a successful one that came
  # back on the old version, so the change is proven before we relaunch.
  $after = Get-ExecutableFingerprint $executable
  Write-UpdaterLog "post-install-version" "productVersion=$($after.productVersion) lastWriteUtc=$($after.lastWriteUtc)"
  if (-not (Test-FingerprintChanged -Before $before -After $after)) {
    throw "The installer reported success but $executable is unchanged (still $($after.productVersion)); the update was written elsewhere."
  }

  Write-UpdaterLog "installation-verified" "productVersion=$($after.productVersion)"
  Start-Process -FilePath $executable -ArgumentList @("--updated") -WindowStyle Hidden
} catch {
  $failure = $_.Exception.Message
  Write-UpdaterLog "installation-failed" $failure
  try {
    if (Test-Path -LiteralPath $rollback -PathType Container) {
      Invoke-RobocopyChecked -Source $rollback -Destination $installDirectory
      Write-UpdaterLog "rollback-restored"
    }
  } catch {
    $failure = "$failure Rollback also failed: $($_.Exception.Message)"
    Write-UpdaterLog "rollback-failed" $_.Exception.Message
  }
  Set-UpdaterState -Phase "error" -Message "Update failed; the previous version was recovered where possible" -Failure $failure
  if (Test-Path -LiteralPath $executable -PathType Leaf) {
    Start-Process -FilePath $executable -ArgumentList @("--update-recovered") -WindowStyle Hidden
  }
  exit 1
}
