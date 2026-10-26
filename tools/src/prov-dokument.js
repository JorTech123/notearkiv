'use strict';
/**
 * prov-dokument.js — tester dokumentdeteksjonen mot kunstige scener.
 *
 * Legger en ekte notside skjevt paa et lyst, teksturert underlag, slik
 * Joergen fotograferte den. Underlaget er med vilje like lyst som arket:
 * det var akkurat der den gamle lysstyrkebaserte metoden feilet.
 *
 * Skriver kontrollbilder til data/arbeid/kontroll/diag-*.jpg:
 * groenn ramme er fasit, oransje er det deteksjonen fant.
 *
 *   node tools/src/prov-dokument.js
 */

const sharp = require('sharp');
const D = require('../../public/dokument.js');
const N = require('../../public/noteanalyse.js');

const UT = 'data/arbeid/kontroll';
const SB = 1200, SH = 1600;

/**
 * Treaktig underlag: lyst, med aaremoenster og stoey.
 *
 * Aaringa maa boelge. Perfekt rette striper over hele bredden finnes
 * ikke i ekte treverk, men de gir linjer som slaar arkkanten i Hough —
 * og da tester man mot en fiende som ikke finnes.
 */
function underlag(b, h, froe) {
  const g = new Uint8Array(b * h);
  let s = froe;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < b; x++) {
      const fase = y * 0.05 + Math.sin(x * 0.004) * 2.4 + Math.sin(x * 0.0017) * 5;
      const aare = Math.sin(fase) * 11 + Math.sin(fase * 3.1) * 4;
      const flekk = Math.sin(x * 0.009 + y * 0.003) * 6;
      g[y * b + x] = Math.max(0, Math.min(255, 182 + aare + flekk + (rnd() - 0.5) * 20));
    }
  }
  return g;
}

/** En rett kant i bildet — bordkant, bokrygg, kanten av et naboark. */
function forstyrrelse(g, b, h, x0, y0, x1, y1, moerkere) {
  const n = Math.round(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + (x1 - x0) * i / n);
    const y = Math.round(y0 + (y1 - y0) * i / n);
    for (let d = -1; d <= 1; d++) {
      const yy = y + d;
      if (x < 0 || x >= b || yy < 0 || yy >= h) continue;
      g[yy * b + x] = Math.max(0, g[yy * b + x] - moerkere);
    }
  }
}

/** Legger sida inn i scena med perspektiv. */
function leggInn(scene, sb, sh, side, pb, ph, hjorner) {
  const H = D.homografi(hjorner, [[0, 0], [pb - 1, 0], [pb - 1, ph - 1], [0, ph - 1]]);
  const xs = hjorner.map((p) => p[0]), ys = hjorner.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min.apply(null, xs)) - 2);
  const x1 = Math.min(sb - 1, Math.ceil(Math.max.apply(null, xs)) + 2);
  const y0 = Math.max(0, Math.floor(Math.min.apply(null, ys)) - 2);
  const y1 = Math.min(sh - 1, Math.ceil(Math.max.apply(null, ys)) + 2);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const w = H[6] * x + H[7] * y + H[8];
      const u = (H[0] * x + H[1] * y + H[2]) / w;
      const v = (H[3] * x + H[4] * y + H[5]) / w;
      if (u < 0 || v < 0 || u >= pb - 1 || v >= ph - 1) continue;
      const u0 = u | 0, v0 = v | 0, fu = u - u0, fv = v - v0;
      const i = v0 * pb + u0;
      scene[y * sb + x] =
        side[i] * (1 - fu) * (1 - fv) + side[i + 1] * fu * (1 - fv) +
        side[i + pb] * (1 - fu) * fv + side[i + pb + 1] * fu * fv;
    }
  }
}

/** Tegner fasit (groenn) og funn (oransje) oppaa scena. */
async function tegnKontroll(scene, b, h, fasit, funnet, navn) {
  const rgb = new Uint8Array(b * h * 3);
  for (let i = 0; i < b * h; i++) {
    rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = scene[i];
  }
  const strek = (a, c, farge) => {
    const n = 900;
    for (let i = 0; i <= n; i++) {
      const x = Math.round(a[0] + (c[0] - a[0]) * i / n);
      const y = Math.round(a[1] + (c[1] - a[1]) * i / n);
      for (let d = -2; d <= 2; d++) {
        const yy = y + d;
        if (x < 0 || x >= b || yy < 0 || yy >= h) continue;
        const j = (yy * b + x) * 3;
        rgb[j] = farge[0]; rgb[j + 1] = farge[1]; rgb[j + 2] = farge[2];
      }
    }
  };
  for (let i = 0; i < 4; i++) strek(fasit[i], fasit[(i + 1) % 4], [0, 210, 0]);
  if (funnet) for (let i = 0; i < 4; i++) strek(funnet[i], funnet[(i + 1) % 4], [255, 70, 0]);

  await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length),
    { raw: { width: b, height: h, channels: 3 } })
    .resize({ width: 480 }).jpeg({ quality: 80 })
    .toFile(UT + '/diag-' + navn + '.jpg');
}

function avvik(funnet, fasit) {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    sum += Math.hypot(funnet[i][0] - fasit[i][0], funnet[i][1] - fasit[i][1]);
  }
  return sum / 4;
}

const TILFELLER = [
  { navn: 'rett-paa', hj: [[150, 130], [1050, 128], [1052, 1470], [148, 1472]] },
  { navn: 'skjev-og-dreid', hj: [[205, 190], [1010, 140], [1070, 1425], [160, 1380]] },
  { navn: 'kraftig-perspektiv', hj: [[260, 250], [980, 170], [1090, 1380], [140, 1290]] },
  { navn: 'lite-ark', hj: [[330, 430], [880, 410], [900, 1230], [310, 1240]] },
  {
    navn: 'med-bordkant',
    hj: [[190, 210], [1000, 175], [1030, 1400], [170, 1420]],
    kant: [60, 40, 1150, 95],
  },
];

async function main() {
  const { data: side, info } = await sharp('data/ut/sider/my-way-001.jpg')
    .grayscale().raw().toBuffer({ resolveWithObject: true });
  const pb = info.width, ph = info.height;

  await require('node:fs/promises').mkdir(UT, { recursive: true });
  console.log('scene ' + SB + 'x' + SH + ', ark paa lyst treunderlag\n');

  for (const t of TILFELLER) {
    const scene = underlag(SB, SH, 7);
    if (t.kant) forstyrrelse(scene, SB, SH, t.kant[0], t.kant[1], t.kant[2], t.kant[3], 55);
    leggInn(scene, SB, SH, side, pb, ph, t.hj);

    const funnet = D.finnDokument(scene, SB, SH);
    await tegnKontroll(scene, SB, SH, t.hj, funnet, t.navn);

    if (!funnet) { console.log(t.navn.padEnd(22) + ' FANT INGENTING'); continue; }

    const a = avvik(funnet, t.hj);
    const mal = D.maalStorrelse(funnet, 2200);
    const rettet = D.rettUt(scene, SB, SH, funnet, mal.b, mal.h);
    const st = N.analyser(N.terskle(rettet, 150), mal.b, mal.h);

    console.log(
      t.navn.padEnd(22) +
      ' avvik ' + a.toFixed(1).padStart(6) + ' px  ' +
      mal.b + 'x' + mal.h + '  ' +
      String(st.staver.length).padStart(2) + ' staver, ' +
      st.systemer.length + ' sys, ' + st.antallTakter + ' takter',
    );

    await sharp(Buffer.from(rettet.buffer, rettet.byteOffset, rettet.length),
      { raw: { width: mal.b, height: mal.h, channels: 1 } })
      .jpeg({ quality: 80 }).toFile(UT + '/dok-' + t.navn + '.jpg');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
