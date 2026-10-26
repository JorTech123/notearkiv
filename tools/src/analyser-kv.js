'use strict';
/**
 * analyser-kv.js — kjoerer strukturanalysen paa sider som allerede ligger
 * i KV uten struktur.
 *
 * Skanneren analyserer paa telefonen, saa dette er reservevegen: sider som
 * ble lagret foer analysen kom paa plass, eller der telefonen ikke fikk det
 * til. Henter sida fra nettstedet, analyserer med samme delte kode, og
 * skriver katalogen tilbake.
 *
 *   node tools/src/analyser-kv.js            viser hva som mangler
 *   node tools/src/analyser-kv.js --skriv    analyserer og lagrer
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const N = require('../../public/noteanalyse.js');

const BASE = process.env.NOTEARKIV || 'https://notearkiv.jortech.no';
const NS = '6dbeec950d5f42d7af7cb5a45b4e3660';
const WRANGLER = path.resolve('node_modules/wrangler/bin/wrangler.js');
const TMP = process.env.TEMP || '.';

/** Gratone rett fra JPEG-bytene. */
async function gratone(bytes) {
  const { data, info } = await sharp(Buffer.from(bytes))
    .grayscale().raw().toBuffer({ resolveWithObject: true });
  return { g: data, b: info.width, h: info.height };
}

async function main() {
  const skriv = process.argv.includes('--skriv');
  const katalog = await (await fetch(`${BASE}/arkiv.json`)).json();

  const mangler = [];
  for (const stykke of katalog.stykker) {
    for (const side of stykke.sider) {
      if (!side.systemer || !side.systemer.length) mangler.push({ stykke, side });
    }
  }

  if (!mangler.length) {
    console.log('Alle sider har struktur. Ingenting aa gjoere.');
    return;
  }
  console.log(`${mangler.length} sider uten struktur:`);
  for (const m of mangler) console.log(`  ${m.stykke.tittel} — side ${m.side.nr}`);
  if (!skriv) {
    console.log('\nKjoer med --skriv for aa analysere og lagre.');
    return;
  }

  console.log('');
  for (const { stykke, side } of mangler) {
    process.stdout.write(`${stykke.tittel} — side ${side.nr} … `);
    try {
      const svar = await fetch(`${BASE}/${side.fil}`);
      if (!svar.ok) { console.log(`hentefeil ${svar.status}`); continue; }
      const { g, b, h } = await gratone(await svar.arrayBuffer());

      // Sidene i KV er allerede renset, saa fast terskel holder — samme
      // vei som skanneren gaar.
      const bin = N.terskle(g, 150);
      const ny = N.tilJson(N.analyser(bin, b, h), b, h);
      side.bredde = ny.bredde;
      side.hoyde = ny.hoyde;
      side.linjeavstand = ny.linjeavstand;
      side.systemer = ny.systemer;
      side.antallTakter = ny.antallTakter;
      console.log(`${ny.systemer.length} systemer, ${ny.antallTakter} takter`);
    } catch (e) {
      console.log(`FEIL: ${e.message}`);
    }
  }

  // Stemmenavn paa stavene, og summer opp paa nytt.
  const OPPSETT = {
    1: ['melodi'], 2: ['overstemme', 'understemme'],
    3: ['tenor', 'baryton', 'bass'],
    4: ['1. tenor', '2. tenor', 'baryton', 'bass'],
    5: ['1. tenor', '2. tenor', 'baryton', 'bass', 'piano'],
    6: ['1. tenor', '2. tenor', 'baryton', 'bass', 'piano h.h.', 'piano v.h.'],
  };
  for (const stykke of katalog.stykker) {
    let flest = 0;
    for (const side of stykke.sider) {
      for (const sys of side.systemer || []) flest = Math.max(flest, sys.staver.length);
    }
    if (flest && (!stykke.stemmer || !stykke.stemmer.length)) {
      stykke.stemmer = OPPSETT[flest] || OPPSETT[4];
    }
    for (const side of stykke.sider) {
      for (const sys of side.systemer || []) {
        const sett = OPPSETT[sys.staver.length] || stykke.stemmer || [];
        sys.staver.forEach((st, k) => { st.stemme = sett[k] || `stemme ${k + 1}`; });
      }
    }
    stykke.antallTakter = stykke.sider.reduce((a, s) => a + (s.antallTakter || 0), 0);
  }

  const fil = path.join(TMP, 'notearkiv-katalog.json');
  fs.writeFileSync(fil, JSON.stringify([{ key: 'katalog', value: JSON.stringify(katalog) }]));
  execFileSync(process.execPath, [WRANGLER, 'kv', 'bulk', 'put', fil, '--namespace-id', NS],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  fs.unlinkSync(fil);
  console.log('\nKatalogen er oppdatert.');
}

main().catch((e) => { console.error(e); process.exit(1); });
