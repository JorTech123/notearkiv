'use strict';
/**
 * les-noter.js — leser noter ut av de rensede sidene, retter opp
 * systeminndelingen med stykkets egen systemstoerrelse, og legger en
 * spillbar stemme per sangstemme inn i katalogen.
 *
 * Resultatet havner i `stykke.noter[stemmenavn]` som en liste av
 * { takt, slag, varighet, midi }. Visningsverktoeyet spiller den
 * direkte — det leter allerede etter akkurat dette feltet.
 *
 * To ting er verdt aa vite om framgangsmaaten:
 *
 * 1. Systemstoerrelsen bestemmes for HELE stykket, ikke per side. Et
 *    partitur har like mange staver i hvert system hele veien, og den
 *    foeringa er mye sterkere enn noe som kan leses av én enkelt side.
 *    Sidevis deteksjon splitter ofte et system i enkeltstaver; med
 *    stykkets stoerrelse i haanden kan de settes sammen igjen.
 *
 * 2. Takttallet er loepende gjennom hele stykket. Ellers ville noter fra
 *    side 1 takt 3 ogsaa klinge paa side 2 takt 3.
 *
 *   node tools/src/les-noter.js            hele arkivet
 *   node tools/src/les-noter.js my-way     bare ett stykke
 */

const fs = require('node:fs');
const sharp = require('sharp');
const N = require('../../public/noteanalyse.js');
const G = require('../../public/notegjenkjenning.js');

const UT = 'data/ut';
const SLAG_PER_TAKT = 4;

// Navn etter hvor mange staver systemet faktisk har. Er stykket skrevet
// paa to staver, finnes det ingen egen 2. tenor aa velge.
const STEMMEOPPSETT_V = {
  1: ['melodi'],
  2: ['overstemme', 'understemme'],
  3: ['tenor', 'baryton', 'bass'],
  4: ['1. tenor', '2. tenor', 'baryton', 'bass'],
  5: ['1. tenor', '2. tenor', 'baryton', 'bass', 'piano'],
  6: ['1. tenor', '2. tenor', 'baryton', 'bass', 'piano h.h.', 'piano v.h.'],
};

// Stemmeoppsett satt for haand. Se data/oppsett.json.
const OPPSETT = (function () {
  try {
    const raa = JSON.parse(fs.readFileSync('data/oppsett.json', 'utf8'));
    const ut = {};
    for (const k in raa) if (k[0] !== '_' && raa[k] && raa[k].staver) ut[k] = raa[k];
    return ut;
  } catch (e) { return {}; }
})();

/** Stemmer vi lager avspilling for. Pianoet hopper vi over. */
function erSangstemme(navn) {
  return !!navn && !/piano/i.test(navn);
}

async function lesSide(sti) {
  const { data: g, info } = await sharp(sti).grayscale().raw()
    .toBuffer({ resolveWithObject: true });
  const b = info.width, h = info.height;
  const bin = N.terskle(g, 150);
  const st = N.analyser(bin, b, h);
  const uten = G.fjernNotelinjer(bin, b, h, st.staver, st.mal.tykkelse);
  return { bin, uten, b, h, st };
}

const median = (a) => {
  const v = a.slice().sort((x, y) => x - y);
  return v.length ? v[v.length >> 1] : 0;
};

/**
 * Velger systemstoerrelsen for hele stykket.
 *
 * Ikke den vanligste stoerrelsen som ble oppdaget — den tellinga
 * domineres av fragmenter der deteksjonen splittet et system. I stedet
 * proeves hver tenkelig stoerrelse som en hypotese: deler vi stavene i
 * blokker av V, faller systemskillene da sammen med de store sprangene
 * mellom stavene? Maalt over alle sidene i stykket samtidig, og med
 * uttelling for at sidene gaar jevnt opp i V.
 */
/**
 * Finner systemstoerrelsen av noekkelmoensteret.
 *
 * Dette er det sterkeste signalet som finnes til dette: stemmene staar i
 * samme rekkefoelge i hvert eneste system, og dermed gjentar noekklene
 * seg med nettopp systemets lengde. Tenor-tenor-bass, om og om igjen.
 * I motsetning til aa maale avstander bryr det seg ikke om at
 * sangteksten gjoer alle mellomrom like store, og i motsetning til
 * klammer taaler det at kopien er oppbrutt.
 *
 * @returns {{V:number, treff:number}} perioden og hvor godt den passer
 */
function periodeFraNokler(alle) {
  // Ukjente noekler teller ikke med; de ville bare stoeye.
  const nokler = alle;
  if (nokler.length < 4) return { V: nokler.length || 1, treff: 0 };
  let beste = { V: nokler.length, treff: 0 };

  for (let V = 2; V <= Math.min(8, Math.floor(nokler.length / 2)); V++) {
    // Hvilken noekkel er vanligst i hver posisjon i systemet?
    const moenster = [];
    for (let f = 0; f < V; f++) {
      let g = 0, fK = 0;
      for (let i = f; i < nokler.length; i += V) {
        if (nokler[i] === 'f') fK++;
        else if (nokler[i] === 'g') g++;
      }
      moenster.push(fK > g ? 'f' : 'g');
    }
    // Et moenster helt uten F-noekkel sier ingenting; da kan enhver
    // periode «passe», og vi ville valgt den minste uten grunn.
    if (!moenster.some(function (k) { return k === 'f'; })) continue;

    let treff = 0, kjente = 0;
    for (let i = 0; i < nokler.length; i++) {
      if (nokler[i] === 'ukjent') continue;
      kjente++;
      if (nokler[i] === moenster[i % V]) treff++;
    }
    if (kjente < 4) continue;
    const andel = treff / kjente;
    if (andel > beste.treff + 0.02) beste = { V: V, treff: andel };
  }
  return beste;
}

function velgSystemstorrelse(sider, forventet) {
  const kandidater = [];
  for (let V = 2; V <= 8; V++) {
    let sum = 0, vekt = 0, deleligeSider = 0;
    for (const s of sider) {
      const st = s.st.staver;
      if (st.length < V + 1) continue;
      const gap = [];
      for (let i = 0; i < st.length - 1; i++) gap.push(st[i + 1].yTopp - st[i].yBunn);

      const inne = [], mellom = [];
      for (let i = 0; i < gap.length; i++) {
        if ((i + 1) % V === 0) mellom.push(gap[i]); else inne.push(gap[i]);
      }
      if (!inne.length || !mellom.length) continue;
      sum += median(mellom) / Math.max(1, median(inne));
      vekt++;
      if (st.length % V === 0) deleligeSider++;
    }
    if (!vekt) continue;
    let poeng = sum / vekt;
    poeng *= 1 + 0.3 * (deleligeSider / vekt);
    // Antall stemmer i katalogen er et selvstendig hint, ikke en fasit.
    if (V === forventet) poeng *= 1.2;
    kandidater.push({ V: V, poeng: poeng });
  }
  if (!kandidater.length) return Math.max(1, forventet || 1);
  kandidater.sort((a, b) => b.poeng - a.poeng);
  return kandidater[0].V;
}

/** Setter systemene paa nytt med fast stoerrelse, og regner takter om. */
function grupperPaaNytt(s, V) {
  const systemer = N.delIBlokker(s.st.staver, V);
  for (const sys of systemer) {
    const streker = N.finnTaktstreker(sys, s.bin, s.b, s.h, s.st.mal);
    sys.taktstreker = streker;
    sys.takter = N.byggTakter(sys, streker, s.st.mal);
  }
  return systemer;
}

async function main() {
  const bare = process.argv[2];
  const arkiv = JSON.parse(fs.readFileSync(`${UT}/arkiv.json`, 'utf8'));

  for (const stykke of arkiv.stykker) {
    if (bare && stykke.id !== bare) continue;

    // ── 1. les alle sidene i stykket ────────────────────────────────
    const sider = [];
    let feilet = 0;
    for (const side of stykke.sider) {
      try {
        sider.push({ side, ...(await lesSide(`${UT}/${side.fil}`)) });
      } catch (e) { feilet++; }
    }
    if (!sider.length) { console.log(`${stykke.tittel}: ingen sider kunne leses`); continue; }

    // ── 2. én systemstoerrelse for hele stykket ─────────────────────
    // Oppsettet i data/oppsett.json gaar foran alt. Antall staver per
    // system er noe et menneske ser paa ett sekund, mens maskinen maa
    // gjette — og gjetter feil ofte nok til at det ikke kan spilles av.
    // Staar stykket der, er resten av kjeden deterministisk.
    const satt = OPPSETT[stykke.id];

    // Ellers: noekkelmoensteret foerst, avstandsmaaling som reserve.
    const nokler = [];
    for (const s of sider) {
      for (const stav of s.st.staver) {
        nokler.push(G.finnNokkel(s.uten, s.b, s.h, stav, s.st.mal));
      }
    }
    const perArk = periodeFraNokler(nokler);
    const V = (satt && satt.staver) ? satt.staver
      : perArk.treff >= 0.8 ? perArk.V
      : velgSystemstorrelse(sider, (stykke.stemmer || []).length);
    if (satt && satt.stemmer) stykke.stemmer = satt.stemmer;
    else if (STEMMEOPPSETT_V[V]) stykke.stemmer = STEMMEOPPSETT_V[V];

    // ── 3. stem over noekkelen for hver plass i systemet ────────────
    //
    // Stemmene staar i samme rekkefoelge i hvert system, saa plass 3
    // har samme noekkel hele stykket igjennom. Ett bomskudd paa én side
    // skal ikke faa avgjoere at bassen plutselig leses i G-noekkel og
    // loeftes en oktav. Flertallet over alle systemene bestemmer.
    const stemmer = [];
    for (let k = 0; k < V; k++) stemmer.push({ g: 0, f: 0 });
    for (const s of sider) {
      for (const sys of grupperPaaNytt(s, V)) {
        if (sys.staver.length !== V) continue;
        sys.staver.forEach(function (stav, k) {
          const n = G.finnNokkel(s.uten, s.b, s.h, stav, s.st.mal);
          if (n === 'g' || n === 'f') stemmer[k][n]++;
        });
      }
    }
    const nokkelPerPlass = stemmer.map(function (v) {
      return v.f > v.g ? 'f' : 'g';
    });

    // ── 4. grupper om, les noter, skriv struktur tilbake ────────────
    const mannskor = (stykke.stemmer || []).some(function (v) { return /bass|baryton/i.test(v); });
    const noter = {};
    const fortegnTeller = {};
    let taktTeller = 0, helSystem = 0, delvis = 0, taktOk = 0, taktProvd = 0;

    for (const s of sider) {
      const systemer = grupperPaaNytt(s, V);

      // Katalogen skrives om, saa overlayet foelger den nye inndelinga.
      s.side.systemer = systemer.map(function (sys) {
        return {
          yTopp: Math.round(sys.yTopp),
          yBunn: Math.round(sys.yBunn),
          staver: sys.staver.map(function (st, k) {
            return {
              yTopp: Math.round(st.yTopp), yBunn: Math.round(st.yBunn),
              x0: Math.round(st.x0), x1: Math.round(st.x1),
              rekonstruerte: st.rekonstruerte || 0,
              stemme: (stykke.stemmer || [])[k] || `stemme ${k + 1}`,
            };
          }),
          takter: [],
        };
      });

      systemer.forEach(function (sys, si) {
        const takter = (sys.takter || []).map(function (t, i) {
          return { x0: t.x0, x1: t.x1, nummer: taktTeller + i + 1 };
        });
        s.side.systemer[si].takter = takter.map(function (t) {
          return { nummer: t.nummer, x0: Math.round(t.x0), x1: Math.round(t.x1) };
        });

        // Et system der ikke alle stavene ble funnet forskyver stemmene:
        // barytonen ville faatt bassens noter. Da er det bedre aa la
        // takten staa tom. Takten telles likevel, saa nummereringa og
        // overlayet holder foelge.
        if (sys.staver.length !== V) { delvis++; taktTeller += takter.length; return; }
        helSystem++;

        for (let vi = 0; vi < sys.staver.length; vi++) {
          const navn = (stykke.stemmer || [])[vi];
          if (!erSangstemme(navn)) continue;

          // Halvveis til naboen over og under: der gaar skillet.
          const over = sys.staver[vi - 1], under = sys.staver[vi + 1];
          const grenser = {
            yMin: over ? (over.yBunn + sys.staver[vi].yTopp) / 2 : 0,
            yMax: under ? (sys.staver[vi].yBunn + under.yTopp) / 2 : s.h - 1,
          };
          const lest = G.lesStav(s.uten, s.b, s.h, sys.staver[vi], s.st.mal, s.st.omraade, grenser,
                                 nokkelPerPlass[vi]);
          fortegnTeller[lest.fortegn] = (fortegnTeller[lest.fortegn] || 0) + 1;
          // Varigheten leses naa av notebildet (hals, bjelke, fane,
          // punktering), og hver takt kontrolleres mot taktarten. Bare
          // takter som gaar opp sendes ut — da er det som klinger riktig,
          // i stedet for at alt er omtrentlig.
          const medRytme = [];
          for (const t of takter) {
            const iTakt = lest.noter.filter(function (n) { return n.x >= t.x0 && n.x < t.x1; })
              .concat((lest.pauser || [])
                .filter(function (p) { return p.x >= t.x0 && p.x < t.x1; })
                .map(function (p) { return { x: p.x, varighet: p.varighet, pause: true }; }))
              .sort(function (a, c) { return a.x - c.x; });
            if (!iTakt.length) continue;
            const kontroll = G.byggTakt(iTakt, SLAG_PER_TAKT);
            taktProvd++;
            if (!kontroll.gyldig) continue;
            taktOk++;
            let slag = 0;
            for (const n of kontroll.noter) {
              if (!n.pause && n.midi) {
                medRytme.push({ takt: t.nummer, slag: Math.round(slag * 1000) / 1000,
                                varighet: n.varighet, midi: n.midi });
              }
              slag += n.varighet;
            }
          }

          // I mannskorpartitur staar alle de hoeye stemmene i G-noekkel
          // med en liten 8 under, og klinger en oktav lavere enn skrevet.
          // Derfor styres oktavskiftet av noekkelen som ble lest, ikke av
          // stemmenavnet — ellers havner barytonen over tenoren.
          const oktav = mannskor && nokkelPerPlass[vi] === 'g' ? -12 : 0;
          if (!noter[navn]) noter[navn] = [];
          for (const n of medRytme) {
            noter[navn].push(oktav ? Object.assign({}, n, { midi: n.midi + oktav }) : n);
          }
        }
        taktTeller += takter.length;
      });

      s.side.antallTakter = s.side.systemer.reduce(function (a, sy) {
        return a + sy.takter.length;
      }, 0);
    }

    let toppFortegn = 0, flest = 0;
    for (const f in fortegnTeller) {
      if (fortegnTeller[f] > flest) { flest = fortegnTeller[f]; toppFortegn = +f; }
    }

    const antall = Object.keys(noter).reduce(function (a, k) { return a + noter[k].length; }, 0);
    stykke.antallTakter = taktTeller;
    if (antall) stykke.toneart = toneartNavn(toppFortegn);

    // Stemmene legges bare ut naar tilordningen er til aa stole paa.
    //
    // Staven blir knyttet til en stemme ut fra plasseringa si i systemet.
    // Mangler én stav i et system, forskyver resten seg, og barytonen
    // faar bassens noter. Flere av arrangementene har dessuten systemer
    // med ulikt antall staver — pianoforspill, unisone partier — saa
    // plasseringa betyr ikke det samme overalt.
    //
    // Under oeving er feil toner i din egen stemme verre enn ingen
    // toner: du laerer noe galt uten aa merke det. Derfor kreves det at
    // de aller fleste systemene har full besetning foer noe spilles av.
    const andelHele = helSystem / Math.max(1, helSystem + delvis);
    // Med oppsettet satt for haand er tilordningen trygg uansett hvor
    // mange systemer som ble komplett oppdaget — de ufullstendige er
    // hoppet over, ikke feiltolket.
    // Spill bare av naar en vesentlig del av taktene faktisk gaar opp.
    // Under det er lesinga for hullete til aa oeve etter, og da er
    // taktslag alene mer aerlig enn spredte toner.
    const andelTakter = taktProvd ? taktOk / taktProvd : 0;
    const troverdig = antall > 20 && V >= 2 && andelTakter >= 0.3;
    if (troverdig) {
      stykke.noter = noter;
      stykke.slagPerTakt = SLAG_PER_TAKT;
    } else {
      delete stykke.noter;
    }

    console.log(
      (stykke.tittel + '                              ').slice(0, 30) +
      ' V=' + V + '(' + perArk.V + '/' + perArk.treff.toFixed(2) + ')  ' + String(antall).padStart(5) + ' noter  ' +
      String(taktTeller).padStart(3) + ' takter  ' +
      '[' + helSystem + '/' + (helSystem + delvis) + ' hele, ' + taktOk + '/' + taktProvd + ' takter gaar opp]  ' + (troverdig ? 'SPILLES  ' : 'bare taktslag  ') +
      Object.keys(noter).map(function (k) { return k + ':' + noter[k].length; }).join(' '),
    );
  }

  fs.writeFileSync(`${UT}/arkiv.json`, JSON.stringify(arkiv, null, 1), 'utf8');
  console.log('\nSkrev ' + UT + '/arkiv.json');
}

/** Dur-toneart av antall faste fortegn. */
function toneartNavn(antall) {
  const KRYSS = ['C', 'G', 'D', 'A', 'E', 'H', 'F#', 'C#'];
  const BEE = ['C', 'F', 'B', 'Ess', 'Ass', 'Dess', 'Gess', 'Cess'];
  const n = Math.min(7, Math.abs(antall));
  return (antall >= 0 ? KRYSS[n] : BEE[n]) + '-dur';
}

main().catch((e) => { console.error(e); process.exit(1); });
