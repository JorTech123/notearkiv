'use strict';
/**
 * prov-varighet.js — kontrollbilde for varighetslesinga.
 *
 * Tegner hvert funnet notehode med halsen sin og skriver den leste
 * varigheten ved siden av, saa den kan holdes opp mot noten med oeyet.
 *
 *   node tools/src/prov-varighet.js data/ut/sider/my-way-001.jpg [stav]
 */

const sharp = require('sharp');
const N = require('../../public/noteanalyse.js');
const G = require('../../public/notegjenkjenning.js');

const UT = 'data/arbeid/kontroll';

// Ett bittelite 5x7-siffer per tegn, nok til aa merke av varigheter.
const SIFFER = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '8': ['111', '101', '111', '101', '111'],
  '.': ['000', '000', '000', '000', '010'],
  '/': ['001', '001', '010', '100', '100'],
};

function skrivTekst(rgb, b, h, x, y, tekst, farge) {
  let dx = 0;
  for (const tegn of tekst) {
    const m = SIFFER[tegn];
    if (!m) { dx += 4; continue; }
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (m[r][c] !== '1') continue;
        for (let s = 0; s < 2; s++) {
          for (let t = 0; t < 2; t++) {
            const px = x + dx + c * 2 + s, py = y + r * 2 + t;
            if (px < 0 || px >= b || py < 0 || py >= h) continue;
            const i = (py * b + px) * 3;
            rgb[i] = farge[0]; rgb[i + 1] = farge[1]; rgb[i + 2] = farge[2];
          }
        }
      }
    }
    dx += 8;
  }
}

function strek(rgb, b, h, x0, y0, x1, y1, farge) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + (x1 - x0) * i / n);
    const y = Math.round(y0 + (y1 - y0) * i / n);
    for (let d = 0; d < 2; d++) {
      const px = x + d;
      if (px < 0 || px >= b || y < 0 || y >= h) continue;
      const j = (y * b + px) * 3;
      rgb[j] = farge[0]; rgb[j + 1] = farge[1]; rgb[j + 2] = farge[2];
    }
  }
}

function varighetTekst(v) {
  if (Math.abs(v - 4) < 0.01) return '4';
  if (Math.abs(v - 3) < 0.01) return '3';
  if (Math.abs(v - 2) < 0.01) return '2';
  if (Math.abs(v - 1.5) < 0.01) return '15';
  if (Math.abs(v - 1) < 0.01) return '1';
  if (Math.abs(v - 0.75) < 0.01) return '08';
  if (Math.abs(v - 0.5) < 0.01) return '05';
  if (Math.abs(v - 0.25) < 0.01) return '03';
  return String(Math.round(v * 100) / 100);
}

async function main() {
  const fil = process.argv[2] || 'data/ut/sider/my-way-001.jpg';
  const bare = process.argv[3] ? parseInt(process.argv[3], 10) : null;

  const { data: g, info } = await sharp(fil).grayscale().raw()
    .toBuffer({ resolveWithObject: true });
  const b = info.width, h = info.height;
  const bin = N.terskle(g, 150);
  const st = N.analyser(bin, b, h);
  const uten = G.fjernNotelinjer(bin, b, h, st.staver, st.mal.tykkelse);

  const rgb = new Uint8Array(b * h * 3);
  for (let i = 0; i < b * h; i++) {
    const v = uten[i] ? 30 : 250;
    rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v;
  }

  const telling = {};
  st.staver.forEach((stav, i) => {
    if (bare !== null && i !== bare) return;
    const lest = G.lesStav(uten, b, h, stav, st.mal, st.omraade);
    for (const n of lest.noter) {
      const sp = stav.avstand;
      // notehode
      for (let a = 0; a < 360; a += 4) {
        const x = Math.round(n.x + Math.cos(a * Math.PI / 180) * sp * 0.7);
        const y = Math.round(n.y + Math.sin(a * Math.PI / 180) * sp * 0.55);
        if (x < 0 || x >= b || y < 0 || y >= h) continue;
        const j = (y * b + x) * 3;
        rgb[j] = 215; rgb[j + 1] = 45; rgb[j + 2] = 0;
      }
      // hals
      if (n.hals) {
        const hx = n.x + (n.hals < 0 ? sp * 0.52 : -sp * 0.52);
        strek(rgb, b, h, hx, n.y, hx, n.y + n.hals * n.halsLengde, [0, 130, 230]);
      }
      // bjelker som korte merker ved tuppen
      for (let k = 0; k < n.bjelker; k++) {
        const hx = n.x + (n.hals < 0 ? sp * 0.52 : -sp * 0.52);
        const ty = n.y + n.hals * n.halsLengde + n.hals * (-k * sp * 0.4);
        strek(rgb, b, h, hx, ty, hx + sp * 1.1, ty, [230, 150, 0]);
      }
      const t = varighetTekst(n.varighet);
      telling[t] = (telling[t] || 0) + 1;
      skrivTekst(rgb, b, h, Math.round(n.x - 6), Math.round(n.y - sp * 2.4), t, [0, 140, 60]);
    }
    console.log(
      `  stav ${String(i).padStart(2)}  noekkel ${lest.nokkel}  ${String(lest.noter.length).padStart(3)} noter  ` +
      `halser ${lest.noter.filter((n) => n.hals).length}  ` +
      `bjelker ${lest.noter.filter((n) => n.bjelker).length}  ` +
      `punkt ${lest.noter.filter((n) => n.punkt).length}`,
    );
  });

  console.log('\n  varigheter:', Object.keys(telling).sort()
    .map((k) => k + ':' + telling[k]).join('  '));

  await require('node:fs/promises').mkdir(UT, { recursive: true });
  await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length),
    { raw: { width: b, height: h, channels: 3 } })
    .png({ compressionLevel: 9 }).toFile(`${UT}/varighet.png`);
  console.log(`  skrev ${UT}/varighet.png`);
}

main().catch((e) => { console.error(e); process.exit(1); });
