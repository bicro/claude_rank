# Pre-commit check script for claude_rank (Windows)
# Verifies code quality before pushing

$ErrorActionPreference = "Stop"

# Colors
function Write-Blue { param($Text) Write-Host $Text -ForegroundColor Blue }
function Write-Green { param($Text) Write-Host $Text -ForegroundColor Green }
function Write-Red { param($Text) Write-Host $Text -ForegroundColor Red }
function Write-Yellow { param($Text) Write-Host $Text -ForegroundColor Yellow }

Write-Blue "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Blue "  Pre-commit Check"
Write-Blue "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host ""

Push-Location src-tauri

# Track overall status
$Failed = $false

# 1. Rust formatting (auto-fix)
Write-Host "[1/4] " -ForegroundColor Blue -NoNewline
Write-Host "Formatting Rust code..."
$fmtOutput = cargo fmt 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  " -NoNewline
    Write-Green "✓ Code formatted"
} else {
    Write-Host "  " -NoNewline
    Write-Red "✗ Formatting failed"
    $Failed = $true
}

# 2. Rust build
Write-Host "[2/4] " -ForegroundColor Blue -NoNewline
Write-Host "Building project..."
$buildOutput = cargo build 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  " -NoNewline
    Write-Green "✓ Build succeeded"
} else {
    Write-Host "  " -NoNewline
    Write-Red "✗ Build failed"
    Write-Host $buildOutput
    $Failed = $true
}

# 3. Rust linting with clippy
Write-Host "[3/4] " -ForegroundColor Blue -NoNewline
Write-Host "Running clippy..."
$clippyOutput = cargo clippy -- -D warnings 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  " -NoNewline
    Write-Green "✓ Clippy passed"
} else {
    Write-Host "  " -NoNewline
    Write-Red "✗ Clippy found errors"
    $Failed = $true
}

Pop-Location

# 4. Sensitive files check
Write-Host "[4/4] " -ForegroundColor Blue -NoNewline
Write-Host "Checking for sensitive files..."
$sensitiveFiles = @(".api_key", ".env", "credentials.json", "secrets.json")
$stagedFiles = git diff --cached --name-only 2>$null

$stagedSensitive = @()
foreach ($file in $sensitiveFiles) {
    if ($stagedFiles -match $file) {
        $stagedSensitive += $file
    }
}

if ($stagedSensitive.Count -gt 0) {
    Write-Host "  " -NoNewline
    Write-Red "✗ Sensitive files staged for commit: $($stagedSensitive -join ', ')"
    $Failed = $true
} else {
    Write-Host "  " -NoNewline
    Write-Green "✓ No sensitive files staged"
}

# Summary
Write-Host ""
Write-Blue "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if (-not $Failed) {
    Write-Green "  All checks passed! Ready to commit."
    Write-Blue "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    exit 0
} else {
    Write-Red "  Some checks failed. Please fix before committing."
    Write-Blue "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    exit 1
}
