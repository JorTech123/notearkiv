'use strict';
/**
 * homr.js — kjoerer den nevrale notegjenkjenneren over arkivet.
 *
 * VIKTIG: den faar RAA sider, rett fra PDF-en, ikke de rensede bildene
 * i data/ut/sider.
 *
 * Det er ikke en detalj. Maalt paa «Hark, the Herald Angels Sing»,
 * side 1, mot Opuscans egen fil:
 *
 *     mine rensede bilder   87,1 %
 *     raa render            95,8 %
 *
 * Opprenskinga — flatfelt, nivaajustering, sotfjerning, opptegning av
 * notelinjer — er tunet for den regelbaserte detektoren min. En nevral
 * modell er trent paa vanlige noter og blir forvirret av den. Den rene
 * utgaven er fortsatt riktig til VISNING paa skjerm; den skal bare ikke
 * mates inn i gjenkjenneren.
 *
 * Opploesning betyr derimot lite: 1700, 2600 og 3400 px gav 262 noter
 * alle tre. Modellen normaliserer selv.
 *
 *   node tools/src/homr.js              hele arkivet
 *   node tools/src/homr.js "My Way"     bare ett stykke
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const pdf = require('./pdf.js');

const EXE = 'C:\\Prosjekter\\.tools\\python\\Scripts\\homr.exe';
const INN = 'data/musicxml-inn';
const PDF = 'data/pdf';
const UT = 'data/ut';
const BREDDE = 2600;        // god nok, og raskere enn full opploesning

function finnPdf(id) {
  if (!fs.existsSync(PDF)) return null;
  const treff = fs.readdirSync(PDF).find((f) => {
    const t = f.replace(/\.pdf$/i, '')
      .replace(/\s*\(Conflict[^)]*\)\s*/gi, '')
      .replace(/^\d+\s+/, '').trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    return t === id || t.startsWith(id) || id.startsWith(t);
  });
  return treff ? path.join(PDF, treff) : null;
}

/** Raa sider ut av PDF-en, uten noen form for opprensking. */
async function raaSider(sti, mappe) {
  const doc = await pdf.aapne(sti);
  const ut = [];
  try {
    for (let nr = 1; nr <= doc.numPages; nr++) {
      const r = await pdf.rasterSide(doc, nr, 300, 99999);
      const fil = path.join(mappe, `side-${String(nr).padStart(2, '0')}.jpg`);
      await sharp(Buffer.from(r.g.buffer, r.g.byteOffset, r.g.length),
        { raw: { width: r.b, height: r.h, channels: 1 } })
        .resize({ width: Math.min(BREDDE, r.b), kernel: 'lanczos3' })
        .jpeg({ quality: 94 })
        .toFile(fil);
      ut.push({ nr: nr, fil: fil });
    }
  } finally { await doc.destroy(); }
  return ut;
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`Fant ikke homr paa ${EXE}`);
    process.exit(1);
  }
  const bare = process.argv[2];
  const arkiv = JSON.parse(fs.readFileSync(`${UT}/arkiv.json`, 'utf8'));
  fs.mkdirSync(INN, { recursive: true });

  for (const stykke of arkiv.stykker) {
    if (bare && !stykke.tittel.toLowerCase().includes(bare.toLowerCase())) continue;

    const kilde = finnPdf(stykke.id);
    if (!kilde) { console.log(`${stykke.tittel}: ingen PDF`); continue; }

    const maalMappe = path.join(INN, stykke.id);
    fs.mkdirSync(maalMappe, { recursive: true });

    const arbeid = fs.mkdtempSync(path.join(os.tmpdir(), 'homr-raa-'));
    let sider;
    try { sider = await raaSider(kilde, arbeid); }
    catch (e) { console.log(`${stykke.tittel}: kunne ikke rastrere (${e.message})`); continue; }

    process.stdout.write(`${stykke.tittel} — ${sider.length} sider: `);
    const t0 = Date.now();
    let ok = 0;

    for (const side of sider) {
      const maal = path.join(maalMappe, `ark-${String(side.nr).padStart(2, '0')}.musicxml`);
      if (fs.existsSync(maal)) { ok++; process.stdout.write('.'); continue; }

      const r = spawnSync(EXE, [side.fil], {
        encoding: 'utf8', timeout: 1800000, windowsHide: true,
      });
      const laget = fs.readdirSync(arbeid)
        .filter((f) => /\.musicxml$/i.test(f))
        .map((f) => path.join(arbeid, f));
      if (laget.length) {
        fs.copyFileSync(laget[0], maal);
        for (const f of laget) fs.rmSync(f, { force: true });
        ok++; process.stdout.write('+');
      } else {
        process.stdout.write('-');
        const feil = ((r.stderr || '') + (r.stdout || '')).trim().split('\n').pop();
        if (feil) fs.writeFileSync(path.join(maalMappe, `feil-${side.nr}.txt`), feil);
      }
    }

    fs.rmSync(arbeid, { recursive: true, force: true });
    console.log(`  ${ok}/${sider.length} ark  ${Math.round((Date.now() - t0) / 1000)} s`);
  }

  console.log('\nKjoer deretter:  node tools/src/noter-fra-import.js');
}

main().catch((e) => { console.error(e); process.exit(1); });
