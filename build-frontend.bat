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

echo Ensuring npm is installed...
where npm >nul 2>&1
if errorlevel 1 (
  echo npm is not installed. Please install Node.js and npm from https://nodejs.org/ and try again.
  exit /b 1
)

echo Installing npm dependencies...
call npm install



echo Minifying JS, CSS, locales, and themes...
call node build.js
if errorlevel 1 (
    echo Build failed. See errors above.
    exit /b 1
)

echo Frontend build complete!
