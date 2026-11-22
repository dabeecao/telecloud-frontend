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

# Add Bun to PATH if it exists in the default installation directory
if [ -d "$HOME/.bun/bin" ]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! command -v bun > /dev/null 2>&1; then
  echo "bun is not installed. Installing bun..."
  curl -fsSL https://bun.sh/install | bash || { echo "Failed to install bun. Please install it manually from https://bun.com/ and try again."; exit 1; }
  export PATH="$HOME/.bun/bin:$PATH"
fi

echo "Installing dependencies..."
# Use the committed lockfile so every machine and CI run installs the same
# versions. An unpinned install once pulled a newer Font Awesome that no longer
# ships the webfonts/ directory required by main.go's go:embed directive.
if [ -f bun.lock ]; then
  bun install --frozen-lockfile
else
  echo "WARNING: bun.lock is missing; installing unpinned versions."
  bun install
fi

echo "Minifying JS, CSS, locales, and themes..."
bun run build.js

echo "Frontend build complete!"
