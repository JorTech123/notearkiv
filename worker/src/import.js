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
 * Henter enkelttoner som har spratt en oktav ut av stemmens leie.
 *
 * Oktaven settes per STAV. Leser gjenkjenneren en tone paa feil stav —
 * og det gjoer den innimellom — faar den stavens korreksjon, og lander
 * tolv halvtoner fra der den hoerer hjemme. Paa skjermen er det én tone
 * med en haug hjelpelinjer over eller under staven, og i lyden er det
 * et sprang som ikke staar i noten.
 *
 * Maalt paa «Hark test 2» mot en utgave vi vet er riktig: 62 toner laa
 * utenfor leiet, og ALLE 62 kunne hentes inn med en oktav. Fasiten
 * hadde én.
 *
 * Leiet maales paa stemmen SELV, ikke slaas opp paa navn. Navnene
 * kommer fra skanneren og kan vaere hva som helst — «1. bass»,
 * «2. bass» — mens tonene alltid forteller sitt eget leie.
 */
function foldInnIOmfang(noter) {
  const h = noter.map((n) => n.midi).filter(Number.isFinite).sort((a, b) => a - b);
  if (h.length < 8) return 0;
  const p = (q) => h[Math.min(h.length - 1, Math.floor(q * h.length))];
  // Litt slingringsmonn over og under: en stemme har lov til aa strekke
  // seg noen toner utenfor der den ellers ligger.
  const lav = p(0.10) - 6, hoy = p(0.90) + 6;
  if (hoy - lav < 12) return 0;        // for smalt til aa folde trygt
  let flyttet = 0;
  for (const n of noter) {
    if (!Number.isFinite(n.midi)) continue;
    const foer = n.midi;
    while (n.midi < lav) n.midi += 12;
    while (n.midi > hoy) n.midi -= 12;
    if (n.midi !== foer) flyttet++;
  }
  return flyttet;
}

/**
 * Hvilken oktav staven faktisk KLINGER i.
 *
 * I MusicXML er <pitch> den klingende tonen, og <clef-octave-change>
 * beskriver bare notasjonen. Et ordentlig OMR-verktoey skriver begge
 * deler, og da skal tonene staa som de staar.
 *
 * En nevral leser gjoer ikke det. Den skriver tonen slik den LESER den
 * av staven, og utelater oktavskiftet. Tenorstaven i et mannskorpartitur
 * er G-noekkel med en liten 8 under — den klinger en oktav ned — og da
 * kommer hele staven ut en oktav for hoeyt.
 *
 * Maalt mot en utgave vi vet er riktig: tenorstemmene laa paa +12,
 * bass-stavene (F-noekkel, ingen skift) laa helt rett. Etter denne
 * korreksjonen traff tenoren 92 % av fasitens anslag.
 *
 * Terskelen 66 skiller en tenorstav fra en som virkelig ligger hoeyt.
 * Den gjelder mannsstemmer; har noten sopran eller alt, staar G-noekkelen
 * som den klinger og vi lar den vaere.
 */
function oktavAvNokkel(nokkel, skrevetMedian, harLyseStemmer) {
  if (harLyseStemmer) return 0;
  if (!nokkel || !nokkel.tegn) return skrevetMedian >= 66 ? -12 : 0;
  if (nokkel.oktavskift) return 0;          // fila sier det selv
  if (nokkel.tegn !== 'G') return 0;        // F- og C-noekkel staar som de klinger
  return skrevetMedian >= 66 ? -12 : 0;
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
 * Rydder én stavelse fra OCR-lesinga, eller forkaster den.
 *
 * Tekstleseren tar med alt som staar som tekst ved notene, og det er
 * ikke bare sang: akkordsymboler («G(add9)/B», «Am7») staar over staven
 * og havner i samme sekk. De skal ikke synges. Tall hoerer heller ikke
 * hjemme i en stavelse. Resten slipper igjennom som den er — en
 * halvlest stavelse er bedre enn ingen, saa lenge den staar paa rett
 * sted i teksten.
 */
function rensStavelse(raa) {
  if (!raa) return null;
  const s = String(raa)
    .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/’/g, "'").replace(/[“”]/g, '"')
    .replace(/[~|]/g, '').replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  if (/\d/.test(s)) return null;                      // tall synges ikke
  if (/^[A-G](#|b)?(m|maj|min|dim|aug|sus|add)?(\/[A-G](#|b)?)?$/.test(s)) return null;
  if (!/[a-zA-ZæøåÆØÅéèüö]/.test(s)) return null;
  return s;
}

/**
 * Oversetter ett taktnummer fra tekstlesinga til notelesingas.
 *
 * Koblinga bygges av justerte stavelser, saa den dekker bare takter
 * som BAERER tekst. Et repetisjonstegn staar gjerne i siste takt, og
 * der er det ofte ingen — da falt merket bort i stillhet.
 *
 * Mangler takten, brukes forskjellen de andre taktene ble enige om.
 * De to lesingene teller stort sett i takt; det er startpunktet som
 * kan sprike.
 */
function oversettTakt(taktKart, t, audTakter, noteTakter) {
  const rett = taktKart.get(t);
  if (rett) return rett;
  if (!taktKart.size) return null;

  const par = [...taktKart].sort((a, b) => a[0] - b[0]);
  const foer = par.filter(([f]) => f < t).pop();
  const etter = par.find(([f]) => f > t);

  let ut;
  if (foer && etter) {
    // Mellom to kjente takter: legg den der forholdet tilsier.
    const andel = (t - foer[0]) / (etter[0] - foer[0]);
    ut = Math.round(foer[1] + andel * (etter[1] - foer[1]));
  } else if (audTakter > 0 && noteTakter > 0) {
    // Utenfor de kjente: skaler mot hvor mange takter hver lesing fant.
    // En fast forskyvning duger ikke — den plasserte et avslutningstegn
    // i takt 19 av et stykke paa 17.
    ut = Math.round(t * noteTakter / audTakter);
  } else {
    return null;
  }
  if (!Number.isFinite(ut)) return null;
  return Math.max(1, Math.min(noteTakter || ut, ut));
}

/**
 * Repetisjonstegnene i én lesing, hvert tegn bare én gang.
 *
 * Et tegn staar paa hver stav i systemet — fire staver gir fire like
 * merker — men i musikken er det ett.
 */
function merkerFra(doc) {
  const sett = new Map();
  for (const del of doc.deler) {
    for (const m of del.merker || []) {
      sett.set(`${m.takt}:${m.type}:${m.nummer || ''}:${m.kant || ''}`, m);
    }
  }
  return [...sett.values()].sort((a, b) => a.takt - b.takt);
}

/** Stavelsene i én lesing, i den rekkefoelgen de synges. */
function stavelserFra(doc) {
  // Teksten henger paa én stemme, men flere staver kan ha den samme
  // teksten under seg. Hvert (takt, slag) tas derfor bare én gang.
  const sett = new Map();
  for (const del of doc.deler) {
    for (const n of del.noter) {
      if (!n.tekst) continue;
      const ord = rensStavelse(n.tekst.ord);
      if (!ord) continue;
      const k = n.takt + ':' + n.slag;
      if (!sett.has(k)) {
        sett.set(k, {
          takt: n.takt, slag: n.slag, midi: n.midi,
          tekst: { ord, del: n.tekst.del },
        });
      }
    }
  }
  return [...sett.values()].sort((a, b) => a.takt - b.takt || a.slag - b.slag);
}

/**
 * Notene paa hver stav, helst uten klaveret — klaveret synger ikke.
 *
 * Men navnet kan ikke avgjoere det alene. En nevral leser doeper alt
 * den ser som ett system til «Piano», og et firestavs korpartitur ER
 * ett system. Kaster vi da ut alt som heter piano, staar vi igjen uten
 * staver i det hele tatt — og nettopp de stykkene som IKKE har klaver
 * blir de eneste uten tekst.
 *
 * Derfor: luk ut klaveret bare naar det blir noe igjen. Er alt
 * «piano», betyr navnet ingenting, og alle stavene er sangstaver.
 */
function sangstaver(doc) {
  const alle = [];
  for (const del of doc.deler) {
    const klaver = gruppeAv(del) === 'klaver';
    const perStav = new Map();
    for (const n of del.noter) {
      const k = n.stav || 1;
      if (!perStav.has(k)) perStav.set(k, []);
      perStav.get(k).push(n);
    }
    for (const liste of perStav.values()) {
      if (liste.length >= 4) alle.push({ klaver, noter: liste });
    }
  }
  const uten = alle.filter((s) => !s.klaver);
  return (uten.length ? uten : alle).map((s) => s.noter);
}

/**
 * Legger stavelsene fra tekstlesinga paa tonene fra notelesinga.
 *
 * De to leserne er uenige om nesten alt — taktnumre, antall staver,
 * enkelttoner — saa de kan ikke stilles opp mot hverandre paa takt og
 * slag. I stedet justeres rekkene mot hverandre som sekvenser, med
 * tonetrinnet (uten oktav) som signal. Teksten flyttes over hver gang
 * de to rykker fram SAMMEN — ogsaa naar tonene er ulike, for da er
 * plassen i rekka riktig selv om den ene leste tonen feil. Det er
 * plasseringa vi er ute etter, ikke tonen.
 */
function leggPaaTekst(doc, stavelser) {
  const staver = sangstaver(doc);
  if (!stavelser.length || !staver.length) return { satt: 0, taktKart: new Map() };

  // Oeverste stemme baerer teksten: i en homofon korsats har den én
  // tone per stavelse, og det er alle disse arrangementene.
  const topp = staver.reduce((a, s) =>
    (median(s.map((n) => n.midi)) > median(a.map((n) => n.midi)) ? s : a), staver[0]);
  const b = topp.slice().sort((x, y) => x.takt - y.takt || x.slag - y.slag);
  const a = stavelser;

  const TREFF = 2, BOM = -1, HULL = -1;
  const d = [], fra = [];
  for (let i = 0; i <= a.length; i++) {
    d.push(new Float64Array(b.length + 1).fill(-Infinity));
    fra.push(new Array(b.length + 1).fill(null));
  }
  d[0][0] = 0;
  for (let i = 0; i <= a.length; i++) {
    for (let j = 0; j <= b.length; j++) {
      if (d[i][j] === -Infinity) continue;
      if (i < a.length && j < b.length) {
        const like = ((a[i].midi % 12) + 12) % 12 === ((b[j].midi % 12) + 12) % 12;
        const n = d[i][j] + (like ? TREFF : BOM);
        if (n > d[i + 1][j + 1]) { d[i + 1][j + 1] = n; fra[i + 1][j + 1] = [i, j, true]; }
      }
      if (i < a.length && d[i][j] + HULL > d[i + 1][j]) {
        d[i + 1][j] = d[i][j] + HULL; fra[i + 1][j] = [i, j, false];
      }
      if (j < b.length && d[i][j] + HULL > d[i][j + 1]) {
        d[i][j + 1] = d[i][j] + HULL; fra[i][j + 1] = [i, j, false];
      }
    }
  }

  const paaSlag = new Map();
  // Hvilken takt i TEKSTlesinga som svarer til hvilken i NOTElesinga.
  // De to teller takter hver for seg, saa repetisjonstegnene — som bare
  // den ene leser — maa oversettes foer de kan brukes. Hvert justerte
  // par er én stemme for en kobling; flertallet vinner.
  const stemmer = new Map();
  let i = a.length, j = b.length, satt = 0;
  while (i > 0 || j > 0) {
    const steg = fra[i][j];
    if (!steg) break;
    if (steg[2]) {
      const note = b[steg[1]];
      paaSlag.set(note.takt + ':' + note.slag, a[steg[0]].tekst);
      const fraT = a[steg[0]].takt, tilT = note.takt;
      if (!stemmer.has(fraT)) stemmer.set(fraT, new Map());
      const s = stemmer.get(fraT);
      s.set(tilT, (s.get(tilT) || 0) + 1);
      satt++;
    }
    i = steg[0]; j = steg[1];
  }
  const taktKart = new Map();
  for (const [fraT, s] of stemmer) {
    let beste = null, flest = 0;
    for (const [tilT, n] of s) if (n > flest) { flest = n; beste = tilT; }
    if (beste !== null) taktKart.set(fraT, beste);
  }

  // Teksten legges paa ALLE sangstavene paa samme slag: i en homofon
  // sats synger koret de samme ordene samtidig. Men bare ÉN tone per
  // slag per stav skal baere stavelsen — ligger det en akkord der,
  // ville alle tonene faatt den, og teksten kom ut dobbelt:
  // «talc talc can can seem seem to to».
  for (const stav of staver) {
    const brukt = new Set();
    for (const n of stav) {
      const k = n.takt + ':' + n.slag;
      if (brukt.has(k)) continue;
      const t = paaSlag.get(k);
      if (t) { n.tekst = t; brukt.add(k); }
    }
  }
  return { satt, taktKart };
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
  const doc = { deler: [], slagPerTakt: 4, tittel: '', fortegn: null,
                merker: [], merkerFunnet: 0 };
  let forskyvning = 0;

  for (const post of liste) {
    // En side kommer enten som bare noter — en opplastet notefil — eller
    // som to lesinger av det samme arket, der den ene har tonene og den
    // andre teksten. Begge formene tas imot her.
    const erPar = post && !ArrayBuffer.isView(post) && !(post instanceof ArrayBuffer) && post.noter;
    const noterBytes = erPar ? post.noter : post;
    const tekstBytes = erPar ? post.tekst : null;

    let side;
    try { side = await lesBytes(noterBytes); } catch (e) { continue; }
    if (!side.deler.length) continue;

    // Teksten legges paa FOER taktnumrene forskyves. De to lesingene
    // teller takter hver for seg, og begge begynner paa arkets egen
    // takt 1 — forskyver vi foerst, staar de ikke lenger i samme verden.
    //
    // At dette feiler skal aldri felle sida: tekst er et tillegg, toner
    // er poenget.
    if (tekstBytes) {
      try {
        const tekstDoc = await lesBytes(tekstBytes);
        const { taktKart } = leggPaaTekst(side, stavelserFra(tekstDoc));
        // Repetisjonstegnene leses BARE av tekstleseren — den nevrale
        // skriver dem ikke i det hele tatt, saa et strofisk stykke ble
        // lest som om hvert vers var ny musikk. Taktnumrene er
        // tekstlesingas egne, og oversettes med koblinga justeringa ga.
        const funnet = merkerFra(tekstDoc);
        doc.merkerFunnet += funnet.length;
        const audTakter = Math.max(...tekstDoc.deler.map((d) => d.takter || 0), 0);
        const noteTakter = Math.max(...side.deler.map((d) => d.takter || 0), 0);
        // Er de to lesingene sterkt uenige om hvor mange takter arket
        // har, vet vi ikke hvor et merke hoerer hjemme. Da er det bedre
        // aa la det vaere enn aa sette et repetisjonstegn paa feil sted.
        const enige = audTakter && noteTakter
          && Math.min(audTakter, noteTakter) >= Math.max(audTakter, noteTakter) * 0.75;
        if (enige) {
          for (const m of funnet) {
            const t = oversettTakt(taktKart, m.takt, audTakter, noteTakter);
            if (t) doc.merker.push(Object.assign({}, m, { takt: t + forskyvning }));
          }
        }
      } catch (e) { /* uten tekst, men med noter */ }
    }

    if (side.slagPerTakt) doc.slagPerTakt = side.slagPerTakt;
    if (!doc.tittel && side.tittel) doc.tittel = side.tittel;
    // Tonearten fra hver side. Den foerste sida er den som teller mest:
    // der staar noekkelen i sin rene form, foer eventuelle skifter.
    if (Number.isFinite(side.fortegn) && doc.fortegn === null) doc.fortegn = side.fortegn;

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

  // Har leseren kalt ALT for klaver, betyr navnet ingenting.
  //
  // En nevral leser doeper hvert system den ser til «Piano», og et
  // firestavs korpartitur ER ett system. Tror vi paa det, blir hele
  // stykket et klaver: ingen sangstemmer, stemmenavnene fra skanneren
  // blir ikke brukt, og teksten faar ingen aa sitte paa. Det rammet
  // nettopp de stykkene som IKKE har klaver.
  //
  // Vi overstyrer bare naar brukeren har sagt at det ER sangstemmer
  // her. Et ekte klaverstykke faar fortsatt vaere et klaverstykke.
  // Sopran eller alt i noten? Da er G-noekkelen en vanlig G-noekkel, og
  // oktavgjettinga under skal ligge unna. Se oktavAvNokkel.
  const harLyseStemmer = (valg.stemmer || []).some((n) => /sopran|alt\b/i.test(n));
  const vilHaSang = (valg.stemmer || []).some((n) => !/^klaver/i.test(n));
  const altErKlaver = vilHaSang && doc.deler.every((d) => gruppeAv(d) === 'klaver');

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
      const oktav = oktavAvNokkel(
        nokkel, median(paaStaven.map((n) => n.midi)), harLyseStemmer);

      const stemmer = stemmerPaaStav(paaStaven);
      const gruppe = (altErKlaver ? null : gruppeAv(del))
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
  // SA BRUKEREN AT DET FINNES KLAVER?
  //
  // Skanneren spoer linje for linje: «hvilken stemme er 1. linje, 2.
  // linje …». Lista er derfor en fasit over hvor mange staver arket har
  // og hva de er. Staar det ingen klaverlinje der, FINNES det ingen —
  // og det leseren kalte klaver er sangstoff som er tatt fra stemmene.
  //
  // Det skjedde: brukeren oppga tre stemmer, lesinga fant fem linjer,
  // og de to nederste ble doept «klaver h» og «klaver h 2». De laa paa
  // median 61 og 50 — midt i sangregisteret — mens de tre «stemmene»
  // laa en oktav for hoeyt og var innbyrdes like. Baryton og bass
  // manglet altsaa nettopp det stoffet som sto merket klaver.
  const oppgittKlaver = (valg.stemmer || []).some((n) => /^klaver/i.test(n));

  if (oppgitt.length > 1) {
    const sang = rekke.filter((n) => !/^klaver/i.test(n));
    // Uten oppgitt klaver er HELE lesinga sangstoff.
    const kilde = oppgittKlaver ? sang : rekke.slice();
    const lengder = sang.map((n) => ut[n].length);
    const storst = Math.max(...lengder, 0);
    const minst = Math.min(...lengder, Infinity);
    const skjev = storst > 0 && minst < storst * 0.25;

    if (kilde.length !== oppgitt.length || skjev) {
      const alle = [];
      for (const n of kilde) for (const x of ut[n]) alle.push(x);
      alle.sort((a, b) => a.takt - b.takt || a.slag - b.slag);
      if (alle.length >= oppgitt.length * 4) {
        for (const n of kilde) { delete ut[n]; }
        const beholdt = oppgittKlaver ? rekke.filter((n) => /^klaver/i.test(n)) : [];
        const deler = delPaaHoyde(alle, oppgitt.length);
        rekke.length = 0;
        oppgitt.forEach((navn, i) => {
          if (deler[i] && deler[i].length) { ut[navn] = deler[i]; rekke.push(navn); }
        });
        for (const n of beholdt) rekke.push(n);
      }
    }
  }

  // Teksten ut til alle SANGstemmene: koret synger de samme ordene.
  // Klaveret synger ikke, og skal ikke ha stavelser under seg — det
  // ville satt sangtekst under en akkompagnementsfigur som ingen
  // synger, og gjort klaverlinja uleselig.
  const synger = rekke.filter((n) => !/^klaver/i.test(n));
  // Finnes det ingen sangstemmer i det hele tatt, er dette et rent
  // klaverstykke. Da er det ingen tekst aa spre — og ingen aa fjerne.
  if (!synger.length) return ferdig(valg, doc, rekke, ut, slagPerTakt);
  const ordPaaSlag = new Map();
  for (const n of synger) {
    for (const x of ut[n]) {
      if (!x.tekst) continue;
      const k = x.takt + ':' + x.slag;
      if (!ordPaaSlag.has(k)) ordPaaSlag.set(k, { ord: x.tekst, del: x.del });
    }
  }
  for (const n of rekke) {
    if (!synger.includes(n)) {
      // Har klaveret faatt tekst fra lesinga, fjernes den her.
      for (const x of ut[n]) { delete x.tekst; delete x.del; }
      continue;
    }
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

  return ferdig(valg, doc, rekke, ut, slagPerTakt);
}

// Toneartsnavn paa norsk, fra sju b-er til sju kryss. Merk at B er
// b-en og H er den rene sjuende — norsk, ikke engelsk.
const DURNAVN = ['Cess', 'Gess', 'Dess', 'Ass', 'Ess', 'B', 'F',
  'C', 'G', 'D', 'A', 'E', 'H', 'Fiss', 'Ciss'];

/** Samler det ferdige stykket. */
function ferdig(valg, doc, rekke, ut, slagPerTakt) {
  // Hent enkelttoner som har spratt en oktav ut av stemmens leie.
  // Gjoeres helt til slutt: foerst naa er stemmene satt, og det er
  // stemmens eget leie foldinga maaler mot.
  for (const n of rekke) foldInnIOmfang(ut[n]);

  let takter = 0;
  const medTekst = new Set();
  for (const n of rekke) {
    for (const x of ut[n]) {
      if (x.takt > takter) takter = x.takt;
      if (x.tekst) medTekst.add(x.takt + ':' + x.slag);
    }
  }

  return {
    // Antall stavelser som faktisk havnet paa en tone. Det er dette
    // man ser i appen, ikke hvor mange tekstleseren fant.
    ord: medTekst.size,
    // Repetisjonene: hvor verset begynner om igjen, og 1./2. hus.
    // Tomt naar tekstlesinga ikke kom gjennom — da vet vi ikke.
    gjentakelser: (doc.merker || []).length ? doc.merker : undefined,
    // Hvor mange repetisjonstegn tekstlesinga fant, mot hvor mange vi
    // klarte aa plassere. Spriker de, er det oversettelsen mellom de to
    // lesingenes taktnumre som ikke holder — ikke at tegnene mangler.
    merkerFunnet: doc.merkerFunnet || 0,
    // Tonearten: tallet til graveringa, navnet til deg. Uten dette
    // tegnes ingen faste fortegn, og da maa hver svarte tangent faa et
    // loest kryss — selv i en note med fire b-er.
    fortegn: Number.isFinite(doc.fortegn) ? doc.fortegn : undefined,
    toneart: Number.isFinite(doc.fortegn) && Math.abs(doc.fortegn) <= 7
      ? DURNAVN[doc.fortegn + 7] + '-dur' : undefined,
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
