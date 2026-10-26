'use strict';
/**
 * rydd-kv.js — fjerner de gamle filene fra KV etter overgangen til R2.
 *
 * Katalogen (`katalog`) blir liggende; den hoerer hjemme i KV. Alt annet
 * er notesider og PDF-er som naa ligger i R2, og som bare opptar plass.
 *
 *   node tools/src/rydd-kv.js            viser hva som ville blitt slettet
 *   node tools/src/rydd-kv.js --slett    sletter
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const NS = '6dbeec950d5f42d7af7cb5a45b4e3660';
const WRANGLER = path.resolve('node_modules/wrangler/bin/wrangler.js');
const TMP = process.env.TEMP || '.';
const BEHOLD = new Set(['katalog']);

function wrangler(args) {
  return execFileSync(process.execPath, [WRANGLER, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
}

const slett = process.argv.includes('--slett');
const raa = wrangler(['kv', 'key', 'list', '--namespace-id', NS]);
// Utskriften har en oppdateringsadvarsel foran JSON-en.
const noekler = JSON.parse(raa.slice(raa.indexOf('[')));

const kandidater = noekler.map((n) => n.name).filter((n) => !BEHOLD.has(n));
console.log(`${noekler.length} noekler i KV, ${kandidater.length} kan fjernes:`);
for (const n of kandidater.slice(0, 8)) console.log(`  ${n}`);
if (kandidater.length > 8) console.log(`  … og ${kandidater.length - 8} til`);

if (!kandidater.length) process.exit(0);
if (!slett) {
  console.log('\nKjoer med --slett for aa fjerne dem.');
  process.exit(0);
}

const fil = path.join(TMP, 'notearkiv-slett.json');
fs.writeFileSync(fil, JSON.stringify(kandidater));
execFileSync(process.execPath,
  [WRANGLER, 'kv', 'bulk', 'delete', fil, '--namespace-id', NS, '--force'],
  { stdio: ['ignore', 'ignore', 'inherit'] });
fs.unlinkSync(fil);
console.log(`\n${kandidater.length} noekler fjernet. Katalogen staar igjen.`);
