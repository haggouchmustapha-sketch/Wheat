param(
  [string]$PythonVersion = "3.12",
  [switch]$SkipModelWarmup
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$PaddleRoot = Join-Path $RepositoryRoot "resources\paddleocr"
$RuntimeRoot = Join-Path $PaddleRoot "runtime"
$RuntimePython = Join-Path $RuntimeRoot "python.exe"
$Requirements = Join-Path $PaddleRoot "requirements.txt"
$Worker = Join-Path $PaddleRoot "worker.py"
$ModelRoot = Join-Path $PaddleRoot "models"

if (-not (Test-Path -LiteralPath $Requirements) -or -not (Test-Path -LiteralPath $Worker)) {
  throw "Wheat PaddleOCR resources are incomplete."
}

$Launcher = Get-Command py -ErrorAction SilentlyContinue
if (-not $Launcher) {
  throw "Python Launcher is required. Install Python $PythonVersion (64-bit), then retry."
}

if (-not (Test-Path -LiteralPath $RuntimePython)) {
  $PythonInfoJson = & $Launcher.Source "-$PythonVersion" -c "import json,sys; print(json.dumps({'base':sys.base_prefix,'version':f'{sys.version_info.major}{sys.version_info.minor}'}))"
  if ($LASTEXITCODE -ne 0) { throw "Could not locate Python $PythonVersion." }
  $PythonInfo = $PythonInfoJson | ConvertFrom-Json
  $BasePython = [System.IO.Path]::GetFullPath([string]$PythonInfo.base)
  $BaseLib = Join-Path $BasePython "Lib"
  $BaseDlls = Join-Path $BasePython "DLLs"
  if (-not (Test-Path -LiteralPath (Join-Path $BasePython "python.exe")) -or -not (Test-Path -LiteralPath $BaseLib)) {
    throw "The selected Python installation cannot be copied into a portable Wheat runtime."
  }
  New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $RuntimeRoot "Lib") -Force | Out-Null
  foreach ($FileName in @("python.exe", "pythonw.exe", "python$($PythonInfo.version).dll", "python3.dll", "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt")) {
    $SourceFile = Join-Path $BasePython $FileName
    if (Test-Path -LiteralPath $SourceFile) { Copy-Item -LiteralPath $SourceFile -Destination $RuntimeRoot -Force }
  }
  if (Test-Path -LiteralPath $BaseDlls) {
    Copy-Item -LiteralPath $BaseDlls -Destination $RuntimeRoot -Recurse -Force
  }
  Get-ChildItem -LiteralPath $BaseLib -Force | Where-Object { $_.Name -ne "site-packages" } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $RuntimeRoot "Lib") -Recurse -Force
  }
  & $RuntimePython -m ensurepip --upgrade
  if ($LASTEXITCODE -ne 0) { throw "Could not initialize pip in the portable PaddleOCR runtime." }
}

& $RuntimePython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "Could not update pip in the PaddleOCR runtime." }
& $RuntimePython -m pip install --requirement $Requirements
if ($LASTEXITCODE -ne 0) { throw "Could not install the pinned PaddleOCR dependencies." }

if (-not $SkipModelWarmup) {
  New-Item -ItemType Directory -Path $ModelRoot -Force | Out-Null
  $env:PADDLE_PDX_CACHE_HOME = $ModelRoot
  & $RuntimePython $Worker --warmup
  if ($LASTEXITCODE -ne 0) { throw "PaddleOCR installed, but its models could not be prepared." }
}

$env:PADDLE_PDX_CACHE_HOME = $ModelRoot
& $RuntimePython $Worker --health
if ($LASTEXITCODE -ne 0) { throw "PaddleOCR health check failed." }
Write-Host "Wheat PaddleOCR runtime is ready at $RuntimeRoot"
