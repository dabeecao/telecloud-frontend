#!/bin/bash
set -e

echo "Building frontend assets for Telecloud..."
echo "This may take a few moments. Please wait..."
echo "Cleaning up old build files..."
rm -f static/css/*.min.css static/js/*.min.js static/locales/*.min.json

TELECLOUD_PULL_LATEST="${1}"

if [ "$TELECLOUD_PULL_LATEST" = "1" ]; then
  echo "Updating repository from origin/main..."
  git pull origin main || { echo "Failed to pull latest changes. Please resolve any conflicts and try again."; exit 1; }
else
  echo "Skipping repository update. Building from the current checkout."
  echo "Pass '1' as first argument to explicitly pull origin/main before building."
fi

echo "Ensuring npm is installed..."
if ! command -v npm > /dev/null 2>&1; then
  echo "npm is not installed. Please install Node.js and npm from https://nodejs.org/ and try again."
  exit 1
fi

echo "Installing npm dependencies..."
npm install

echo "Downloading frontend libraries..."
mkdir -p static/js static/css

# Helper function for downloading with retry/error check
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
  echo "Adding Prism language: $lang..."
  echo "" >> static/js/prism.js
  curl -sSL "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-$lang.min.js" >> static/js/prism.js
done

echo "Minifying JS, CSS, locales, and themes..."
node build.js

echo "Frontend build complete!"
