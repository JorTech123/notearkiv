'use strict';
/**
 * rens.js — bildeprimitiver og opprensking av scannede noter.
 *
 * Kjeden er: gratone -> sauvola -> finnSkjevhet/roter -> finnNotelinjer
 *            -> fjernSot -> reparerLinjer -> skriv ut.
 *
 * Alt regnes paa raa 8-bits gratonebuffere. 1 = blekk, 0 = papir i
 * binaerbuffere, slik at projeksjoner blir rene summer.
 */

const sharp = require('sharp');
// tynnMaske er ren regning og bor i den delte analysefila.
const { tynnMaske } = require('../../public/noteanalyse.js');

// ---------------------------------------------------------------- inn og ut

async function lesGratone(sti) {
  const { data, info } = await sharp(sti)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { g: data, b: info.width, h: info.height };
}

async function skrivGratone(g, b, h, sti, kvalitet = 92) {
  const bilde = sharp(Buffer.from(g.buffer, g.byteOffset, g.length), {
    raw: { width: b, height: h, channels: 1 },
  });
  if (/\.png$/i.test(sti)) return bilde.png({ compressionLevel: 9 }).toFile(sti);
  return bilde.jpeg({ quality: kvalitet }).toFile(sti);
}

/** Binaerbuffer (1=blekk) tilbake til hvit bakgrunn med sort blekk. */
function binTilGratone(bin, b, h) {
  const g = new Uint8Array(b * h);
  for (let i = 0; i < g.length; i++) g[i] = bin[i] ? 0 : 255;
  return g;
}

// ------------------------------------------------------------ binarisering

/**
 * Sauvola adaptiv terskling via integralbilder. Taaler ujevn
 * scannerbelysning og bokrygg-skygge, som global Otsu ikke gjoer.
 */
function sauvola(g, b, h, vindu, k = 0.2) {
  if (!vindu) vindu = Math.max(15, Math.round(b / 40) | 1);
  const r = vindu >> 1;
  const bb = b + 1;
  const sum = new Float64Array(bb * (h + 1));
  const sum2 = new Float64Array(bb * (h + 1));

  for (let y = 0; y < h; y++) {
    const rad = y * b;
    const n = (y + 1) * bb;
    const f = y * bb;
    for (let x = 0; x < b; x++) {
      const v = g[rad + x];
      sum[n + x + 1] = v + sum[n + x] + sum[f + x + 1] - sum[f + x];
      sum2[n + x + 1] = v * v + sum2[n + x] + sum2[f + x + 1] - sum2[f + x];
    }
  }

  const bin = new Uint8Array(b * h);
  const R = 128;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    const a = y0 * bb;
    const c = (y1 + 1) * bb;
    for (let x = 0; x < b; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(b - 1, x + r);
      const n = (x1 + 1 - x0) * (y1 + 1 - y0);
      const s = sum[c + x1 + 1] - sum[c + x0] - sum[a + x1 + 1] + sum[a + x0];
      const s2 = sum2[c + x1 + 1] - sum2[c + x0] - sum2[a + x1 + 1] + sum2[a + x0];
      const snitt = s / n;
      const varians = Math.max(0, s2 / n - snitt * snitt);
      const terskel = snitt * (1 + k * (Math.sqrt(varians) / R - 1));
      bin[y * b + x] = g[y * b + x] < terskel ? 1 : 0;
    }
  }
  return bin;
}

/**
 * Bakgrunnsdivisjon («flatfelt»). Et kraftig uskarpt bilde er et godt
 * estimat av papiret med all ujevn belysning, gulning og bokrygg-skygge.
 * Deler vi originalen paa det, blir papiret jevnt hvitt mens blekket
 * staar igjen. Dette er det samme grepet skannerprogrammer bruker, og
 * det er langt skaansommere enn hard terskling: gråtonene i notehoder og
 * tekst beholdes, saa resultatet ser trykt ut i stedet for oppstykket.
 */
async function flatfelt(g, b, h, sigma, loft = 1.0) {
  const bakgrunn = await sharp(Buffer.from(g.buffer, g.byteOffset, g.length), {
    raw: { width: b, height: h, channels: 1 },
  }).blur(sigma).raw().toBuffer();

  const ut = new Uint8Array(b * h);
  for (let i = 0; i < g.length; i++) {
    const bg = Math.max(1, bakgrunn[i]);
    let v = (g[i] / bg) * 255 * loft;
    ut[i] = v > 255 ? 255 : v < 0 ? 0 : v;
  }
  return ut;
}

/**
 * Strekker kontrasten slik at papiret blir rent hvitt og blekket helt
 * sort, med en myk overgang imellom. svart/hvit er innslagspunkter i
 * 0–255; alt over hvit blir 255, alt under svart blir 0.
 */
function kontrast(g, svart, hvit) {
  const ut = new Uint8Array(g.length);
  const spenn = Math.max(1, hvit - svart);
  for (let i = 0; i < g.length; i++) {
    let v = ((g[i] - svart) / spenn) * 255;
    ut[i] = v > 255 ? 255 : v < 0 ? 0 : v;
  }
  return ut;
}

/** Finner fornuftige innslagspunkter fra histogrammet. */
function autoNivaa(g) {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const n = g.length;
  // Papiret er den klart vanligste verdien i oevre halvdel.
  let papir = 200, best = -1;
  for (let v = 128; v < 256; v++) if (hist[v] > best) { best = hist[v]; papir = v; }
  // Blekkpunktet: 0,5-persentilen nedenfra.
  let sum = 0, blekk = 0;
  for (let v = 0; v < 256; v++) { sum += hist[v]; if (sum >= n * 0.005) { blekk = v; break; } }
  return { svart: Math.min(papir - 30, blekk + 18), hvit: Math.max(papir - 12, 140) };
}

/** Global Otsu — brukes bare til aa anslaa hvor mye blekk sida har. */
function otsu(g) {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const n = g.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, terskel = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const mellom = wB * wF * (mB - mF) * (mB - mF);
    if (mellom > best) { best = mellom; terskel = t; }
  }
  return terskel;
}

// ----------------------------------------------------------------- skjevhet

/**
 * Finner skjevhet ved aa skjaere bildet for ulike vinkler og maale hvor
 * «spiss» den horisontale projeksjonen blir. Notelinjer gir et kraftig
 * utslag, saa dette treffer paa noter selv naar vanlig tekstdeskew bommer.
 */
function finnSkjevhet(bin, b, h, maksGrader = 4, steg = 0.1) {
  const hopp = Math.max(1, Math.floor((b * h) / 400000));
  const punkt = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < b; x += hopp) {
      if (bin[y * b + x]) punkt.push(x, y);
    }
  }
  if (punkt.length < 200) return 0;

  const midtX = b / 2;
  let beste = 0, besteScore = -1;
  for (let grad = -maksGrader; grad <= maksGrader + 1e-9; grad += steg) {
    const tan = Math.tan((grad * Math.PI) / 180);
    const prof = new Float64Array(h + 1);
    for (let i = 0; i < punkt.length; i += 2) {
      const y = punkt[i + 1] - (punkt[i] - midtX) * tan;
      const yi = y | 0;
      if (yi >= 0 && yi < h) prof[yi]++;
    }
    let score = 0;
    for (let i = 0; i < h; i++) score += prof[i] * prof[i];
    if (score > besteScore) { besteScore = score; beste = grad; }
  }
  return beste;
}

/** Roterer gratonebildet om midten, beholder dimensjoner, hvitt utenfor. */
function roter(g, b, h, grader) {
  if (Math.abs(grader) < 0.02) return g;
  const rad = (grader * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = b / 2, cy = h / 2;
  const ut = new Uint8Array(b * h).fill(255);
  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    for (let x = 0; x < b; x++) {
      const dx = x - cx;
      const sx = cx + dx * cos + dy * sin;
      const sy = cy - dx * sin + dy * cos;
      if (sx < 0 || sy < 0 || sx >= b - 1 || sy >= h - 1) continue;
      const x0 = sx | 0, y0 = sy | 0;
      const fx = sx - x0, fy = sy - y0;
      const i = y0 * b + x0;
      ut[y * b + x] =
        g[i] * (1 - fx) * (1 - fy) + g[i + 1] * fx * (1 - fy) +
        g[i + b] * (1 - fx) * fy + g[i + b + 1] * fx * fy;
    }
  }
  return ut;
}

// ------------------------------------------------- sammenhengende komponenter

/**
 * 8-naboskap merking, iterativ (ingen rekursjon — sider kan ha
 * hundretusenvis av komponenter). Returnerer merker + statistikk.
 */
function merkKomponenter(bin, b, h) {
  const merke = new Int32Array(b * h).fill(-1);
  const ko = new Int32Array(b * h);
  const boks = [];
  let neste = 0;

  for (let start = 0; start < bin.length; start++) {
    if (!bin[start] || merke[start] !== -1) continue;
    const id = neste++;
    let hode = 0, hale = 0;
    ko[hale++] = start;
    merke[start] = id;
    let x0 = start % b, x1 = x0, y0 = (start / b) | 0, y1 = y0, areal = 0;

    while (hode < hale) {
      const p = ko[hode++];
      const px = p % b, py = (p / b) | 0;
      areal++;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= b) continue;
          const q = ny * b + nx;
          if (bin[q] && merke[q] === -1) { merke[q] = id; ko[hale++] = q; }
        }
      }
    }
    boks.push({ id, x0, y0, x1, y1, areal, bredde: x1 - x0 + 1, hoyde: y1 - y0 + 1 });
  }
  return { merke, boks, antall: neste };
}

// -------------------------------------------------------------- kopi-sot

/**
 * Fjerner kopi-sot: smaa, isolerte flekker. Terskelen skaleres med
 * notelinjeavstanden, slik at staccatoprikker og punkteringer (som er
 * vesentlig stoerre enn sot) blir staaende.
 */
function fjernSot(bin, b, h, avstand, komponenter, omraade) {
  const { merke, boks } = komponenter || merkKomponenter(bin, b, h);
  const minAreal = Math.max(6, Math.round(0.15 * avstand * avstand));
  const maksSide = Math.max(3, Math.round(avstand * 0.55));

  // Utenfor notebildet finnes det ingen musikk aa miste, saa der kan vi
  // fjerne langt stoerre flekker enn inne mellom notelinjene.
  const margAreal = Math.max(minAreal, Math.round(1.6 * avstand * avstand));
  const utenfor = (k) =>
    omraade &&
    (k.x1 < omraade.x0 - avstand * 1.5 || k.x0 > omraade.x1 + avstand * 1.5 ||
     k.y1 < omraade.y0 - avstand * 1.5 || k.y0 > omraade.y1 + avstand * 1.5);

  const slett = new Uint8Array(boks.length);
  let fjernet = 0;
  for (const k of boks) {
    const liten = k.areal <= minAreal && k.bredde <= maksSide && k.hoyde <= maksSide;
    // Tynne, spinkle streker fra skitten glassplate: lang men nesten uten blekk.
    const spinkel =
      k.areal < avstand * 0.8 &&
      (k.bredde <= 2 || k.hoyde <= 2) &&
      Math.max(k.bredde, k.hoyde) < avstand * 1.5;
    const marg = utenfor(k) && k.areal <= margAreal;
    if (liten || spinkel || marg) { slett[k.id] = 1; fjernet++; }
  }
  if (fjernet) {
    for (let i = 0; i < bin.length; i++) {
      if (bin[i] && slett[merke[i]]) bin[i] = 0;
    }
  }
  return { fjernet, minAreal };
}

/**
 * Lukker hull i notelinjer og notehoder: morfologisk lukking (dilater,
 * så eroder) med et lite element. Kjoeres etter sotfjerning saa stoey
 * ikke vokser.
 */
function lukk(bin, b, h, r = 1) {
  const d = dilater(bin, b, h, r);
  return eroder(d, b, h, r);
}

function dilater(bin, b, h, r) {
  const ut = new Uint8Array(b * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < b; x++) {
      let paa = 0;
      for (let dy = -r; dy <= r && !paa; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= b) continue;
          if (bin[ny * b + nx]) { paa = 1; break; }
        }
      }
      ut[y * b + x] = paa;
    }
  }
  return ut;
}

function eroder(bin, b, h, r) {
  const ut = new Uint8Array(b * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < b; x++) {
      let alle = 1;
      for (let dy = -r; dy <= r && alle; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) { alle = 0; break; }
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= b || !bin[ny * b + nx]) { alle = 0; break; }
        }
      }
      ut[y * b + x] = alle;
    }
  }
  return ut;
}

/**
 * Reparerer horisontale brudd i notelinjene. For hver kjente linje-y
 * fylles hull som er kortere enn maksHull, saa lenge det finnes blekk
 * paa begge sider i et smalt vindu rundt linja.
 */
function reparerLinjer(bin, b, h, linjer, maksHull) {
  let fylt = 0;
  for (const linje of linjer) {
    const yMidt = Math.round(linje.y);
    const tjukk = Math.max(1, Math.round(linje.tykkelse));
    const yFra = Math.max(0, yMidt - tjukk);
    const yTil = Math.min(h - 1, yMidt + tjukk);

    // Kollaps baandet til en 1-bits profil: er det blekk i kolonnen?
    const paa = new Uint8Array(b);
    for (let x = 0; x < b; x++) {
      for (let y = yFra; y <= yTil; y++) {
        if (bin[y * b + x]) { paa[x] = 1; break; }
      }
    }
    let x = 0;
    while (x < b) {
      if (paa[x]) { x++; continue; }
      let slutt = x;
      while (slutt < b && !paa[slutt]) slutt++;
      const lengde = slutt - x;
      if (x > 0 && slutt < b && lengde <= maksHull) {
        for (let i = x; i < slutt; i++) {
          bin[yMidt * b + i] = 1;
          fylt++;
        }
      }
      x = slutt;
    }
  }
  return fylt;
}

/**
 * Tegner notelinjene opp paa nytt: en ren, sammenhengende strek i maalt
 * tykkelse over stavens faktiske bredde. Dette er selve «linjeopprenskinga»
 * — en fotokopiert notelinje er stiplet og ujevn, mens posisjonen er kjent
 * med underpikselpresisjon fra deteksjonen.
 */
function tegnOppLinjer(bin, b, h, staver, tykkelse) {
  let tegnet = 0;
  for (const stav of staver) {
    // Stavens bredde: medianen av de linjene som faktisk ble maalt.
    const maalte = stav.linjer.filter((l) => !l.rekonstruert && l.x1 > l.x0);
    if (!maalte.length) continue;
    const midt = (arr) => arr.sort((a, c) => a - c)[arr.length >> 1];
    const x0 = Math.max(0, midt(maalte.map((l) => l.x0)));
    const x1 = Math.min(b - 1, midt(maalte.map((l) => l.x1)));
    if (x1 - x0 < 20) continue;

    const t = Math.max(1, Math.round(tykkelse));
    for (const linje of stav.linjer) {
      const topp = Math.round(linje.y - (t - 1) / 2);
      for (let d = 0; d < t; d++) {
        const y = topp + d;
        if (y < 0 || y >= h) continue;
        const rad = y * b;
        for (let x = x0; x <= x1; x++) {
          if (!bin[rad + x]) { bin[rad + x] = 1; tegnet++; }
        }
      }
      linje.x0 = x0; linje.x1 = x1;
    }
    stav.x0 = x0; stav.x1 = x1;
  }
  return tegnet;
}

/**
 * Fjerner den moerke kanten som oppstaar der bokryggen ikke ligger flatt
 * paa glasset. Ser etter sammenhengende moerke kolonner/rader helt ytterst.
 */
function fjernKantskygge(g, b, h) {
  const grense = Math.round(b * 0.06);
  const terskel = 110;
  let venstre = 0, hoyre = 0;
  for (let x = 0; x < grense; x++) {
    let moerk = 0;
    for (let y = 0; y < h; y++) if (g[y * b + x] < terskel) moerk++;
    if (moerk > h * 0.5) venstre = x + 1; else if (x > 2) break;
  }
  for (let x = b - 1; x > b - 1 - grense; x--) {
    let moerk = 0;
    for (let y = 0; y < h; y++) if (g[y * b + x] < terskel) moerk++;
    if (moerk > h * 0.5) hoyre = b - x; else if (b - x > 2) break;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < venstre; x++) g[y * b + x] = 255;
    for (let x = b - hoyre; x < b; x++) g[y * b + x] = 255;
  }
  return { venstre, hoyre };
}

module.exports = {
  lesGratone, skrivGratone, binTilGratone,
  sauvola, otsu, flatfelt, kontrast, autoNivaa,
  finnSkjevhet, roter,
  merkKomponenter, fjernSot, tynnMaske,
  lukk, dilater, eroder,
  reparerLinjer, fjernKantskygge, tegnOppLinjer,
};
