@echo off
setlocal enabledelayedexpansion

set "TELECLOUD_PULL_LATEST=%1"

echo Building frontend assets for Telecloud...
echo This may take a few moments. Please wait...
echo Cleaning up old build files...
del /q static\css\*.min.css 2>nul
del /q static\js\*.min.js 2>nul
del /q static\locales\*.min.json 2>nul

if "%TELECLOUD_PULL_LATEST%"=="1" (
    echo Updating repository from origin/main...
    git pull origin main
    if errorlevel 1 (
        echo Failed to pull latest changes. Please resolve any conflicts and try again.
        exit /b 1
    )
) else (
    echo Skipping repository update. Building from the current checkout.
    echo Set TELECLOUD_PULL_LATEST=1 to explicitly pull origin/main before building.
)

if exist "%USERPROFILE%\.bun\bin" (
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
)

where bun >nul 2>&1
if errorlevel 1 (
  echo bun is not installed. Installing bun...
  powershell -c "irm bun.sh/install.ps1 | iex"
  if errorlevel 1 (
    echo Failed to install bun. Please install it manually from https://bun.com/ and try again.
    exit /b 1
  )
  if exist "%USERPROFILE%\.bun\bin" (
      set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
  )
)

echo Installing dependencies...
call bun install

echo Minifying JS, CSS, locales, and themes...
call bun run build.js
if errorlevel 1 (
    echo Build failed. See errors above.
    exit /b 1
)

echo Frontend build complete!
