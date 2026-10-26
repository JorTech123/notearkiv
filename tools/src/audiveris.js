'use strict';
/**
 * audiveris.js — kjoerer Audiveris over arkivet og henter ut MusicXML.
 *
 * Audiveris er en moden notegjenkjenner og gjoer jobben langt bedre enn
 * den hjemmelagde lesinga: den finner stemmer, noekler (ogsaa tenorens
 * G-noekkel med liten 8 under), faste fortegn, varigheter og pauser.
 *
 * To ting maa haandteres rundt den:
 *
 *  1. Et enkelt ark kan krasje midt i behandlinga. Da nekter Audiveris
 *     aa eksportere HELE boka. Derfor transkriberes boka foerst og
 *     lagres, og eksporten gjoeres deretter ark for ark — da koster en
 *     daarlig side bare den ene sida.
 *  2. Eksport av flere ark til samme mappe overskriver samme filnavn
 *     naar Audiveris deler opp i flere satser. Hvert ark faar derfor sin
 *     egen mappe.
 *
 *   node tools/src/audiveris.js              hele data/pdf
 *   node tools/src/audiveris.js "My Way"     bare ett stykke
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const pdf = require('./pdf.js');

const EXE = 'C:\\Prosjekter\\.tools\\audiveris\\Audiveris\\Audiveris.exe';
const TESSDATA = 'C:\\Prosjekter\\.tools\\tessdata';
const PDF = 'data/pdf';
const UT = 'data/musicxml';
// Hvor bredt sida tegnes opp naar den maa gaa via bilde. Audiveris
// finner notelinjeavstanden selv, men bare innenfor et rimelig spenn.
const BILDEBREDDE = parseInt(process.env.NOTE_BREDDE || '2600', 10);

/**
 * Hvilket spraak teksten under notene skal leses som.
 *
 * Audiveris sender sangteksten gjennom Tesseract, og standarden er
 * engelsk. Paa de norske stykkene blir «Ånders Herre, en sangers bønn»
 * da lest med et alfabet uten æ, ø og å. Sett NOTE_SPRAAK=nor (eller
 * «nor+eng» for et blandet hefte) foer kjoeringa.
 *
 *   NOTE_SPRAAK=nor node tools/src/audiveris.js "Vi sees igjen"
 */
function spraakValg() {
  const s = process.env.NOTE_SPRAAK;
  if (!s) return [];
  return ['-option', `org.audiveris.omr.text.Language.defaultSpecification=${s}`];
}

function kjor(args, tidsgrense) {
  const r = spawnSync(EXE, args, {
    encoding: 'utf8',
    timeout: tidsgrense || 900000,
    env: Object.assign({}, process.env, {
      TESSDATA_PREFIX: TESSDATA,
      // «Comparison method violates its general contract» slaar ut paa
      // flere ark og stopper dem midt i. Det er TimSort som oppdager at
      // en av Audiveris sine sammenlikninger ikke er transitiv. Den gamle
      // flettesorteringen er mindre kresen og kommer gjennom.
      JAVA_TOOL_OPTIONS: '-Djava.util.Arrays.useLegacyMergeSort=true',
    }),
    windowsHide: true,
  });
  return ((r.stdout || '') + (r.stderr || ''));
}

/** Arknumre som krasjet, lest ut av Audiveris sin egen logg. */
function feiledeArk(logg) {
  const ark = new Set();
  const m = logg.match(/\[[^\]#]+#(\d+)\][^\n]*Error processing stub/g) || [];
  for (const t of m) {
    const n = t.match(/#(\d+)\]/);
    if (n) ark.add(parseInt(n[1], 10));
  }
  return ark;
}

/**
 * Antall ark = antall sider i PDF-en. Loggen duger ikke til dette:
 * den inneholder ogsaa «system#4» og liknende, som ser likt ut.
 */
async function antallSider(sti) {
  const pdf = require('./pdf.js');
  const doc = await pdf.aapne(sti);
  const n = doc.numPages;
  await doc.destroy();
  return n;
}

/**
 * Er sida saa stor at Audiveris ikke kjenner igjen noter paa den?
 *
 * Skannede PDF-er oppgir ofte sidestoerrelsen i PIKSLER i stedet for
 * punkter: 1912 x 2698 pt der et A4 er 595 x 842. Audiveris tegner den
 * da opp i flere ganger full stoerrelse, og med en notelinjeavstand paa
 * godt over hundre piksler finner den ingenting — loggen sier bare
 * «Created scores: []», uten feilmelding. Det rammet baade «Ånders
 * Herre» og «Vi sees igjen».
 */
async function altForStor(fil) {
  const doc = await pdf.aapne(fil);
  try {
    const vp = (await doc.getPage(1)).getViewport({ scale: 1 });
    return vp.width > 1200 || vp.height > 1600;
  } finally { await doc.destroy(); }
}

/**
 * Veien rundt: tegn hver side til et bilde i vanlig stoerrelse og la
 * Audiveris lese bildet. Da blir hvert ark sin egen lille bok, og
 * eksporten blir enklere enn for en flersidig PDF.
 */
async function viaBilder(fil, bok) {
  const doc = await pdf.aapne(fil);
  const arbeid = path.join(bok, 'sider');
  fs.mkdirSync(arbeid, { recursive: true });
  let ok = 0, antall = doc.numPages;
  try {
    for (let k = 1; k <= antall; k++) {
      const mal = path.join(bok, 'ark-' + String(k).padStart(2, '0') + '.mxl');
      if (fs.existsSync(mal)) { ok++; continue; }

      const r = await pdf.rasterSide(doc, k, 300, 99999);
      const bilde = path.join(arbeid, `side-${String(k).padStart(2, '0')}.png`);
      await sharp(Buffer.from(r.g.buffer, r.g.byteOffset, r.g.length),
        { raw: { width: r.b, height: r.h, channels: 1 } })
        .resize({ width: Math.min(BILDEBREDDE, r.b), kernel: 'lanczos3' })
        .png().toFile(bilde);

      kjor(['-batch', '-transcribe', '-export', '-output', arbeid]
        .concat(spraakValg()).concat(['--', bilde]), 900000);

      const laget = fs.readdirSync(arbeid).filter((f) => /\.mxl$/i.test(f));
      if (!laget.length) continue;
      fs.renameSync(path.join(arbeid, laget[0]), mal);
      for (const f of laget) fs.rmSync(path.join(arbeid, f), { force: true });
      ok++;
    }
  } finally { await doc.destroy(); }
  return { ok: ok, ark: antall };
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`Fant ikke Audiveris paa ${EXE}`);
    process.exit(1);
  }
  const bare = process.argv[2];
  const filer = fs.readdirSync(PDF).filter((f) => /\.pdf$/i.test(f))
    .filter((f) => !bare || f.toLowerCase().includes(bare.toLowerCase()));
  if (!filer.length) { console.error('Ingen PDF-er aa behandle.'); process.exit(1); }

  fs.mkdirSync(UT, { recursive: true });
  let alleMxl = 0;

  for (const fil of filer) {
    const navn = fil.replace(/\.pdf$/i, '');
    const bok = path.join(UT, navn.replace(/[^a-zA-Z0-9 ]/g, '_'));
    fs.mkdirSync(bok, { recursive: true });
    process.stdout.write(`${navn} … `);
    const t0 = Date.now();

    if (await altForStor(path.resolve(PDF, fil))) {
      const r = await viaBilder(path.resolve(PDF, fil), bok);
      alleMxl += r.ok;
      console.log(`${r.ok}/${r.ark} ark eksportert  (via bilder)  ` +
        `${Math.round((Date.now() - t0) / 1000)} s`);
      continue;
    }

    // 1 — transkriber og lagre. Finnes bokfila fra foer, jobbes det
    // videre paa den: arkene som gikk bra er allerede lagret, saa bare
    // de som manglet blir forsoekt paa nytt. Det gjoer en ny runde
    // billig naar noe er rettet, som sorteringsflagget over.
    const fraFor = fs.readdirSync(bok).find((f) => /\.omr$/i.test(f));
    const kilde = fraFor ? path.join(bok, fraFor) : path.resolve(PDF, fil);
    const logg = kjor(['-batch', '-transcribe', '-save', '-output', bok]
      .concat(spraakValg()).concat(['--', kilde]));
    const omr = fs.readdirSync(bok).find((f) => /\.omr$/i.test(f));
    if (!omr) { console.log('ingen bokfil — hoppet over'); continue; }

    const daarlige = feiledeArk(logg);
    const ark = await antallSider(path.resolve(PDF, fil));

    // 2 — eksporter ark for ark, hver til sin egen mappe
    // Audiveris skriver til bokmappa uansett hva -output sier, og
    // bruker samme filnavn hver gang. Derfor doepes hver eksport om med
    // det samme, ellers overskriver neste ark det forrige.
    let ok = 0;
    for (let k = 1; k <= ark; k++) {
      if (daarlige.has(k)) continue;
      // Allerede eksportert i en tidligere runde? La det staa.
      const mal = path.join(bok, 'ark-' + String(k).padStart(2, '0') + '.mxl');
      if (fs.existsSync(mal)) { ok++; alleMxl++; continue; }
      // Fjern bare Audiveris sin egen utdatafil, ALDRI arkene vi
      // allerede har doept om. Et bredt filter her sletter forrige ark
      // for hver eksport, og da overlever bare det siste.
      for (const gammel of fs.readdirSync(bok)) {
        if (/^ark-\d+\.mxl$/i.test(gammel)) continue;
        if (!/\.mxl$/i.test(gammel)) continue;
        fs.rmSync(path.join(bok, gammel), { force: true });
      }
      kjor(['-batch', '-export', '-sheets', String(k), '-output', bok,
        '--', path.join(bok, omr)], 600000);
      // Den nye eksporten er den .mxl-fila som IKKE alt er et nummerert ark.
      const laget = fs.readdirSync(bok).filter(function (f) {
        return /\.mxl$/i.test(f) && !/^ark-\d+\.mxl$/i.test(f);
      });
      if (!laget.length) continue;
      fs.renameSync(path.join(bok, laget[0]), mal);
      ok++; alleMxl++;
    }

    console.log(
      `${ok}/${ark} ark eksportert` +
      (daarlige.size ? `  (${daarlige.size} krasjet)` : '') +
      `  ${Math.round((Date.now() - t0) / 1000)} s`,
    );
  }
  console.log(`\nTil sammen ${alleMxl} MusicXML-filer i ${UT}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
