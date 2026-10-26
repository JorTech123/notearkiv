'use strict';
/**
 * prov.js — kjoerer hele kjeden paa ett bilde og legger ut tre filer:
 *   <navn>-renset.png   opprensket svart/hvitt
 *   <navn>-kontroll.png fargelagt overlay som viser hva som ble funnet
 * Brukes til aa se med egne oeyne at deteksjonen treffer.
 *
 *   node tools/src/prov.js data/arbeid/prover/my-way.jpg
 */

const path = require('node:path');
const sharp = require('sharp');
const R = require('./rens');
const N = require('./noter');

const FARGE = {
  stav: [0, 140, 255],
  system: [255, 60, 160],
  takt: [40, 190, 90],
  ramme: [255, 170, 0],
};

function tilRgb(g, b, h) {
  const rgb = new Uint8Array(b * h * 3);
  for (let i = 0; i < b * h; i++) {
    // Toner ned bakgrunnen saa overlay-fargene leses tydelig.
    const v = 255 - (255 - g[i]) * 0.45;
    rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v;
  }
  return rgb;
}

function strekH(rgb, b, h, y, x0, x1, farge, tjukk = 1) {
  for (let d = 0; d < tjukk; d++) {
    const yy = Math.round(y) + d;
    if (yy < 0 || yy >= h) continue;
    for (let x = Math.max(0, Math.round(x0)); x <= Math.min(b - 1, Math.round(x1)); x++) {
      const i = (yy * b + x) * 3;
      rgb[i] = farge[0]; rgb[i + 1] = farge[1]; rgb[i + 2] = farge[2];
    }
  }
}

function strekV(rgb, b, h, x, y0, y1, farge, tjukk = 1) {
  for (let d = 0; d < tjukk; d++) {
    const xx = Math.round(x) + d;
    if (xx < 0 || xx >= b) continue;
    for (let y = Math.max(0, Math.round(y0)); y <= Math.min(h - 1, Math.round(y1)); y++) {
      const i = (y * b + xx) * 3;
      rgb[i] = farge[0]; rgb[i + 1] = farge[1]; rgb[i + 2] = farge[2];
    }
  }
}

async function main() {
  const inn = process.argv[2];
  if (!inn) { console.error('bruk: node tools/src/prov.js <bilde>'); process.exit(1); }
  const navn = path.basename(inn).replace(/\.[^.]+$/, '');
  const utMappe = 'data/arbeid/kontroll';
  await require('node:fs/promises').mkdir(utMappe, { recursive: true });

  const t0 = Date.now();
  let { g, b, h } = await R.lesGratone(inn);
  console.log(`${navn}  ${b}x${h}`);

  const kant = R.fjernKantskygge(g, b, h);
  if (kant.venstre || kant.hoyre) console.log(`  kantskygge fjernet  v=${kant.venstre} h=${kant.hoyre}`);

  let bin = R.sauvola(g, b, h);
  const grov = N.anslaaAvstand(bin, b, h);

  const vinkel = R.finnSkjevhet(bin, b, h);
  console.log(`  skjevhet            ${vinkel.toFixed(2)} grader`);
  if (Math.abs(vinkel) >= 0.05) {
    g = R.roter(g, b, h, -vinkel);
    bin = R.sauvola(g, b, h);
  }

  const struktur = N.analyser(bin, b, h);
  const mal = struktur.mal;
  console.log(`  linjeavstand        ${mal.avstand}px  tykkelse ${mal.tykkelse}px  (grov: ${grov.avstand})`);
  console.log(`  notelinjer funnet   ${struktur.antallLinjer}`);
  if (process.env.DIAG) {
    const N2 = require('./noter');
    const ls = N2.finnNotelinjer(bin, b, h, mal);
    console.log('  linje-y:', ls.slice(0, 26).map((l) => Math.round(l.y)).join(' '));
    const gaps = [];
    for (let i = 1; i < Math.min(26, ls.length); i++) gaps.push(Math.round(ls[i].y - ls[i - 1].y));
    console.log('  gap:    ', gaps.join(' '));
  }
  console.log(`  staver              ${struktur.staver.length}`);
  console.log(`  systemer            ${struktur.systemer.length}  [${struktur.systemer.map(s => s.staver.length).join(', ')} staver]`);
  console.log(`  takter              ${struktur.antallTakter}`);

  const sot = R.fjernSot(bin, b, h, mal.avstand);
  console.log(`  sot fjernet         ${sot.fjernet} komponenter (minareal ${sot.minAreal}px)`);

  const alleLinjer = struktur.staver.flatMap((s) => s.linjer);
  const fylt = R.reparerLinjer(bin, b, h, alleLinjer, Math.round(mal.avstand * 2.5));
  console.log(`  linjehull fylt      ${fylt}px`);

  // --- filer ut ---
  const renset = R.binTilGratone(bin, b, h);
  await R.skrivGratone(renset, b, h, `${utMappe}/${navn}-renset.png`);

  const rgb = tilRgb(renset, b, h);
  for (const s of struktur.systemer) {
    strekV(rgb, b, h, 6, s.yTopp, s.yBunn, FARGE.system, 5);
    for (const st of s.staver) {
      strekH(rgb, b, h, st.yTopp, 14, b - 14, FARGE.stav, 1);
      strekH(rgb, b, h, st.yBunn, 14, b - 14, FARGE.stav, 1);
    }
    for (const x of s.taktstreker || []) strekV(rgb, b, h, x, s.yTopp, s.yBunn, FARGE.takt, 2);
    for (const t of s.takter || []) {
      strekH(rgb, b, h, s.yTopp - mal.avstand, t.x0, t.x1, FARGE.ramme, 2);
    }
  }
  await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length), {
    raw: { width: b, height: h, channels: 3 },
  }).png({ compressionLevel: 9 }).toFile(`${utMappe}/${navn}-kontroll.png`);

  console.log(`  ferdig paa          ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
