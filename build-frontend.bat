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

echo Downloading frontend libraries...
if not exist "static\js" mkdir "static\js"
if not exist "static\css" mkdir "static\css"

curl -sSL https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js -o static/js/alpine.min.js
curl -sSL https://cdn.jsdelivr.net/npm/@alpinejs/collapse@3.x.x/dist/cdn.min.js -o static/js/alpine-collapse.min.js
curl -sSL https://cdn.plyr.io/3.7.8/plyr.css -o static/css/plyr.css
curl -sSL https://cdn.plyr.io/3.7.8/plyr.polyfilled.js -o static/js/plyr.polyfilled.js
curl -sSL https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css -o static/css/fontawesome.min.css

echo Building Prism.js locally...
curl -sSL https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css -o static/css/prism.css
curl -sSL https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js -o static/js/prism.js
for %%l in (json javascript python go bash yaml sql) do (
  echo Adding Prism language: %%l
  echo. >> static/js/prism.js
  curl -sSL https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-%%l.min.js >> static/js/prism.js
)

echo Minifying JS, CSS, locales, and themes...
call node build.js
if errorlevel 1 (
    echo Build failed. See errors above.
    exit /b 1
)

echo Frontend build complete!
