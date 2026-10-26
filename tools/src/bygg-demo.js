'use strict';
// Bygger en selvstendig demo-fil: visningsverktoeyet med ekte sider lagt
// inn som data-URI-er, slik at den kan aapnes uten server.
const fs = require('node:fs');
const sharp = require('sharp');

(async () => {
  const arkiv = JSON.parse(fs.readFileSync('data/ut/arkiv.json', 'utf8'));
  let bytes = 0;
  for (const stykke of arkiv.stykker) {
    for (const side of stykke.sider) {
      const jpg = await sharp('data/ut/' + side.fil)
        .jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      side.bilde = 'data:image/jpeg;base64,' + jpg.toString('base64');
      bytes += jpg.length;
      delete side.fil;
    }
  }
  const html = fs.readFileSync('public/index.html', 'utf8');
  const css = fs.readFileSync('public/stil.css', 'utf8');
  const js = fs.readFileSync('public/app.js', 'utf8');

  const ut = html
    .replace('<link rel="stylesheet" href="stil.css">', '<style>\n' + css + '\n</style>')
    .replace('<script src="app.js"></script>',
      '<script>window.ARKIV=' + JSON.stringify(arkiv) + ';</script>\n<script>\n' + js + '\n</script>');

  fs.writeFileSync('data/ut/demo.html', ut, 'utf8');
  console.log('demo.html:', (Buffer.byteLength(ut) / 1048576).toFixed(2), 'MB',
    '(bilder', (bytes / 1048576).toFixed(2), 'MB)');
})();
