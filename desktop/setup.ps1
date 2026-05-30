# ClaudeRank Desktop - Windows Setup
# Run in PowerShell: .\setup.ps1

$ErrorActionPreference = "Stop"

Write-Host "`nClaudeRank Desktop Setup (Windows)`n" -ForegroundColor Blue

$missing = @()

function Test-WebView2Runtime {
    $clientGuid = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    $registryKeys = @(
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientGuid",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$clientGuid",
        "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientGuid"
    )

    foreach ($key in $registryKeys) {
        if (Test-Path $key) {
            $version = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).pv
            if ($version) {
                return $version
            }
        }
    }

    $installDirs = @(
        "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application",
        "$env:ProgramFiles\Microsoft\EdgeWebView\Application"
    )

    foreach ($dir in $installDirs) {
        if (Test-Path $dir) {
            $versionDir = Get-ChildItem -Path $dir -Directory -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($versionDir) {
                return $versionDir.Name
            }
        }
    }

    return $false
}

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

# Check Microsoft Edge WebView2 Runtime (required by Tauri on Windows)
$webView2Version = Test-WebView2Runtime
if ($webView2Version) {
    Write-Host "  [OK] Microsoft Edge WebView2 Runtime $webView2Version" -ForegroundColor Green
} else {
    Write-Host "  [X] Microsoft Edge WebView2 Runtime not installed" -ForegroundColor Red
    $missing += "webview2"
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
        "webview2" {
            $response = Read-Host "  Install Microsoft Edge WebView2 Runtime? [y/N]"
            if ($response -eq "y" -or $response -eq "Y") {
                if (Get-Command winget -ErrorAction SilentlyContinue) {
                    Write-Host "  Installing WebView2 Runtime..." -ForegroundColor Blue
                    winget install --id Microsoft.EdgeWebView2Runtime -e --accept-source-agreements --accept-package-agreements
                } else {
                    Write-Host "  Opening WebView2 download page..." -ForegroundColor Blue
                    Start-Process "https://developer.microsoft.com/en-us/microsoft-edge/webview2/"
                    Write-Host "  Download and install the Evergreen Runtime, then run .\setup.ps1 again." -ForegroundColor Yellow
                }
            }
        }
    }
}

Write-Host "`nRun .\setup.ps1 again to verify." -ForegroundColor Blue
