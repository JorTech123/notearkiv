'use strict';
/**
 * noter-fra-import.js — tar MusicXML fra en notegjenkjenner og gjoer det
 * om til stemmer arkivet kan spille.
 *
 * Leser `data/musicxml-inn/`, enten som én fil per stykke eller som en
 * mappe med ett ark per side. Det som kommer herfra overstyrer alt annet.
 *
 * Stemmene kommer fra `data/oppsett.json`, ikke fra gjetning:
 *
 *     "hark-the-herald-angels-sing": { "staver": ["tenor", "bass"] }
 *
 * Opuscan spoer brukeren om akkurat det samme, og det er en fornuftig
 * arbeidsdeling — maskinen leser tonene, mennesket sier hvem som synger
 * dem. Opplysningen avgjoer to ting maskinen ellers bommer paa:
 * stemmenavnene, og oktaven. En tenorstav staar i G-noekkel med en liten
 * 8 under og klinger et oktav lavere enn den ser ut.
 *
 *   node tools/src/noter-fra-import.js
 */

const fs = require('node:fs');
const path = require('node:path');
const M = require('./musicxml.js');

const UT = 'data/ut';
const INN = 'data/musicxml-inn';

/** Hva en stav av hver type heter, etter hvor mange stemmer den rommer. */
const STAVTYPER = {
  tenor: { navn: ['1. tenor', '2. tenor'], ett: 'tenor', oktav: -12 },
  bass: { navn: ['baryton', 'bass'], ett: 'bass', oktav: 0 },
  baryton: { navn: ['baryton', 'bass'], ett: 'baryton', oktav: 0 },
  sopran: { navn: ['1. sopran', '2. sopran'], ett: 'sopran', oktav: 0 },
  alt: { navn: ['1. alt', '2. alt'], ett: 'alt', oktav: 0 },
  // Klaveret er ikke en sangstemme, men det SKAL spilles: det er
  // akkompagnementet koret synger mot. Det merkes derfor som klaver i
  // stedet for aa kastes, og faar klaverklang ved avspilling.
  piano: { navn: ['klaver h', 'klaver v'], ett: 'klaver', oktav: 0, klaver: true },
};

/** Er stemmenavnet en klaverstemme? */
function erKlaver(navn) {
  return /^klaver/.test(String(navn || '').toLowerCase());
}

function slugg(s) {
  return s
    .replace(/\.(musicxml|mxl|xml)$/i, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function median(a) {
  const v = a.slice().sort((x, y) => x - y);
  return v.length ? v[v.length >> 1] : 0;
}

const OPPSETT = (function () {
  try {
    const raa = JSON.parse(fs.readFileSync('data/oppsett.json', 'utf8'));
    const ut = {};
    for (const k in raa) if (k[0] !== '_' && raa[k]) ut[k] = raa[k];
    return ut;
  } catch (e) { return {}; }
})();

/** Gjenkjenner stavtypen av et delnavn, naar oppsettet ikke sier noe. */
function typeAvNavn(navn) {
  const n = (navn || '').toLowerCase();
  if (/piano|klaver/.test(n)) return 'piano';
  if (/tenor/.test(n)) return 'tenor';
  if (/bass/.test(n)) return 'bass';
  if (/baryton/.test(n)) return 'baryton';
  if (/sopran/.test(n)) return 'sopran';
  if (/\balt\b/.test(n)) return 'alt';
  return null;
}

/**
 * Deler én stroem i to stemmer paa tonehoeyde.
 *
 * Noter som starter samtidig hoerer til samme anslag; den oeverste gaar
 * til foerste stemme, resten til andre. Er det bare én tone, foerer den
 * videre i begge — stemmene synger unisont der.
 */
function delPaaHoyde(noter, antall) {
  const n = Math.max(2, antall || 2);
  const anslag = new Map();
  for (const x of noter) {
    const k = x.takt + ':' + x.slag;
    if (!anslag.has(k)) anslag.set(k, []);
    anslag.get(k).push(x);
  }

  const ut = [];
  for (let i = 0; i < n; i++) ut.push([]);

  for (const [, gruppe] of anslag) {
    gruppe.sort((a, c) => c.midi - a.midi);     // hoeyeste foerst
    for (let i = 0; i < n; i++) {
      // Faerre toner enn stemmer betyr at stemmene synger unisont der,
      // eller at lesinga bare fant den ene. Den oeverste gaar til de
      // oeverste stemmene og den nederste til de nederste — da havner
      // ingen stemme i feil ende naar satsen trekker seg sammen.
      let j;
      if (gruppe.length >= n) {
        j = Math.round(i * (gruppe.length - 1) / (n - 1));
      } else if (gruppe.length === 1) {
        j = 0;
      } else {
        j = i < n / 2 ? 0 : gruppe.length - 1;
      }
      ut[i].push(gruppe[Math.min(gruppe.length - 1, j)]);
    }
  }

  const sorter = (l) => l.sort((a, c) => a.takt - c.takt || a.slag - c.slag);
  return ut.map(sorter);
}

/**
 * Alle kilder i inn-mappa: en fil eller en mappe med ark per stykke.
 *
 * Finnes begge deler for samme stykke, vinner den enkeltstaaende fila.
 * Den er lagt inn for haand — typisk fra Opuscan — og er bedre enn det
 * vi selv har kjoert fram: hele stykket i én fil, med navngitte stemmer
 * og oktavskiftet notert.
 */
function kilder() {
  const funnet = new Map();
  for (const f of fs.readdirSync(INN)) {
    const full = path.join(INN, f);
    if (fs.statSync(full).isDirectory()) {
      const ark = fs.readdirSync(full)
        .filter((x) => /\.(musicxml|mxl|xml)$/i.test(x)).sort();
      if (!ark.length) continue;
      const id = slugg(f);
      if (!funnet.has(id)) {
        funnet.set(id, { id: id, filer: ark.map((x) => path.join(full, x)), egen: true });
      }
    } else if (/\.(musicxml|mxl|xml)$/i.test(f)) {
      const id = slugg(f);
      funnet.set(id, { id: id, filer: [full], egen: false });
    }
  }
  return [...funnet.values()];
}

/**
 * Sangteksten, hentet fra Audiveris-lesingene i data/musicxml.
 *
 * De to leserne er gode paa hver sin ting. Den nevrale finner tonene —
 * 97 % av dem — men leser ikke ett ord: modellen er aldri trent paa
 * tekst. Audiveris leser teksten («Al-most heav-en», «Some say love,
 * it is riv-er») men bommer paa stemmefordelinga. Saa vi tar tonene fra
 * den ene og ordene fra den andre.
 *
 * Taktnumrene deres kan ikke sammenliknes: Audiveris gav opp paa flere
 * ark, saa den teller 17 takter der den nevrale teller 106. Derfor
 * kobles de ARK FOR ARK — begge leste de samme sidene i samme
 * rekkefoelge — og innenfor arket stilles tonerekkene opp mot
 * hverandre. Da holder sprikene seg inne paa én side.
 */
const AUDIVERIS = 'data/musicxml';

function audiverisMappe(id) {
  if (!fs.existsSync(AUDIVERIS)) return null;
  // Audiveris doeper om mappa si og bytter ut alt som ikke er ASCII med
  // «_»: «59 Ånders Herre» blir «59 _nders Herre», som sluggen gjoer til
  // «nders-herre…» mens stykket heter «anders-herre…». Derfor
  // sammenliknes de uten bindestreker, og det holder at den ene er
  // inneholdt i den andre — da finner vi den igjen selv om foerste
  // bokstav er spist.
  const flat = (s) => s.replace(/-/g, '');
  const maal = flat(id);
  const treff = fs.readdirSync(AUDIVERIS).find((d) => {
    if (!fs.statSync(path.join(AUDIVERIS, d)).isDirectory()) return false;
    const t = flat(slugg(d.replace(/\s*\(Conflict[^)]*\)\s*/gi, '').replace(/^\d+\s+/, '')));
    if (t.length < 8 || maal.length < 8) return t === maal;
    return t === maal || t.includes(maal) || maal.includes(t);
  });
  return treff ? path.join(AUDIVERIS, treff) : null;
}

/**
 * Rydder én stavelse fra OCR-lesinga, eller forkaster den.
 *
 * Audiveris leser alt som staar som tekst under notene, og det er ikke
 * bare sang: akkordsymboler («G(add9)/B», «Am7») staar over staven og
 * havner i samme sekk. De skal ikke synges. Tall hoerer heller ikke
 * hjemme i en stavelse. Resten slipper igjennom som den er — en
 * halvlest stavelse er bedre enn ingen, saa lenge den staar paa rett
 * sted i teksten.
 */
function rensStavelse(raa) {
  if (!raa) return null;
  let s = String(raa)
    .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')      // ligaturer
    .replace(/’/g, "'").replace(/“|”/g, '"')
    .replace(/[~|]/g, '').replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  if (/\d/.test(s)) return null;                            // tall synges ikke
  if (/^[A-G](#|b)?(m|maj|min|dim|aug|sus|add)?(\/[A-G](#|b)?)?$/.test(s)) return null;
  if (!/[a-zA-ZæøåÆØÅéèüö]/.test(s)) return null;           // bare skilletegn
  return s;
}

/** Stavelsene paa ett ark, i den rekkefoelgen de synges. */
function stavelserForArk(mappe, arkNr) {
  const fil = path.join(mappe, `ark-${String(arkNr).padStart(2, '0')}.mxl`);
  if (!fs.existsSync(fil)) return [];
  let doc;
  try { doc = M.lesFil(fil); } catch (e) { return []; }

  // Teksten henger paa én stemme. Flere staver kan ha den samme
  // teksten under seg, saa hvert (takt, slag) tas bare én gang.
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
          tekst: { ord: ord, del: n.tekst.del },
        });
      }
    }
  }
  return [...sett.values()].sort((a, b) => a.takt - b.takt || a.slag - b.slag);
}

/**
 * Legger stavelsene paa tonene i ett ark.
 *
 * Rekkene stilles opp mot hverandre med vanlig sekvensjustering, der
 * tonetrinnet (uten oktav) er signalet. Teksten flyttes over hver gang
 * de to rykker fram SAMMEN — ogsaa naar tonene er ulike, for da er
 * plassen i rekka riktig selv om den ene leste tonen feil. Det er
 * plasseringa vi er ute etter, ikke tonen.
 */
function leggPaaTekst(navngitt, stavelser) {
  if (!stavelser.length || !navngitt.length) return 0;

  // Oeverste stemme baerer teksten; den har én tone per stavelse i en
  // homofon korsats, og det er alle disse arrangementene.
  const topp = navngitt.reduce((a, s) =>
    (median(s.noter.map((n) => n.midi)) > median(a.noter.map((n) => n.midi)) ? s : a), navngitt[0]);
  const b = topp.noter;
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

  // Teksten legges paa ALLE stemmene paa samme slag. I en homofon sats
  // synger koret de samme ordene samtidig, og da skal hele koret ha
  // stavelsen — ikke bare den stemmen vi stilte opp mot.
  const paaSlag = new Map();
  let i = a.length, j = b.length, satt = 0;
  while (i > 0 || j > 0) {
    const steg = fra[i][j];
    if (!steg) break;
    if (steg[2]) {
      const note = b[steg[1]];
      paaSlag.set(note.takt + ':' + note.slag, a[steg[0]].tekst);
      satt++;
    }
    i = steg[0]; j = steg[1];
  }
  for (const stemme of navngitt) {
    // Bare ÉN tone per slag skal baere stavelsen. Ligger det en akkord
    // der, ville alle tonene faatt den, og teksten kom ut dobbelt:
    // «talc talc can can seem seem to to».
    const brukt = new Set();
    for (const n of stemme.noter) {
      const k = n.takt + ':' + n.slag;
      if (brukt.has(k)) continue;
      const t = paaSlag.get(k);
      if (t) { n.tekst = t; brukt.add(k); }
    }
  }
  return satt;
}

/**
 * Retter opp en del der systemene er lagt i KOE i stedet for stablet.
 *
 * Leseren leser én stav om gangen. Klarer den aa se at stavene paa et
 * system hoerer sammen, kommer de ut som parallelle staver — og da er
 * alt greit. Men paa en femtedel av arkene ser den dem ikke, og da
 * skriver den dem ut etter hverandre: hele tenorlinja i system 1, saa
 * basslinja i system 1, saa tenor i system 2 … som om det var 34 takter
 * paa rad. Lyden blir da noe helt annet enn det som staar paa arket.
 *
 * Her settes de tilbake. Hvert `new-system`-merke starter et segment,
 * og segmentene kommer i faste runder: like mange som systemet har
 * staver. Hvor mange det er, maa gjettes — men det kan maales: velger
 * man riktig rundelengde, ligger segmentene i samme spor i hver runde
 * i samme leie (tenorlinja er like hoey i system 1 som i system 3).
 * Velger man feil, spriker de. Saa vi proever alle rundelengder og tar
 * den som gir minst sprik.
 *
 * @returns {Array|null} nye noter med stav og takt satt, eller null
 */
function avkoe(del, forventet) {
  const start = del.systemstart || [];
  if (start.length < 4 || !del.noter.length) return null;

  // Ett segment per system-merke, med taktene og tonene sine.
  const seg = start.map((fra, i) => ({
    fra: fra,
    til: i + 1 < start.length ? start[i + 1] : del.takter + 1,
    noter: [],
  }));
  if (seg[0].fra > 1) seg.unshift({ fra: 1, til: seg[0].fra, noter: [] });
  for (const n of del.noter) {
    for (const s of seg) if (n.takt >= s.fra && n.takt < s.til) { s.noter.push(n); break; }
  }
  const brukte = seg.filter((s) => s.noter.length >= 3);
  if (brukte.length < 4) return null;

  const medianAv = (s) => median(s.noter.map((n) => n.midi));
  for (const s of brukte) s.median = medianAv(s);

  // Hvilken rundelengde gir minst sprik innen hvert spor?
  const sprik = (N) => {
    let sum = 0;
    for (let spor = 0; spor < N; spor++) {
      const mine = brukte.filter((s, i) => i % N === spor);
      if (!mine.length) continue;
      const m = median(mine.map((s) => s.median));
      for (const s of mine) sum += Math.abs(s.median - m);
    }
    return sum / brukte.length;
  };

  let beste = null;
  for (let N = 2; N <= 6; N++) {
    if (brukte.length / N < 2) break;
    const s = sprik(N);
    if (!beste || s < beste.snitt) beste = { N: N, snitt: s };
  }
  if (!beste || beste.snitt > 7) return null;

  // Vet vi hvor mange linjer noten HAR — fordi brukeren har sagt det —
  // saa er det tallet bedre enn det vi maaler oss fram til. Maalinga
  // velger den runden som gir jevnest leie, og paa en flat lesing kan
  // to spor se like jevne ut som tre. Da deler vi satsen i to der den
  // har tre stemmer.
  if (forventet >= 2 && forventet <= 6 && brukte.length / forventet >= 2) {
    const s = sprik(forventet);
    if (s <= Math.max(7, beste.snitt * 1.6)) beste = { N: forventet, snitt: s };
  }

  // Og er dette i det hele tatt en koe?
  //
  // En del som ER én stemme — slik en ordentlig leser skriver den — har
  // alle segmentene i samme leie, og da gir ogsaa runde paa ÉN lavt
  // sprik. Da skal ingenting stables om. Bare naar flere spor forklarer
  // leiene klart bedre enn ett, er stavene virkelig lagt etter
  // hverandre. Uten denne proeven ble Opuscans egne filer revet i
  // stykker: 668 toner ble 185.
  const ett = sprik(1);
  if (beste.snitt > ett * 0.6 || ett - beste.snitt < 2) return null;

  const N = beste.N;
  // Takttallene bygges opp paa nytt: hvert system begynner der det
  // forrige sluttet, og alle stavene i systemet deler taktnumrene.
  const ut = [];
  let forskyvning = 0;
  for (let runde = 0; runde * N < brukte.length; runde++) {
    const iRunden = brukte.slice(runde * N, runde * N + N);
    let lengst = 0;
    for (let spor = 0; spor < iRunden.length; spor++) {
      const s = iRunden[spor];
      for (const n of s.noter) {
        ut.push(Object.assign({}, n, {
          takt: forskyvning + (n.takt - s.fra) + 1,
          stav: spor + 1,
        }));
      }
      if (s.til - s.fra > lengst) lengst = s.til - s.fra;
    }
    forskyvning += lengst;
  }
  if (process.env.NOTE_SPOR) {
    process.stdout.write(`      avkoe: ${brukte.length} segmenter, ` +
      `${N} staver per system, sprik ${beste.snitt.toFixed(1)} -> ${forskyvning} takter\n`);
  }
  return ut;
}

/**
 * Deler ett dokument i stroemmer, én per (del, stav, stemme), i
 * rekkefoelge ovenfra og ned.
 */
function stroemmer(doc, forventetStaver) {
  const ut = [];
  doc.deler.forEach((del) => {
    // Ligger hele arket paa én stav med mange systemmerker, er
    // systemene lagt i koe. Da maa de stables tilbake foerst.
    const flereStaver = del.noter.some((n) => (n.stav || 1) > 1);
    const rettet = flereStaver ? null : avkoe(del, forventetStaver);
    const noterIDel = rettet || del.noter;

    const grupper = new Map();
    for (const n of noterIDel) {
      const k = (n.stav || 1) * 1000 + n.stemme;
      if (!grupper.has(k)) grupper.set(k, []);
      grupper.get(k).push(n);
    }
    [...grupper.keys()].sort((a, c) => a - c).forEach((k) => {
      const liste = grupper.get(k).slice()
        .sort((a, c) => a.takt - c.takt || a.slag - c.slag);
      // Smaa stroemmer er feillesinger, ikke sangere.
      if (liste.length >= 6) {
        const stav = Math.floor(k / 1000);
        ut.push({
          delnavn: del.navn || '', delid: del.id || '', stav: stav, noter: liste,
          nokkel: (del.nokler || {})[stav] || null,
        });
      }
    });
  });
  return ut;
}

/** Omtrent hvor de ulike stemmene ligger naar de klinger, i MIDI. */
const LEIE = { sopran: 69, alt: 62, tenor: 59, baryton: 52, bass: 48 };

/** Hva stemmene faktisk kan synge, i klingende MIDI. */
const OMFANG = {
  '1. sopran': [60, 84], '2. sopran': [57, 81], sopran: [58, 83],
  '1. alt': [53, 77], '2. alt': [50, 74], alt: [52, 76],
  '1. tenor': [48, 74], '2. tenor': [45, 71], tenor: [46, 72],
  baryton: [41, 65], bass: [36, 60],
};

/**
 * Retter enkelttoner som hopper en oktav fra sine naboer.
 *
 * Omfangsfoldinga tar bare det som ligger utenfor stemmens yttergrenser.
 * Men en tone kan ligge godt innenfor omfanget og likevel vaere lest en
 * oktav feil — den staar bare midt i en linje der alt annet ligger en
 * oktav under, og paa skjermen spretter den plutselig hoeyt opp.
 *
 * En korstemme beveger seg i hovedsak trinnvis. Et sprang paa over ni
 * halvtoner BORT fra begge naboene, der en oktav opp eller ned legger
 * tonen pent inntil dem igjen, er en feillest oktav og ikke et sprang
 * komponisten har skrevet. Proeven er bevisst streng: den retter bare
 * naar flyttinga gjoer tonen klart naermere naboene.
 */
function foldMotNaboene(noter, navn) {
  const omfang = OMFANG[navn] || [0, 127];
  let rettet = 0;
  for (let i = 1; i < noter.length - 1; i++) {
    const naer = (noter[i - 1].midi + noter[i + 1].midi) / 2;
    const naa = Math.abs(noter[i].midi - naer);
    if (naa <= 9) continue;
    const opp = Math.abs(noter[i].midi + 12 - naer);
    const ned = Math.abs(noter[i].midi - 12 - naer);
    const beste = Math.min(opp, ned);
    if (beste > 5 || beste >= naa) continue;
    const ny = noter[i].midi + (opp < ned ? 12 : -12);
    // Flyttinga maa ikke dytte tonen ut av det stemmen kan synge.
    if (ny < omfang[0] || ny > omfang[1]) continue;
    noter[i].midi = ny;
    rettet++;
  }
  return rettet;
}

/**
 * Folder toner som ligger utenfor stemmens omfang inn i det.
 *
 * En tone paa MIDI 17 i en tenorstemme er ikke en tone — det er en
 * feillest oktav. Leseren treffer notehodets plass paa staven, men
 * bommer paa hvilken oktav den havner i naar hjelpelinjene er utydelige
 * eller oktavsifferet gjettes. Tonetrinnet er altsaa riktig; registeret
 * er det ikke.
 *
 * Derfor flyttes tonen oktavvis til den er innenfor det stemmen kan
 * synge. Det bevarer linjas form og gjoer den syngbar. Alternativet —
 * aa la den staa — gir en oevingsfil med toner ingen kan bruke, og
 * alternativet aa kaste den gir hull i melodien.
 */
function foldInnIOmfang(noter, navn) {
  const omfang = OMFANG[navn];
  if (!omfang) return 0;
  const [lav, hoy] = omfang;
  let flyttet = 0;
  for (const n of noter) {
    const foer = n.midi;
    while (n.midi < lav) n.midi += 12;
    while (n.midi > hoy) n.midi -= 12;
    // Skulle tonen havne under igjen, ligger den mellom to stoler;
    // legg den paa naermeste kant i stedet for aa sprette.
    if (n.midi < lav) n.midi = lav;
    if (n.midi !== foer) flyttet++;
  }
  return flyttet;
}

/**
 * Hvor mange halvtoner en stav klinger fra det som staar skrevet.
 *
 * Dette ble foer gjettet ut av hvilken STEMME vi trodde staven var, og
 * det er bakvendt: gjetter vi feil stemme, flytter vi oktaven feil og
 * gjoer feilen verre. Noekkelen staar i fila, saa den kan leses.
 *
 * To ting avgjoer:
 *
 *  1. Har fila selv notert `clef-octave-change`, er den eksplisitt, og
 *     da gjoer vi ingenting mer — tonehoeydene klinger som de staar.
 *  2. Ellers: en mannsstemme i G-noekkel synger en oktav under det
 *     skrevne. Men en G-noekkel er ogsaa klaverets hoeyre haand, og den
 *     klinger som den staar. Skillet er hvor staven ligger: skrevet
 *     median fra 66 og opp er for hoeyt for noen av dem aa SYNGE, saa
 *     den staven maa vaere notert en oktav opp. Ligger den lavere,
 *     staar den alt i det leiet den klinger i.
 */
function oktavAvNokkel(nokkel, skrevetMedian) {
  if (!nokkel || !nokkel.tegn) return skrevetMedian >= 66 ? -12 : 0;
  if (nokkel.oktavskift) return 0;          // fila sier det selv
  if (nokkel.tegn !== 'G') return 0;        // F- og C-noekkel staar som de klinger
  return skrevetMedian >= 66 ? -12 : 0;
}

/**
 * Hvilket leie hver stav i oppsettet er ventet aa ligge i.
 *
 * Staar samme type flere ganger etter hverandre — ["tenor", "tenor"] —
 * er det 1. og 2. tenor paa hver sin stav, og de ligger en terts fra
 * hverandre. Rommer staven baade stemmene, ligger den midt imellom, og
 * da er grunnverdien riktig som den staar.
 */
function forventetLeie(staver) {
  const ut = staver.map((s) => LEIE[String(s).toLowerCase()]);
  let i = 0;
  while (i < staver.length) {
    let j = i;
    while (j + 1 < staver.length && staver[j + 1] === staver[i]) j++;
    const antall = j - i + 1;
    if (antall > 1) {
      for (let k = i; k <= j; k++) {
        if (ut[k] !== undefined) ut[k] += (antall - 1 - 2 * (k - i)) * 3;
      }
    }
    i = j + 1;
  }
  return ut;
}

/**
 * Hvilke stemmer hver stav i oppsettet skal gi.
 *
 * To staver av samme slag — ["tenor", "tenor"] — er 1. og 2. tenor paa
 * hver sin linje, og hver av dem rommer ÉN stemme. Staar slaget bare én
 * gang, er begge stemmene trengt sammen paa den ene staven, og da skal
 * den deles. Blandes dette, blir barytonstaven delt i baryton og bass
 * mens den virkelige bass-staven ogsaa blir det, og de to kolliderer
 * paa samme navn.
 */
function stavPlan(staver) {
  const plan = staver.map((s) => {
    const type = STAVTYPER[String(s).toLowerCase()];
    return type ? { type: type, noekkel: type.navn.join('|'), navn: null } : null;
  });
  const teller = {};
  let syngende = 0;
  for (const p of plan) if (p) { teller[p.noekkel] = (teller[p.noekkel] || 0) + 1; syngende++; }

  // Med TRE eller flere sangstaver har hver stav sin egen stemme.
  //
  // «Ånders Herre» staar Tenor / Baryton / Bass — tre stemmer paa tre
  // staver. Delte vi tenorstaven i 1. og 2. tenor fordi «tenor» bare
  // staar én gang, fikk vi fire stemmer av et trestemt stykke, og de to
  // tenorene ble identiske. Det er bare det sammentrengte partituret
  // paa TO staver som rommer to stemmer per stav.
  const deles = syngende <= 2;

  const brukt = {};
  for (const p of plan) {
    if (!p) continue;
    if (teller[p.noekkel] === 1 && deles) {
      p.navn = p.type.navn.slice();        // hele paret paa én stav: del den
    } else if (teller[p.noekkel] === 1) {
      p.navn = [p.type.ett];
    } else {
      const i = brukt[p.noekkel] = (brukt[p.noekkel] || 0);
      brukt[p.noekkel] = i + 1;
      p.navn = [p.type.navn[i] || `${p.type.ett} ${i + 1}`];
    }
  }
  return plan;
}

/**
 * Kobler stavene paa ETT ark til stemmene i oppsettet.
 *
 * Nevrale lesere teller stavene fra 1 paa hvert ark, og finner ikke
 * alltid like mange. Leses oppsettet av paa plass — stav 1 er foerste
 * stemme — havner 2. tenor paa barytonens plass saa snart ett ark
 * mangler en stav, og fra da av er stemmene blandet. Det var nettopp
 * det som gjorde at avspillinga ikke lignet noten.
 *
 * Her kobles de paa tonehoeyde i stedet. Et korpartitur staar alltid
 * ovenfra og ned etter leie, saa rekkefoelgen er den samme i begge
 * lister — det som varierer er hva som mangler. Det er en vanlig
 * sekvensjustering: gaa gjennom begge listene samtidig, og la den
 * koblinga vinne som samlet ligger naermest leiene stemmene synger i.
 *
 * @param klingende  medianen hver gruppe KLINGER paa, ikke den skrevne
 * @param fasit      stykkets EGNE leier per stemmenavn, naar vi har
 *                   lest dem av arkene foerst. Da trenger vi ikke gaa
 *                   etter en generell tabell.
 * @returns {Array<number|null>} stavindeks i oppsettet, per gruppe
 */
function koble(klingende, staver, fasit) {
  const generelt = forventetLeie(staver);
  const plan = stavPlan(staver);

  // Stykkets eget leie slaar tabellen. Tabellen sier hva en baryton
  // pleier aa ligge paa; arkene sier hva DENNE barytonen ligger paa.
  const vent = generelt.map((v, i) => {
    if (!fasit || !plan[i]) return v;
    const egne = plan[i].navn.map((n) => fasit[n]).filter((x) => x !== undefined);
    if (!egne.length) return v;
    return egne.reduce((a, x) => a + x, 0) / egne.length;
  });

  const G = klingende.length, V = staver.length;
  const UTEN_STAV = 4;       // leseren fant ikke denne staven paa arket
  const UTEN_GRUPPE = 16;    // stroemmen er ikke en sangstav i det hele tatt
  // Over dette er staven ikke den stemmen, uansett hva som ellers
  // passer. Det er denne grensa som holder klaveret ute: paa ark der
  // koret ikke ble lest, lot DP-en klaverets venstre haand gli inn som
  // bass — og da synger «barytonen» akkompagnementet, en oktav under
  // det et menneske kan synge.
  const MAKS = fasit ? 7 : 11;

  function kost(g, v) {
    const type = STAVTYPER[String(staver[v]).toLowerCase()];
    if (type === null) return 5;        // klaver: ingen tonehoeyde aa gaa etter
    if (type === undefined) return 9;
    const avvik = Math.abs(klingende[g] - vent[v]);
    return avvik > MAKS ? 40 : avvik;
  }

  // d[g][v] = laveste kostnad for de g foerste gruppene mot de v
  // foerste stavene. fra[][] husker hvilket steg som gav den.
  const d = [], fra = [];
  for (let g = 0; g <= G; g++) {
    d.push(new Array(V + 1).fill(Infinity));
    fra.push(new Array(V + 1).fill(null));
  }
  d[0][0] = 0;
  for (let g = 0; g <= G; g++) {
    for (let v = 0; v <= V; v++) {
      if (d[g][v] === Infinity) continue;
      if (g < G && v < V) {
        const n = d[g][v] + kost(g, v);
        if (n < d[g + 1][v + 1]) { d[g + 1][v + 1] = n; fra[g + 1][v + 1] = ['par', g, v]; }
      }
      if (v < V) {
        const n = d[g][v] + UTEN_STAV;
        if (n < d[g][v + 1]) { d[g][v + 1] = n; fra[g][v + 1] = ['stav', g, v]; }
      }
      if (g < G) {
        const n = d[g][v] + UTEN_GRUPPE;
        if (n < d[g + 1][v]) { d[g + 1][v] = n; fra[g + 1][v] = ['gruppe', g, v]; }
      }
    }
  }

  const svar = new Array(G).fill(null);
  let g = G, v = V;
  while (g > 0 || v > 0) {
    const steg = fra[g][v];
    if (!steg) break;
    if (steg[0] === 'par') svar[steg[1]] = steg[2];
    g = steg[1]; v = steg[2];
  }
  return svar;
}

/**
 * Setter navn og oktav paa stroemmene i ett ark.
 * `staver` er listen fra oppsettet, f.eks. ["tenor", "bass"].
 */
function navngi(str, staver, alleredeKlingende, fasit) {
  // Grupper stroemmene etter hvilken stav de hoerer til, i rekkefoelge.
  const stavOrden = [];
  for (const s of str) {
    const noekkel = s.delid + '#' + s.stav;
    if (!stavOrden.includes(noekkel)) stavOrden.push(noekkel);
  }

  const paa = (noekkel) => str.filter((s) => s.delid + '#' + s.stav === noekkel);

  // Hver stav faar oktaven sin fra noekkelen, FOER koblinga — det er
  // bare naar vi vet hva staven klinger paa at vi kan kjenne igjen
  // hvilken stemme den er.
  const leie = {};
  for (const k of stavOrden) {
    const grupper = paa(k);
    const alle = [];
    let takter = 1;
    for (const s of grupper) {
      for (const n of s.noter) { alle.push(n.midi); if (n.takt > takter) takter = n.takt; }
    }
    const sortert = alle.slice().sort((a, b) => a - b);
    const skrevet = median(alle);
    // Med stykkets egne leier i haanden velges oktaven etter hvilken
    // av de to mulighetene som lander naermest en stemme stykket
    // FAKTISK har — ikke etter en fast grense paa 66.
    //
    // Den grensa gjorde at samme tenorstav ble skiftet paa ett ark
    // (skrevet 69) og staaende paa det neste (skrevet 65), og da
    // spriker stemmen en oktav midt i stykket.
    let oktav = alleredeKlingende ? 0 : oktavAvNokkel(grupper[0].nokkel, skrevet);
    const nokkel = grupper[0].nokkel;
    if (!alleredeKlingende && fasit && nokkel && nokkel.tegn === 'G' && !nokkel.oktavskift) {
      const naermest = (m) => Math.min(...Object.values(fasit).map((v) => Math.abs(m - v)));
      oktav = naermest(skrevet) <= naermest(skrevet - 12) ? 0 : -12;
    }
    // Spennet maales mellom 10. og 90. persentil, ikke mellom hoeyeste
    // og laveste. Noen feilleste oktaver er nok til aa blaase opp et
    // min-til-maks-spenn, og da ser en helt vanlig tenorstemme ut som
    // et klaver.
    const p = (d) => sortert.length
      ? sortert[Math.min(sortert.length - 1, Math.floor(sortert.length * d))] : 0;
    const medNoter = new Set();
    for (const s of grupper) for (const n of s.noter) medNoter.add(n.takt);
    leie[k] = {
      skrevet: skrevet, oktav: oktav, klinger: skrevet + oktav,
      spenn: p(0.9) - p(0.1),
      tettleik: alle.length / Math.max(1, medNoter.size),
    };
  }

  // Hvilke staver kan i det hele tatt vaere en SUNGET stemme?
  //
  // Dette maa avgjoeres paa staven selv, for rekkefoelgen i fila kan vi
  // ikke stole paa: leseren legger alltid de sammenbundne stavene (et
  // klaver) foerst, uansett hvor de staar paa arket. Derfor sorteres
  // stavene her etter hvor de KLINGER, ovenfra og ned, slik et
  // korpartitur staar — og klaveret kjennes igjen paa seg selv:
  //
  //   leie      en mann synger mellom ca. 36 og 70; ingenting utenfor
  //   spenn     en stemme holder seg innen to oktaver. Klaverstemmer
  //             spenner over tre og mer
  //   tettleik  en sanger har én tone om gangen, rundt 4-8 i takta.
  //             Et akkompagnement har akkorder og loep
  // Dette er et POENG, ikke et ja/nei. En hard grense kastet ekte
  // stemmer like gjerne som klaver; her rangeres stavene i stedet, og
  // de beste beholdes — like mange som oppsettet sier at det syngende
  // koret har. Da kan vi ikke miste en stemme helt.
  // Staar det BAADE enkeltstaver og en sammenbundet stavgruppe paa
  // arket, er den sammenbundne klaveret.
  //
  // Leseren navngir delene selv: en klammer blir «Piano», en enkelt
  // stav blir «Voice». Det kan vi ikke gaa rett etter — i «Hark» er
  // koret selv en klammer, og heter «Piano». Men naar begge former er
  // til stede paa samme ark, er klammeren akkompagnementet og
  // enkeltstavene koret. Uten dette vant klaveret paa fem av seks ark
  // i «Fly Me to the Moon», fordi det skaarer like godt som koret og
  // staar foerst i fila.
  const staverIDel = {};
  for (const k of stavOrden) {
    const d = k.split('#')[0];
    staverIDel[d] = (staverIDel[d] || 0) + 1;
  }
  const harEnkle = Object.values(staverIDel).some((n) => n === 1);
  const erKlammer = (k) => staverIDel[k.split('#')[0]] > 1;

  const poeng = (k) => {
    const v = leie[k];
    return (v.klinger >= 34 && v.klinger <= 72 ? 0 : 30) +
      Math.max(0, v.spenn - 20) +
      Math.max(0, (v.tettleik - 9) * 3) +
      (harEnkle && erKlammer(k) ? 12 : 0);
  };

  // Sangstemmene kobles for seg. Klaveret holdes utenfor koblinga —
  // det skal ikke konkurrere med en tenor om en plass — og plukkes opp
  // etterpaa, av de stavene som ble til overs.
  const syngende = staver
    ? staver.filter((s) => {
        const t = STAVTYPER[String(s).toLowerCase()];
        return t && !t.klaver;
      })
    : null;
  const klaverStaver = staver
    ? staver.filter((s) => {
        const t = STAVTYPER[String(s).toLowerCase()];
        return t && t.klaver;
      }).length
    : 0;

  const sangstaver = (syngende
    ? stavOrden.slice()
        .sort((a, b) => poeng(a) - poeng(b))
        .slice(0, Math.max(syngende.length, 1))
        .filter((k) => poeng(k) <= 25)
    : stavOrden.slice()
  ).sort((a, b) => leie[b].klinger - leie[a].klinger);
  const kobling = syngende && syngende.length
    ? koble(sangstaver.map((k) => leie[k].klinger), syngende, fasit)
    : null;

  const plan = syngende ? stavPlan(syngende) : null;

  const ut = [];

  // HELE SATSEN PAA ÉN STAV.
  //
  // En nevral leser gir noen ganger alt den ser som én eneste stav med
  // akkorder, selv om noten har tre eller fire adskilte linjer. Da er
  // ikke stemmene borte — de ligger over hverandre i hvert anslag, og
  // kan deles ut igjen paa tonehoeyde.
  //
  // Uten dette ble et trestemt partitur til to stemmer der den ene
  // hadde 53 toner og den andre 162: det som skulle vaert tre linjer
  // ble stappet i to.
  if (syngende && sangstaver.length === 1 && syngende.length > 1) {
    const alle = [];
    for (const s of paa(sangstaver[0])) for (const n of s.noter) alle.push(n);
    alle.sort((a, c) => a.takt - c.takt || a.slag - c.slag);

    // Hvor mange stemmer satsen har til sammen, etter oppsettet.
    const navnIOrden = [];
    for (const p of plan) if (p) for (const n of p.navn) navnIOrden.push(n);

    if (navnIOrden.length > 1) {
      const deler = delPaaHoyde(alle, navnIOrden.length);
      const oktav = leie[sangstaver[0]].oktav;
      deler.forEach((noter, i) => {
        if (noter.length) ut.push({ navn: navnIOrden[i], oktav: oktav, noter: noter });
      });
      if (process.env.NOTE_SPOR) {
        process.stdout.write(`      hele satsen paa én stav -> delt i ` +
          `${navnIOrden.length}: ${navnIOrden.join(', ')}\n`);
      }
      return ut;
    }
  }

  const gaaGjennom = kobling ? sangstaver : stavOrden;
  gaaGjennom.forEach((noekkel, si) => {
    const paaStaven = paa(noekkel);
    // Typen kommer fra oppsettet naar det finnes, ellers fra delnavnet.
    const plass = kobling ? kobling[si] : null;
    if (kobling && plass === null) return;      // ingen stav passet
    if (process.env.NOTE_SPOR) {
      const v = leie[noekkel];
      process.stdout.write(`      ${(noekkel + '            ').slice(0, 12)}` +
        ` skrevet ${v.skrevet} oktav ${String(v.oktav).padStart(3)} klinger ${v.klinger}` +
        `  spenn ${String(v.spenn).padStart(2)} tett ${v.tettleik.toFixed(1)}` +
        `  -> ${plass === null || plass === undefined ? 'INGEN' : syngende[plass]}\n`);
    }
    const oppsatt = plan && plass !== null && plass !== undefined ? plan[plass] : null;
    const type = oppsatt ? oppsatt.type : STAVTYPER[typeAvNavn(paaStaven[0].delnavn)];
    if (type === null || type === undefined) return;      // piano eller ukjent
    // Hvor mange stemmer DENNE staven skal gi. Oppsettet bestemmer;
    // uten oppsett antar vi at staven rommer begge stemmene i paret.
    let venter = oppsatt ? oppsatt.navn.slice() : type.navn.slice();

    // Ligger begge stemmene i én stroem, deles de paa tonehoeyde.
    //
    // Nevrale lesere gir gjerne hele staven som ett loep, med begge
    // stemmene om hverandre. I et korpartitur synger stemmene paa samme
    // slag, saa den oeverste tonen i hvert anslag er 1. stemme og den
    // under er 2. Det stemmer saa lenge satsen er homofon, og det er
    // den i alle disse arrangementene.
    // Deling paa tonehoeyde gjoeres BARE naar staven kom som én stroem.
    //
    // Fristelsen er aa slaa sammen to ujevne stroemmer og dele dem paa
    // nytt, men det maalte daarligere (54,9 % mot 65,4 %): naar lesinga
    // har blandet to staver i samme stroem, skiller en hoeydedeling
    // tenor fra bass i stedet for 1. fra 2. tenor. Da er det bedre aa la
    // stroemmene staa som de er.
    let raa = paaStaven.map((s) => s.noter);

    // Staven kan komme som flere stroemmer enn den har stemmer: en
    // nevral leser lager gjerne en egen `<voice>` av noen feilleste
    // toner. De skal ikke bli en femte sanger — de hoerer til den
    // stemmen de ligger naermest i tonehoeyde.
    if (raa.length > venter.length) {
      raa = raa.slice().sort((a, b) => b.length - a.length);
      const beholdt = raa.slice(0, venter.length)
        .sort((a, b) => median(b.map((n) => n.midi)) - median(a.map((n) => n.midi)));
      const medianer = beholdt.map((l) => median(l.map((n) => n.midi)));
      for (const rest of raa.slice(venter.length)) {
        const m = median(rest.map((n) => n.midi));
        let naermest = 0;
        for (let i = 1; i < medianer.length; i++) {
          if (Math.abs(medianer[i] - m) < Math.abs(medianer[naermest] - m)) naermest = i;
        }
        for (const n of rest) beholdt[naermest].push(n);
      }
      for (const l of beholdt) l.sort((a, c) => a.takt - c.takt || a.slag - c.slag);
      raa = beholdt;
    }

    // Skal staven gi to stemmer, maa vi avgjoere om leseren faktisk
    // HAR skilt dem.
    //
    // Den nummererer `<voice>` selv, og gjoer det ikke paalitelig: paa
    // «Hark» la den 301 toner i den ene stemmen og 18 i den andre, der
    // fasiten har 170 og 170. Begge tenorene laa altsaa i det samme
    // loepet, og de 18 var tilfeldige. Stolte vi paa nummereringa, ble
    // 2. tenor borte (10 % gjenfunnet) og 1. tenor dobbelt saa tett som
    // den skulle.
    //
    // Proeven er balansen: to stemmer som synger samme sats har omtrent
    // like mange toner. Er den minste under en tredjedel av den
    // stoerste, er det ikke to stemmer — det er én, pluss noen
    // feilleste toner. Da slaas de sammen og deles paa tonehoeyde i
    // stedet, slik satsen faktisk ligger: oeverste tone i hvert anslag
    // er foerste stemme.
    let deler = raa;
    if (venter.length > 1) {
      const storst = raa.reduce((a, l) => Math.max(a, l.length), 0);
      const minst = raa.reduce((a, l) => Math.min(a, l.length), Infinity);
      if (raa.length === 1 || minst < storst * 0.34) {
        const alt = [].concat(...raa).sort((a, c) => a.takt - c.takt || a.slag - c.slag);
        deler = delPaaHoyde(alt);
      }
    }

    // Ble de to halvdelene helt like, var det aldri to stemmer der.
    //
    // `delPaaHoyde` lar en enslig tone gaa videre til BEGGE stemmene —
    // der synger de unisont, og det er riktig. Men er hele staven slik,
    // har leseren funnet bare én linje, og det er den OEVERSTE av de to
    // stemmene. Aa levere den under begge navnene gir en bass som oever
    // inn barytonens toner. Da er det bedre aa si at bassen ikke er
    // lest: en tom plass er aerlig, en feil plass laerer feil toner.
    if (deler.length === 2 && venter.length === 2 &&
        deler[0].length === deler[1].length &&
        deler[0].every((n, i) => n.midi === deler[1][i].midi &&
          n.takt === deler[1][i].takt && n.slag === deler[1][i].slag)) {
      deler = [deler[0]];
      venter = [venter[0]];
    }

    deler.forEach((noter, vi) => {
      if (!noter.length) return;
      const navn = venter.length === 1 && deler.length === 1
        ? venter[0]
        : (venter[vi] || type.navn[vi] || `${type.ett} ${vi + 1}`);
      ut.push({ navn: navn, oktav: leie[noekkel].oktav, noter: noter });
    });
  });

  // Klaveret: de stavene som ikke ble en sangstemme, hoeyeste foerst.
  //
  // Et klaverpartitur er to staver — hoeyre og venstre haand — og de
  // skiller seg fra hverandre paa leie alene. Her trengs ingen kobling:
  // det som er igjen ER klaveret.
  if (klaverStaver > 0) {
    const brukt = new Set(gaaGjennom.filter((k, i) =>
      kobling && kobling[i] !== null && kobling[i] !== undefined));
    const rest = stavOrden
      .filter((k) => !brukt.has(k))
      .sort((a, b) => leie[b].klinger - leie[a].klinger)
      .slice(0, klaverStaver);
    rest.forEach((k, i) => {
      const noter = [].concat(...paa(k).map((x) => x.noter))
        .sort((a, c) => a.takt - c.takt || a.slag - c.slag);
      if (noter.length < 8) return;
      ut.push({
        navn: leie[k].klinger >= 55 ? 'klaver h' : 'klaver v',
        oktav: 0, noter: noter,
      });
    });
  }

  return ut;
}

function main() {
  if (!fs.existsSync(INN)) { console.log(`Ingen mappe ${INN}.`); return; }
  const liste = kilder();
  if (!liste.length) { console.log(`Ingenting i ${INN}.`); return; }

  const arkiv = JSON.parse(fs.readFileSync(`${UT}/arkiv.json`, 'utf8'));
  let antall = 0;

  for (const kilde of liste) {
    const stykke = arkiv.stykker.find(
      (s) => s.id === kilde.id || s.id.startsWith(kilde.id) || kilde.id.startsWith(s.id),
    );
    if (!stykke) { console.log(`${kilde.id}: fant ikke stykket`); continue; }

    const satt = OPPSETT[stykke.id];
    const staver = satt && satt.staver && Array.isArray(satt.staver) ? satt.staver : null;

    // Les alle arkene, navngi stemmene, og sett dem sammen med
    // loepende takttall.
    const samlet = new Map();
    let forskyvning = 0, slagPerTakt = 4, systemer = [];
    let avvik = 0, stavelser = 0;
    const audMappe = kilde.egen ? audiverisMappe(stykke.id) : null;

    // FOERSTE RUNDE: finn ut hvor stykkets egne stemmer ligger.
    //
    // Den generelle tabellen sier hva en baryton pleier aa ligge paa.
    // Den holder ikke naar et ark mangler koret helt: paa side 1 av
    // «Fly Me to the Moon» fant leseren bare klaveret, og da gled
    // venstre haand inn som bass fordi den laa «naer nok». Resultatet
    // var en baryton paa MIDI 43 som synger akkompagnementet.
    //
    // Her leses derfor arkene gjennom én gang foerst, uten fasit, og
    // medianen av det hvert ark mener om hver stemme blir fasiten i
    // andre runde. Da maales hvert ark mot stykkets egne stemmer, og
    // et ark som bare har klaver faar ingen stemmer i det hele tatt.
    const fasit = (function () {
      if (!staver) return null;
      const sett = {};
      for (const fil of kilde.filer) {
        let d;
        try { d = M.lesFil(fil); } catch (e) { continue; }
        let kl = false;
        try {
          const raa = /\.mxl$/i.test(fil)
            ? (M.lesZip(fil, (n) => /\.xml$/i.test(n) && !/^META-INF/i.test(n)) || {}).innhold
            : fs.readFileSync(fil);
          kl = raa ? raa.toString('utf8').indexOf('clef-octave-change') >= 0 : false;
        } catch (e) { /* ingen */ }
        for (const s of navngi(stroemmer(d, staver ? staver.length : 0), staver, kl)) {
          if (!s.noter.length) continue;
          (sett[s.navn] = sett[s.navn] || [])
            .push(median(s.noter.map((n) => n.midi + s.oktav)));
        }
      }
      const ut = {};
      for (const k in sett) if (sett[k].length >= 2) ut[k] = median(sett[k]);
      return Object.keys(ut).length ? ut : null;
    })();

    for (const fil of kilde.filer) {
      let doc;
      try { doc = M.lesFil(fil); } catch (e) { continue; }
      if (doc.slagPerTakt) slagPerTakt = doc.slagPerTakt;
      systemer = systemer.concat(doc.systemer || []);

      // Har fila oktavskiftet notert selv?
      let klingende = false;
      try {
        const raaXml = /\.mxl$/i.test(fil)
          ? (M.lesZip(fil, (n) => /\.xml$/i.test(n) && !/^META-INF/i.test(n)) || {}).innhold
          : fs.readFileSync(fil);
        klingende = raaXml ? raaXml.toString('utf8').indexOf('clef-octave-change') >= 0 : false;
      } catch (e) { klingende = false; }

      const navngitt = navngi(stroemmer(doc, staver ? staver.length : 0),
        staver, klingende, fasit);
      if (staver && navngitt.length !== staverAntall(staver, navngitt)) avvik++;

      // Har ikke arket tekst alt (Opuscans filer har), hentes den fra
      // Audiveris-lesinga av den SAMME sida.
      const harTekst = navngitt.some((s) => s.noter.some((n) => n.tekst));
      if (!harTekst && audMappe) {
        const arkNr = parseInt((path.basename(fil).match(/(\d+)/) || [])[1] || '0', 10);
        if (arkNr) stavelser += leggPaaTekst(navngitt, stavelserForArk(audMappe, arkNr));
      }

      let flestTakter = 0;
      for (const s of navngitt) {
        for (const n of s.noter) if (n.takt > flestTakter) flestTakter = n.takt;
        if (!samlet.has(s.navn)) samlet.set(s.navn, { oktav: s.oktav, noter: [] });
        for (const n of s.noter) {
          samlet.get(s.navn).noter.push({
            takt: n.takt + forskyvning,
            slag: n.slag,
            varighet: n.varighet,
            midi: n.midi + s.oktav,
            tekst: n.tekst ? n.tekst.ord : undefined,
            del: n.tekst ? n.tekst.del : undefined,
          });
        }
      }
      forskyvning += flestTakter;
    }

    if (!samlet.size) { console.log(`${stykke.tittel}: ingen sangstemmer`); continue; }

    // Stemmene skal staa ovenfra og ned, slik de staar i noten. Uten
    // dette er rekkefoelgen den tilfeldige: hvilken stemme som dukket
    // opp foerst paa foerste ark leseren klarte.
    const RANG = [
      '1. sopran', '2. sopran', 'sopran', '1. alt', '2. alt', 'alt',
      '1. tenor', '2. tenor', 'tenor', 'baryton', 'bass',
      'klaver h', 'klaver', 'klaver v',
    ];
    const navn = [...samlet.keys()].sort((a, b) => {
      const ra = RANG.indexOf(a), rb = RANG.indexOf(b);
      return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.localeCompare(b);
    });
    const ut = {};
    for (const n of navn) {
      ut[n] = samlet.get(n).noter.sort((a, c) => a.takt - c.takt || a.slag - c.slag);
    }

    // ── FAERRE LINJER ENN NOTEN HAR ──────────────────────────────────
    //
    // Her tas alle veiene under ett. Lesinga kan komme ut som
    // parallelle staver, som en koe av systemer, eller som ÉN stav der
    // hele satsen ligger oppaa hverandre i akkorder — og hvilken av
    // dem det blir, varierer fra ark til ark i samme stykke.
    //
    // I stedet for en regel per form: tell til slutt. Sier oppsettet at
    // noten har fire stemmer og vi sitter igjen med to, saa ligger de to
    // andre inne i dem — som akkordtoner. Da deles den stemmen som har
    // flest toner, paa tonehoeyde, til tallet stemmer.
    //
    // Uten dette ble et trestemt partitur til to stemmer paa 53 og 162
    // toner: alt som ikke fikk plass, ble stuet i den ene.
    const venteNavn = [];
    if (staver) {
      for (const p of stavPlan(staver.filter((x) => {
        const t = STAVTYPER[String(x).toLowerCase()];
        return t && !t.klaver;
      }))) if (p) for (const nn of p.navn) venteNavn.push(nn);
    }
    const sangNavn = navn.filter((n) => !erKlaver(n));
    let delt = 0;
    while (venteNavn.length > sangNavn.length && sangNavn.length) {
      // Del den tykkeste stemmen i to.
      let tykkest = sangNavn[0];
      for (const n of sangNavn) if (ut[n].length > ut[tykkest].length) tykkest = n;
      const par = delPaaHoyde(ut[tykkest], 2);
      if (!par[1] || !par[1].length || par[0].length === ut[tykkest].length) break;

      // Navnet som mangler, hentet fra oppsettets rekkefoelge.
      const mangler = venteNavn.find((n) => sangNavn.indexOf(n) < 0);
      if (!mangler) break;
      const oktav = samlet.get(tykkest).oktav;
      ut[tykkest] = par[0];
      ut[mangler] = par[1];
      samlet.set(mangler, { oktav: oktav, noter: par[1] });
      sangNavn.push(mangler);
      navn.push(mangler);
      delt++;
      if (delt > 4) break;
    }
    if (delt) {
      navn.sort((a, b) => {
        const ra = RANG.indexOf(a), rb = RANG.indexOf(b);
        return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.localeCompare(b);
      });
    }

    let foldet = 0;
    for (const n of navn) {
      if (!erKlaver(n)) {
        foldet += foldInnIOmfang(ut[n], n);
        foldet += foldMotNaboene(ut[n], n);
      }
    }

    // Slaa sammen to stemmer lesinga aldri klarte aa skille.
    //
    // En stav med to stemmer deles paa tonehoeyde, og der bare ÉN tone
    // er lest gaar den til begge. Er det tilfellet for det meste av
    // stykket, har vi ikke to stemmer — vi har én linje under to navn.
    // Da staar «bassen» i barytonens leie, og en bass som oever etter
    // den laerer feil toner.
    //
    // Proeven er at de er enige om det meste OG ligger i samme leie.
    // En ekte deling gir langt mindre: i «Hark», lest av Opuscan, er
    // ingen av parene over 60 % enige.
    //
    // De slaas da sammen til ett navn — «baryton + bass» — slik at det
    // staar i stemmevelgeren at de to deler linje her. Det er aerligere
    // enn aa levere to filer som later som de er forskjellige.
    for (let i = 0; i < navn.length - 1; i++) {
      const a = ut[navn[i]], b = ut[navn[i + 1]];
      if (!a || !b || !a.length || !b.length) continue;
      if (erKlaver(navn[i]) || erKlaver(navn[i + 1])) continue;
      const kart = new Map();
      for (const n of b) kart.set(n.takt + ':' + n.slag, n.midi);
      let felles = 0, like = 0;
      for (const n of a) {
        const m = kart.get(n.takt + ':' + n.slag);
        if (m === undefined) continue;
        felles++;
        if (m === n.midi) like++;
      }
      if (!felles) continue;
      const enige = like / felles;
      const sprik = Math.abs(median(a.map((n) => n.midi)) - median(b.map((n) => n.midi)));
      if (enige >= 0.7 && sprik <= 2) {
        const nytt = `${navn[i]} + ${navn[i + 1]}`;
        ut[nytt] = a;                       // oeverste linja er den leste
        delete ut[navn[i]]; delete ut[navn[i + 1]];
        navn.splice(i, 2, nytt);
        i--;
      }
    }

    // En stemme med noen faa toner mot de andres hundrevis er ikke en
    // stemme — det er restene av ett ark der lesinga tilfeldigvis delte
    // staven i to. Den gir en oevingsfil som er stille nesten hele
    // veien, og det er verre enn ingen fil: man tror man har stemmen.
    // ── Teksten ut til alle stemmene, og vask den foerst ──
    //
    // To ting var galt. For det foerste sto teksten bare paa den
    // oeverste stemmen: naar en stav deles paa tonehoeyde, foelger
    // `<lyric>` med den tonen som bar den, og den nederste halvdelen
    // staar igjen stum. Men hele koret synger de samme ordene.
    //
    // For det andre slapp det gjennom soppel som «2,19,15~Www» og
    // «C2004» — copyright-linjer som lesinga tok for sangtekst. De ble
    // vasket bort fra Audiveris-teksten, men ikke fra filer som alt
    // hadde tekst i seg (Opuscans egne).
    const ordPaaSlag = new Map();
    for (const n of navn) {
      for (const x of ut[n]) {
        if (!x.tekst) continue;
        const rent = rensStavelse(x.tekst);
        if (!rent) { delete x.tekst; delete x.del; continue; }
        x.tekst = rent;
        const k = x.takt + ':' + x.slag;
        if (!ordPaaSlag.has(k)) ordPaaSlag.set(k, { ord: rent, del: x.del });
      }
    }
    for (const n of navn) {
      const brukt = new Set();
      let sist = null;
      for (const x of ut[n]) {
        const k = x.takt + ':' + x.slag;
        if (x.tekst) { brukt.add(k); sist = x.tekst; continue; }
        if (brukt.has(k)) continue;      // én stavelse per slag per stemme
        const t = ordPaaSlag.get(k);
        // Samme ord to ganger paa rad er en dublett fra to lesinger
        // av samme stavelse, ikke to stavelser.
        if (t && t.ord !== sist) { x.tekst = t.ord; x.del = t.del; brukt.add(k); sist = t.ord; }
      }
    }

    const storst = navn.reduce((a, n) => (erKlaver(n) ? a : Math.max(a, ut[n].length)), 0);
    for (const n of navn.slice()) {
      if (!erKlaver(n) && ut[n].length < storst * 0.15) {
        delete ut[n];
        navn.splice(navn.indexOf(n), 1);
      }
    }

    // Fire slag i hver takt — takten ER taktarten sin.
    let justert = 0, takter = 0;
    for (const n of navn) {
      const perTakt = new Map();
      for (const x of ut[n]) {
        if (!perTakt.has(x.takt)) perTakt.set(x.takt, []);
        perTakt.get(x.takt).push(x);
      }
      for (const [, iTakt] of perTakt) {
        takter++;
        const slutt = iTakt.reduce((a, x) => Math.max(a, x.slag + x.varighet), 0);
        if (slutt <= 0 || Math.abs(slutt - slagPerTakt) < 0.02) continue;
        const faktor = slagPerTakt / slutt;
        for (const x of iTakt) {
          x.slag = Math.round(x.slag * faktor * 1000) / 1000;
          x.varighet = Math.round(x.varighet * faktor * 1000) / 1000;
        }
        justert++;
      }
    }

    stykke.stemmer = navn;
    stykke.noter = ut;
    stykke.slagPerTakt = slagPerTakt;
    stykke.kilde = 'import';
    // Takttallet kommer fra notene naar bildeanalysen ikke fant systemer.
    // Paa et foto gjoer den ofte ikke det, og da sto det `0 takter` paa
    // et stykke som har alt det trenger.
    {
      let siste = 0;
      for (const n of navn) for (const x of ut[n]) if (x.takt > siste) siste = x.takt;
      if (siste > (stykke.antallTakter || 0)) stykke.antallTakter = siste;
    }
    byggOverlay(stykke, systemer, navn, ut);
    antall++;

    const medianer = navn.map((n) => median(ut[n].map((x) => x.midi)));
    // Bare SANGstemmene skal ligge fallende. Klaveret spenner over
    // hele registeret og sier ingenting om stemmefordelinga.
    const sangMed = navn.map((n, i) => (erKlaver(n) ? null : medianer[i])).filter((v) => v !== null);
    const fallende = sangMed.every((v, i) => i === 0 || v <= sangMed[i - 1] + 1);
    console.log(
      (stykke.tittel + '                              ').slice(0, 30) +
      `${kilde.filer.length} ark  ` +
      `${navn.reduce((a, n) => a + ut[n].length, 0)} noter  ` +
      `${justert}/${takter} justert  ` +
      (staver ? 'oppsett  ' : 'gjettet  ') +
      (fallende ? 'OK   ' : 'FEIL ') +
      (stavelser ? stavelser + ' ord  ' : '') +
      (foldet ? foldet + ' foldet  ' : '') +
      navn.map((n, i) => `${n}:${ut[n].length}(${medianer[i]})`).join(' '),
    );
  }

  fs.writeFileSync(`${UT}/arkiv.json`, JSON.stringify(arkiv, null, 1), 'utf8');
  console.log(`\n${antall} stykker importert.`);
}

function staverAntall(staver, navngitt) { return navngitt.length; }

/** Lar taktinndelinga i fila styre overlayet, i mine systemrammer. */
function byggOverlay(stykke, systemer, navn, ut) {
  const mine = [];
  for (const side of stykke.sider || []) {
    for (const sys of side.systemer || []) mine.push(sys);
  }
  if (!systemer.length || !mine.length) return;

  const maksLyd = Math.max.apply(null, navn.flatMap((n) => ut[n].map((x) => x.takt)));
  let per = mine.map((_, i) => {
    if (systemer.length === mine.length) return systemer[i];
    const fra = Math.floor(i * systemer.length / mine.length);
    const til = Math.max(fra + 1, Math.floor((i + 1) * systemer.length / mine.length));
    return systemer.slice(fra, til).reduce((a, c) => a + c, 0);
  });
  const sum = per.reduce((a, c) => a + c, 0);
  if (sum && Math.abs(sum - maksLyd) > 1) {
    per = per.map((v) => Math.max(1, Math.round(v * maksLyd / sum)));
    let diff = maksLyd - per.reduce((a, c) => a + c, 0);
    while (diff !== 0) {
      let i = 0;
      for (let k = 1; k < per.length; k++) if (per[k] > per[i]) i = k;
      if (diff > 0) { per[i]++; diff--; }
      else if (per[i] > 1) { per[i]--; diff++; }
      else break;
    }
  }
  let nr = 0;
  mine.forEach((sys, i) => {
    const n = Math.max(1, per[i] || 1);
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
  for (const side of stykke.sider || []) {
    side.antallTakter = (side.systemer || []).reduce((a, y) => a + y.takter.length, 0);
  }
  stykke.antallTakter = nr;
}

module.exports = { stroemmer, navngi, avkoe, koble, stavPlan, median, erKlaver, OPPSETT };

if (require.main === module) main();
