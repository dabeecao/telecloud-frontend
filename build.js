'use strict';

const esbuild = require('esbuild');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function syncAndMinifyLocales() {
  const localesDir = './static/locales';
  const sourceFile = 'en.json';
  const sourcePath = path.join(localesDir, sourceFile);
  
  if (!fs.existsSync(sourcePath)) return;
  let sourceData = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

  // Sort en.json itself first
  const sortedSource = {};
  Object.keys(sourceData).sort().forEach(k => { sortedSource[k] = sourceData[k]; });
  if (JSON.stringify(sourceData) !== JSON.stringify(sortedSource)) {
    fs.writeFileSync(sourcePath, JSON.stringify(sortedSource, null, 4), 'utf8');
    sourceData = sortedSource;
    console.log(`  sync  ${sourceFile}: sorted keys A-Z`);
  }

  const files = fs.readdirSync(localesDir);
  for (const file of files) {
    if (file.endsWith('.json') && !file.endsWith('.min.json')) {
      const filePath = path.join(localesDir, file);
      let content = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Sync if not the source file
      if (file !== sourceFile) {
        let addedKeys = [];
        let removedKeys = [];
        
        const syncObjects = (src, tgt, prefix = '') => {
          const res = {};
          
          // Add/Update keys from source
          Object.keys(src).forEach(k => {
            const fullKey = prefix ? `${prefix}.${k}` : k;
            if (tgt[k] === undefined) {
              res[k] = src[k];
              addedKeys.push(fullKey);
            } else if (typeof src[k] === 'object' && src[k] !== null && !Array.isArray(src[k])) {
              res[k] = syncObjects(src[k], tgt[k] || {}, fullKey);
            } else {
              res[k] = tgt[k];
            }
          });

          // Check for keys to remove (present in tgt but not in src)
          Object.keys(tgt).forEach(k => {
            const fullKey = prefix ? `${prefix}.${k}` : k;
            if (src[k] === undefined) {
              removedKeys.push(fullKey);
            }
          });

          return res;
        };

        const syncedContent = syncObjects(sourceData, content);
        if (addedKeys.length > 0 || removedKeys.length > 0) {
          if (addedKeys.length > 0) console.log(`  sync  ${file}: added ${addedKeys.length} keys (${addedKeys.slice(0, 5).join(', ')}${addedKeys.length > 5 ? '...' : ''})`);
          if (removedKeys.length > 0) console.log(`  sync  ${file}: removed ${removedKeys.length} keys (${removedKeys.slice(0, 5).join(', ')}${removedKeys.length > 5 ? '...' : ''})`);
          
          // Sort keys
          const sorted = {};
          Object.keys(syncedContent).sort().forEach(k => { sorted[k] = syncedContent[k]; });
          content = sorted;
          fs.writeFileSync(filePath, JSON.stringify(content, null, 4), 'utf8');
        }
      }

      // Minify
      const minPath = path.join(localesDir, file.replace('.json', '.min.json'));
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
    { in: 'static/js/artplayer.js', out: 'static/js/artplayer.min.js' },
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
    wrap('locales', () => Promise.resolve(syncAndMinifyLocales())),
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
