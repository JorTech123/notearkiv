'use strict';
/**
 * sjekk-stemmer.js — ser etter de feilene man HOERER.
 *
 * «Faller medianene?» var for slapp som kvalitetsmaal. «Fly Me to the
 * Moon» gikk gjennom den proeven med glans og laat likevel, med
 * Joergens ord, «som to fulle menn som tar en siste laat paa piano».
 * Tre ting laa under, og ingen av dem viser seg i en median:
 *
 *   1. To stemmer helt like — da synger «barytonen» bassens linje, og
 *      koret er i praksis én stemme faerre enn det later som.
 *   2. Toner utenfor det et menneske kan synge. En tone paa MIDI 26
 *      (D1) er en feillest oktav, ikke en basstone.
 *   3. Leiet paa feil sted — en baryton med median 43 er en bass.
 *
 * Kjoeres paa katalogen, ikke paa lydfilene: det er den de lages av.
 *
 *   node tools/src/sjekk-stemmer.js
 */

const fs = require('node:fs');

const UT = 'data/ut';

/**
 * Hva stemmene faktisk kan synge, i klingende MIDI.
 *
 * Rommelig satt — ytterpunktene er det en oevet korsanger naar, ikke
 * det som er behagelig. Alt utenfor er en feillesing.
 */
const OMFANG = {
  '1. sopran': [60, 84], '2. sopran': [57, 81], sopran: [58, 83],
  '1. alt': [53, 77], '2. alt': [50, 74], alt: [52, 76],
  '1. tenor': [48, 74], '2. tenor': [45, 71], tenor: [46, 72],
  baryton: [41, 65], bass: [36, 60],
};

/** Omtrent hvor stemmen boer ligge. */
const LEIE = {
  '1. sopran': 71, '2. sopran': 67, sopran: 69,
  '1. alt': 64, '2. alt': 60, alt: 62,
  '1. tenor': 62, '2. tenor': 57, tenor: 59, baryton: 52, bass: 47,
};

function median(a) {
  const v = a.slice().sort((x, y) => x - y);
  return v.length ? v[v.length >> 1] : 0;
}

function main() {
  const arkiv = JSON.parse(fs.readFileSync(`${UT}/arkiv.json`, 'utf8'));
  let feilStykker = 0, feilTotalt = 0;

  for (const stykke of arkiv.stykker) {
    const navn = stykke.stemmer || [];
    const noter = stykke.noter || {};
    const merknader = [];

    // 1 — er to stemmer den samme linja?
    const fingeravtrykk = {};
    for (const n of navn) {
      fingeravtrykk[n] = (noter[n] || [])
        .map((x) => x.takt + ':' + x.slag + ':' + x.midi).join(',');
    }
    for (let i = 0; i < navn.length; i++) {
      if (/^klaver/.test(navn[i])) continue;
      for (let j = i + 1; j < navn.length; j++) {
        if (/^klaver/.test(navn[j])) continue;
        if (fingeravtrykk[navn[i]] && fingeravtrykk[navn[i]] === fingeravtrykk[navn[j]]) {
          merknader.push(`${navn[i]} = ${navn[j]} (samme linje)`);
        }
      }
    }

    // 2 og 3 — toner utenfor omfanget, og leie paa feil sted
    for (const n of navn) {
      if (/^klaver/.test(n)) continue;   // klaveret har ikke et sangomfang
      const liste = noter[n] || [];
      if (!liste.length) continue;
      const omfang = OMFANG[n];
      if (omfang) {
        const utenfor = liste.filter((x) => x.midi < omfang[0] || x.midi > omfang[1]);
        if (utenfor.length) {
          const h = utenfor.map((x) => x.midi).sort((a, b) => a - b);
          merknader.push(`${n}: ${utenfor.length} av ${liste.length} toner utenfor ` +
            `${omfang[0]}-${omfang[1]} (${h[0]}-${h[h.length - 1]})`);
        }
      }
      const vent = LEIE[n];
      const m = median(liste.map((x) => x.midi));
      if (vent !== undefined && Math.abs(m - vent) > 6) {
        merknader.push(`${n}: ligger paa ${m}, ventet rundt ${vent}`);
      }
    }

    if (merknader.length) { feilStykker++; feilTotalt += merknader.length; }
    const merke = merknader.length ? '  FEIL' : '  ok  ';
    console.log((stykke.tittel + '                              ').slice(0, 30) + merke +
      (merknader.length ? '' : `  ${navn.length} stemmer`));
    for (const m of merknader) console.log('        ' + m);
  }

  console.log(`\n${arkiv.stykker.length - feilStykker} av ${arkiv.stykker.length} ` +
    `stykker uten merknad.  ${feilTotalt} merknader i alt.`);
}

main();
