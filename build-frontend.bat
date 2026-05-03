@echo off
echo Building frontend assets for Telecloud...
echo This may take a few moments. Please wait...
echo Cleaning up old build files...
del /q static\css\*.min.css 2>nul
del /q static\js\*.min.js 2>nul
del /q static\locales\*.min.json 2>nul

echo Checking update status of git repository...
git fetch origin main >nul 2>&1
for /f "tokens=1,2 delims= " %%a in ('git rev-list --left-right --count origin/main...HEAD') do (
  set "ahead=%%a"
  set "behind=%%b"
)

if "%ahead%"=="0" if "%behind%"=="0" (
  echo Repository is up to date with origin/main.
) else (
  echo Repository is not up to date with origin/main. Please pull the latest changes and try again.
  exit /b 1
)

echo Ensuring npm is installed...
where npm >nul 2>&1
if errorlevel 1 (
  echo npm is not installed. Please install Node.js and npm from https://nodejs.org/ and try again.
  exit /b 1
)

echo Installing npm dependencies...
call npm install

echo Building Tailwind CSS...
call npx @tailwindcss/cli -i ./static/css/input.css -o ./static/css/tailwind.css --minify

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

echo Minifying JS and CSS files...
call npx -y esbuild static/js/common.js --minify --outfile=static/js/common.min.js
call npx -y esbuild static/js/script.js --minify --outfile=static/js/script.min.js
call npx -y esbuild static/js/prism.js --minify --outfile=static/js/prism.min.js

call npx -y esbuild static/css/style.css --bundle --minify --external:/static/* --outfile=static/css/style.min.css
call npx -y esbuild static/css/nunito.css --minify --outfile=static/css/nunito.min.css
call npx -y esbuild static/css/prism.css --minify --outfile=static/css/prism.min.css
call npx -y esbuild static/css/plyr.css --minify --outfile=static/css/plyr.min.css

echo Minifying JSON locales...
node -e "const fs = require('fs'); const path = require('path'); const localesDir = './static/locales'; fs.readdirSync(localesDir).forEach(file => { if (file.endsWith('.json') && !file.endsWith('.min.json')) { const filePath = path.join(localesDir, file); const minPath = path.join(localesDir, file.replace('.json', '.min.json')); try { const content = JSON.parse(fs.readFileSync(filePath, 'utf8')); fs.writeFileSync(minPath, JSON.stringify(content)); console.log('Minified ' + file + ' -> ' + path.basename(minPath)); } catch (e) { console.error('Error minifying ' + file + ':', e.message); } } });"

echo Frontend build complete!
