'use strict';
/**
 * prov-takter.js — maaler hvor stor del av taktene som gaar opp.
 *
 * Summen av varigheter i en takt maa vaere lik taktarten. Andelen takter
 * som stemmer er den aerligste maalingen vi har paa hvor god lesinga er.
 */
const sharp = require('sharp');
const N = require('../../public/noteanalyse.js');
const G = require('../../public/notegjenkjenning.js');

const SLAG = 4;

async function main() {
  const filer = process.argv.slice(2);
  let altGyldig = 0, altTakter = 0, altRettet = 0;

  for (const fil of filer) {
    const { data, info } = await sharp(fil).grayscale().raw().toBuffer({ resolveWithObject: true });
    const b = info.width, h = info.height;
    const bin = N.terskle(data, 150);
    const st = N.analyser(bin, b, h);
    const uten = G.fjernNotelinjer(bin, b, h, st.staver, st.mal.tykkelse);

    let gyldig = 0, takter = 0, rettet = 0, noter = 0;
    for (const sys of st.systemer) {
      for (const stav of sys.staver) {
        const lest = G.lesStav(uten, b, h, stav, st.mal, st.omraade);
        for (const t of (sys.takter || [])) {
          const i = lest.noter.filter((n) => n.x >= t.x0 && n.x < t.x1)
            .concat((lest.pauser || []).filter((p) => p.x >= t.x0 && p.x < t.x1)
              .map((p) => ({ x: p.x, varighet: p.varighet, pause: true, fylt: true, hals: 0, bjelker: 0 })))
            .sort((a, c) => a.x - c.x);
          if (!i.length) continue;
          takter++;
          const r = G.byggTakt(i, SLAG);
          if (r.gyldig) { gyldig++; noter += r.noter.length; }
          if (r.rettet) rettet++;
        }
      }
    }
    altGyldig += gyldig; altTakter += takter; altRettet += rettet;
    console.log(
      fil.split(/[\/]/).pop().slice(0, 34).padEnd(35) +
      String(takter).padStart(4) + ' takter  ' +
      String(gyldig).padStart(4) + ' gaar opp  ' +
      (takter ? (gyldig / takter * 100).toFixed(0) : '0').padStart(3) + ' %  ' +
      '(' + rettet + ' rettet)',
    );
  }
  console.log('\nTotalt: ' + altGyldig + ' av ' + altTakter + ' takter gaar opp = ' +
    (altTakter ? (altGyldig / altTakter * 100).toFixed(1) : 0) + ' %  (' + altRettet + ' rettet)');
}
main().catch((e) => { console.error(e); process.exit(1); });
