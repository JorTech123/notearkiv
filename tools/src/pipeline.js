'use strict';
/**
 * pipeline.js — hele behandlingen av én scannet side, fra raa fil til
 * renset bilde pluss strukturdata.
 *
 * Rekkefoelgen er ikke tilfeldig:
 *   1  kantskygge   bokryggen fjernes foer noe maales
 *   2  deskew       alt senere avhenger av at linjene er vannrette
 *   3  maal         notestoerrelsen styrer alle terskler under
 *   4  flatfelt     papiret jevnes ut i gratone (ikke binaert — skaansomt)
 *   5  deteksjon    binariseres *internt* for aa finne struktur
 *   6  opptegning   notelinjene tegnes rene der vi vet de gaar
 */

const R = require('./rens');
const N = require('./noter');

/**
 * Fyller hull i notelinjene — den tegner dem ikke paa nytt fra ende til
 * ende. Forskjellen er viktig: full opptegning strekker linjer ut i
 * marger og tomrom der deteksjonen bommer, og da ser sida verre ut enn
 * originalen. Her fylles bare et hull som har blekk paa begge sider og
 * er kort nok til aa vaere et kopihull, ikke et reelt opphold i notene.
 */
function tegnLinjerGraa(g, b, h, staver, tykkelse, avstand) {
  const maksHull = Math.round(avstand * 6);
  const blekk = 110;      // hva som regnes som «det staar noe her»
  const strek = 40;       // hvor moerk den fylte biten blir
  let fylt = 0;

  for (const stav of staver) {
    const maalte = stav.linjer.filter((l) => !l.rekonstruert && l.x1 > l.x0);
    if (!maalte.length) continue;
    const midt = (arr) => arr.sort((a, c) => a - c)[arr.length >> 1];
    const x0 = Math.max(0, midt(maalte.map((l) => l.x0)));
    const x1 = Math.min(b - 1, midt(maalte.map((l) => l.x1)));
    if (x1 - x0 < avstand * 8) continue;

    const t = Math.max(1, Math.round(tykkelse * 0.7));
    for (const linje of stav.linjer) {
      const yMidt = Math.round(linje.y);
      const yFra = Math.max(0, yMidt - t);
      const yTil = Math.min(h - 1, yMidt + t);

      // Hvor staar det blekk langs linja?
      const paa = new Uint8Array(x1 - x0 + 1);
      for (let x = x0; x <= x1; x++) {
        for (let y = yFra; y <= yTil; y++) {
          if (g[y * b + x] < blekk) { paa[x - x0] = 1; break; }
        }
      }

      let i = 0;
      while (i < paa.length) {
        if (paa[i]) { i++; continue; }
        let slutt = i;
        while (slutt < paa.length && !paa[slutt]) slutt++;
        // Bare innvendige hull som er korte nok.
        if (i > 0 && slutt < paa.length && slutt - i <= maksHull) {
          const topp = Math.round(linje.y - (t - 1) / 2);
          for (let d = 0; d < t; d++) {
            const y = topp + d;
            if (y < 0 || y >= h) continue;
            for (let x = i; x < slutt; x++) {
              const p = y * b + x0 + x;
              if (g[p] > strek) { g[p] = strek; fylt++; }
            }
          }
        }
        i = slutt;
      }
      linje.x0 = x0; linje.x1 = x1;
    }
    stav.x0 = x0; stav.x1 = x1;
  }
  return fylt;
}

/**
 * Behandler én side.
 * @returns {{bilde:Uint8Array,b:number,h:number,struktur:object,logg:object}}
 */
async function behandleSide(kilde, valg = {}) {
  const logg = {};
  // Kilden er enten en filsti eller et ferdig rastrert gratonebilde
  // (fra PDF). Resten av kjeden bryr seg ikke om hvor det kom fra.
  let { g, b, h } = typeof kilde === 'string' ? await R.lesGratone(kilde) : kilde;
  if (typeof kilde !== 'string') g = Uint8Array.from(g);
  logg.bredde = b; logg.hoyde = h;

  // 1 — bokrygg og skannekant
  logg.kant = R.fjernKantskygge(g, b, h);

  // 2 — rett opp
  let bin = R.sauvola(g, b, h);
  const vinkel = R.finnSkjevhet(bin, b, h);
  logg.skjevhet = +vinkel.toFixed(2);
  if (Math.abs(vinkel) >= 0.05) g = R.roter(g, b, h, -vinkel);

  // 3 — maal notestoerrelsen
  bin = R.sauvola(g, b, h);
  let mal = N.anslaaAvstand(bin, b, h);

  // 4 — jevn ut papiret, i gratone
  let ren = await R.flatfelt(g, b, h, Math.max(6, mal.avstand * 1.8), 1.02);
  const nivaa = R.autoNivaa(ren);
  ren = R.kontrast(ren, nivaa.svart, nivaa.hvit);
  logg.nivaa = nivaa;

  // 5 — struktur, funnet paa en intern binarisering av det rensede bildet
  const vindu = Math.max(15, (Math.round(mal.avstand * 3.2) | 1));
  bin = R.sauvola(ren, b, h, vindu, 0.15);
  mal = N.anslaaAvstand(bin, b, h);
  const struktur = N.analyser(bin, b, h);
  logg.mal = mal;

  // 6 — sot, bare der det ikke finnes musikk aa miste
  if (struktur.staver.length) {
    const omr = {
      x0: struktur.omraade.x0,
      x1: struktur.omraade.x1,
      y0: struktur.staver[0].yTopp,
      y1: struktur.staver[struktur.staver.length - 1].yBunn,
    };
    const sot = R.fjernSot(bin, b, h, mal.avstand, null, omr);
    logg.sot = sot.fjernet;
    // Flekker utenfor notebildet viskes ogsaa ut av gratonebildet.
    viskUtMarg(ren, b, h, omr, mal.avstand * 1.5);
  }

  // 7 — tegn notelinjene rene
  if (valg.tegnLinjer !== false) {
    logg.linjehull = tegnLinjerGraa(ren, b, h, struktur.staver, mal.tykkelse, mal.avstand);
  }

  return { bilde: ren, b, h, struktur, logg };
}

/** Hvitvasker alt utenfor notebildet med en liten luftespalte. */
function viskUtMarg(g, b, h, omr, luft) {
  const x0 = Math.max(0, Math.round(omr.x0 - luft));
  const x1 = Math.min(b - 1, Math.round(omr.x1 + luft));
  for (let y = 0; y < h; y++) {
    const rad = y * b;
    for (let x = 0; x < x0; x++) g[rad + x] = 255;
    for (let x = x1 + 1; x < b; x++) g[rad + x] = 255;
  }
}

// tilJson ligger i den delte analysefila, saa skanneren og
// Node-pipelinen gir nøyaktig samme struktur ut.
const { tilJson } = require("../../public/noteanalyse.js");

module.exports = { behandleSide, tilJson, tegnLinjerGraa };
