# Build script for beta testers
# Reads beta_testers.csv, builds Windows MSI for each user with their unique API key

$ErrorActionPreference = "Continue"

# Path configuration - calculate paths relative to script location
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

$csvPath = "$ProjectRoot\beta_testers.csv"
$outputDir = "$ProjectRoot\beta_builds"
$msiSourceDir = "$ProjectRoot\src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi"

# Results tracking
$successful = @()
$failed = @()

# Create output directory
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Beta Testers Build Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Read and parse CSV
if (-not (Test-Path $csvPath)) {
    Write-Host "ERROR: $csvPath not found!" -ForegroundColor Red
    exit 1
}

$testers = Import-Csv -Path $csvPath
$totalTesters = $testers.Count

Write-Host "Found $totalTesters beta testers to build for" -ForegroundColor Yellow
Write-Host ""

$currentIndex = 0

foreach ($tester in $testers) {
    $currentIndex++
    $username = $tester.DISCORD_USERNAME
    $apiKey = $tester.'API KEY'

    Write-Host "----------------------------------------" -ForegroundColor Gray
    Write-Host "[$currentIndex/$totalTesters] Building for: $username" -ForegroundColor Cyan
    Write-Host "----------------------------------------" -ForegroundColor Gray

    # Set the API key environment variable
    $env:OPENROUTER_API_KEY = $apiKey

    # Run the build from project root
    Write-Host "Running build..." -ForegroundColor Yellow
    Push-Location $ProjectRoot
    $buildResult = bun run build:windows 2>&1
    $buildExitCode = $LASTEXITCODE
    Pop-Location

    if ($buildExitCode -ne 0) {
        Write-Host "BUILD FAILED for $username" -ForegroundColor Red
        Write-Host $buildResult -ForegroundColor Red
        $failed += $username
        continue
    }

    # Find the MSI file
    $msiFiles = Get-ChildItem -Path $msiSourceDir -Filter "*.msi" -ErrorAction SilentlyContinue

    if ($null -eq $msiFiles -or $msiFiles.Count -eq 0) {
        Write-Host "ERROR: No MSI file found for $username" -ForegroundColor Red
        $failed += $username
        continue
    }

    # Create user's output directory
    $userDir = Join-Path $outputDir $username
    if (-not (Test-Path $userDir)) {
        New-Item -ItemType Directory -Path $userDir | Out-Null
    }

    # Copy MSI to user's folder
    foreach ($msi in $msiFiles) {
        Copy-Item -Path $msi.FullName -Destination $userDir -Force
        Write-Host "Copied $($msi.Name) to $userDir" -ForegroundColor Green
    }

    $successful += $username
    Write-Host "SUCCESS: Build complete for $username" -ForegroundColor Green
}

# Clear the environment variable
Remove-Item Env:\OPENROUTER_API_KEY -ErrorAction SilentlyContinue

# Summary
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Build Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Total testers: $totalTesters" -ForegroundColor White
Write-Host "Successful: $($successful.Count)" -ForegroundColor Green
Write-Host "Failed: $($failed.Count)" -ForegroundColor Red

if ($successful.Count -gt 0) {
    Write-Host ""
    Write-Host "Successful builds:" -ForegroundColor Green
    foreach ($user in $successful) {
        Write-Host "  - $user" -ForegroundColor Green
    }
}

if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host "Failed builds:" -ForegroundColor Red
    foreach ($user in $failed) {
        Write-Host "  - $user" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Build outputs are in: $outputDir" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan
