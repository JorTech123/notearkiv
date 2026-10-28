'use strict';
/**
 * noteskrift.js — setter noter. Ekte notebilde, tegnet fra dataene.
 *
 * Hvorfor dette finnes: overlayet forsoekte aa peke paa riktig sted i
 * en innskannet fotokopi. Det krever at bildeanalysen finner hver takt
 * paa piksel, og det gjoer den ikke paalitelig nok. Resultatet var en
 * markoer som pekte feil sted i feil tempo, og «noter» tegnet som
 * abstrakte prikker.
 *
 * Her snus det: notene tegnes paa nytt fra de samme dataene som
 * spilles. Da ER det som staar paa skjermen det som klinger — de kan
 * ikke gli fra hverandre, for de er det samme.
 *
 * Koordinater: x foelger slag (loepende gjennom hele stykket), y
 * foelger tonetrinn. Alt maales i «linjeavstand» (L), slik notesats
 * alltid har gjort: et notehode er én L bredt, en oktav er 3,5 L.
 */

(function (global) {

  const BOKSTAV = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  // Tonetrinn (0-11) til bokstav og fortegn, skarpt og flatt.
  const SKARP = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0]];
  const FLATT = [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [4, -1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]];

  // Hvor mange kryss (+) eller b (−) toneartene har.
  const TONEARTER = {
    'c': 0, 'a': 0,
    'g': 1, 'e': 1, 'd': 2, 'b': 3, 'a-dur': 3, 'e-dur': 4, 'h': 5, 'b-dur': 5,
    'f': -1, 'bb': -2, 'eb': -3, 'ab': -4, 'db': -5, 'gb': -6,
  };

  /** Antall fortegn i tonearten, lest av et navn som «Eb-dur» eller «A-dur». */
  function fortegnAv(toneart) {
    if (!toneart) return 0;
    const t = String(toneart).trim().toLowerCase();
    const m = t.match(/^([a-h])\s*(b|#|iss|ess)?/);
    if (!m) return 0;
    const dur = !/moll|minor|-m\b/.test(t);
    let grunn = m[1];
    if (grunn === 'h') grunn = 'b';
    const tegn = m[2] === 'b' || m[2] === 'ess' ? -1 : (m[2] === '#' || m[2] === 'iss' ? 1 : 0);
    // Kvintsirkelen: C=0, G=1, D=2 … F=−1, Bb=−2 …
    const dursirkel = { c: 0, g: 1, d: 2, a: 3, e: 4, b: 5, f: -1 };
    let n = dursirkel[grunn];
    if (n === undefined) return 0;
    n += tegn * 7;
    if (!dur) n -= 3;                       // samme fortegn som dur en liten ters over
    return Math.max(-7, Math.min(7, n));
  }

  /**
   * Tonehoeyde til notelinje.
   *
   * `trinn` teller diatonisk: C0 = 0, D0 = 1 … altsaa syv per oktav.
   * Det er den eneste telemaaten som gir riktig plass paa staven, for
   * staven har fem linjer per oktav og ikke tolv.
   */
  function skrivemaate(midi, fortegn) {
    const tabell = fortegn < 0 ? FLATT : SKARP;
    const pc = ((midi % 12) + 12) % 12;
    const [bokstav, tegn] = tabell[pc];
    const oktav = Math.floor(midi / 12) - 1;
    // C flyttet opp av et b (Cb) hoerer til oktaven under, og omvendt.
    const trinn = oktav * 7 + bokstav;
    return { trinn: trinn, tegn: tegn, bokstav: BOKSTAV[bokstav] };
  }

  /** Hvilke bokstaver toneartens fortegn allerede dekker. */
  function fasteFortegn(fortegn) {
    const KRYSS = [3, 0, 4, 1, 5, 2, 6];      // F C G D A E B
    const BER = [6, 2, 5, 1, 4, 0, 3];        // B E A D G C F
    const ut = {};
    const liste = fortegn >= 0 ? KRYSS : BER;
    for (let i = 0; i < Math.abs(fortegn); i++) ut[liste[i]] = fortegn >= 0 ? 1 : -1;
    return ut;
  }

  /**
   * Midtlinjas tonetrinn for hver noekkel.
   *  G-noekkel: H4 (trinn 4*7+6 = 34)
   *  F-noekkel: D3 (trinn 3*7+1 = 22)
   * Tenorens G-noekkel med liten 8 noteres en oktav OVER det den
   * klinger, saa der legges 12 halvtoner til foer trinnet regnes ut.
   */
  const NOEKLER = {
    g: { midt: 34, oktav: 0, tegn: 'G' },
    g8: { midt: 34, oktav: 12, tegn: 'G' },
    f: { midt: 22, oktav: 0, tegn: 'F' },
  };

  function noekkelFor(navn, median) {
    const n = String(navn || '').toLowerCase();
    if (/sopran|alt/.test(n)) return 'g';
    if (/bass|baryton/.test(n)) return 'f';
    if (/tenor/.test(n)) return 'g8';
    return median >= 55 ? 'g' : 'f';         // ukjent navn: la leiet bestemme
  }

  // ───────────────────────────── tegning ──────────────────────────────

  const NS = 'http://www.w3.org/2000/svg';
  function lag(navn, attr) {
    const e = document.createElementNS(NS, navn);
    for (const k in attr) e.setAttribute(k, attr[k]);
    return e;
  }

  /** Hvor mye hoeyde én stav trenger, i linjeavstander. */
  const STAVHOYDE = 10.4;

  /**
   * Tegner ÉN stav inn i en gruppe, med midtlinja paa `midtY`.
   *
   * Trukket ut fra `tegn` fordi et partitur er den samme staven gjentatt
   * nedover med felles x-akse. Returnerer notehodene, slik at den som
   * spiller av kan lyse opp tonen som klinger.
   */
  function tegnStav(mor, noter, valg, midtY, bredde) {
    const L = valg.L, slagPerTakt = valg.slagPerTakt;
    const fortegn = valg.fortegn, faste = valg.faste;
    const noekkel = valg.noekkel;
    const xAvSlag = valg.xAvSlag;
    const slagAv = (n) => (n.takt - 1) * slagPerTakt + n.slag;

    const linjer = lag('g', { class: 'ns-linjer' });
    for (let i = 0; i < 5; i++) {
      const y = midtY + (i - 2) * L;
      linjer.appendChild(lag('line', { x1: 0, y1: y, x2: bredde, y2: y }));
    }
    mor.appendChild(linjer);

    const nk = lag('text', {
      class: 'ns-noekkel', x: L * 1.2, y: noekkel.tegn === 'G' ? midtY + L : midtY - L,
      'font-size': L * (noekkel.tegn === 'G' ? 4.2 : 3.4),
    });
    nk.textContent = noekkel.tegn === 'G' ? '𝄞' : '𝄢';
    mor.appendChild(nk);
    if (noekkel.oktav) {
      const aatte = lag('text', { class: 'ns-oktav', x: L * 2.1, y: midtY + L * 3.4, 'font-size': L * 1.3 });
      aatte.textContent = '8';
      mor.appendChild(aatte);
    }

    const KRYSS_Y = [4, 1, 5, 2, 6, 3, 7];
    const BER_Y = [2, 5, 1, 4, 0, 3, -1];
    for (let i = 0; i < Math.abs(fortegn); i++) {
      const rad = (fortegn > 0 ? KRYSS_Y : BER_Y)[i] - (noekkel.tegn === 'F' ? 1 : 0);
      const t = lag('text', {
        class: 'ns-fortegn', x: L * 4.4 + i * L * 0.9,
        y: midtY - (rad - 2) * (L / 2) + L * 0.35, 'font-size': L * 2.4,
      });
      t.textContent = fortegn > 0 ? '♯' : '♭';
      mor.appendChild(t);
    }

    const gNoter = lag('g', { class: 'ns-noter' });
    const gTekst = lag('g', { class: 'ns-tekst' });
    const tekstY = midtY + L * 2 + L * 2.3;
    const hoder = [];
    // Sist brukte hoeyrekant for en stavelse. To stavelser som havner
    // oppaa hverandre blir uleselige — «drowns» + «Bil'Ch» + «ten» ble
    // til «drownsBil'Chten» paa skjermen. Da er det bedre aa utelate
    // den ene enn aa skrive begge i samme felt.
    let tekstTil = -Infinity;

    noter.forEach((n) => {
      const sk = skrivemaate(n.midi + noekkel.oktav, fortegn);
      const rad = sk.trinn - noekkel.midt;
      const y = midtY - rad * (L / 2);
      const x = xAvSlag(slagAv(n));
      const v = n.varighet || 1;

      const hj = lag('g', { class: 'ns-hjelp' });
      for (let r = 6; r <= rad; r += 2) {
        hj.appendChild(lag('line', { x1: x - L, y1: midtY - r * (L / 2), x2: x + L, y2: midtY - r * (L / 2) }));
      }
      for (let r = -6; r >= rad; r -= 2) {
        hj.appendChild(lag('line', { x1: x - L, y1: midtY - r * (L / 2), x2: x + L, y2: midtY - r * (L / 2) }));
      }
      if (hj.childNodes.length) gNoter.appendChild(hj);

      const bokstavNr = BOKSTAV.indexOf(sk.bokstav);
      if ((faste[bokstavNr] || 0) !== sk.tegn) {
        const f = lag('text', { class: 'ns-fortegn', x: x - L * 1.9, y: y + L * 0.38, 'font-size': L * 2.2 });
        f.textContent = sk.tegn > 0 ? '♯' : (sk.tegn < 0 ? '♭' : '♮');
        gNoter.appendChild(f);
      }

      const hode = lag('ellipse', {
        class: 'ns-hode' + (v >= 2 ? ' hul' : ''),
        cx: x, cy: y, rx: L * 0.68, ry: L * 0.5,
        transform: 'rotate(-20 ' + x + ' ' + y + ')',
      });
      gNoter.appendChild(hode);
      hoder.push({ e: hode, start: slagAv(n), slutt: slagAv(n) + v });

      if (v < 4) {
        const opp = rad < 0;
        const hx = x + (opp ? L * 0.62 : -L * 0.62);
        const hy2 = y + (opp ? -L * 3.2 : L * 3.2);
        gNoter.appendChild(lag('line', { class: 'ns-hals', x1: hx, y1: y, x2: hx, y2: hy2 }));
        const faner = v <= 0.3 ? 2 : (v < 0.95 ? 1 : 0);
        for (let f = 0; f < faner; f++) {
          const fy = hy2 + (opp ? f * L * 0.7 : -f * L * 0.7);
          gNoter.appendChild(lag('path', {
            class: 'ns-fane',
            d: 'M ' + hx + ' ' + fy + ' q ' + (L * 0.9) + ' ' + (opp ? L * 0.6 : -L * 0.6) +
               ' ' + (L * 0.8) + ' ' + (opp ? L * 1.5 : -L * 1.5),
          }));
        }
      }

      if (Math.abs(v / 1.5 - Math.round(v / 1.5)) < 0.01 && v > 0.4) {
        gNoter.appendChild(lag('circle', {
          class: 'ns-punkt', cx: x + L * 1.15,
          cy: y - (Math.abs(rad % 2) < 0.5 ? L * 0.5 : 0), r: L * 0.17,
        }));
      }

      if (n.tekst && valg.visTekst) {
        const bred = n.tekst.length * L * 0.72;     // grovt anslag
        if (x - bred / 2 > tekstTil) {
          const t = lag('text', { class: 'ns-ord', x: x, y: tekstY, 'font-size': L * 1.45 });
          t.textContent = n.tekst;
          gTekst.appendChild(t);
          tekstTil = x + bred / 2 + L * 0.5;
        }
      }
    });

    // Pauser: der stemmen tier, skal det staa noe. En tom stav ser ut
    // som en feil, og man vet ikke om stemmen hviler eller om lesinga
    // mistet den.
    const dekket = new Map();
    for (const no of noter) {
      const t = no.takt;
      if (!dekket.has(t)) dekket.set(t, []);
      dekket.get(t).push([no.slag, no.slag + (no.varighet || 1)]);
    }
    const sisteT = valg.sisteTakt || 1;
    const gPause = lag('g', { class: 'ns-pause' });
    for (let t = 1; t <= sisteT; t++) {
      const spenn = (dekket.get(t) || []).slice().sort((a, b) => a[0] - b[0]);
      let paa = 0;
      const hull = [];
      for (const [fra, til] of spenn) {
        if (fra - paa >= 0.9) hull.push([paa, fra]);
        if (til > paa) paa = til;
      }
      if (slagPerTakt - paa >= 0.9) hull.push([paa, slagPerTakt]);
      for (const [fra, til] of hull) {
        const lengde = til - fra;
        const helTakt = lengde >= slagPerTakt - 0.05;
        const x = xAvSlag((t - 1) * slagPerTakt + (helTakt ? slagPerTakt / 2 : fra + 0.2));
        const p = lag('text', {
          class: 'ns-pausetegn', x: x, y: midtY + L * 0.5, 'font-size': L * 2.6,
        });
        // hel, halv eller fjerdedel — nok til aa lese takten
        p.textContent = helTakt || lengde >= 3.5 ? '𝄻'
          : (lengde >= 1.8 ? '𝄼' : '𝄽');
        gPause.appendChild(p);
      }
    }
    mor.appendChild(gPause);

    mor.appendChild(gNoter);
    mor.appendChild(gTekst);
    return hoder;
  }

  /** Felles oppsett for begge tegnemaatene. */
  function grunnlag(alleNoter, valg) {
    const L = valg.L || 12;
    const perSlag = valg.perSlag || 70;
    const slagPerTakt = valg.slagPerTakt || 4;
    // Tallet gaar foran navnet: lesinga oppgir tonearten som antall
    // kryss eller b, og det er presist. Navnet er for deg aa lese, og
    // er bare en omvei tilbake til det samme tallet.
    const fortegn = Number.isFinite(valg.fortegn)
      ? valg.fortegn : fortegnAv(valg.toneart);
    const venstre = Math.round(valg.venstre || L * 9);
    const xAvSlag = (s) => venstre + s * perSlag;

    let sisteSlag = 0, sisteTakt = 1;
    for (const n of alleNoter) {
      const s = (n.takt - 1) * slagPerTakt + n.slag;
      if (s + (n.varighet || 1) > sisteSlag) sisteSlag = s + (n.varighet || 1);
      if (n.takt > sisteTakt) sisteTakt = n.takt;
    }
    return {
      L, perSlag, slagPerTakt, fortegn, faste: fasteFortegn(fortegn),
      venstre, xAvSlag, sisteSlag, sisteTakt,
      bredde: xAvSlag(sisteSlag) + perSlag,
    };
  }

  /** Taktstreker gjennom hele systemet, med taktnummer oeverst. */
  function tegnTaktstreker(mor, g, fraY, tilY) {
    const streker = lag('g', { class: 'ns-taktstrek' });
    for (let t = 1; t <= g.sisteTakt + 1; t++) {
      const x = g.xAvSlag((t - 1) * g.slagPerTakt);
      streker.appendChild(lag('line', { x1: x, y1: fraY, x2: x, y2: tilY }));
      if (t <= g.sisteTakt) {
        const nr = lag('text', { class: 'ns-taktnr', x: x + 3, y: fraY - g.L * 0.6, 'font-size': g.L * 1.1 });
        nr.textContent = t;
        streker.appendChild(nr);
      }
    }
    mor.appendChild(streker);
  }

  /** Setter én stemme som en sammenhengende notelinje. */
  function tegn(noter, valg) {
    const g = grunnlag(noter, valg);
    const L = g.L;
    const hoeyder = noter.map((n) => n.midi).sort((a, b) => a - b);
    const median = hoeyder.length ? hoeyder[hoeyder.length >> 1] : 60;
    const noekkel = NOEKLER[noekkelFor(valg.navn, median)];

    const overYtre = L * 3.2, underYtre = L * 2.6, tekstPlass = L * 2.4;
    const midtY = overYtre + L * 2;
    const hoyde = overYtre + L * 4 + underYtre + tekstPlass;

    const svg = lag('svg', {
      class: 'noteskrift', width: g.bredde, height: hoyde,
      viewBox: '0 0 ' + g.bredde + ' ' + hoyde,
    });
    tegnTaktstreker(svg, g, midtY - L * 2, midtY + L * 2);
    const hoder = tegnStav(svg, noter,
      Object.assign({}, g, { noekkel: noekkel, visTekst: true }), midtY, g.bredde);

    return {
      svg, bredde: g.bredde, hoyde, midtY, L, noekkel, fortegn: g.fortegn,
      hoder, xAvSlag: g.xAvSlag, perSlag: g.perSlag, slagPerTakt: g.slagPerTakt,
    };
  }

  /**
   * Setter et helt PARTITUR: alle stemmene under hverandre, med felles
   * x-akse og taktstreker som gaar gjennom alle stavene.
   *
   * Dette er hovedvisninga. Den erstatter overlayet paa den innskannede
   * sida, som aldri kunne bli helt riktig: det maatte finne hver takt
   * paa piksel i en fotokopi, og bommet. Her tegnes notene av de samme
   * dataene som klinger, og da er markoeren riktig fordi den ikke kan
   * vaere noe annet.
   *
   * @param stemmer [{navn, noter}] ovenfra og ned
   */
  function tegnPartitur(stemmer, valg) {
    const alle = [].concat.apply([], stemmer.map((s) => s.noter));
    const g = grunnlag(alle, valg);
    const L = g.L;

    const toppMarg = L * 2.6;
    const hoyde = toppMarg + stemmer.length * L * STAVHOYDE + L;

    const svg = lag('svg', {
      class: 'noteskrift partitur', width: g.bredde, height: hoyde,
      viewBox: '0 0 ' + g.bredde + ' ' + hoyde,
    });

    const midterY = stemmer.map((_, i) => toppMarg + i * L * STAVHOYDE + L * 3.2 + L * 2);
    // Taktstrekene gaar fra oeverste til nederste stav, slik de gjoer i
    // et partitur — det er dette som binder stemmene sammen for oeyet.
    tegnTaktstreker(svg, g, midterY[0] - L * 2, midterY[midterY.length - 1] + L * 2);

    const klammer = lag('g', { class: 'ns-klammer' });
    klammer.appendChild(lag('line', {
      x1: 1.5, y1: midterY[0] - L * 2, x2: 1.5, y2: midterY[midterY.length - 1] + L * 2,
    }));
    svg.appendChild(klammer);

    const ut = [];
    stemmer.forEach((st, i) => {
      const h = st.noter.map((n) => n.midi).sort((a, b) => a - b);
      const median = h.length ? h[h.length >> 1] : 60;
      const noekkel = NOEKLER[noekkelFor(st.navn, median)];
      const hoder = tegnStav(svg, st.noter,
        Object.assign({}, g, { noekkel: noekkel, visTekst: !!st.visTekst }),
        midterY[i], g.bredde);
      ut.push({ navn: st.navn, hoder: hoder, midtY: midterY[i] });
    });

    return {
      svg, bredde: g.bredde, hoyde, L, stemmer: ut,
      xAvSlag: g.xAvSlag, perSlag: g.perSlag, slagPerTakt: g.slagPerTakt,
      venstre: g.venstre,
    };
  }

  const api = { tegn, tegnPartitur, skrivemaate, fortegnAv, noekkelFor, fasteFortegn, STAVHOYDE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Noteskrift = api;

})(typeof window !== 'undefined' ? window : globalThis);
