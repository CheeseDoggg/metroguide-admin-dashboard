<#
Deploy script for Firebase project.
Usage examples (run in PowerShell):
  ./deploy.ps1                 # deploy all (functions + database rules)
  ./deploy.ps1 -Target functions
  ./deploy.ps1 -Target database
  ./deploy.ps1 -Target rules   # alias of database rules only
  ./deploy.ps1 -Target functions -Emulators  # (only starts emulators instead of deploy)
#>
[CmdletBinding()]
param(
    [ValidateSet('all','functions','database','rules','hosting')]
    [string]$Target = 'all',
    [switch]$Emulators
)

function Write-Info($msg){ Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Warn($msg){ Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg){ Write-Host "[ERR ] $msg" -ForegroundColor Red }

# Move to script root (expected firebase.json here)
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptRoot

if (-not (Test-Path firebase.json)) {
    Write-Err "firebase.json not found in $ScriptRoot. Run this script from the project root."; exit 1
}

# Determine command
$cmd = $null
if ($Emulators) {
    Write-Info "Starting Firebase emulators for: $Target"
    switch ($Target) {
        'all'       { $cmd = 'firebase emulators:start' }
        'functions' { $cmd = 'firebase emulators:start --only functions' }
        'database'  { $cmd = 'firebase emulators:start --only database' }
        'rules'     { $cmd = 'firebase emulators:start --only database' }
        'hosting'   { $cmd = 'firebase emulators:start --only hosting' }
    }
} else {
    Write-Info "Preparing deploy for target: $Target"
    switch ($Target) {
        'all'       { $cmd = 'firebase deploy' }
        'functions' { $cmd = 'firebase deploy --only "functions"' }
        'database'  { $cmd = 'firebase deploy --only "database"' }
        'rules'     { $cmd = 'firebase deploy --only "database"' }
        'hosting'   { $cmd = 'firebase deploy --only "hosting"' }
    }
}

# Basic pre-flight checks
try { $fv = (firebase --version) 2>$null } catch { Write-Warn 'firebase CLI not found in PATH. Install via: npm install -g firebase-tools'; exit 1 }
Write-Info "Firebase CLI version: $fv"

# Show a quick diff summary for functions if git present
if (Test-Path .git) {
    try {
        $pending = git --no-pager diff --name-only functions 2>$null
        if ($pending) { Write-Info "Uncommitted changes in functions directory:`n$pending" }
    } catch { }
}

Write-Info "Executing: $cmd"
$err = $null
try {
    iex $cmd
} catch {
    $err = $_
}
if ($err) {
    Write-Err "Deployment/emulator command failed: $($err.Exception.Message)"
    exit 1
} else {
    Write-Host "=== Completed successfully ===" -ForegroundColor Green
}
