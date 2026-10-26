/**
 * import.js (Worker) — gjoer en lest notefil om til et stykke i arkivet.
 *
 * Her gjettes det lite, og det er hele poenget. Naar fila kommer fra et
 * verktoey som er bygget for aa lese noter, staar opplysningene
 * allerede der:
 *
 *   delnavn + instrument-sound  ->  hvilken stemmegruppe staven er
 *   <voice> innen staven        ->  1. eller 2. stemme
 *   clef-octave-change          ->  oktaven, ferdig haandtert
 *   <lyric>                     ->  teksten, stavelse for stavelse
 *
 * Det eneste som fortsatt er et skjoenn, er om den nederste staven
 * heter «baryton og bass» eller «1. og 2. bass». Det staar ikke i fila,
 * og det retter du i appen med ✎ Stemmer.
 */

import { lesBytes } from './musicxml.js';

/** Stemmegruppa en stav tilhoerer, lest av navn og instrumentlyd. */
function gruppeAv(del) {
  const t = `${del.lyd} ${del.navn}`.toLowerCase();
  if (/sopran|soprano/.test(t)) return 'sopran';
  if (/\balto?\b|voice\.alto/.test(t)) return 'alt';
  if (/tenor/.test(t)) return 'tenor';
  if (/bariton|baryton/.test(t)) return 'bass';
  if (/bass/.test(t)) return 'bass';
  if (/piano|klaver|keyboard/.test(t)) return 'klaver';
  return null;
}

const NAVN = {
  sopran: ['1. sopran', '2. sopran'],
  alt: ['1. alt', '2. alt'],
  tenor: ['1. tenor', '2. tenor'],
  bass: ['1. bass', '2. bass'],
  klaver: ['klaver h', 'klaver v'],
};

/** Gjetter gruppa av leiet naar fila ikke sier noe. */
function gruppeAvLeie(median) {
  if (median >= 67) return 'sopran';
  if (median >= 60) return 'tenor';
  return 'bass';
}

function median(a) {
  const v = a.slice().sort((x, y) => x - y);
  return v.length ? v[v.length >> 1] : 0;
}

/**
 * Deler en stav i stemmer.
 *
 * Har fila skilt dem med <voice>, brukes det. Ellers deles hvert anslag
 * paa tonehoeyde: oeverste tone til foerste stemme, nederste til andre.
 * Der bare én tone staar, synger begge den.
 */
function stemmerPaaStav(noter) {
  const perStemme = new Map();
  for (const n of noter) {
    const k = n.stemme || 1;
    if (!perStemme.has(k)) perStemme.set(k, []);
    perStemme.get(k).push(n);
  }
  const grupper = [...perStemme.keys()].sort((a, b) => a - b)
    .map((k) => perStemme.get(k)).filter((l) => l.length >= 4);

  if (grupper.length >= 2) {
    // Fila har skilt dem selv — stol paa det, men sorter etter leie.
    return grupper.sort((a, b) => median(b.map((n) => n.midi)) - median(a.map((n) => n.midi)));
  }
  const alt = (grupper[0] || noter).slice()
    .sort((a, b) => a.takt - b.takt || a.slag - b.slag);
  const anslag = new Map();
  for (const n of alt) {
    const k = n.takt + ':' + n.slag;
    if (!anslag.has(k)) anslag.set(k, []);
    anslag.get(k).push(n);
  }
  let delt = false;
  const over = [], under = [];
  for (const [, g] of anslag) {
    g.sort((a, b) => b.midi - a.midi);
    over.push(g[0]);
    under.push(g.length > 1 ? g[g.length - 1] : g[0]);
    if (g.length > 1) delt = true;
  }
  if (!delt) return [alt];
  const sorter = (l) => l.sort((a, b) => a.takt - b.takt || a.slag - b.slag);
  return [sorter(over), sorter(under)];
}

/**
 * Bygger katalogoppfoeringa.
 *
 * @param bytes   fila slik den ble lastet opp
 * @param valg    {id, tittel}
 */
export async function importer(bytes, valg) {
  return importerFlere([bytes], valg);
}

/**
 * Flere sider til ett stykke.
 *
 * En skanning gir én lesing per side. De skal bli ett notesett, saa
 * taktnumrene paa side to maa fortsette der side én slapp — ellers
 * ligger hele stykket oppaa hverandre i takt 1 til 20.
 */
export async function importerFlere(liste, valg) {
  const doc = { deler: [], slagPerTakt: 4, tittel: '' };
  let forskyvning = 0;

  for (const bytes of liste) {
    let side;
    try { side = await lesBytes(bytes); } catch (e) { continue; }
    if (!side.deler.length) continue;
    if (side.slagPerTakt) doc.slagPerTakt = side.slagPerTakt;
    if (!doc.tittel && side.tittel) doc.tittel = side.tittel;

    let flest = 0;
    for (const del of side.deler) {
      for (const n of del.noter) {
        n.takt += forskyvning;
        if (n.takt > flest) flest = n.takt;
      }
      // Samme del paa flere sider skal vaere ÉN stemme, ikke én per side.
      const fra = doc.deler.find((d) => d.id === del.id && d.navn === del.navn);
      if (fra) {
        fra.noter = fra.noter.concat(del.noter);
        for (const k in del.nokler) if (!fra.nokler[k]) fra.nokler[k] = del.nokler[k];
      } else {
        doc.deler.push(del);
      }
    }
    forskyvning = flest;
  }

  return byggStykke(doc, valg);
}

/**
 * Deler ett loep i N stemmer paa tonehoeyde.
 *
 * Oeverste tone i hvert anslag til foerste stemme, nederste til siste.
 * Staar det faerre toner enn stemmer, synger de unisont der — eller
 * lesinga fant bare den ene.
 */
function delPaaHoyde(noter, antall) {
  const n = Math.max(2, antall);
  const anslag = new Map();
  for (const x of noter) {
    const k = x.takt + ':' + x.slag;
    if (!anslag.has(k)) anslag.set(k, []);
    anslag.get(k).push(x);
  }
  const ut = [];
  for (let i = 0; i < n; i++) ut.push([]);
  for (const [, g] of anslag) {
    g.sort((a, b) => b.midi - a.midi);
    for (let i = 0; i < n; i++) {
      let j;
      if (g.length >= n) j = Math.round(i * (g.length - 1) / (n - 1));
      else if (g.length === 1) j = 0;
      else j = i < n / 2 ? 0 : g.length - 1;
      ut[i].push(g[Math.min(g.length - 1, j)]);
    }
  }
  const sorter = (l) => l.sort((a, b) => a.takt - b.takt || a.slag - b.slag);
  return ut.map(sorter);
}

function byggStykke(doc, valg) {
  if (!doc.deler.length) throw new Error('Fant ingen stemmer i fila');

  const slagPerTakt = doc.slagPerTakt || 4;
  const ut = {};
  const rekke = [];
  const brukt = {};

  for (const del of doc.deler) {
    // Hver stav i delen for seg.
    const perStav = new Map();
    for (const n of del.noter) {
      const k = n.stav || 1;
      if (!perStav.has(k)) perStav.set(k, []);
      perStav.get(k).push(n);
    }

    for (const stavNr of [...perStav.keys()].sort((a, b) => a - b)) {
      const paaStaven = perStav.get(stavNr);
      if (paaStaven.length < 4) continue;

      const nokkel = del.nokler[stavNr] || {};
      // Fila har alt notert oktavskiftet i noekkelen; da er
      // tonehoeydene klingende og skal staa som de er.
      const oktav = nokkel.oktavskift ? 0 : 0;

      const stemmer = stemmerPaaStav(paaStaven);
      const gruppe = gruppeAv(del)
        || gruppeAvLeie(median(paaStaven.map((n) => n.midi)));
      const maler = NAVN[gruppe] || NAVN.tenor;

      stemmer.forEach((liste, i) => {
        if (!liste.length) return;
        let navn = stemmer.length === 1 && maler.length > 1 && gruppe !== 'klaver'
          ? maler[0].replace(/^1\.\s*/, '')
          : (maler[i] || `${gruppe} ${i + 1}`);
        if (brukt[navn]) { let k = 2; while (brukt[navn + ' ' + k]) k++; navn = navn + ' ' + k; }
        brukt[navn] = true;

        rekke.push(navn);
        ut[navn] = liste
          .sort((a, b) => a.takt - b.takt || a.slag - b.slag)
          .map((n) => ({
            takt: n.takt, slag: n.slag, varighet: n.varighet,
            midi: n.midi + oktav,
            tekst: n.tekst ? n.tekst.ord : undefined,
            del: n.tekst ? n.tekst.del : undefined,
          }));
      });
    }
  }

  if (!rekke.length) throw new Error('Fant ingen toner i fila');

  // ── SA BRUKEREN NOE ANNET? ───────────────────────────────────────
  //
  // Skanneren spoer hvilken stemme hver linje er, og svaret er bedre
  // enn noe vi kan utlede. En nevral leser nummererer <voice> selv, og
  // gjoer det ikke paalitelig: paa en skannet side kom det ut som 69,
  // 5 og 4 toner der det skulle vaert tre jevne linjer.
  //
  // Stemmer ikke antallet, eller er fordelinga sterkt skjev, slaas
  // sangstemmene sammen og deles paa nytt paa tonehoeyde — like mange
  // som brukeren sa at noten har.
  const oppgitt = (valg.stemmer || []).filter((n) => !/^klaver/i.test(n));
  if (oppgitt.length > 1) {
    const sang = rekke.filter((n) => !/^klaver/i.test(n));
    const lengder = sang.map((n) => ut[n].length);
    const storst = Math.max(...lengder, 0);
    const minst = Math.min(...lengder, Infinity);
    const skjev = storst > 0 && minst < storst * 0.25;

    if (sang.length !== oppgitt.length || skjev) {
      const alle = [];
      for (const n of sang) for (const x of ut[n]) alle.push(x);
      alle.sort((a, b) => a.takt - b.takt || a.slag - b.slag);
      if (alle.length >= oppgitt.length * 4) {
        for (const n of sang) { delete ut[n]; }
        const beholdt = rekke.filter((n) => /^klaver/i.test(n));
        const deler = delPaaHoyde(alle, oppgitt.length);
        rekke.length = 0;
        oppgitt.forEach((navn, i) => {
          if (deler[i] && deler[i].length) { ut[navn] = deler[i]; rekke.push(navn); }
        });
        for (const n of beholdt) rekke.push(n);
      }
    }
  }

  // Teksten ut til alle stemmene: koret synger de samme ordene.
  const ordPaaSlag = new Map();
  for (const n of rekke) {
    for (const x of ut[n]) {
      if (!x.tekst) continue;
      const k = x.takt + ':' + x.slag;
      if (!ordPaaSlag.has(k)) ordPaaSlag.set(k, { ord: x.tekst, del: x.del });
    }
  }
  for (const n of rekke) {
    let sist = null;
    const sett = new Set();
    for (const x of ut[n]) {
      const k = x.takt + ':' + x.slag;
      if (x.tekst) { sett.add(k); sist = x.tekst; continue; }
      if (sett.has(k)) continue;
      const t = ordPaaSlag.get(k);
      if (t && t.ord !== sist) { x.tekst = t.ord; x.del = t.del; sett.add(k); sist = t.ord; }
    }
  }

  let takter = 0;
  for (const n of rekke) for (const x of ut[n]) if (x.takt > takter) takter = x.takt;

  return {
    id: valg.id,
    tittel: valg.tittel || doc.tittel || valg.id,
    stemmer: rekke,
    noter: ut,
    slagPerTakt,
    antallTakter: takter,
    antallSider: 0,
    sider: [],
    kilde: 'notefil',
    importert: new Date().toISOString(),
  };
}
