#!/bin/bash
set -e

echo "Building frontend assets for Telecloud..."
echo "This may take a few moments. Please wait..."

echo "Cleaning up old build files..."
rm -f static/css/*.min.css
rm -f static/js/*.min.js
rm -f static/locales/*.min.json

echo "Checking update status of git repository..."
git fetch origin main > /dev/null 2>&1
ahead=$(git rev-list --left-right --count origin/main...HEAD | awk '{print $1}')
behind=$(git rev-list --left-right --count origin/main...HEAD | awk '{print $2}')

if [ "$ahead" = "0" ] && [ "$behind" = "0" ]; then
  echo "Repository is up to date with origin/main."
else
  echo "Repository is not up to date with origin/main. Please pull the latest changes and try again."
  exit 1
fi

echo "Ensuring npm is installed..."
if ! command -v npm > /dev/null 2>&1; then
  echo "npm is not installed. Please install Node.js and npm from https://nodejs.org/ and try again."
  exit 1
fi

echo "Installing npm dependencies..."
npm install

echo "Building Tailwind CSS..."
npx @tailwindcss/cli -i ./static/css/input.css -o ./static/css/tailwind.css --minify

echo "Downloading frontend libraries..."
mkdir -p static/js static/css

download_lib() {
    local url=$1
    local out=$2
    echo "Downloading $out..."
    curl -sSL "$url" -o "$out"
}

download_lib "https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js" "static/js/alpine.min.js"
download_lib "https://cdn.jsdelivr.net/npm/@alpinejs/collapse@3.x.x/dist/cdn.min.js" "static/js/alpine-collapse.min.js"
download_lib "https://cdn.plyr.io/3.7.8/plyr.css" "static/css/plyr.css"
download_lib "https://cdn.plyr.io/3.7.8/plyr.polyfilled.js" "static/js/plyr.polyfilled.js"
download_lib "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" "static/css/fontawesome.min.css"

echo "Building Prism.js locally..."
download_lib "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" "static/css/prism.css"
download_lib "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js" "static/js/prism.js"
for lang in json javascript python go bash yaml sql; do
  echo "Adding Prism language: $lang"
  echo "" >> static/js/prism.js
  curl -sSL "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-$lang.min.js" >> static/js/prism.js
done

echo "Minifying JS and CSS files..."
npx -y esbuild static/js/common.js --minify --outfile=static/js/common.min.js
npx -y esbuild static/js/script.js --minify --outfile=static/js/script.min.js
npx -y esbuild static/js/prism.js --minify --outfile=static/js/prism.min.js

npx -y esbuild static/css/style.css --bundle --minify --external:/static/* --outfile=static/css/style.min.css
npx -y esbuild static/css/nunito.css --minify --outfile=static/css/nunito.min.css
npx -y esbuild static/css/prism.css --minify --outfile=static/css/prism.min.css
npx -y esbuild static/css/plyr.css --minify --outfile=static/css/plyr.min.css

echo "Minifying JSON locales..."
node -e "const fs = require('fs'); const path = require('path'); const localesDir = './static/locales'; fs.readdirSync(localesDir).forEach(file => { if (file.endsWith('.json') && !file.endsWith('.min.json')) { const filePath = path.join(localesDir, file); const minPath = path.join(localesDir, file.replace('.json', '.min.json')); try { const content = JSON.parse(fs.readFileSync(filePath, 'utf8')); fs.writeFileSync(minPath, JSON.stringify(content)); console.log('Minified ' + file + ' -> ' + path.basename(minPath)); } catch (e) { console.error('Error minifying ' + file + ':', e.message); } } });"

echo "Frontend build complete!"
