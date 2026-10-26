'use strict';
/**
 * prov-noter.js — tester notehodedeteksjonen paa en ekte side og legger
 * ut et kontrollbilde der hvert funn er ringet inn.
 *
 *   node tools/src/prov-noter.js data/ut/sider/my-way-001.jpg [stavnr]
 */

const sharp = require('sharp');
const N = require('../../public/noteanalyse.js');
const G = require('../../public/notegjenkjenning.js');

const UT = 'data/arbeid/kontroll';

async function main() {
  const fil = process.argv[2] || 'data/ut/sider/my-way-001.jpg';
  const bare = process.argv[3] ? parseInt(process.argv[3], 10) : null;

  const { data: g, info } = await sharp(fil).grayscale().raw()
    .toBuffer({ resolveWithObject: true });
  const b = info.width, h = info.height;

  const bin = N.terskle(g, 150);
  const st = N.analyser(bin, b, h);
  console.log(`${fil}  ${b}x${h}`);
  console.log(`  ${st.staver.length} staver, ${st.systemer.length} systemer, ` +
              `${st.antallTakter} takter, linjeavstand ${st.mal.avstand}`);

  const uten = G.fjernNotelinjer(bin, b, h, st.staver, st.mal.tykkelse);
  const foer = bin.reduce((a, v) => a + v, 0);
  const etter = uten.reduce((a, v) => a + v, 0);
  console.log(`  notelinjer fjernet: ${(100 - etter / foer * 100).toFixed(1)} % av blekket`);

  // Fargelagt kontrollbilde
  const rgb = new Uint8Array(b * h * 3);
  for (let i = 0; i < b * h; i++) {
    const v = uten[i] ? 40 : 252;
    rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v;
  }
  const ring = (cx, cy, r, farge) => {
    for (let a = 0; a < 360; a += 3) {
      const x = Math.round(cx + Math.cos(a * Math.PI / 180) * r);
      const y = Math.round(cy + Math.sin(a * Math.PI / 180) * r * 0.8);
      for (let d = 0; d < 2; d++) {
        const yy = y + d;
        if (x < 0 || x >= b || yy < 0 || yy >= h) continue;
        const j = (yy * b + x) * 3;
        rgb[j] = farge[0]; rgb[j + 1] = farge[1]; rgb[j + 2] = farge[2];
      }
    }
  };

  let total = 0;
  st.staver.forEach((stav, i) => {
    if (bare !== null && i !== bare) return;
    const nokkel = G.finnNokkel(uten, b, h, stav, st.mal);
    const hoder = G.finnNotehoder(uten, b, h, stav, st.mal, st.omraade);
    total += hoder.length;
    const fylte = hoder.filter((n) => n.fylt).length;
    console.log(
      `  stav ${String(i).padStart(2)}  y ${Math.round(stav.yTopp)}-${Math.round(stav.yBunn)}` +
      `  noekkel ${nokkel}  ${String(hoder.length).padStart(3)} notehoder ` +
      `(${fylte} fylte, ${hoder.length - fylte} hule)`,
    );
    for (const n of hoder) {
      ring(n.x, n.y, stav.avstand * 0.75, n.fylt ? [220, 40, 0] : [0, 120, 230]);
    }
  });
  console.log(`  til sammen ${total} notehoder`);

  await require('node:fs/promises').mkdir(UT, { recursive: true });
  await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length),
    { raw: { width: b, height: h, channels: 3 } })
    .png({ compressionLevel: 9 }).toFile(`${UT}/notehoder.png`);
  console.log(`  skrev ${UT}/notehoder.png (roed = fylt, blaa = hul)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
