# Project Flashwave launcher.
#
# Starts the backend and frontend dev servers, waits for them to come up, and opens the app.
# Double-click "Start Flashwave.bat" on the Desktop rather than running this directly -- that
# wrapper sets -ExecutionPolicy Bypass, which is what makes a .ps1 launchable in one click on a
# default Windows install.
#
# Safe to run when things are already running: it detects listening ports and skips those.

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendPort = 3001
$FrontendPort = 5173
$FrontendUrl = "http://localhost:$FrontendPort"

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "  [X]  $msg" -ForegroundColor Red }

function Test-PortListening($port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $conn
}

Write-Host ""
Write-Host "  Project Flashwave" -ForegroundColor White
Write-Host "  ----------------------------------------" -ForegroundColor DarkGray

# --- Node -------------------------------------------------------------------------------------
# Node is frequently not on PATH for GUI-launched processes even when it works in a terminal, so
# add the standard install location before giving up.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $nodeDir = "C:\Program Files\nodejs"
    if (Test-Path $nodeDir) { $env:Path = "$nodeDir;" + $env:Path }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Err "Node.js not found."
    Write-Host ""
    Write-Host "  Install it, then run this again:" -ForegroundColor Gray
    Write-Host "      winget install OpenJS.NodeJS.LTS" -ForegroundColor White
    Write-Host ""
    Read-Host "  Press Enter to close"
    exit 1
}

$nodeVersion = (node --version)
$nodeMajor = [int]($nodeVersion -replace '^v(\d+)\..*$', '$1')
if ($nodeMajor -lt 24) {
    # node:sqlite (used for the whole database layer) is only built in from Node 24.
    Write-Err "Node $nodeVersion found, but this project needs Node 24 or newer."
    Write-Host "      winget install OpenJS.NodeJS.LTS" -ForegroundColor White
    Read-Host "  Press Enter to close"
    exit 1
}
Write-Ok "Node $nodeVersion"

# --- Dependencies -----------------------------------------------------------------------------
foreach ($pkg in @("backend", "frontend")) {
    $dir = Join-Path $ProjectRoot $pkg
    if (-not (Test-Path (Join-Path $dir "node_modules"))) {
        Write-Step "Installing $pkg dependencies (first run only, takes a minute)..."
        Push-Location $dir
        npm install --no-fund --no-audit
        Pop-Location
        if ($LASTEXITCODE -ne 0) {
            Write-Err "npm install failed in $pkg."
            Read-Host "  Press Enter to close"
            exit 1
        }
    }
}
Write-Ok "Dependencies present"

# --- Optional integrations: report, never block -----------------------------------------------
# Both of these are additive. The app runs fine without either, so a missing one is worth a note
# and nothing more.
$ollamaUp = $false
try {
    Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 2 | Out-Null
    $ollamaUp = $true
} catch { $ollamaUp = $false }

if ($ollamaUp) {
    Write-Ok "Ollama running (AI explanations + digests available)"
} else {
    Write-Warn "Ollama not running - AI features will show errors until you start it."
}

$copilotDir = Join-Path $env:USERPROFILE ".runelite\flipping-copilot"
if (Test-Path $copilotDir) {
    $slotFiles = @(Get-ChildItem $copilotDir -Filter "acc_*_?.json" -ErrorAction SilentlyContinue)
    Write-Ok "RuneLite GE data found ($($slotFiles.Count) slot files)"
} else {
    Write-Warn "Flipping Copilot data not found - GE board/Portfolio/Flips will be empty."
    Write-Host "       (Install the plugin from RuneLite's Plugin Hub; see the README.)" -ForegroundColor DarkGray
}

# --- Servers ----------------------------------------------------------------------------------
# Each server gets its own visible window so a crash or stack trace is readable rather than
# swallowed by a background process.
if (Test-PortListening $BackendPort) {
    Write-Ok "Backend already running on port $BackendPort"
} else {
    Write-Step "Starting backend..."
    Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoExit", "-Command",
        "`$host.UI.RawUI.WindowTitle='Flashwave backend'; Set-Location '$ProjectRoot\backend'; npm run dev"
    )
}

if (Test-PortListening $FrontendPort) {
    Write-Ok "Frontend already running on port $FrontendPort"
} else {
    Write-Step "Starting frontend..."
    Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoExit", "-Command",
        "`$host.UI.RawUI.WindowTitle='Flashwave frontend'; Set-Location '$ProjectRoot\frontend'; npm run dev -- --port $FrontendPort"
    )
}

# --- Wait, then open --------------------------------------------------------------------------
# Poll rather than sleeping a fixed amount: a warm start is ready in a couple of seconds, a cold
# one can take fifteen, and opening the browser too early just shows a connection error.
Write-Step "Waiting for servers..."
$ready = $false
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    if ((Test-PortListening $BackendPort) -and (Test-PortListening $FrontendPort)) {
        $ready = $true
        break
    }
}

Write-Host ""
if ($ready) {
    Write-Ok "Backend  http://127.0.0.1:$BackendPort"
    Write-Ok "Frontend $FrontendUrl"
    Start-Process $FrontendUrl
    Write-Host ""
    Write-Host "  Opening $FrontendUrl" -ForegroundColor White
    Write-Host "  Prices need one 60s poll before the Market tab fills up." -ForegroundColor DarkGray
    Write-Host "  To stop: close the two 'Flashwave backend'/'Flashwave frontend' windows." -ForegroundColor DarkGray
} else {
    Write-Err "Servers didn't come up within 45 seconds."
    Write-Host "  Check the two server windows that opened - the error will be in one of them." -ForegroundColor Gray
}

Write-Host ""
Start-Sleep -Seconds 4
