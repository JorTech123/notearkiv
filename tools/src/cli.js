'use strict';
/**
 * cli.js — kjoerer hele arkivet gjennom pipelinen.
 *
 *   node tools/src/cli.js                 behandler alt i data/inn
 *   node tools/src/cli.js <fil|mappe>     behandler det som er angitt
 *
 * Tar bade PDF (flersidig) og enkeltbilder. Resultat:
 * data/ut/sider/*.jpg og data/ut/arkiv.json, som public/ leser.
 *
 * Deteksjonen kjoerer paa 300 dpi, mens bildene som legges ut skaleres
 * ned: en iPad trenger ikke mer enn ~1700 px bredde, og strukturen
 * oppgis i full opploesning saa SVG-overlayet treffer uansett.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { behandleSide, tilJson } = require('./pipeline');
const pdf = require('./pdf');

const INN = 'data/inn';
const UT = 'data/ut';
const DPI = 300;
const NETT_BREDDE = 1700;
const BILDE = /\.(jpe?g|png|tiff?|webp)$/i;
const PDF = /\.pdf$/i;

/**
 * Standardoppsett for mannskor etter hvor mange staver systemet har.
 * En kvalifisert gjetning som skal kunne overstyres i korrekturen —
 * ikke noe som er lest ut av notene.
 */
const STEMMEOPPSETT = {
  1: ['melodi'],
  2: ['overstemme', 'understemme'],
  3: ['tenor', 'baryton', 'bass'],
  4: ['1. tenor', '2. tenor', 'baryton', 'bass'],
  5: ['1. tenor', '2. tenor', 'baryton', 'bass', 'piano'],
  6: ['1. tenor', '2. tenor', 'baryton', 'bass', 'piano h.h.', 'piano v.h.'],
};

/** Andel moerke piksler — brukes til aa kjenne igjen blanke sider. */
function blekkandel(g) {
  let moerk = 0;
  for (let i = 0; i < g.length; i++) if (g[i] < 160) moerk++;
  return moerk / g.length;
}

function slugg(s) {
  return s
    .replace(/\.[^.]+$/, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** Pen tittel ut av et filnavn: fjerner Jotta-konfliktmerker og rydder. */
function tittelFra(filnavn) {
  return filnavn
    .replace(/\.[^.]+$/, '')
    .replace(/\s*\(Conflict[^)]*\)\s*/gi, '')
    .replace(/^\d+\s+/, '')
    .trim();
}

function utledStemmer(sider) {
  let flest = 0;
  for (const side of sider) {
    for (const sys of side.struktur.systemer) {
      if (sys.staver.length > flest) flest = sys.staver.length;
    }
  }
  return STEMMEOPPSETT[flest] || STEMMEOPPSETT[4];
}

async function finnFiler(mal) {
  const stat = await fs.stat(mal).catch(() => null);
  if (!stat) return [];
  if (stat.isFile()) return [mal];
  const ut = [];
  for (const f of (await fs.readdir(mal)).sort()) {
    if (BILDE.test(f) || PDF.test(f)) ut.push(path.join(mal, f));
  }
  return ut;
}

/** Skriver et gratonebilde ned til nettstoerrelse. */
async function skrivNettbilde(bilde, b, h, sti) {
  const bredde = Math.min(NETT_BREDDE, b);
  await sharp(Buffer.from(bilde.buffer, bilde.byteOffset, bilde.length), {
    raw: { width: b, height: h, channels: 1 },
  })
    .resize({ width: bredde, kernel: 'lanczos3' })
    .jpeg({ quality: 86, mozjpeg: true })
    .toFile(sti);
}

async function main() {
  const mal = process.argv[2] || INN;
  const filer = await finnFiler(mal);
  if (!filer.length) {
    console.error(`Fant ingen PDF-er eller bilder i ${mal}.`);
    process.exit(1);
  }

  await fs.mkdir(`${UT}/sider`, { recursive: true });
  const katalog = [];

  for (const fil of filer) {
    const tittel = tittelFra(path.basename(fil));
    const id = slugg(tittel);
    const sider = [];

    if (PDF.test(fil)) {
      let nr = 0;
      for await (const side of pdf.sider(fil, DPI)) {
        process.stdout.write(`${tittel} — side ${side.nr}/${side.antall} … `);
        // Tosidige skann har blanke baksider. De skal ikke inn i arkivet,
        // og sidetallene skal telle videre uten hull.
        if (blekkandel(side.g) < 0.003) { console.log('blank, hoppet over'); continue; }
        nr++;
        try {
          const res = await behandleSide({ g: side.g, b: side.b, h: side.h });
          const utfil = `sider/${id}-${String(nr).padStart(3, '0')}.jpg`;
          await skrivNettbilde(res.bilde, res.b, res.h, `${UT}/${utfil}`);
          sider.push({ nr, fil: utfil, ...res });
          console.log(
            `${res.struktur.staver.length} staver, ${res.struktur.systemer.length} sys, ` +
            `${res.struktur.antallTakter} takter, ${res.logg.skjevhet}°`,
          );
        } catch (e) {
          console.log(`FEIL: ${e.message}`);
        }
      }
    } else {
      process.stdout.write(`${tittel} … `);
      try {
        const res = await behandleSide(fil);
        const utfil = `sider/${id}-001.jpg`;
        await skrivNettbilde(res.bilde, res.b, res.h, `${UT}/${utfil}`);
        sider.push({ nr: 1, fil: utfil, ...res });
        console.log(`${res.struktur.staver.length} staver, ${res.struktur.antallTakter} takter`);
      } catch (e) {
        console.log(`FEIL: ${e.message}`);
      }
    }

    if (!sider.length) continue;

    const stemmer = utledStemmer(sider);
    const oppfoering = {
      id, tittel, stemmer,
      antallSider: sider.length,
      antallTakter: sider.reduce((a, s) => a + s.struktur.antallTakter, 0),
      sider: sider.map((s) => ({
        nr: s.nr,
        fil: s.fil,
        ...tilJson(s.struktur, s.b, s.h),
      })),
    };

    // Merk stavene med stemmenavn, ovenfra og ned i hvert system.
    for (const side of oppfoering.sider) {
      for (const sys of side.systemer) {
        const sett = STEMMEOPPSETT[sys.staver.length] || stemmer;
        sys.staver.forEach((st, k) => { st.stemme = sett[k] || `stemme ${k + 1}`; });
      }
    }
    katalog.push(oppfoering);
  }

  const arkiv = {
    generert: new Date().toISOString(),
    antall: katalog.length,
    stykker: katalog,
  };
  await fs.writeFile(`${UT}/arkiv.json`, JSON.stringify(arkiv, null, 1), 'utf8');
  console.log(
    `\nSkrev ${UT}/arkiv.json — ${katalog.length} stykker, ` +
    `${katalog.reduce((a, s) => a + s.antallSider, 0)} sider.`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
