'use strict';
/**
 * sammenlikn-musicxml.js — maaler én notegjenkjenning mot en annen.
 *
 * Brukes til aa svare paa det eneste spoersmaalet som betyr noe naar man
 * bygger en kopi: hvor naer kommer den originalen?
 *
 * Stemmene i de to filene kan vaere delt ulikt, saa de pares foerst paa
 * tonehoeyde. Deretter sammenliknes tonerekkene med lengste felles
 * delfoelge — da teller en note som treff selv om det mangler eller er
 * lagt til noter rundt den, og maalet blir ikke oedelagt av at de to
 * filene er forskjoevet med én takt.
 *
 *   node tools/src/sammenlikn-musicxml.js <fasit> <kopi>
 */

const M = require('./musicxml.js');

function median(a) {
  const v = a.slice().sort((x, y) => x - y);
  return v.length ? v[v.length >> 1] : 0;
}

/** Stroemmer per (del, stav, stemme), i rekkefoelge ovenfra og ned. */
function stroemmer(doc) {
  const ut = [];
  doc.deler.forEach((del, di) => {
    const grupper = new Map();
    for (const n of del.noter) {
      const k = (n.stav || 1) + ':' + n.stemme;
      if (!grupper.has(k)) grupper.set(k, []);
      grupper.get(k).push(n);
    }
    [...grupper.keys()].sort((a, c) => {
      const [as, av] = a.split(':').map(Number);
      const [cs, cv] = c.split(':').map(Number);
      return as - cs || av - cv;
    }).forEach((k) => {
      const liste = grupper.get(k).slice()
        .sort((a, c) => a.takt - c.takt || a.slag - c.slag);
      if (liste.length >= 5) {
        ut.push({ navn: `${del.navn || 'del' + di}/${k}`, noter: liste });
      }
    });
  });
  return ut;
}

/** Lengste felles delfoelge av to tallrekker. */
function lcs(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let forrige = new Int32Array(m + 1);
  let naa = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      naa[j] = a[i - 1] === b[j - 1]
        ? forrige[j - 1] + 1
        : Math.max(forrige[j], naa[j - 1]);
    }
    const t = forrige; forrige = naa; naa = t;
    naa.fill(0);
  }
  return forrige[m];
}

function main() {
  const [fasitFil, kopiFil] = process.argv.slice(2);
  if (!fasitFil || !kopiFil) {
    console.error('bruk: node tools/src/sammenlikn-musicxml.js <fasit> <kopi>');
    process.exit(1);
  }

  const fasit = stroemmer(M.lesFil(fasitFil));
  const kopi = stroemmer(M.lesFil(kopiFil));
  console.log(`fasit: ${fasit.length} stemmer, ${fasit.reduce((a, s) => a + s.noter.length, 0)} noter`);
  console.log(`kopi : ${kopi.length} stemmer, ${kopi.reduce((a, s) => a + s.noter.length, 0)} noter`);
  if (!fasit.length || !kopi.length) return;

  // Par stemmene paa tonehoeyde, én til én.
  const ledige = kopi.map((_, i) => i);
  const par = [];
  for (const f of fasit) {
    if (!ledige.length) { par.push({ f: f, k: null }); continue; }
    const mf = median(f.noter.map((n) => n.midi));
    let beste = 0, avvik = Infinity;
    ledige.forEach((idx, j) => {
      const d = Math.abs(median(kopi[idx].noter.map((n) => n.midi)) - mf);
      if (d < avvik) { avvik = d; beste = j; }
    });
    par.push({ f: f, k: kopi[ledige.splice(beste, 1)[0]] });
  }

  console.log('\nstemme                   fasit  kopi   toner   rytme');
  let sumTreff = 0, sumFasit = 0, sumRytme = 0;
  for (const p of par) {
    const a = p.f.noter.map((n) => n.midi);
    if (!p.k) {
      console.log(`${p.f.navn.padEnd(24)}${String(a.length).padStart(5)}      -      -       -`);
      sumFasit += a.length;
      continue;
    }
    const b = p.k.noter.map((n) => n.midi);
    const treff = lcs(a, b);
    // Rytme: sammenlikn (takt, slag, varighet) som tekst.
    const ra = p.f.noter.map((n) => `${n.takt}:${n.slag}:${n.varighet}`);
    const rb = p.k.noter.map((n) => `${n.takt}:${n.slag}:${n.varighet}`);
    const rTreff = lcs(ra.map((s, i) => s.charCodeAt(0) * 0 + i), rb.map(() => -1)) * 0 ||
      ra.filter((s, i) => rb[i] === s).length;
    sumTreff += treff; sumFasit += a.length; sumRytme += rTreff;
    console.log(
      `${p.f.navn.padEnd(24)}${String(a.length).padStart(5)}${String(b.length).padStart(6)}` +
      `${(treff / a.length * 100).toFixed(0).padStart(7)} %${(rTreff / a.length * 100).toFixed(0).padStart(7)} %`,
    );
  }
  console.log(
    `\nSamlet: ${sumTreff} av ${sumFasit} toner gjenfunnet = ` +
    `${(sumTreff / Math.max(1, sumFasit) * 100).toFixed(1)} %  ` +
    `(rytme paa plass: ${(sumRytme / Math.max(1, sumFasit) * 100).toFixed(1)} %)`,
  );
}

main();
