'use strict';
/**
 * last-opp.js — skriver katalogen fra data/ut/arkiv.json til KV.
 *
 * Selve filene gaar til R2 med `flytt-til-r2.js`; her settes bare
 * stiene som katalogen peker paa, saa de to henger sammen.
 * Kjoer flytt-til-r2.js foerst, ellers peker katalogen paa filer som
 * ikke finnes ennaa.
 *
 *   node tools/src/last-opp.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const NS = '6dbeec950d5f42d7af7cb5a45b4e3660';
const WRANGLER = path.resolve('node_modules/wrangler/bin/wrangler.js');
const TMP = process.env.TEMP || '.';

const arkiv = JSON.parse(fs.readFileSync('data/ut/arkiv.json', 'utf8'));

for (const stykke of arkiv.stykker) {
  for (const side of stykke.sider) {
    side.fil = `fil/${stykke.id}/side-${String(side.nr).padStart(3, '0')}.jpg`;
  }
  // Originalen, saa den kan lastes ned fra arkivet.
  const pdf = fs.existsSync('data/pdf') && fs.readdirSync('data/pdf').find((f) => {
    const t = f.replace(/\.pdf$/i, '')
      .replace(/\s*\(Conflict[^)]*\)\s*/gi, '')
      .replace(/^\d+\s+/, '').trim()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[‘’]/g, "'")
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    return t === stykke.id;
  });
  stykke.pdf = pdf ? `fil/${stykke.id}/noter.pdf` : null;
}

const fil = path.join(TMP, 'notearkiv-katalog.json');
fs.writeFileSync(fil, JSON.stringify([{ key: 'katalog', value: JSON.stringify(arkiv) }]));
execFileSync(process.execPath, [WRANGLER, 'kv', 'bulk', 'put', fil, '--namespace-id', NS],
  { stdio: ['ignore', 'ignore', 'inherit'] });
fs.unlinkSync(fil);

const sider = arkiv.stykker.reduce((a, s) => a + s.antallSider, 0);
console.log(`Katalogen er skrevet: ${arkiv.stykker.length} stykker, ${sider} sider.`);
