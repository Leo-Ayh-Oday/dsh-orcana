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
  Invoke-Orcana -Label "Pinned Orcana profile installation" -Arguments @(
    "--wsl-profile", $Profile,
    "--wsl-install"
  )

  # Re-run doctor after installation. The second pass verifies the exact
  # profile manifest plus real ESM imports from the WSL profile anchor, so a
  # broken Cordis/DSH peer fallback is caught before the first Agent task.
  Invoke-Orcana -Label "Post-install profile/module verification" -Arguments @(
    "--wsl-profile", $Profile,
    "--wsl-doctor"
  )
}

Invoke-Orcana -Label "DSH profile composition" -Arguments @(
  "--profile", $Profile,
  "--dump-config"
)

if ($Task -ne "") {
  Write-Host ""
  Write-Host "A real Agent task was requested. This may use your configured model/provider and incur API cost."
  Invoke-Orcana -Label "Real Agent task" -Arguments @(
    "--profile", $Profile,
    $Task
  )
} else {
  Write-Host ""
  Write-Host "No -Task supplied; model/API execution intentionally skipped."
}

Write-Host ""
Write-Host "PASS: Windows -> WSL dsh-orcana acceptance smoke completed."
