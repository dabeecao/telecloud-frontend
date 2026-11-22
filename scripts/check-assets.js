#!/usr/bin/env node
// Verifies that every generated asset referenced by a template actually exists
// after a build. Source files (committed) are skipped; only build outputs
// (gitignored: *.min.js, *.min.css, *.min.json, tailwind.css) are asserted.
//
// Run locally with:  node scripts/check-assets.js
// CI runs it after "node build.js" in the "Build assets" job.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEMPLATES_DIR = path.join(ROOT, 'templates');

// Only these are produced by the build and therefore must exist afterwards.
const GENERATED = [/\.min\.js$/, /\.min\.css$/, /\.min\.json$/, /^static\/css\/tailwind\.css$/];

function collectTemplateFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTemplateFiles(full));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

function main() {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    console.log('No templates directory; nothing to check.');
    return 0;
  }

  const refs = new Map(); // asset path -> first template that referenced it
  const assetRe = /\/static\/[A-Za-z0-9._\/-]+\.(?:js|css|json)/g;

  for (const file of collectTemplateFiles(TEMPLATES_DIR)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(assetRe)) {
      const rel = match[0].replace(/^\//, '');
      if (!refs.has(rel)) refs.set(rel, path.relative(ROOT, file));
    }
  }

  let missing = 0;
  let checked = 0;
  for (const [rel, template] of [...refs].sort()) {
    if (!GENERATED.some((re) => re.test(rel))) continue; // committed source file
    checked++;
    if (!fs.existsSync(path.join(ROOT, rel))) {
      missing++;
      console.error(`::error file=${rel}::${template} references ${rel} but the build did not produce it`);
    }
  }

  if (missing) {
    console.error(`\nAsset check FAILED: ${missing} of ${checked} generated asset(s) missing.`);
    return 1;
  }
  console.log(`Asset check passed: ${checked} generated asset reference(s) resolved.`);
  return 0;
}

process.exit(main());
