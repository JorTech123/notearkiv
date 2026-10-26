/**
 * noteanalyse.js — strukturanalyse av et binarisert notebilde:
 * notelinjer -> staver (grupper paa fem) -> systemer -> takter.
 *
 * Denne fila er DELT mellom Node-pipelinen og skanneren i nettleseren.
 * Den rører hverken filsystem, sharp eller DOM — bare Uint8Array inn og
 * vanlige objekter ut — slik at det bare finnes én utgave av algoritmen.
 * Lastes som klassisk <script> i nettleseren og med require() i Node.
 *
 * Alt bygger paa at notelinjer er de eneste objektene paa sida som er
 * baade lange og horisontale. Derfor filtreres projeksjonen paa
 * loepelengde foer topper hentes ut — ellers drukner linjene i kopi-sot.
 */
(function (rot) {
  'use strict';

  /**
   * Enkel terskling. Etter flatfelt og nivaajustering er papiret hvitt og
   * blekket moerkt, saa en fast grense holder — og den koster ingenting i
   * minne, til forskjell fra Sauvola, som trenger to integralbilder i
   * dobbel presisjon. Det betyr noe paa en telefon.
   */
  function terskle(g, grense) {
    const bin = new Uint8Array(g.length);
    for (let i = 0; i < g.length; i++) bin[i] = g[i] < grense ? 1 : 0;
    return bin;
  }

  /**
   * Beholder bare blekk som inngaar i korte vertikale loep. Notelinjer er
   * per definisjon tynne i hoeyden, mens notehoder, halser, bjelker og
   * tekst er tykke — de forsvinner. Uten dette filteret broer tett blekk
   * mellom linjene seg sammen til falske, lange horisontale loep.
   */
  function tynnMaske(bin, b, h, maksLoep) {
    const ut = new Uint8Array(b * h);
    for (let x = 0; x < b; x++) {
      let y = 0;
      while (y < h) {
        if (!bin[y * b + x]) { y++; continue; }
        let slutt = y;
        while (slutt < h && bin[slutt * b + x]) slutt++;
        if (slutt - y <= maksLoep) {
          for (let i = y; i < slutt; i++) ut[i * b + x] = 1;
        }
        y = slutt;
      }
    }
    return ut;
  }

  /**
   * Anslaar notelinjeavstand og linjetykkelse fra vertikale loepelengder.
   * Den vanligste sorte loepa er linjetykkelsen, den vanligste hvite loepa
   * mellom to tynne sorte er avstanden.
   */
  function anslaaAvstand(bin, b, h) {
    const sort = new Float64Array(64);
    const hvit = new Float64Array(128);
    const hopp = Math.max(1, Math.round(b / 700));

    for (let x = 0; x < b; x += hopp) {
      const loep = [];
      let y = 0;
      while (y < h) {
        const verdi = bin[y * b + x];
        let slutt = y;
        while (slutt < h && bin[slutt * b + x] === verdi) slutt++;
        loep.push({ verdi: verdi, lengde: slutt - y });
        y = slutt;
      }
      for (let i = 0; i < loep.length; i++) {
        const l = loep[i];
        if (l.verdi) { if (l.lengde < 64) sort[l.lengde]++; continue; }
        // Bare hvite loep mellom to tynne sorte teller som linjeavstand.
        // Ellers forurenses maalingen av mellomrom i tekst.
        const foer = loep[i - 1], etter = loep[i + 1];
        if (foer && etter && foer.lengde <= 6 && etter.lengde <= 6 && l.lengde < 128) {
          hvit[l.lengde]++;
        }
      }
    }
    const topp = function (arr, fra) {
      let best = fra, bestV = -1;
      for (let i = fra; i < arr.length; i++) if (arr[i] > bestV) { bestV = arr[i]; best = i; }
      return best;
    };
    const tykkelse = Math.max(1, topp(sort, 1));
    const avstand = Math.max(4, topp(hvit, 3));
    return { avstand: avstand, tykkelse: tykkelse, hoyde: avstand * 4 + tykkelse * 5 };
  }

  /**
   * Horisontal «linje-profil»: for hver rad den lengste blekkloepa, med
   * lov til aa hoppe over smaa hull. Lengste loep (ikke summen) brukes
   * fordi det er uavhengig av hvor mye annet blekk som ligger paa raden.
   */
  function linjeProfil(bin, b, h, maksHull) {
    const maksLoep = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      const rad = y * b;
      let beste = 0, start = -1, sisteBlekk = -1;
      for (let x = 0; x < b; x++) {
        if (bin[rad + x]) {
          if (start < 0) start = x;
          sisteBlekk = x;
        } else if (start >= 0 && x - sisteBlekk > maksHull) {
          const lengde = sisteBlekk - start + 1;
          if (lengde > beste) beste = lengde;
          start = -1;
        }
      }
      if (start >= 0) {
        const lengde = sisteBlekk - start + 1;
        if (lengde > beste) beste = lengde;
      }
      maksLoep[y] = beste;
    }
    return maksLoep;
  }

  /**
   * Notelinjas utstrekning: foerste og siste blekkpiksel i et smalt baand
   * rundt linja, med persentiler saa en flekk i margen ikke drar den med.
   * Den lengste sammenhengende loepa duger ikke — en fotokopiert linje er
   * oppbrutt.
   */
  function lengsteStrekk(bin, b, h, y, baand) {
    if (y < 0 || y >= h) return { x0: 0, x1: b - 1 };
    const yFra = Math.max(0, y - baand);
    const yTil = Math.min(h - 1, y + baand);

    const xer = [];
    for (let x = 0; x < b; x++) {
      for (let yy = yFra; yy <= yTil; yy++) {
        if (bin[yy * b + x]) { xer.push(x); break; }
      }
    }
    if (xer.length < 8) return { x0: 0, x1: b - 1 };
    return {
      x0: xer[Math.floor(xer.length * 0.01)],
      x1: xer[Math.floor(xer.length * 0.99)],
    };
  }

  /** Finner notelinjer som sammenhengende baand av hoey profilverdi. */
  function finnNotelinjer(bin, b, h, mal) {
    // Foerst bort med alt som er tykt i hoeyden: notehoder, halser,
    // bjelker og tekst. Da staar notelinjene nesten alene i profilen.
    const tynn = tynnMaske(bin, b, h, Math.max(2, Math.round(mal.tykkelse * 2.2)));
    const prof = linjeProfil(tynn, b, h, Math.max(2, Math.round(mal.avstand * 0.6)));

    // Notebredden fra 95-persentilen, ikke maks, saa ett utslag (sidekant,
    // ramme) ikke setter terskelen for hoeyt.
    const sortert = Array.prototype.slice.call(prof).sort(function (a, c) { return a - c; });
    const bredde = sortert[Math.floor(sortert.length * 0.95)];
    if (!bredde) return [];
    const terskel = Math.max(mal.avstand * 8, bredde * 0.45);
    const maksTykk = Math.max(3, Math.round(mal.tykkelse * 2.5), Math.round(mal.avstand * 0.5));

    const linjer = [];
    let y = 0;
    while (y < h) {
      if (prof[y] < terskel) { y++; continue; }
      let slutt = y, vekt = 0, vektY = 0, topp = 0;
      while (slutt < h && prof[slutt] >= terskel) {
        vekt += prof[slutt];
        vektY += prof[slutt] * slutt;
        if (prof[slutt] > topp) topp = prof[slutt];
        slutt++;
      }
      const tykkelse = slutt - y;
      if (tykkelse <= maksTykk) {
        const strekk = lengsteStrekk(tynn, b, h, Math.round(vektY / vekt),
          Math.max(1, Math.round(mal.tykkelse * 0.8)));
        linjer.push({
          y: vektY / vekt, tykkelse: tykkelse, styrke: topp / bredde,
          x0: strekk.x0, x1: strekk.x1,
        });
      }
      y = slutt;
    }
    return linjer;
  }

  /**
   * Grupperer linjer i staver paa fem. I stedet for aa kreve fem
   * paafoelgende linjer laases senteravstanden lokalt, og de tre neste
   * soekes opp der de *skal* ligge. Da overlever grupperinga at det ligger
   * en falsk linje (tekst, understrek, bjelke) imellom.
   */
  function grupperStaver(linjer, mal) {
    if (linjer.length < 5) return [];

    const grovGap = [];
    for (let i = 1; i < linjer.length; i++) {
      const g = linjer[i].y - linjer[i - 1].y;
      if (g >= mal.avstand * 0.6 && g <= mal.avstand * 2.4) grovGap.push(g);
    }
    if (!grovGap.length) return [];
    grovGap.sort(function (a, c) { return a - c; });
    let globalSteg = grovGap[grovGap.length >> 1];

    // Tykke eller ujevne linjer kan gi to topper. Slaa sammen alt som
    // ligger naermere hverandre enn en knapp halv linjeavstand.
    const slaatt = [];
    for (const l of linjer) {
      const forrige = slaatt[slaatt.length - 1];
      if (forrige && l.y - forrige.y < globalSteg * 0.45) {
        const vekt = forrige.styrke + l.styrke || 2;
        forrige.y = (forrige.y * forrige.styrke + l.y * l.styrke) / vekt;
        forrige.tykkelse = Math.max(forrige.tykkelse, l.tykkelse);
        forrige.styrke = Math.max(forrige.styrke, l.styrke);
      } else {
        slaatt.push({
          y: l.y, tykkelse: l.tykkelse, styrke: l.styrke, x0: l.x0, x1: l.x1,
        });
      }
    }

    const gap = [];
    for (let i = 1; i < slaatt.length; i++) {
      const g = slaatt[i].y - slaatt[i - 1].y;
      if (g >= mal.avstand * 0.6 && g <= mal.avstand * 2.4) gap.push(g);
    }
    if (gap.length) {
      gap.sort(function (a, c) { return a - c; });
      globalSteg = gap[gap.length >> 1];
    }

    const brukt = new Array(slaatt.length).fill(false);
    const staver = [];

    for (let i = 0; i < slaatt.length; i++) {
      if (brukt[i]) continue;

      let j = i + 1;
      while (j < slaatt.length && brukt[j]) j++;
      if (j >= slaatt.length) break;
      const steg = slaatt[j].y - slaatt[i].y;
      if (steg < globalSteg * 0.72 || steg > globalSteg * 1.4) continue;

      const valgt = [i, j];
      const toleranse = steg * 0.34;
      let mangler = 0, ok = true;
      for (let k = 2; k < 5; k++) {
        const forventet = slaatt[i].y + k * steg;
        let best = -1, bestAvvik = Infinity;
        for (let n = j + 1; n < slaatt.length; n++) {
          if (brukt[n]) continue;
          const avvik = Math.abs(slaatt[n].y - forventet);
          if (avvik < bestAvvik) { bestAvvik = avvik; best = n; }
          if (slaatt[n].y > forventet + steg) break;
        }
        if (best < 0 || bestAvvik > toleranse) {
          // En stav har alltid fem linjer. Er fire sikre, vet vi hvor den
          // femte ligger, saa den rekonstrueres i stedet for aa forkastes.
          if (++mangler > 1) { ok = false; break; }
          valgt.push(-k);
        } else {
          valgt.push(best);
        }
      }
      if (!ok) continue;

      const fem = valgt.map(function (n) {
        if (n >= 0) { brukt[n] = true; return slaatt[n]; }
        return {
          y: slaatt[i].y + -n * steg, tykkelse: mal.tykkelse,
          styrke: 0, rekonstruert: true,
        };
      });
      brukt[i] = true; brukt[j] = true;
      fem.sort(function (a, c) { return a.y - c.y; });
      staver.push({
        linjer: fem,
        yTopp: fem[0].y,
        yBunn: fem[4].y,
        avstand: (fem[4].y - fem[0].y) / 4,
        hoyde: fem[4].y - fem[0].y,
        rekonstruerte: mangler,
      });
    }

    staver.sort(function (a, c) { return a.yTopp - c.yTopp; });
    return staver;
  }

  /**
   * Gjetter hvor mange staver et system har.
   *
   * Et korpartitur har like mange staver i hvert system hele veien. Det
   * er en sterk foering, og den loeser tilfellet der klammen er brutt i
   * kopien: prøv hver tenkelig systemstoerrelse, og se hvilken som gir
   * stoerst sprang nettopp der systemskillene da havner.
   */
  function besteSystemstorrelse(staver) {
    if (staver.length < 4) return { V: staver.length, score: 0 };
    const gap = [];
    for (let i = 0; i < staver.length - 1; i++) {
      gap.push(staver[i + 1].yTopp - staver[i].yBunn);
    }
    const midt = function (a) {
      const v = a.slice().sort(function (x, y) { return x - y; });
      return v[v.length >> 1];
    };

    let beste = { V: staver.length, score: 0 };
    for (let V = 2; V <= Math.min(8, staver.length - 1); V++) {
      const inne = [], mellom = [];
      for (let i = 0; i < gap.length; i++) {
        if ((i + 1) % V === 0) mellom.push(gap[i]); else inne.push(gap[i]);
      }
      if (!mellom.length || !inne.length) continue;
      let score = midt(mellom) / Math.max(1, midt(inne));
      // En stoerrelse som deler stavene jevnt opp er mer sannsynlig.
      if (staver.length % V !== 0) score *= 0.82;
      if (score > beste.score) beste = { V: V, score: score };
    }
    return beste;
  }

  /** Deler stavene i blokker av fast stoerrelse. */
  function delIBlokker(staver, V) {
    const systemer = [];
    for (let i = 0; i < staver.length; i += V) {
      const gruppe = staver.slice(i, i + V);
      systemer.push({
        indeks: systemer.length,
        staver: gruppe,
        yTopp: gruppe[0].yTopp,
        yBunn: gruppe[gruppe.length - 1].yBunn,
      });
    }
    return systemer;
  }

  /** Kolonner som er fylt med blekk gjennom hele én stavs hoeyde. */
  function stavTaktstreker(bin, b, h, stav, mal) {
    const yFra = Math.max(0, Math.round(stav.yTopp));
    const yTil = Math.min(h - 1, Math.round(stav.yBunn));
    const hoyde = yTil - yFra + 1;
    if (hoyde < 8) return [];

    const x0 = Math.max(0, Math.round(stav.x0 != null ? stav.x0 : 0));
    const x1 = Math.min(b - 1, Math.round(stav.x1 != null ? stav.x1 : b - 1));
    const treff = [];
    for (let x = x0; x <= x1; x++) {
      let blekk = 0;
      for (let y = yFra; y <= yTil; y++) if (bin[y * b + x]) blekk++;
      if (blekk < hoyde * 0.85) continue;
      const forrige = treff[treff.length - 1];
      if (forrige && x - forrige.slutt <= Math.max(2, mal.avstand * 0.6)) forrige.slutt = x;
      else treff.push({ start: x, slutt: x });
    }
    return treff.map(function (t) { return Math.round((t.start + t.slutt) / 2); });
  }

  /**
   * Binder staver til systemer ut fra at de deler taktstreker.
   *
   * Dette er det sterkeste signalet som finnes: to staver som spilles
   * samtidig har taktstrekene paa noeyaktig samme x. To staver fra ulike
   * systemer har ulik musikk, og dermed ulike taktstreker. I motsetning
   * til systemklammen taaler det at kopien er oppbrutt, og i motsetning
   * til avstandsmaaling bryr det seg ikke om at sangteksten mellom
   * stavene gjoer alle mellomrom like store.
   */
  function finnSystemerViaTaktstreker(staver, bin, b, h, mal) {
    if (staver.length < 2) {
      return staver.length ? delIBlokker(staver, 1) : [];
    }
    const perStav = staver.map(function (s) {
      return stavTaktstreker(bin, b, h, s, mal);
    });
    const toleranse = Math.max(3, mal.avstand * 0.8);

    const likhet = [];
    for (let i = 0; i < staver.length - 1; i++) {
      const a = perStav[i], c = perStav[i + 1];
      if (a.length < 2 || c.length < 2) { likhet.push(0); continue; }
      let treff = 0;
      for (const x of a) {
        for (const y of c) {
          if (Math.abs(x - y) <= toleranse) { treff++; break; }
        }
      }
      // Deles paa det MINSTE settet. En stav har gjerne et par falske
      // streker fra notehalser eller skannestriper; det skal ikke vaere
      // nok til aa si at den hoerer til et annet system. Spoersmaalet er
      // om alle strekene i det minste settet gjenfinnes i det andre.
      likhet.push(treff >= 2 ? treff / Math.min(a.length, c.length) : 0);
    }

    const systemer = [];
    let start = 0;
    for (let i = 0; i <= staver.length - 1; i++) {
      const slutt = i === staver.length - 1 || likhet[i] < 0.65;
      if (!slutt) continue;
      const gruppe = staver.slice(start, i + 1);
      systemer.push({
        indeks: systemer.length,
        staver: gruppe,
        yTopp: gruppe[0].yTopp,
        yBunn: gruppe[gruppe.length - 1].yBunn,
      });
      start = i + 1;
    }
    return systemer;
  }

  /** Lange vertikale streker: systemklammer og gjennomgaaende taktstreker. */
  function finnVertikaler(bin, b, h, minHoyde) {
    const treff = [];
    for (let x = 0; x < b; x++) {
      let y = 0;
      while (y < h) {
        if (!bin[y * b + x]) { y++; continue; }
        let slutt = y;
        while (slutt < h && bin[slutt * b + x]) slutt++;
        if (slutt - y >= minHoyde) treff.push({ x: x, y0: y, y1: slutt - 1 });
        y = slutt;
      }
    }
    treff.sort(function (a, c) { return a.x - c.x || a.y0 - c.y0; });
    const samlet = [];
    for (const t of treff) {
      const forrige = samlet[samlet.length - 1];
      if (forrige && t.x - forrige.x <= 3 &&
          t.y0 < forrige.y1 + 5 && t.y1 > forrige.y0 - 5) {
        forrige.x = t.x;
        forrige.y0 = Math.min(forrige.y0, t.y0);
        forrige.y1 = Math.max(forrige.y1, t.y1);
        forrige.bredde++;
      } else {
        samlet.push({ x: t.x, y0: t.y0, y1: t.y1, bredde: 1 });
      }
    }
    return samlet;
  }

  /**
   * Binder staver til systemer, primaert via klammer og gjennomgaaende
   * taktstreker. Faller tilbake paa avstandsgruppering naar skannen er for
   * daarlig til at klammen henger sammen.
   */
  function finnSystemer(staver, bin, b, h, mal, omraade) {
    if (!staver.length) return [];
    const alle = finnVertikaler(bin, b, h, Math.round(mal.hoyde * 1.2));

    const margin = mal.avstand * 2;
    const maksSpenn = h * 0.75;
    const spennerStaver = function (v) {
      return staver.filter(function (s) {
        return s.yTopp >= v.y0 - mal.avstand && s.yBunn <= v.y1 + mal.avstand;
      }).length;
    };

    // Bare streker inne i notebildet teller. Bokrygg-skygge og skannekant
    // gir ellers én strek over hele sida, som binder alt til ett system.
    const vertikaler = alle.filter(function (v) {
      return v.x >= (omraade ? omraade.x0 - margin : 0) &&
             v.x <= (omraade ? omraade.x1 + margin : b) &&
             v.y1 - v.y0 <= maksSpenn &&
             spennerStaver(v) <= Math.max(4, Math.ceil(staver.length * 0.7));
    });

    const sprang = [];
    for (let i = 0; i < staver.length - 1; i++) {
      sprang.push(staver[i + 1].yTopp - staver[i].yBunn);
    }
    const sortertSprang = sprang.slice().sort(function (a, c) { return a - c; });
    const medianSprang = sortertSprang[sortertSprang.length >> 1] || Infinity;

    const bro = new Array(Math.max(0, staver.length - 1)).fill(false);
    for (const v of vertikaler) {
      for (let i = 0; i < staver.length - 1; i++) {
        if (sprang[i] > medianSprang * 1.8) continue;
        if (v.y0 <= staver[i].yBunn + mal.avstand &&
            v.y1 >= staver[i + 1].yTopp - mal.avstand) {
          bro[i] = true;
        }
      }
    }

    if (!bro.some(Boolean) && staver.length > 1) {
      const sortert = sprang.slice().sort(function (a, c) { return a - c; });
      const median = sortert[sortert.length >> 1];
      for (let i = 0; i < sprang.length; i++) bro[i] = sprang[i] <= median * 1.6;
    }

    const systemer = [];
    let start = 0;
    for (let i = 0; i <= staver.length - 1; i++) {
      if (!(i === staver.length - 1 || !bro[i])) continue;
      const gruppe = staver.slice(start, i + 1);
      systemer.push({
        indeks: systemer.length,
        staver: gruppe,
        yTopp: gruppe[0].yTopp,
        yBunn: gruppe[gruppe.length - 1].yBunn,
      });
      start = i + 1;
    }
    return systemer;
  }

  /**
   * Taktstreker. En taktstrek er en kolonne som er fylt med blekk gjennom
   * hele stavens hoeyde — det maales direkte, i stedet for aa lete etter
   * sammenhengende vertikale loep, som ikke taaler en oppbrutt kopi.
   *
   * Den teller for systemet naar den finnes i de fleste av stavene. Da
   * forsvinner notehalser, som bare rammer én stav.
   */
  function finnTaktstreker(system, bin, b, h, mal) {
    const stemmer = new Float64Array(b);

    for (const stav of system.staver) {
      const yFra = Math.max(0, Math.round(stav.yTopp));
      const yTil = Math.min(h - 1, Math.round(stav.yBunn));
      const hoyde = yTil - yFra + 1;
      if (hoyde < 8) continue;

      for (let x = 0; x < b; x++) {
        let blekk = 0;
        for (let y = yFra; y <= yTil; y++) if (bin[y * b + x]) blekk++;
        if (blekk >= hoyde * 0.85) stemmer[x]++;
      }
    }

    const noedvendig = Math.max(1, Math.ceil(system.staver.length * 0.6));
    const samlet = [];
    for (let x = 0; x < b; x++) {
      if (stemmer[x] < noedvendig) continue;
      const forrige = samlet[samlet.length - 1];
      if (forrige && x - forrige.slutt <= Math.max(2, mal.avstand * 0.6)) forrige.slutt = x;
      else samlet.push({ start: x, slutt: x });
    }
    return samlet.map(function (s) { return Math.round((s.start + s.slutt) / 2); });
  }

  /**
   * Bygger takter av taktstrekene. Takter i ett system er omtrent like
   * brede, saa grensa settes av den typiske avstanden mellom strekene:
   * alt vesentlig smalere er dobbeltstrek, repetisjonstegn eller stoey.
   */
  function byggTakter(system, taktstreker, mal) {
    let reelle = taktstreker.slice();
    for (let runde = 0; runde < 3 && reelle.length > 2; runde++) {
      const gap = [];
      for (let i = 1; i < reelle.length; i++) gap.push(reelle[i] - reelle[i - 1]);
      const sortert = gap.slice().sort(function (a, c) { return a - c; });
      const grense = Math.max(mal.avstand * 6, sortert[sortert.length >> 1] * 0.55);

      const neste = [reelle[0]];
      let endret = false;
      for (let i = 1; i < reelle.length; i++) {
        if (reelle[i] - neste[neste.length - 1] < grense) {
          neste[neste.length - 1] = reelle[i];
          endret = true;
        } else {
          neste.push(reelle[i]);
        }
      }
      reelle = neste;
      if (!endret) break;
    }

    const takter = [];
    for (let i = 0; i < reelle.length - 1; i++) {
      takter.push({
        x0: reelle[i], x1: reelle[i + 1],
        yTopp: system.yTopp, yBunn: system.yBunn,
      });
    }
    return takter;
  }

  /** Hovedinngang: full strukturanalyse av et binarisert notebilde. */
  function analyser(bin, b, h) {
    const mal = anslaaAvstand(bin, b, h);
    const linjer = finnNotelinjer(bin, b, h, mal);
    const staver = grupperStaver(linjer, mal);

    // Notebildets x-utstrekning: medianen av linjenes egne endepunkter.
    const ekte = linjer.filter(function (l) { return l.x1 > l.x0; });
    const median = function (arr) {
      return arr.sort(function (a, c) { return a - c; })[arr.length >> 1] || 0;
    };
    const omraade = ekte.length
      ? {
          x0: median(ekte.map(function (l) { return l.x0; })),
          x1: median(ekte.map(function (l) { return l.x1; })),
        }
      : { x0: 0, x1: b - 1 };

    // Hver stav faar sin egen x-utstrekning fra linjene som faktisk ble
    // maalt. Uten den vet ingenting hvor staven begynner, og noekkelen
    // lar seg ikke finne.
    for (const stav of staver) {
      const maalte = stav.linjer.filter(function (l) {
        return !l.rekonstruert && l.x1 > l.x0;
      });
      if (maalte.length) {
        stav.x0 = median(maalte.map(function (l) { return l.x0; }));
        stav.x1 = median(maalte.map(function (l) { return l.x1; }));
      } else {
        stav.x0 = omraade.x0;
        stav.x1 = omraade.x1;
      }
    }

    // Taktstrekene er det sterkeste signalet; de to andre er reserver.
    // Gir taktstrek-metoden systemer av ujevn stoerrelse, er det et tegn
    // paa at den bommet — da proever vi fast systemstoerrelse i stedet,
    // som utnytter at et partitur har like mange staver i hvert system.
    let systemer = finnSystemerViaTaktstreker(staver, bin, b, h, mal);
    const storrelser = systemer.map(function (s) { return s.staver.length; });
    const jevn = storrelser.length > 1 &&
      storrelser.slice(0, -1).every(function (v) { return v === storrelser[0]; });

    if (!jevn) {
      const fast = besteSystemstorrelse(staver);
      if (fast.score >= 1.3) systemer = delIBlokker(staver, fast.V);
      else if (!systemer.length) systemer = finnSystemer(staver, bin, b, h, mal, omraade);
    }

    let taktNr = 1;
    for (const s of systemer) {
      s.taktstreker = finnTaktstreker(s, bin, b, h, mal);
      s.takter = byggTakter(s, s.taktstreker, mal);
      for (const t of s.takter) t.nummer = taktNr++;
    }

    return {
      mal: mal, omraade: omraade,
      antallLinjer: linjer.length,
      staver: staver,
      systemer: systemer,
      antallTakter: taktNr - 1,
    };
  }

  /**
   * Strukturen slik visningsverktoeyet vil ha den. Koordinatene er i
   * bildets egne piksler, og SVG-laget faar samme viewBox — da treffer
   * overlayet uansett hvor sida skaleres.
   */
  function tilJson(struktur, b, h) {
    return {
      bredde: b,
      hoyde: h,
      linjeavstand: struktur.mal.avstand,
      antallTakter: struktur.antallTakter,
      systemer: struktur.systemer.map(function (s) {
        return {
          yTopp: Math.round(s.yTopp),
          yBunn: Math.round(s.yBunn),
          staver: s.staver.map(function (st) {
            return {
              yTopp: Math.round(st.yTopp),
              yBunn: Math.round(st.yBunn),
              x0: Math.round(st.x0 != null ? st.x0 : struktur.omraade.x0),
              x1: Math.round(st.x1 != null ? st.x1 : struktur.omraade.x1),
              rekonstruerte: st.rekonstruerte || 0,
            };
          }),
          takter: (s.takter || []).map(function (t) {
            return { nummer: t.nummer, x0: Math.round(t.x0), x1: Math.round(t.x1) };
          }),
        };
      }),
    };
  }

  const api = {
    terskle: terskle, tynnMaske: tynnMaske, anslaaAvstand: anslaaAvstand,
    linjeProfil: linjeProfil, lengsteStrekk: lengsteStrekk,
    finnNotelinjer: finnNotelinjer, grupperStaver: grupperStaver,
    finnVertikaler: finnVertikaler, finnSystemer: finnSystemer,
    finnTaktstreker: finnTaktstreker, byggTakter: byggTakter,
    besteSystemstorrelse: besteSystemstorrelse, delIBlokker: delIBlokker,
    stavTaktstreker: stavTaktstreker, finnSystemerViaTaktstreker: finnSystemerViaTaktstreker,
    analyser: analyser, tilJson: tilJson,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else rot.Noteanalyse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
