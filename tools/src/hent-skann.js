'use strict';
/**
 * hent-skann.js — henter ned noter som er skannet med mobilen og
 * kjoerer dem gjennom gjenkjenninga.
 *
 * Hvorfor dette ikke skjer av seg selv paa serveren: gjenkjenninga er
 * to nevrale modeller paa til sammen ~190 MB pluss Audiveris med Java.
 * Det lar seg ikke kjoere i en Cloudflare Worker. Skanneren lagrer
 * derfor sidene og merker stykket «venter», og dette verktoeyet gjoer
 * resten her.
 *
 * Det ene skanneren IKKE gjetter, er hvilken stemme hver notelinje er.
 * Det svarte du paa i appen, og svaret foelger med i katalogen. Her
 * skrives det rett inn i data/oppsett.json, slik at importen bruker
 * det samme oppsettet som for resten av arkivet.
 *
 *   node tools/src/hent-skann.js            alle som venter
 *   node tools/src/hent-skann.js <id>       bare én
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BASE = 'https://notearkiv.jortech.no';
const PDF = 'data/pdf';
const INN = 'data/inn';
const OPPSETT = 'data/oppsett.json';

/** Samme slugging som sidebehandlinga bruker paa filnavnet. */
function slugg(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** Stavtypen et stemmenavn hoerer til — det importen trenger aa vite. */
function stavtypeAv(navn) {
  const n = String(navn || '').toLowerCase();
  if (/klaver|piano/.test(n)) return 'piano';
  if (/tenor/.test(n)) return 'tenor';
  if (/baryton/.test(n)) return 'baryton';
  if (/bass/.test(n)) return 'bass';
  if (/sopran/.test(n)) return 'sopran';
  if (/\balt\b/.test(n)) return 'alt';
  return 'tenor';
}

async function hent(url, binaer) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return binaer ? Buffer.from(await r.arrayBuffer()) : r.json();
}

async function main() {
  const bare = process.argv[2];
  const katalog = await hent(`${BASE}/arkiv.json`);
  const venter = (katalog.stykker || []).filter(
    (s) => s.venter && (!bare || s.id === bare));

  if (!venter.length) {
    console.log('Ingen skannede noter venter paa gjenkjenning.');
    return;
  }
  fs.mkdirSync(PDF, { recursive: true });

  // Stemmene du oppga i appen, over i oppsettet importen leser.
  let oppsett = {};
  try { oppsett = JSON.parse(fs.readFileSync(OPPSETT, 'utf8')); } catch (e) { /* nytt */ }

  const hentet = [];
  for (const stykke of venter) {
    console.log(`\n${stykke.tittel}  (${stykke.antallSider} sider)`);

    // PDF-en skanneren lagde er den beste kilden — én fil, riktig
    // rekkefoelge, og samme vei inn som resten av arkivet.
    if (!stykke.pdf) {
      console.log('  ingen PDF lagret — hopper over');
      continue;
    }
    // Fila doepes etter TITTELEN, ikke id-en. Resten av kjeden finner
    // PDF-en igjen ved aa slugge filnavnet, og da maa det gi samme id
    // som katalogen bruker.
    const navn = `${stykke.tittel.replace(/[\\/:*?"<>|]/g, '-')}.pdf`;
    const maal = path.join(PDF, navn);
    const innMaal = path.join(INN, navn);
    if (fs.existsSync(maal)) {
      console.log('  PDF finnes alt lokalt');
    } else {
      const bytes = await hent(`${BASE}/${stykke.pdf}`, true);
      fs.mkdirSync(INN, { recursive: true });
      fs.writeFileSync(maal, bytes);
      fs.writeFileSync(innMaal, bytes);
      console.log(`  hentet ${Math.round(bytes.length / 1024)} kB`);
    }
    stykke._inn = innMaal;

    const staver = (stykke.stemmer || []).map(stavtypeAv);
    if (staver.length) {
      // Oppsettet maa ligge under den id-en IMPORTEN kommer til aa
      // bruke. Katalogen gir stykket et tidsstempel i id-en
      // («anders-herre-test-mvpsoc88»), mens sidebehandlinga doeper
      // det etter filnavnet («anders-herre-test»). Skriver vi bare
      // under katalogens id, finner importen ingenting — og leser da
      // hele noten som klaver.
      const lokalId = slugg(stykke.tittel);
      const verdi = {
        staver: staver,
        _sett: `fra skanneren: ${(stykke.stemmer || []).join(', ')}`,
      };
      oppsett[lokalId] = verdi;
      oppsett[stykke.id] = verdi;
      console.log(`  stemmer: ${(stykke.stemmer || []).join(', ')}  (oppsett: ${lokalId})`);
    }
    hentet.push(stykke);
  }

  if (!hentet.length) return;
  fs.writeFileSync(OPPSETT, JSON.stringify(oppsett, null, 2), 'utf8');

  console.log(`\n${hentet.length} stykke(r) klart. Kjoerer gjenkjenninga …\n`);
  const kjor = (fil, args) => {
    try {
      execFileSync(process.execPath, [fil].concat(args || []), { stdio: 'inherit' });
    } catch (e) { console.log(`  ${fil} feilet — fortsetter`); }
  };
  // Foerst gjennom den vanlige sidebehandlinga, saa stykket finnes i
  // det lokale arkivet med rensede sider og struktur — det er det
  // importen fester notene paa.
  //
  // Kjoeres cli.js med ÉN fil, skriver den data/ut/arkiv.json paa nytt
  // med bare den fila — og resten av arkivet er borte. Den maa derfor
  // kjoere over hele data/inn. Det tar lengre tid, men den bygger bare
  // sider som mangler, og den sletter ingenting.
  kjor('tools/src/cli.js');
  for (const s of hentet) kjor('tools/src/homr.js', [s.tittel]);
  for (const s of hentet) kjor('tools/src/audiveris.js', [s.tittel]);
  kjor('tools/src/noter-fra-import.js');
  kjor('tools/src/lag-midi.js');

  console.log('\nKjoer til slutt:');
  console.log('  node tools/src/flytt-til-r2.js && node tools/src/last-opp.js');
}

main().catch((e) => { console.error(e); process.exit(1); });
