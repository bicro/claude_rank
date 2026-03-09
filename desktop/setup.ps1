# Oto Desktop - Windows Setup
# Run in PowerShell: .\setup.ps1

$ErrorActionPreference = "Stop"

Write-Host "`nOto Desktop Setup (Windows)`n" -ForegroundColor Blue

$missing = @()

# Check Rust
if (Get-Command rustc -ErrorAction SilentlyContinue) {
    $rustVersion = (rustc --version) -replace "rustc ", ""
    Write-Host "  [OK] Rust $rustVersion" -ForegroundColor Green
} else {
    Write-Host "  [X] Rust not installed" -ForegroundColor Red
    $missing += "rust"
}

# Check Bun
if (Get-Command bun -ErrorAction SilentlyContinue) {
    $bunVersion = bun --version
    Write-Host "  [OK] Bun $bunVersion" -ForegroundColor Green
} else {
    Write-Host "  [X] Bun not installed" -ForegroundColor Red
    $missing += "bun"
}

# Check VS Build Tools (look for cl.exe or vswhere)
$vswherePath = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasVS = $false
if (Test-Path $vswherePath) {
    $vsPath = & $vswherePath -latest -property installationPath 2>$null
    if ($vsPath) {
        $hasVS = $true
        Write-Host "  [OK] Visual Studio Build Tools" -ForegroundColor Green
    }
}
if (-not $hasVS) {
    Write-Host "  [X] Visual Studio Build Tools not installed" -ForegroundColor Red
    $missing += "vstools"
}

Write-Host ""

if ($missing.Count -eq 0) {
    Write-Host "All dependencies installed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Running bun install..." -ForegroundColor Blue
    bun install
    Write-Host "`nReady! Run: " -NoNewline
    Write-Host "bun run dev" -ForegroundColor Blue
    exit 0
}

Write-Host "Missing: $($missing -join ', ')" -ForegroundColor Yellow
Write-Host ""

# Install missing dependencies
foreach ($dep in $missing) {
    switch ($dep) {
        "rust" {
            $response = Read-Host "  Install Rust? [y/N]"
            if ($response -eq "y" -or $response -eq "Y") {
                Write-Host "  Downloading rustup..." -ForegroundColor Blue
                Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile "$env:TEMP\rustup-init.exe"
                Start-Process -FilePath "$env:TEMP\rustup-init.exe" -ArgumentList "-y" -Wait
                Remove-Item "$env:TEMP\rustup-init.exe"
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
            }
        }
        "bun" {
            $response = Read-Host "  Install Bun? [y/N]"
            if ($response -eq "y" -or $response -eq "Y") {
                Write-Host "  Installing Bun..." -ForegroundColor Blue
                irm bun.sh/install.ps1 | iex
            }
        }
        "vstools" {
            $response = Read-Host "  Install Visual Studio Build Tools? [y/N]"
            if ($response -eq "y" -or $response -eq "Y") {
                Write-Host "  Installing VS Build Tools (this may take a while)..." -ForegroundColor Blue
                winget install Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
                Write-Host "  Note: You may need to restart your PC after VS Build Tools install." -ForegroundColor Yellow
            }
        }
    }
}

Write-Host "`nRun .\setup.ps1 again to verify." -ForegroundColor Blue
