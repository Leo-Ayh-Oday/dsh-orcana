[CmdletBinding()]
param(
  [string]$Distro = "",
  [string]$Profile = "orcana",
  [switch]$SkipInstall,
  [string]$Task = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Orcana {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $bridgeArgs = @()
  if ($Distro -ne "") {
    $bridgeArgs += @("--wsl-distro", $Distro)
  }
  $bridgeArgs += $Arguments

  Write-Host ""
  Write-Host "==> $Label"
  Write-Host ("dsh-orcana " + (($bridgeArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join " "))

  & dsh-orcana @bridgeArgs
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

if ($env:OS -ne "Windows_NT") {
  throw "scripts/smoke-wsl.ps1 is a Windows-host acceptance smoke; run it from Windows PowerShell / pwsh."
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  throw "wsl.exe was not found. Install/enable WSL before running this smoke."
}

if (-not (Get-Command dsh-orcana -ErrorAction SilentlyContinue)) {
  throw "dsh-orcana was not found. Install the Windows launcher first: npm install -g @leooday/dsh-orcana-linux@^0.4.0"
}

Write-Host "dsh-orcana Windows -> WSL acceptance smoke"
Write-Host "workspace: $((Get-Location).Path)"
Write-Host "profile:   $Profile"
Write-Host "web:       $Profile-web"
if ($Distro -ne "") {
  Write-Host "distro:    $Distro"
} else {
  Write-Host "distro:    <bridge auto-selection>"
}

Invoke-Orcana -Label "WSL environment/profile doctor" -Arguments @(
  "--wsl-profile", $Profile,
  "--wsl-doctor"
)

if (-not $SkipInstall) {
  # One product install prepares both exact companion profiles:
  #   <profile>     = DSH headless + Orcana
  #   <profile>-web = DSH web-app + Orcana
  Invoke-Orcana -Label "Pinned Orcana headless + Web profile installation" -Arguments @(
    "--wsl-profile", $Profile,
    "--wsl-install"
  )

  # Re-run doctor after installation. The second pass verifies exact manifests,
  # real ESM imports/peer fallback, WSL Web localhost relay, proxy reachability,
  # and workspace/Git execution readiness without making a model request.
  Invoke-Orcana -Label "Post-install product verification" -Arguments @(
    "--wsl-profile", $Profile,
    "--wsl-doctor"
  )
}

Invoke-Orcana -Label "Headless Orcana profile composition" -Arguments @(
  "--profile", $Profile,
  "--dump-config"
)

# Proves the product alias itself: `web` must be rewritten to <profile>-web and
# must pass the strict Orcana profile gate. --dump-config does not open a server,
# browser, or model session.
Invoke-Orcana -Label "Orcana Web alias composition" -Arguments @(
  "--wsl-profile", $Profile,
  "web",
  "--dump-config"
)

if ($Task -ne "") {
  Write-Host ""
  Write-Host "A real Agent task was requested. This may use your configured model/provider and incur API cost."
  Invoke-Orcana -Label "Real Agent task" -Arguments @(
    "--wsl-profile", $Profile,
    $Task
  )
} else {
  Write-Host ""
  Write-Host "No -Task supplied; model/API execution intentionally skipped."
}

Write-Host ""
Write-Host "PASS: Windows -> WSL dsh-orcana acceptance smoke completed."
