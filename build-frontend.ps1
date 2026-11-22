param(
    [string]$TELECLOUD_PULL_LATEST = ""
)

$ErrorActionPreference = 'Stop'

Write-Host "Building frontend assets for Telecloud..."
Write-Host "This may take a few moments. Please wait..."
Write-Host "Cleaning up old build files..."
Remove-Item -Force -ErrorAction SilentlyContinue static\css\*.min.css
Remove-Item -Force -ErrorAction SilentlyContinue static\js\*.min.js
Remove-Item -Force -ErrorAction SilentlyContinue static\locales\*.min.json

if ($TELECLOUD_PULL_LATEST -eq "1") {
    Write-Host "Updating repository from origin/main..."
    git pull origin main
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to pull latest changes. Please resolve any conflicts and try again."
        exit 1
    }
} else {
    Write-Host "Skipping repository update. Building from the current checkout."
    Write-Host "Pass '1' as first argument to explicitly pull origin/main before building."
}

Write-Host "Ensuring bun is installed..."
$BunPath = "$env:USERPROFILE\.bun\bin"
if (Test-Path $BunPath) {
    if ($env:PATH -notlike "*$BunPath*") {
        $env:PATH = "$BunPath;$env:PATH"
    }
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "bun is not installed. Installing bun..."
    try {
        irm bun.sh/install.ps1 | iex
        if (Test-Path $BunPath) {
            if ($env:PATH -notlike "*$BunPath*") {
                $env:PATH = "$BunPath;$env:PATH"
            }
        }
    } catch {
        Write-Error "Failed to install bun. Please install it manually from https://bun.com/ and try again."
        exit 1
    }
}

Write-Host "Installing dependencies..."
bun install
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "Minifying JS, CSS, locales, and themes..."
bun run build.js
if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed. See errors above."
    exit 1
}

Write-Host "Frontend build complete!"
