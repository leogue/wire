# Installs wire on Windows, or updates it:
#   powershell -c "irm https://raw.githubusercontent.com/leogue/wire/main/install.ps1 | iex"
#
# WIRE_REPO  the git repository to install from
# WIRE_HOME  where wire lives (default %USERPROFILE%\.wire)
$ErrorActionPreference = 'Stop'

$Repo = if ($env:WIRE_REPO) { $env:WIRE_REPO } else { 'https://github.com/leogue/wire.git' }
$HomeDir = if ($env:WIRE_HOME) { $env:WIRE_HOME } else { Join-Path $env:USERPROFILE '.wire' }
$BinDir = Join-Path $HomeDir 'bin'

# Run through `irm | iex`, `exit` would close the user's PowerShell window: stop with an error instead.
function Fail($Message) { throw "wire: $Message" }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail 'Git for Windows is required (the agent also uses its Git Bash): https://git-scm.com/download/win'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js 24 or later is required: https://nodejs.org' }
$NodeMajor = [int](node -p 'parseInt(process.versions.node)')
if ($NodeMajor -lt 24) { Fail "Node.js 24 or later is required (found $(node -v)): https://nodejs.org" }

if (Test-Path (Join-Path $HomeDir '.git')) {
  Write-Host "Updating wire in $HomeDir"
  git -C $HomeDir pull --ff-only --quiet
} else {
  if (Test-Path $HomeDir) { Fail "$HomeDir exists and is not a wire installation: set WIRE_HOME" }
  Write-Host "Installing wire in $HomeDir"
  git clone --quiet --depth 1 $Repo $HomeDir
}
if ($LASTEXITCODE -ne 0) { Fail 'git failed' }

Push-Location $HomeDir
try {
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed' }
} finally {
  Pop-Location
}

# Windows runs `wire` through a small .cmd that starts Node on wire's entry point.
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Main = Join-Path $HomeDir 'packages\agent\src\main.ts'
Set-Content -Path (Join-Path $BinDir 'wire.cmd') -Encoding ASCII -Value "@echo off`r`nnode `"$Main`" %*"
Write-Host "Installed: $BinDir\wire.cmd"

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($UserPath -split ';') -contains $BinDir)) {
  [Environment]::SetEnvironmentVariable('Path', ($(if ($UserPath) { "$UserPath;" } else { '' }) + $BinDir), 'User')
  Write-Host "Added $BinDir to your PATH: open a new terminal to use wire."
}

# Not needed to install, but by the agent: say what is missing.
$KiCad = Join-Path $env:ProgramFiles 'KiCad\10.0\bin\kicad-cli.exe'
if (-not (Get-Command kicad-cli -ErrorAction SilentlyContinue) -and -not (Test-Path $KiCad)) {
  Write-Host "`nStill needed: KiCad 10 (rendering, export, symbols): https://www.kicad.org/download/"
}
if (-not (Get-Command pdftoppm -ErrorAction SilentlyContinue)) {
  Write-Host "`nStill needed: poppler (datasheets, PNG pages): winget install oschwartz10612.Poppler, or scoop install poppler"
}

Write-Host "`nStart a design:  mkdir my-board; cd my-board; wire"
Write-Host "Web search: put EXA_API_KEY=... in $HomeDir\.env"
