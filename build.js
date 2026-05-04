'use strict';

const esbuild = require('esbuild');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function minifyLocales() {
  const localesDir = './static/locales';
  const files = fs.readdirSync(localesDir);
  for (const file of files) {
    if (file.endsWith('.json') && !file.endsWith('.min.json')) {
      const filePath = path.join(localesDir, file);
      const minPath = path.join(localesDir, file.replace('.json', '.min.json'));
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      fs.writeFileSync(minPath, JSON.stringify(content));
    }
  }
}

async function main() {
  const errors = [];

  function wrap(name, fn) {
    return fn().then(() => {
      console.log(`  ok  ${name}`);
    }).catch(err => {
      console.error(`  FAIL  ${name}: ${err.message}`);
      errors.push(name);
    });
  }

  function buildTailwind() {
    return new Promise((resolve, reject) => {
      execFile('npx', ['@tailwindcss/cli', '-i', 'static/css/input.css', '-o', 'static/css/tailwind.css', '--minify'],
        { stdio: 'inherit', shell: process.platform === 'win32' },
        (err) => err ? reject(err) : resolve()
      );
    });
  }

  // JS files
  const jsBuilds = [
    { in: 'static/js/common.js',  out: 'static/js/common.min.js' },
    { in: 'static/js/script.js',  out: 'static/js/script.min.js' },
    { in: 'static/js/prism.js',   out: 'static/js/prism.min.js'  },
  ];

  // CSS files
  const cssBuilds = [
    { in: 'static/css/style.css',   out: 'static/css/style.min.css',   bundle: true  },
    { in: 'static/css/nunito.css',  out: 'static/css/nunito.min.css',  bundle: false },
    { in: 'static/css/prism.css',   out: 'static/css/prism.min.css',   bundle: false },
    { in: 'static/css/plyr.css',    out: 'static/css/plyr.min.css',    bundle: false },
  ];

  // Theme files — discover at runtime, skip already-minified
  const themesDir = 'static/themes';
  let themeBuilds = [];
  try {
    themeBuilds = fs.readdirSync(themesDir)
      .filter(f => f.endsWith('.css') && !f.endsWith('.min.css'))
      .map(f => ({
        in:  path.join(themesDir, f),
        out: path.join(themesDir, f.replace(/\.css$/, '.min.css')),
        bundle: false,
      }));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.warn(`  warn  ${themesDir} not found, skipping themes`);
  }

  const allBuilds = [...jsBuilds, ...cssBuilds, ...themeBuilds];

  const tasks = [
    wrap('tailwind', buildTailwind),
    wrap('locales', () => Promise.resolve(minifyLocales())),
    ...allBuilds.map(({ in: entryPoint, out: outfile, bundle }) =>
      wrap(outfile, () => esbuild.build({
        entryPoints: [entryPoint],
        outfile,
        minify: true,
        bundle: !!bundle,
        external: bundle ? ['/static/*'] : [],
        logLevel: 'silent',
      }))
    ),
  ];

  await Promise.all(tasks);

  if (errors.length > 0) {
    console.error(`\nBuild failed for: ${errors.join(', ')}`);
    process.exit(1);
  }

  console.log('\nBuild complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
