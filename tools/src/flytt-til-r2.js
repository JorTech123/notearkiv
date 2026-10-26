'use strict';
/**
 * flytt-til-r2.js — laster notesidene og PDF-ene opp i R2.
 *
 * Noeklene leses ut av den LIVE katalogen, ikke gjettes paa nytt. Da
 * havner filene nøyaktig der katalogen allerede peker, og overgangen
 * krever ingen endring i katalogen i det hele tatt — bare en deploy.
 *
 * Kjoer denne FOER du deployer Worker-en som leser fra R2, ellers er
 * nettstedet uten bilder i mellomtiden.
 *
 *   node tools/src/flytt-til-r2.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BASE = process.env.NOTEARKIV || 'https://notearkiv.jortech.no';
const BOTTE = 'notearkiv';
const WRANGLER = path.resolve('node_modules/wrangler/bin/wrangler.js');

/** Finner PDF-en i data/pdf som hoerer til et stykke-id. */
function finnPdf(id) {
  if (!fs.existsSync('data/pdf')) return null;
  return fs.readdirSync('data/pdf').find((f) => {
    const t = f.replace(/\.pdf$/i, '')
      .replace(/\s*\(Conflict[^)]*\)\s*/gi, '')
      .replace(/^\d+\s+/, '').trim()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[‘’]/g, "'")
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    return t === id;
  });
}

function leggOpp(nokkel, fil, type) {
  execFileSync(process.execPath, [
    WRANGLER, 'r2', 'object', 'put', `${BOTTE}/${nokkel}`,
    '--file', fil, '--content-type', type, '--jurisdiction', 'eu',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function main() {
  // Katalogen leses LOKALT, fra det siste bygget.
  //
  // Den ble foer hentet fra nettstedet, og det var bakvendt: da la vi
  // opp de filene den FORRIGE utgaven pekte paa, mens de nye aldri kom
  // av gaarde. Stemmefilene heter noe annet naar stemmene er lest paa
  // nytt, og da laa det gamle igjen i R2 mens katalogen pekte i luften.
  const katalog = JSON.parse(fs.readFileSync('data/ut/arkiv.json', 'utf8'));
  const jobber = [];

  for (const stykke of katalog.stykker) {
    for (const side of stykke.sider) {
      // "fil/<id>/side-001.jpg" -> noekkelen er alt etter "fil/"
      const nokkel = side.fil.replace(/^fil\//, '');
      const lokal = path.join('data/ut/sider',
        `${stykke.id}-${String(side.nr).padStart(3, '0')}.jpg`);
      if (fs.existsSync(lokal)) jobber.push({ nokkel, lokal, type: 'image/jpeg' });
      else console.log(`  mangler lokalt: ${lokal}`);
    }
    if (stykke.pdf) {
      const pdf = finnPdf(stykke.id);
      if (pdf) {
        jobber.push({
          nokkel: stykke.pdf.replace(/^fil\//, ''),
          lokal: path.join('data/pdf', pdf),
          type: 'application/pdf',
        });
      } else console.log(`  fant ingen PDF for ${stykke.id}`);
    }

    // Lydfilene: én med alle stemmer, og én per stemme der din egen
    // staar fram. De er smaa, saa de legges opp sammen med sidene.
    if (stykke.midi) {
      const stier = [stykke.midi.alle]
        .concat(Object.values(stykke.midi.stemmer || {}))
        .filter(Boolean);
      for (const sti of stier) {
        const nokkel = sti.replace(/^fil\//, '');
        const lokal = path.join('data/ut', nokkel);
        if (fs.existsSync(lokal)) {
          jobber.push({ nokkel: nokkel, lokal: lokal, type: 'audio/midi' });
        }
      }
    }
  }

  console.log(`${jobber.length} filer skal opp i R2 (${BOTTE}, eu).\n`);
  let n = 0, feil = 0;
  for (const j of jobber) {
    n++;
    const merke = `[${String(n).padStart(2)}/${jobber.length}]`;
    try {
      leggOpp(j.nokkel, j.lokal, j.type);
      const kb = Math.round(fs.statSync(j.lokal).size / 1024);
      console.log(`${merke} ${j.nokkel}  ${kb} kB`);
    } catch (e) {
      feil++;
      console.log(`${merke} ${j.nokkel}  FEIL: ${String(e.stderr || e.message).trim().split('\n').pop()}`);
    }
  }
  console.log(`\nFerdig: ${n - feil} lagt opp, ${feil} feilet.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
