const fs = require('fs');
const path = require('path');
const localesDir = './static/locales';
fs.readdirSync(localesDir).forEach(file => {
  if (file.endsWith('.json') && !file.endsWith('.min.json')) {
    const filePath = path.join(localesDir, file);
    const minPath = path.join(localesDir, file.replace('.json', '.min.json'));
    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      fs.writeFileSync(minPath, JSON.stringify(content));
      console.log('Minified ' + file + ' -> ' + path.basename(minPath));
    } catch (e) {
      console.error('Error minifying ' + file + ':', e.message);
    }
  }
});
