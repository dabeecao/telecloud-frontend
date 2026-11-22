#!/usr/bin/env node
// Verifies that every locale file has exactly the same key set as en.json,
// and that all locale files keep their top-level keys sorted A-Z.
//
// Run locally with:  node scripts/check-locales.js
// CI runs it in the "Locale parity" job.

'use strict';

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'static', 'locales');
const SOURCE = 'en.json';

/** Flattens nested objects into dot-separated keys. */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function main() {
  if (!fs.existsSync(path.join(LOCALES_DIR, SOURCE))) {
    console.error(`::error::${SOURCE} not found in ${LOCALES_DIR}`);
    return 1;
  }

  const baseRaw = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, SOURCE), 'utf8'));
  const base = flatten(baseRaw);
  const baseKeys = new Set(Object.keys(base));

  // en.json itself must be sorted too.
  let failed = false;
  const baseTop = Object.keys(baseRaw);
  if (JSON.stringify(baseTop) !== JSON.stringify([...baseTop].sort())) {
    failed = true;
    console.error(`::error file=static/locales/${SOURCE}::${SOURCE}: top-level keys are not sorted A-Z`);
  }

  const others = fs
    .readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.min.json') && f !== SOURCE)
    .sort();

  for (const file of others) {
    const filePath = path.join(LOCALES_DIR, file);
    const rel = `static/locales/${file}`;

    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      failed = true;
      console.error(`::error file=${rel}::${file}: invalid JSON — ${e.message}`);
      continue;
    }

    const keys = new Set(Object.keys(flatten(raw)));
    const missing = [...baseKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !baseKeys.has(k));

    if (missing.length || extra.length) {
      failed = true;
      console.error(
        `::error file=${rel}::${file}: ${missing.length} missing, ${extra.length} extra key(s) vs ${SOURCE}`
      );
      missing.slice(0, 10).forEach((k) => console.error(`    missing: ${k}`));
      extra.slice(0, 10).forEach((k) => console.error(`    extra:   ${k}`));
      if (missing.length > 10) console.error(`    ... and ${missing.length - 10} more missing`);
      if (extra.length > 10) console.error(`    ... and ${extra.length - 10} more extra`);
    }

    const top = Object.keys(raw);
    if (JSON.stringify(top) !== JSON.stringify([...top].sort())) {
      failed = true;
      console.error(`::error file=${rel}::${file}: top-level keys are not sorted A-Z (run "node build.js" after adding keys, or sort manually)`);
    }

    if (!missing.length && !extra.length) {
      console.log(`${file}: ${keys.size} keys, in sync`);
    }
  }

  if (others.length === 0) {
    console.log('No translation files found besides the source.');
  }

  if (failed) {
    console.error('\nLocale check FAILED.');
    return 1;
  }

  console.log(`\nAll ${others.length + 1} locales share ${baseKeys.size} keys, sorted A-Z.`);
  return 0;
}

process.exit(main());
