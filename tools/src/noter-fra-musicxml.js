'use strict';
/**
 * noter-fra-musicxml.js — bygger stemmene i katalogen fra Audiveris
 * sin MusicXML.
 *
 * Det vanskelige her er aa holde styr paa HVEM som synger hva paa tvers
 * av sidene. Audiveris eksporterer hvert ark for seg og nummererer
 * delene fra 1 i hver fil. Del 3 kan derfor vaere pianoet paa én side og
 * bassen paa den neste. Legger man strømmene sammen paa delnummer, blir
 * hver «stemme» en blanding av ulike instrumenter — og da er ingenting
 * riktig, verken tonehoeyde, rytme eller stemme.
 *
 * Derfor:
 *   1. Pianoet lukes ut per ark. Sangstemmer har sangtekst; pianoet har
 *      ikke. Et ark helt uten tekst er et forspill eller en tittelside,
 *      og hoppes over i sin helhet.
 *   2. Stemmene telles per ark. Bare ark med det antallet som gaar igjen
 *      i stykket brukes. Et ark med faerre stemmer ville ellers forskjøvet
 *      alle de andre.
 *   3. Innenfor ett ark er rekkefoelgen paalitelig: Audiveris skriver
 *      delene ovenfra og ned, og `backup` skiller stemmene i samme del.
 *
 *   node tools/src/noter-fra-musicxml.js
 */

const fs = require('node:fs');
const path = require('node:path');
const M = require('./musicxml.js');

const UT = 'data/ut';
const XML = 'data/musicxml';
const SLAG_PER_TAKT = 4;

const NAVN = {
  1: ['melodi'],
  2: ['overstemme', 'understemme'],
  3: ['tenor', 'baryton', 'bass'],
  4: ['1. tenor', '2. tenor', 'baryton', 'bass'],
};

function slugg(s) {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function finnMappe(id) {
  if (!fs.existsSync(XML)) return null;
  for (const m of fs.readdirSync(XML)) {
    const full = path.join(XML, m);
    if (!fs.statSync(full).isDirectory()) continue;
    if (slugg(m) === id || slugg(m).startsWith(id) || id.startsWith(slugg(m))) return full;
  }
  return null;
}

function median(a) {
  const v = a.slice().sort((x, y) => x - y);
  return v.length ? v[v.length >> 1] : 0;
}

/** Hvilke deler i dokumentet har sangtekst? */
function delerMedTekst(raa) {
  const sett = new Set();
  const re = /<part\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/part>/g;
  let m, i = 0;
  while ((m = re.exec(raa)) !== null) {
    if (m[2].indexOf('<lyric') >= 0) sett.add(i);
    i++;
  }
  return sett;
}

/**
 * Leser ett ark og gir stemmene i rekkefoelge ovenfra og ned.
 * @returns {{stroemmer: Array, takter: number}|null}
 */
function lesArk(sti) {
  let doc, raa;
  try {
    doc = M.lesFil(sti);
    const z = M.lesZip(sti, (n) => /\.xml$/i.test(n) && !/^META-INF/i.test(n));
    raa = z ? z.innhold.toString('utf8') : '';
  } catch (e) { return null; }

  const medTekst = delerMedTekst(raa);
  if (!medTekst.size) return null;          // forspill eller tittelside

  const stroemmer = [];
  let takter = 0;
  doc.deler.forEach((del, di) => {
    if (del.takter > takter) takter = del.takter;
    if (!medTekst.has(di)) return;          // pianoet

    // ÉN stemme per STAV, ikke per del.
    //
    // En del kan romme to staver; et sammentrengt korpartitur ligger
    // ofte slik. Slaas de sammen, havner bassens toner i tenorens
    // stemme og takten renner over. Flere `<voice>` paa samme stav
    // beholdes derimot samlet — det er den linja sangeren ser, og det
    // er den hen ber om aa faa spilt.
    const perStav = new Map();
    for (const n of del.noter) {
      const s = n.stav || 1;
      if (!perStav.has(s)) perStav.set(s, []);
      perStav.get(s).push(n);
    }
    [...perStav.keys()].sort((a, c) => a - c).forEach((s) => {
      const liste = perStav.get(s);
      if (liste.length >= 6) stroemmer.push(liste);
    });
  });

  // Et mannskor har hoeyst fire stemmer. Finner Audiveris flere, er de
  // ekstra stroemmene oppdelinger — behold de fire stoerste, i samme
  // rekkefoelge ovenfra og ned.
  let valgte = stroemmer;
  if (valgte.length > 4) {
    const rangert = valgte.map(function (l, i) { return { i: i, n: l.length }; })
      .sort(function (a, c) { return c.n - a.n; }).slice(0, 4)
      .map(function (x) { return x.i; }).sort(function (a, c) { return a - c; });
    valgte = rangert.map(function (i) { return stroemmer[i]; });
  }
  return valgte.length
    ? { stroemmer: valgte, takter: takter, slag: doc.slagPerTakt, systemer: doc.systemer || [] }
    : null;
}

function main() {
  const arkiv = JSON.parse(fs.readFileSync(`${UT}/arkiv.json`, 'utf8'));
  let medNoter = 0;

  for (const stykke of arkiv.stykker) {
    delete stykke.noter;
    delete stykke.kilde;

    const mappe = finnMappe(stykke.id);
    if (!mappe) { console.log(`${stykke.tittel}: ingen MusicXML`); continue; }

    const filer = fs.readdirSync(mappe)
      .filter((f) => /^ark-\d+\.mxl$/i.test(f)).sort();
    const ark = [];
    for (const f of filer) {
      const a = lesArk(path.join(mappe, f));
      if (a) ark.push(a);
    }
    if (!ark.length) { console.log(`${stykke.tittel}: ingen ark med sang`); continue; }

    // Antallet stemmer som gaar igjen i stykket.
    const teller = {};
    for (const a of ark) teller[a.stroemmer.length] = (teller[a.stroemmer.length] || 0) + 1;
    let V = 0, flest = 0;
    for (const k in teller) if (teller[k] > flest) { flest = teller[k]; V = +k; }

    // Referansetonehoeyde per stemme, hentet fra arkene der besetningen
    // er den vanlige.
    const referanse = [];
    for (let k = 0; k < V; k++) {
      const samlet = [];
      for (const a of ark) {
        if (a.stroemmer.length === V) samlet.push(...a.stroemmer[k].map((n) => n.midi));
      }
      referanse.push(median(samlet));
    }

    // Sett sammen stemme for stemme, med loepende takttall.
    //
    // INGEN ark forkastes. Tidligere droppet jeg ark der Audiveris fant
    // et annet antall stemmer, og mistet dermed store deler av stykket —
    // lyden ble bare en tredjedel saa lang som noten, og overlayet maatte
    // hoppe flere takter om gangen for aa henge med. Naar antallet
    // avviker, plasseres stroemmene i stedet paa den stemmen de ligger
    // naermest i tonehoeyde.
    const noter = [];
    for (let k = 0; k < V; k++) noter.push([]);
    let forskyvning = 0, tilpasset = 0;

    for (const a of ark) {
      let rekke;
      if (a.stroemmer.length === V) {
        rekke = a.stroemmer;
      } else {
        tilpasset++;
        rekke = new Array(V).fill(null);
        const ledige = referanse.map((_, i) => i);
        // Stoerste stroem foerst: den har best grunnlag for aa velge plass.
        const sortert = a.stroemmer.slice()
          .sort((x, y) => y.length - x.length);
        for (const liste of sortert) {
          if (!ledige.length) break;
          const m = median(liste.map((n) => n.midi));
          let beste = 0, avvik = Infinity;
          ledige.forEach((i, j) => {
            const d = Math.abs(referanse[i] - m);
            if (d < avvik) { avvik = d; beste = j; }
          });
          const plass = ledige.splice(beste, 1)[0];
          rekke[plass] = liste;
        }
      }

      rekke.forEach((liste, k) => {
        if (!liste) return;
        for (const n of liste) {
          noter[k].push({
            takt: n.takt + forskyvning,
            slag: n.slag,
            varighet: n.varighet,
            midi: n.midi,
          });
        }
      });
      forskyvning += a.takter;
    }
    const brukt = ark;
    const hoppet = tilpasset;

    // Taktarten, lest av noten. Hardkodet firedelstakt gjoer at alt i
    // tre- eller sekskvartstakt gaar i stykker.
    const slagListe = brukt.map((a) => a.slag).filter(Boolean);
    const slagPerTakt = slagListe.length ? median(slagListe) : SLAG_PER_TAKT;

    // ── fire slag i hver takt, uten unntak ──────────────────────────
    //
    // En 4/4-takt ER fire slag. Det er ikke en retningslinje, det er
    // definisjonen, og den skal brukes — ikke bare maales. Audiveris
    // leser av og til for faa eller for mange noter, og da strekkes
    // eller strammes takten til den stemmer.
    //
    // Skalering, ikke kutt: alle tonene og rekkefoelgen deres beholdes,
    // og bare tidsforholdet justeres. Aa kutte toner ville fjernet
    // musikk som faktisk staar i noten, og aa fylle med stillhet ville
    // latt takten halte.
    let justert = 0, takterIalt = 0;
    for (const liste of noter) {
      const perTakt = new Map();
      for (const n of liste) {
        if (!perTakt.has(n.takt)) perTakt.set(n.takt, []);
        perTakt.get(n.takt).push(n);
      }
      for (const [, iTakt] of perTakt) {
        takterIalt++;
        iTakt.sort((a, c) => a.slag - c.slag);
        const slutt = iTakt.reduce((x, n) => Math.max(x, n.slag + n.varighet), 0);
        if (slutt <= 0) continue;
        if (Math.abs(slutt - slagPerTakt) < 0.02) continue;
        const faktor = slagPerTakt / slutt;
        for (const n of iTakt) {
          n.slag = Math.round(n.slag * faktor * 1000) / 1000;
          n.varighet = Math.round(n.varighet * faktor * 1000) / 1000;
        }
        justert++;
      }
    }

    const navn = NAVN[V] || noter.map((_, i) => `stemme ${i + 1}`);
    const ut = {};
    navn.forEach((n, i) => {
      ut[n] = noter[i].sort((a, c) => a.takt - c.takt || a.slag - c.slag);
    });

    stykke.stemmer = navn;
    stykke.noter = ut;
    stykke.slagPerTakt = slagPerTakt;
    stykke.kilde = 'audiveris';
    medNoter++;

    // ── la Audiveris sin takt-inndeling styre overlayet ─────────────
    //
    // Min egen taktdeteksjon i bildet er upaalitelig: ett stykke fikk
    // 3 takter i overlayet mot 62 i lyden, og da maa markoeren hoppe
    // tjue takter om gangen. Audiveris vet derimot noeyaktig hvor
    // mange takter hvert system har. Systemenes PLASSERING finner jeg
    // best selv i bildet, saa de to settes sammen: mine rammer, deres
    // inndeling. Da er takt 1 i lyden takt 1 i rammen.
    const audSystemer = [];
    for (const a of ark) audSystemer.push(...(a.systemer || []));

    const mine = [];
    for (const side of stykke.sider) {
      for (const sys of side.systemer || []) mine.push(sys);
    }

    if (audSystemer.length && mine.length) {
      // Er antallet systemer ulikt, fordeles taktene jevnt utover.
      let antall = mine.map((_, i) => {
        if (audSystemer.length === mine.length) return audSystemer[i];
        const fra = Math.floor(i * audSystemer.length / mine.length);
        const til = Math.max(fra + 1, Math.floor((i + 1) * audSystemer.length / mine.length));
        return audSystemer.slice(fra, til).reduce((a, c) => a + c, 0);
      });

      // Summen maa treffe lydens egen lengde paa taktet. Systeminndelinga
      // leses av foerste del i fila, og er den pianoets, kan den romme
      // flere takter enn sangstemmene faktisk fikk lest. Da skaleres den
      // ned — ellers hopper markoeren igjen.
      const maksLyd = Math.max.apply(null,
        navn.flatMap((n) => ut[n].map((x) => x.takt)).concat([1]));
      const sumAntall = antall.reduce((a, c) => a + c, 0);
      if (sumAntall && Math.abs(sumAntall - maksLyd) > 1) {
        const skala = maksLyd / sumAntall;
        antall = antall.map((v) => Math.max(1, Math.round(v * skala)));
        // Rett av avrundinga paa det stoerste systemet.
        let diff = maksLyd - antall.reduce((a, c) => a + c, 0);
        while (diff !== 0) {
          let i = 0;
          for (let k = 1; k < antall.length; k++) if (antall[k] > antall[i]) i = k;
          if (diff > 0) { antall[i]++; diff--; }
          else if (antall[i] > 1) { antall[i]--; diff++; }
          else break;
        }
      }

      let nr = 0;
      mine.forEach((sys, i) => {
        const n = Math.max(1, antall[i] || 1);
        const x0 = Math.min(...sys.staver.map((s) => s.x0));
        const x1 = Math.max(...sys.staver.map((s) => s.x1));
        const bredde = (x1 - x0) / n;
        sys.takter = [];
        for (let k = 0; k < n; k++) {
          sys.takter.push({
            nummer: ++nr,
            x0: Math.round(x0 + bredde * k),
            x1: Math.round(x0 + bredde * (k + 1)),
          });
        }
      });
      for (const side of stykke.sider) {
        side.antallTakter = (side.systemer || [])
          .reduce((a, y) => a + y.takter.length, 0);
      }
      stykke.antallTakter = nr;
    }

    const medianer = navn.map((n) => median(ut[n].map((x) => x.midi)));
    const fallende = medianer.every((v, i) => i === 0 || v <= medianer[i - 1] + 1);
    console.log(
      (stykke.tittel + '                              ').slice(0, 30) +
      `${brukt.length}/${filer.length} ark` + (hoppet ? ` (${hoppet} tilpasset)` : '') +
      `  V=${V}  ` + String(navn.reduce((a, n) => a + ut[n].length, 0)).padStart(4) + ' noter  ' +
      `${justert}/${takterIalt} takter justert  ` + (fallende ? 'OK   ' : 'FEIL ') +
      navn.map((n, i) => n + ':' + ut[n].length + '(' + medianer[i] + ')').join(' '),
    );
  }

  fs.writeFileSync(`${UT}/arkiv.json`, JSON.stringify(arkiv, null, 1), 'utf8');
  console.log(`\n${medNoter} stykker fikk noter fra MusicXML.`);
}

main();
