'use strict';
// Bygger artefakt-varianten: samme visning, men uten eget dokumentskall,
// siden Artifact-plattformen legger paa <html>/<head>/<body> selv.
const fs = require('node:fs');
const sharp = require('sharp');

(async () => {
  const arkiv = JSON.parse(fs.readFileSync('data/ut/arkiv.json', 'utf8'));
  for (const stykke of arkiv.stykker) {
    for (const side of stykke.sider) {
      const jpg = await sharp('data/ut/' + side.fil)
        .jpeg({ quality: 80, mozjpeg: true }).toBuffer();
      side.bilde = 'data:image/jpeg;base64,' + jpg.toString('base64');
      delete side.fil;
    }
  }

  const html = fs.readFileSync('public/index.html', 'utf8');
  const css = fs.readFileSync('public/stil.css', 'utf8');
  const js = fs.readFileSync('public/app.js', 'utf8');

  // Bare innholdet i <body>, uten egne skall-tagger.
  const kropp = html
    .slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'))
    .replace('<script src="app.js"></script>', '')
    .trim();

  const ut = [
    '<title>Notearkiv</title>',
    '<meta name="claude:viewport-fit-sides" content="cover">',
    '<style>',
    // Sida er bevisst moerk: hvitt papir skal staa fram i et halvmoerkt
    // oevingslokale. Da settes color-scheme eksplisitt paa :root.
    ':root { color-scheme: dark; }',
    'html, body { height: 100%; }',
    css,
    '</style>',
    kropp,
    '<script>window.ARKIV=' + JSON.stringify(arkiv) + ';</script>',
    '<script>',
    js,
    '</script>',
  ].join('\n');

  fs.writeFileSync('data/ut/notearkiv-artefakt.html', ut, 'utf8');
  console.log('artefakt:', (Buffer.byteLength(ut) / 1048576).toFixed(2), 'MB');
})();
