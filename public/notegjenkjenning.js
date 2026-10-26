/**
 * notegjenkjenning.js — leser notehoder, noekkel og tonehoeyde ut av et
 * binarisert notebilde, og lager en spillbar stemme per stav.
 *
 * Delt mellom Node og nettleseren, som `noteanalyse.js` og `dokument.js`.
 *
 * Forutsetter at strukturen allerede er funnet (staver, systemer,
 * takter). Det er en stor fordel: naar vi vet noeyaktig hvor
 * notelinjene gaar, kan de fjernes rent foer notehodene soekes — og da
 * blir et notehode en tydelig, isolert klump i riktig stoerrelse.
 */
(function (rot) {
  'use strict';

  /**
   * Fjerner notelinjene. En piksel som tilhoerer en linje har kort
   * vertikalt loep; en hals eller et notehode som krysser linja har
   * langt loep og blir staaende. Det er dette som gjoer at notene
   * henger sammen etterpaa i stedet for aa bli kuttet i biter.
   */
  function fjernNotelinjer(bin, b, h, staver, tykkelse) {
    const ut = Uint8Array.from(bin);
    const maksLoep = Math.max(2, Math.round(tykkelse * 2.2));

    for (const stav of staver) {
      for (const linje of stav.linjer) {
        const yMidt = Math.round(linje.y);
        const x0 = Math.max(0, Math.round(stav.x0 != null ? stav.x0 : 0));
        const x1 = Math.min(b - 1, Math.round(stav.x1 != null ? stav.x1 : b - 1));
        for (let x = x0; x <= x1; x++) {
          // Finn loepet som dekker linja i denne kolonnen.
          let topp = yMidt;
          while (topp > 0 && bin[(topp - 1) * b + x]) topp--;
          let bunn = yMidt;
          while (bunn < h - 1 && bin[(bunn + 1) * b + x]) bunn++;
          if (!bin[yMidt * b + x]) continue;
          if (bunn - topp + 1 <= maksLoep) {
            for (let y = topp; y <= bunn; y++) ut[y * b + x] = 0;
          }
        }
      }
    }
    return ut;
  }

  /** Integralbilde, saa blekkmengden i et rektangel kan leses i O(1). */
  function integral(bin, b, h) {
    const bb = b + 1;
    const s = new Int32Array(bb * (h + 1));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < b; x++) {
        s[(y + 1) * bb + x + 1] =
          bin[y * b + x] + s[y * bb + x + 1] + s[(y + 1) * bb + x] - s[y * bb + x];
      }
    }
    return { s: s, bb: bb };
  }

  function sum(I, b, h, x0, y0, x1, y1) {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(b - 1, x1); y1 = Math.min(h - 1, y1);
    if (x1 < x0 || y1 < y0) return 0;
    const bb = I.bb;
    return I.s[(y1 + 1) * bb + x1 + 1] - I.s[(y1 + 1) * bb + x0] -
           I.s[y0 * bb + x1 + 1] + I.s[y0 * bb + x0];
  }

  /**
   * Finner notehoder paa én stav.
   *
   * Et notehode er omtrent 1,3 x 1,0 notelinjeavstand. Vi maaler
   * blekkandelen i et rektangel av den stoerrelsen for hver posisjon, og
   * tar lokale topper. Halser er for smale, bjelker for brede, og tekst
   * ligger utenfor stavens hoeydeomraade.
   *
   * Hule notehoder (halv- og helnoter) kjennes paa at ytterkanten har
   * blekk mens midten er tom.
   */
  function finnNotehoder(uten, b, h, stav, mal, omraade, grenser) {
    const sp = stav.avstand;                       // notelinjeavstand
    const bredde = Math.max(3, Math.round(sp * 1.25));
    const hoyde = Math.max(3, Math.round(sp * 0.95));
    const halvB = bredde >> 1, halvH = hoyde >> 1;

    // Hjelpelinjer gaar sjelden mer enn et par avstander ut fra staven,
    // og teksten under ligger lenger ned enn det. Et romsligere vindu tar
    // med seg sangteksten, og bokstaver er nesten like store som notehoder.
    // Vinduet maa aldri naa inn i nabostaven. Gjoer det det, henter
    // tenoren noter fra bassen, og stemmen spenner tre oktaver.
    const yFra = Math.round(Math.max(0, grenser ? grenser.yMin : 0, stav.yTopp - sp * 2.6));
    const yTil = Math.round(Math.min(h - 1, grenser ? grenser.yMax : h - 1, stav.yBunn + sp * 2.6));
    // Noekkel, faste fortegn og taktart staar foerst paa staven og er
    // ikke noter. De hoppes over.
    const start = (stav.x0 != null ? stav.x0 : omraade.x0) + sp * 5;
    const xFra = Math.max(0, Math.round(Math.max(start, omraade.x0)));
    const xTil = Math.min(b - 1, Math.round(omraade.x1));

    const I = integral(uten, b, h);
    const areal = bredde * hoyde;
    const poeng = new Float32Array((xTil - xFra + 1) * (yTil - yFra + 1));
    const pb = xTil - xFra + 1;

    for (let y = yFra; y <= yTil; y++) {
      for (let x = xFra; x <= xTil; x++) {
        const blekk = sum(I, b, h, x - halvB, y - halvH, x + halvB, y + halvH);
        const andel = blekk / areal;
        if (andel < 0.45) continue;

        // Et notehode staar for seg selv: rett over og under skal det
        // vaere lite blekk. Det skiller det fra bjelker og fra tette
        // akkordklaser.
        const over = sum(I, b, h, x - halvB, y - halvH - hoyde, x + halvB, y - halvH - 1) / areal;
        const under = sum(I, b, h, x - halvB, y + halvH + 1, x + halvB, y + halvH + hoyde) / areal;
        if (over > 0.8 && under > 0.8) continue;

        poeng[(y - yFra) * pb + (x - xFra)] = andel;
      }
    }

    // Ikke-maksimum-undertrykking: behold bare den beste i hver klynge.
    const rX = Math.max(2, Math.round(sp * 0.7));
    const rY = Math.max(2, Math.round(sp * 0.55));
    const funn = [];
    for (let y = yFra; y <= yTil; y++) {
      for (let x = xFra; x <= xTil; x++) {
        const p = poeng[(y - yFra) * pb + (x - xFra)];
        if (p <= 0) continue;
        let topp = true;
        for (let dy = -rY; dy <= rY && topp; dy++) {
          const ny = y + dy;
          if (ny < yFra || ny > yTil) continue;
          for (let dx = -rX; dx <= rX; dx++) {
            const nx = x + dx;
            if (nx < xFra || nx > xTil) continue;
            const q = poeng[(ny - yFra) * pb + (nx - xFra)];
            if (q > p || (q === p && (ny < y || (ny === y && nx < x)))) { topp = false; break; }
          }
        }
        if (!topp) continue;

        // Et notehode sitter alltid paa stavens eget rutenett: enten paa
        // en linje eller midt i et mellomrom, altsaa paa et helt antall
        // halve linjeavstander. Sangteksten under staven foelger ikke det
        // rutenettet, og det er dette filteret som skiller dem.
        const halv = sp / 2;
        const trinn = (stav.yBunn - y) / halv;
        if (Math.abs(trinn - Math.round(trinn)) > 0.3) continue;

        // Et notehode er bredere enn hoeyt. Bokstaver er omtrent kvadratiske.
        const smal = sum(I, b, h, x - Math.round(sp * 0.22), y - halvH,
                         x + Math.round(sp * 0.22), y + halvH);
        const smalAreal = (Math.round(sp * 0.22) * 2 + 1) * hoyde;
        if (smal / smalAreal < 0.55) continue;

        // Hul eller fylt? Midten av et hult hode er tom.
        const indreB = Math.max(1, Math.round(sp * 0.26));
        const indreH = Math.max(1, Math.round(sp * 0.18));
        const indre = sum(I, b, h, x - indreB, y - indreH, x + indreB, y + indreH) /
                      ((indreB * 2 + 1) * (indreH * 2 + 1));
        funn.push({
          x: x, y: y, styrke: p, fylt: indre > 0.70,
          trinn: Math.round(trinn),
        });
      }
    }

    // Sangteksten ligger paa én bestemt hoeyde under staven, mens ekte
    // noter sprer seg over mange trinn. Et trinn under staven som alene
    // rommer en stor del av alle funnene, er derfor en tekstlinje — ikke
    // musikk. Dette tar bokstavene som tilfeldigvis traff rutenettet.
    const perTrinn = {};
    for (const n of funn) perTrinn[n.trinn] = (perTrinn[n.trinn] || 0) + 1;
    const tekstTrinn = {};
    for (const t in perTrinn) {
      if (+t < -1 && perTrinn[t] >= 5 && perTrinn[t] > funn.length * 0.3) {
        tekstTrinn[t] = true;
      }
    }

    let rene = funn.filter(function (n) { return !tekstTrinn[n.trinn]; });
    rene.sort(function (a, c) { return a.x - c.x; });

    // To hoder paa samme x er enten en akkord eller en feillesing. En
    // korstemme synger én tone om gangen, saa den sterkeste beholdes.
    // Uten dette fikk samme slag baade en fjerdedel og en helnote, og
    // takten endte paa ti slag.
    const samlet = [];
    for (const n of rene) {
      const forrige = samlet[samlet.length - 1];
      // Bare reelle dubletter: samme sted OG nesten samme hoeyde. To
      // hoder over hverandre paa samme x er en akkord, og den skal staa.
      if (forrige && n.x - forrige.x < sp * 0.45 && Math.abs(n.y - forrige.y) < sp * 0.6) {
        if (n.styrke > forrige.styrke) samlet[samlet.length - 1] = n;
      } else {
        samlet.push(n);
      }
    }
    return samlet;
  }

  /**
   * Gjetter noekkelen paa staven ut fra hvordan blekket i
   * noekkelomraadet fordeler seg i hoeyden.
   *
   * G-noekkelen strekker seg langt under nederste notelinje; F-noekkelen
   * ligger samlet i oevre halvdel og har to prikker til hoeyre. Det er
   * nok til aa skille dem, og det er de to som finnes i korpartitur.
   */
  function nokkelMaal(uten, b, h, stav) {
    const sp = stav.avstand;
    const x0 = Math.max(0, Math.round((stav.x0 != null ? stav.x0 : 0) + sp * 0.2));
    const x1 = Math.min(b - 1, Math.round(x0 + sp * 3.2));
    const yFra = Math.max(0, Math.round(stav.yTopp - sp * 3));
    const yTil = Math.min(h - 1, Math.round(stav.yBunn + sp * 3));

    let blekk = 0, minY = Infinity, maksY = -1;
    for (let x = x0; x <= x1; x++) {
      for (let y = yFra; y <= yTil; y++) {
        if (!uten[y * b + x]) continue;
        blekk++;
        if (y < minY) minY = y;
        if (y > maksY) maksY = y;
      }
    }
    const stavHoyde = Math.max(1, stav.yBunn - stav.yTopp);
    return {
      blekk: blekk,
      utstrekning: blekk ? (maksY - minY) / stavHoyde : 0,
    };
  }

  /**
   * Avgjoer noekkelen av hvor hoeyt glyfen staar, ikke av hvor blekket
   * ligger i forhold til staven.
   *
   * Maalt paa ekte sider er skillet skarpt: en G-noekkel spenner 1,6-2,2
   * ganger stavhoeyden fordi den henger godt under nederste linje og
   * rekker over den oeverste. En F-noekkel holder seg innenfor staven og
   * lander paa 0,85-1,1. Den gamle regelen talte blekk over og under
   * staven, og den lot seg lure av notehaler og hjelpelinjer like ved.
   */
  function finnNokkel(uten, b, h, stav, mal) {
    const m = nokkelMaal(uten, b, h, stav);
    // For lite blekk: noekkelen er ikke i vinduet, og svaret ville vaert
    // et lykketreff. Da er «vet ikke» riktigere.
    if (m.blekk < Math.max(60, stav.avstand * 12)) return 'ukjent';
    if (m.utstrekning > 1.3) return 'g';
    if (m.utstrekning < 1.2) return 'f';
    return 'ukjent';
  }

  /**
   * Finner halsen til et notehode.
   *
   * Halsen baerer all varighetsinformasjon: uten hals er det en helnote,
   * med hals og hult hode en halvnote, og med bjelker eller faner paa
   * halseenden deles verdien videre. Derfor maa den sitte foerst.
   *
   * Den staar paa hoeyre side naar den peker opp, og paa venstre naar den
   * peker ned — alltid helt inntil hodet.
   */
  function finnHals(uten, b, h, x, y, sp) {
    const sideAvstand = sp * 0.52;
    const halvBredde = Math.max(1, Math.round(sp * 0.22));
    const minLengde = sp * 1.8;

    function maal(xMidt, retning) {
      const xi = Math.round(xMidt);
      if (xi < 0 || xi >= b) return null;
      // Start like utenfor hodet, saa selve hodet ikke teller som hals.
      let yy = Math.round(y + retning * sp * 0.55);
      let lengde = 0, tomme = 0;
      while (yy >= 0 && yy < h) {
        let blekk = false;
        for (let dx = -halvBredde; dx <= halvBredde; dx++) {
          const nx = xi + dx;
          if (nx >= 0 && nx < b && uten[yy * b + nx]) { blekk = true; break; }
        }
        if (blekk) { lengde++; tomme = 0; }
        else if (++tomme > Math.max(1, sp * 0.3)) break;
        yy += retning;
      }
      if (lengde < minLengde) return null;
      return { retning: retning, lengde: lengde, tupp: yy - retning * tomme };
    }

    // Opp paa hoeyre side, ned paa venstre.
    const opp = maal(x + sideAvstand, -1);
    const ned = maal(x - sideAvstand, 1);
    if (opp && ned) return opp.lengde >= ned.lengde ? opp : ned;
    return opp || ned;
  }

  /**
   * Teller bjelker eller faner ved halseenden.
   *
   * Begge deler ligger samme sted og betyr det samme for varigheten: én
   * strek halverer, to halverer igjen. Vi teller derfor hvor mange
   * adskilte blekkbaand som ligger paa tvers av halsen i enden av den,
   * og bryr oss ikke om det er en bjelke til naboen eller en fane.
   */
  function tellBjelker(uten, b, h, hals, x, sp) {
    if (!hals) return 0;
    const xi = Math.round(x + (hals.retning < 0 ? sp * 0.52 : -sp * 0.52));
    // Bjelker og faner sitter helt ytterst paa halsen.
    const dybde = Math.round(sp * 1.6);

    // For hver rad: hvor langt strekker blekket seg vannrett gjennom
    // halsen? Det er dette som skiller en bjelke fra halsen selv — en
    // bar hals er bare et par piksler bred, en bjelke naar bortover mot
    // nabonoten. Den gamle versjonen talte blekk i et vindu, og da talte
    // halsen seg selv som bjelke paa hver eneste fjerdedel.
    const profil = [];
    for (let k = 0; k <= dybde; k++) {
      const yy = Math.round(hals.tupp + hals.retning * -k);
      if (yy < 0 || yy >= h) { profil.push(0); continue; }
      if (!uten[yy * b + xi]) {
        // Litt slingringsmonn sidelengs om halsen ikke er helt loddrett.
        let funnet = false;
        for (let dx = -1; dx <= 1 && !funnet; dx++) {
          if (xi + dx >= 0 && xi + dx < b && uten[yy * b + xi + dx]) funnet = true;
        }
        if (!funnet) { profil.push(0); continue; }
      }
      let venstre = xi, hoyre = xi;
      while (venstre > 0 && uten[yy * b + venstre - 1]) venstre--;
      while (hoyre < b - 1 && uten[yy * b + hoyre + 1]) hoyre++;
      profil.push(hoyre - venstre + 1);
    }

    // Et baand er sammenhengende rader der blekket er klart bredere enn
    // halsen. To bjelker har en tynn luft imellom.
    // En fane boeyer seg bort fra halsen og er smalere enn en bjelke,
    // saa grensa maa ligge lavere enn bjelkebredden for aa fange begge.
    const grense = Math.max(3, Math.round(sp * 0.8));
    let baand = 0, inne = false, tykkelse = 0;
    for (const n of profil) {
      if (n >= grense) {
        tykkelse++;
        if (!inne) { inne = true; }
      } else {
        // Et baand maa ha litt hoeyde; ett enkelt utslag er stoey.
        if (inne && tykkelse >= Math.max(1, Math.round(sp * 0.18))) baand++;
        inne = false; tykkelse = 0;
      }
    }
    if (inne && tykkelse >= Math.max(1, Math.round(sp * 0.18))) baand++;
    return Math.min(4, baand);
  }

  /**
   * Punkteringsprikk: en liten, rund og fritt staaende klump rett til
   * hoeyre for hodet.
   *
   * Det holder ikke aa se at det finnes blekk der — nabonoten, en
   * taktstrek eller en bokstav i teksten ville slaatt ut. Klumpen maa
   * ogsaa ha riktig stoerrelse og ikke henge sammen med noe utenfor
   * vinduet.
   */
  function harPunkt(uten, b, h, x, y, sp) {
    const x0 = Math.round(x + sp * 0.7), x1 = Math.round(x + sp * 1.5);
    const y0 = Math.round(y - sp * 0.45), y1 = Math.round(y + sp * 0.45);
    if (x1 >= b || x0 < 0 || y0 < 0 || y1 >= h) return false;

    let n = 0, minX = x1, maksX = x0, minY = y1, maksY = y0;
    for (let xx = x0; xx <= x1; xx++) {
      for (let yy = y0; yy <= y1; yy++) {
        if (!uten[yy * b + xx]) continue;
        n++;
        if (xx < minX) minX = xx; if (xx > maksX) maksX = xx;
        if (yy < minY) minY = yy; if (yy > maksY) maksY = yy;
      }
    }
    if (!n) return false;

    const bredde = maksX - minX + 1, hoyde = maksY - minY + 1;
    // En prikk er liten og omtrent like bred som hoey.
    if (bredde > sp * 0.6 || hoyde > sp * 0.6) return false;
    if (bredde < sp * 0.15 || hoyde < sp * 0.15) return false;
    if (n < sp * sp * 0.08) return false;
    // Den maa staa fritt: naar den helt ut til kanten av vinduet, er den
    // en del av noe stoerre.
    if (minX <= x0 || maksX >= x1) return false;
    return true;
  }

  /**
   * Varigheten til én note, i slag, gitt notehodet og det som henger paa
   * halsen. Grunnverdien er fire slag (helnote) halvert for hvert hakk:
   * hul uten hals = 4, hul med hals = 2, fylt = 1, og saa én halvering
   * per bjelke eller fane.
   */
  function noteVarighet(fylt, hals, bjelker) {
    let v;
    if (!fylt) v = hals ? 2 : 4;
    else v = 1;
    if (fylt && bjelker > 0) v = 1 / Math.pow(2, bjelker);
    return v;
  }

  // Diatonisk trinn -> halvtoner over C i samme oktav.
  const TRINN = [0, 2, 4, 5, 7, 9, 11];

  /**
   * Gjoer en y-posisjon om til MIDI-tonehoeyde.
   *
   * `trinn` telles i halve notelinjeavstander opp fra nederste linje.
   * For G-noekkel er nederste linje E4 (diatonisk trinn 30 = E i oktav 4),
   * for F-noekkel er den G2.
   */
  function tonehoyde(stav, y, nokkel, fortegn) {
    const halv = stav.avstand / 2;
    const trinnOverBunn = Math.round((stav.yBunn - y) / halv);
    // Diatonisk indeks: 0 = C0.
    const bunn = nokkel === 'f' ? 2 * 7 + 4 : 4 * 7 + 2;   // G2 eller E4
    const diatonisk = bunn + trinnOverBunn;
    const oktav = Math.floor(diatonisk / 7);
    const trinn = ((diatonisk % 7) + 7) % 7;
    let midi = (oktav + 1) * 12 + TRINN[trinn];
    if (fortegn && fortegn[trinn]) midi += fortegn[trinn];
    return midi;
  }

  /** Faste fortegn: antall kryss (positivt) eller b (negativt). */
  function fortegnTabell(antall) {
    const t = [0, 0, 0, 0, 0, 0, 0];
    const KRYSS = [3, 0, 4, 1, 5, 2, 6];   // F C G D A E H
    const BEE = [6, 2, 5, 1, 4, 0, 3];     // H E A D G C F
    if (antall > 0) for (let i = 0; i < Math.min(7, antall); i++) t[KRYSS[i]] = 1;
    if (antall < 0) for (let i = 0; i < Math.min(7, -antall); i++) t[BEE[i]] = -1;
    return t;
  }

  /**
   * Teller faste fortegn mellom noekkelen og foerste note, og avgjoer om
   * det er kryss eller b.
   *
   * Formen skiller dem: en b har hele tyngden i nedre halvdel (buken),
   * mens et kryss er omtrent symmetrisk om midten. Det er robust nok,
   * og langt enklere enn aa kjenne igjen selve glyfen.
   */
  function finnFortegn(uten, b, h, stav, mal) {
    const sp = stav.avstand;
    const x0 = Math.round((stav.x0 != null ? stav.x0 : 0) + sp * 2.6);
    const x1 = Math.round(x0 + sp * 5.5);
    const yFra = Math.max(0, Math.round(stav.yTopp - sp * 1.2));
    const yTil = Math.min(h - 1, Math.round(stav.yBunn + sp * 1.2));
    const bredde = x1 - x0 + 1, hoyde = yTil - yFra + 1;
    if (bredde < 4 || hoyde < 4) return 0;

    // Merk sammenhengende klumper innenfor vinduet.
    const merke = new Int32Array(bredde * hoyde).fill(-1);
    const ko = new Int32Array(bredde * hoyde);
    const bokser = [];
    let neste = 0;

    for (let i = 0; i < merke.length; i++) {
      const gx = x0 + (i % bredde), gy = yFra + ((i / bredde) | 0);
      if (gx < 0 || gx >= b || !uten[gy * b + gx] || merke[i] !== -1) continue;
      const id = neste++;
      let hode = 0, hale = 0;
      ko[hale++] = i; merke[i] = id;
      let bx0 = gx, bx1 = gx, by0 = gy, by1 = gy, areal = 0, sumY = 0;
      while (hode < hale) {
        const p = ko[hode++];
        const px = p % bredde, py = (p / bredde) | 0;
        const ax = x0 + px, ay = yFra + py;
        areal++; sumY += ay;
        if (ax < bx0) bx0 = ax; if (ax > bx1) bx1 = ax;
        if (ay < by0) by0 = ay; if (ay > by1) by1 = ay;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= bredde || ny >= hoyde) continue;
            const q = ny * bredde + nx;
            if (merke[q] !== -1) continue;
            const qx = x0 + nx, qy = yFra + ny;
            if (qx < 0 || qx >= b || !uten[qy * b + qx]) continue;
            merke[q] = id; ko[hale++] = q;
          }
        }
      }
      bokser.push({ bx0: bx0, bx1: bx1, by0: by0, by1: by1, areal: areal, sumY: sumY });
    }

    let kryss = 0, bee = 0;
    for (const k of bokser) {
      const kb = k.bx1 - k.bx0 + 1, kh = k.by1 - k.by0 + 1;
      if (kh < sp * 1.1 || kh > sp * 3.4) continue;
      if (kb < sp * 0.3 || kb > sp * 1.3) continue;
      if (k.areal < sp * 1.2) continue;
      // Hvor ligger tyngdepunktet i hoeyden, 0 = topp, 1 = bunn?
      const tyngde = (k.sumY / k.areal - k.by0) / kh;
      if (tyngde > 0.58) bee++; else kryss++;
    }
    const antall = kryss + bee;
    if (!antall) return 0;
    return bee > kryss ? -antall : antall;
  }

  /**
   * Leser én stav: noekkel, faste fortegn og alle notehoder med
   * tonehoeyde. Rytmen legges paa senere, naar takten er kjent.
   */
  function lesStav(uten, b, h, stav, mal, omraade, grenser, gittNokkel) {
    // Noekkelen kan vaere bestemt av flertallet over hele stykket; da er
    // den langt sikrere enn det denne ene staven kan si.
    const nokkel = gittNokkel || finnNokkel(uten, b, h, stav, mal);
    const antallFortegn = finnFortegn(uten, b, h, stav, mal);
    const fortegn = fortegnTabell(antallFortegn);
    const hoder = finnNotehoder(uten, b, h, stav, mal, omraade, grenser);

    const noter = hoder.map(function (n) { return n; });
    return {
      nokkel: nokkel === 'ukjent' ? 'g' : nokkel,
      pauser: finnPauser(uten, b, h, stav, omraade, hoder),
      fortegn: antallFortegn,
      noter: hoder.map(function (n) {
        const hals = finnHals(uten, b, h, n.x, n.y, stav.avstand);
        const bjelker = tellBjelker(uten, b, h, hals, n.x, stav.avstand);
        const punkt = harPunkt(uten, b, h, n.x, n.y, stav.avstand);
        let varighet = noteVarighet(n.fylt, hals, bjelker);
        if (punkt) varighet *= 1.5;
        return {
          x: n.x, y: n.y, fylt: n.fylt,
          hals: hals ? hals.retning : 0,
          halsLengde: hals ? hals.lengde : 0,
          bjelker: bjelker, punkt: punkt, varighet: varighet,
          midi: tonehoyde(stav, n.y, nokkel === 'f' ? 'f' : 'g', fortegn),
        };
      }),
    };
  }

  /** Sammenhengende klumper innenfor et utsnitt av bildet. */
  function klumper(uten, b, h, x0, y0, x1, y1) {
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(b - 1, Math.round(x1)); y1 = Math.min(h - 1, Math.round(y1));
    const vb = x1 - x0 + 1, vh = y1 - y0 + 1;
    if (vb < 2 || vh < 2) return [];

    const sett = new Uint8Array(vb * vh);
    const ko = new Int32Array(vb * vh);
    const ut = [];

    for (let i = 0; i < sett.length; i++) {
      if (sett[i]) continue;
      const sx = x0 + (i % vb), sy = y0 + ((i / vb) | 0);
      if (!uten[sy * b + sx]) { sett[i] = 1; continue; }
      let hode = 0, hale = 0;
      ko[hale++] = i; sett[i] = 1;
      let bx0 = sx, bx1 = sx, by0 = sy, by1 = sy, areal = 0;
      while (hode < hale) {
        const p = ko[hode++];
        const px = p % vb, py = (p / vb) | 0;
        const gx = x0 + px, gy = y0 + py;
        areal++;
        if (gx < bx0) bx0 = gx; if (gx > bx1) bx1 = gx;
        if (gy < by0) by0 = gy; if (gy > by1) by1 = gy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= vb || ny >= vh) continue;
            const q = ny * vb + nx;
            if (sett[q]) continue;
            if (!uten[(y0 + ny) * b + x0 + nx]) { sett[q] = 1; continue; }
            sett[q] = 1; ko[hale++] = q;
          }
        }
      }
      ut.push({
        x0: bx0, y0: by0, x1: bx1, y1: by1, areal: areal,
        bredde: bx1 - bx0 + 1, hoyde: by1 - by0 + 1,
        midtX: (bx0 + bx1) / 2, midtY: (by0 + by1) / 2,
      });
    }
    return ut;
  }

  /**
   * Finner pauser paa en stav.
   *
   * Uten pauser kan en takt aldri gaa opp, og det var det stoerste
   * hullet i lesinga. Formene er heldigvis karakteristiske:
   *   hel/halv   liten vannrett kloss som henger paa eller over en linje
   *   fjerdedel  hoey og smal krusedull midt i staven
   *   aattedel   kortere, med loekke
   *
   * Klumper som allerede er forklart av et notehode holdes utenfor.
   */
  function finnPauser(uten, b, h, stav, omraade, noter) {
    const sp = stav.avstand;
    const y0 = stav.yTopp - sp * 0.6, y1 = stav.yBunn + sp * 0.6;
    // Noekkel og faste fortegn staar foerst og er ikke pauser. Et kryss
    // har noeyaktig stoerrelsen til en fjerdedelspause.
    const xStart = Math.max(omraade.x0, (stav.x0 != null ? stav.x0 : omraade.x0) + sp * 5);
    const alle = klumper(uten, b, h, xStart, y0, omraade.x1, y1);
    const pauser = [];

    for (const k of alle) {
      // Ligger klumpen oppaa en note vi allerede har? Da er den ikke pause.
      let forklart = false;
      for (const n of noter) {
        if (n.x >= k.x0 - sp * 0.3 && n.x <= k.x1 + sp * 0.3 &&
            n.y >= k.y0 - sp * 0.3 && n.y <= k.y1 + sp * 0.3) { forklart = true; break; }
      }
      if (forklart) continue;

      const bB = k.bredde / sp, hH = k.hoyde / sp;
      const fyll = k.areal / Math.max(1, k.bredde * k.hoyde);

      // Hel- og halvpause: bred, lav og godt fylt kloss.
      if (bB > 0.7 && bB < 2.0 && hH > 0.25 && hH < 0.8 && fyll > 0.55) {
        // Henger den under linje 4 er den hel, staar den paa linje 3 er den halv.
        const overMidt = k.midtY < (stav.yTopp + stav.yBunn) / 2;
        pauser.push({ x: k.midtX, varighet: overMidt ? 4 : 2, type: 'kloss' });
        continue;
      }
      // Fjerdedelspause: hoey og smal, midt i staven.
      if (hH > 1.6 && hH < 3.2 && bB > 0.4 && bB < 1.3 && fyll > 0.3 && fyll < 0.8) {
        pauser.push({ x: k.midtX, varighet: 1, type: 'fjerdedel' });
        continue;
      }
      // Aattedelspause: kortere, med loekke.
      if (hH > 0.9 && hH <= 1.6 && bB > 0.4 && bB < 1.2 && fyll > 0.3 && fyll < 0.85) {
        pauser.push({ x: k.midtX, varighet: 0.5, type: 'aattedel' });
      }
    }
    pauser.sort(function (a, c) { return a.x - c.x; });
    return pauser;
  }

  /**
   * Setter sammen én takt og kontrollerer den mot taktarten.
   *
   * Dette er den viktigste kvalitetssjekken som finnes i notelesing:
   * varighetene i en takt MAA summere til taktens lengde. Gjoer de ikke
   * det, er noe lest feil, og da vet vi det — i stedet for aa sende ut
   * noe som bare hoeres gaerent ut.
   *
   * Naar summen ikke stemmer, proeves et lite utvalg rettelser: en
   * manglende eller overflødig bjelke er den klart vanligste feilen, og
   * ofte finnes det nøyaktig én slik retting som faar takten til aa gaa
   * opp. Da er den nesten helt sikkert den riktige lesningen.
   */
  function byggTakt(noter, slagPerTakt) {
    if (!noter.length) return { noter: [], gyldig: false, sum: 0 };

    const sum = function (liste) {
      return liste.reduce(function (a, n) { return a + n.varighet; }, 0);
    };
    const naerNok = function (s) { return Math.abs(s - slagPerTakt) < 0.02; };

    if (naerNok(sum(noter))) {
      return { noter: noter, gyldig: true, sum: slagPerTakt, rettet: 0 };
    }

    // Prøv aa legge til eller fjerne én bjelke paa én note om gangen.
    for (const retning of [1, -1]) {
      for (let i = 0; i < noter.length; i++) {
        const n = noter[i];
        if (!n.fylt || !n.hals) continue;
        const nyeBjelker = n.bjelker + retning;
        if (nyeBjelker < 0 || nyeBjelker > 4) continue;
        const ny = noteVarighet(true, true, nyeBjelker) * (n.punkt ? 1.5 : 1);
        if (naerNok(sum(noter) - n.varighet + ny)) {
          const kopi = noter.slice();
          kopi[i] = Object.assign({}, n, { varighet: ny, bjelker: nyeBjelker, rettet: true });
          return { noter: kopi, gyldig: true, sum: slagPerTakt, rettet: 1 };
        }
      }
    }

    // Prøv aa fjerne én note. Sangteksten gir av og til et falskt hode,
    // og da gaar takten opp saa snart det tas bort.
    for (let i = 0; i < noter.length; i++) {
      const uten = noter.slice(0, i).concat(noter.slice(i + 1));
      if (uten.length && naerNok(sum(uten))) {
        return { noter: uten, gyldig: true, sum: slagPerTakt, rettet: 1, fjernet: 1 };
      }
    }

    return { noter: noter, gyldig: false, sum: sum(noter) };
  }

  // Varigheter vi runder av til, i slag.
  const VARIGHETER = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

  function naermeste(v) {
    let best = VARIGHETER[0], avvik = Infinity;
    for (const k of VARIGHETER) {
      const d = Math.abs(k - v);
      if (d < avvik) { avvik = d; best = k; }
    }
    return best;
  }

  /**
   * Gir notene rytme ut fra hvor de staar vannrett i takten.
   *
   * Dette er et bevisst valg. Aa lese varighet av bjelker, faner og
   * punkteringer er den vanskeligste delen av notegjenkjenning, og den
   * taaler daarlig en fotokopi. Men notesats plasserer noter omtrent
   * proporsjonalt med tida de varer — en halvnote faar dobbelt saa mye
   * plass som en firedel. Avstanden til neste note er derfor et godt
   * anslag, og den er robust. Hult notehode brukes som nedre grense,
   * siden en halv- eller helnote aldri varer under to slag.
   */
  function leggPaaRytme(noter, takter, slagPerTakt) {
    const ut = [];
    for (const takt of takter) {
      const i = noter.filter(function (n) { return n.x >= takt.x0 && n.x < takt.x1; });
      if (!i.length) continue;

      const rom = [];
      for (let k = 0; k < i.length; k++) {
        const slutt = k + 1 < i.length ? i[k + 1].x : takt.x1;
        rom.push(Math.max(1, slutt - i[k].x));
      }
      const sum = rom.reduce(function (a, c) { return a + c; }, 0);

      // Startpunktet regnes av de RAA andelene, som summerer til nettopp
      // én takt. Varigheten rundes av hver for seg. Summerer vi i stedet
      // opp de avrundede varighetene, vandrer notene ut av takten.
      let andel = 0;
      for (let k = 0; k < i.length; k++) {
        let v = naermeste(rom[k] / sum * slagPerTakt);
        if (!i[k].fylt && v < 2) v = 2;
        const slag = andel * slagPerTakt;
        ut.push({
          takt: takt.nummer,
          slag: Math.round(slag * 1000) / 1000,
          // La ingen note klinge forbi taktslutt.
          varighet: Math.round(Math.min(v, Math.max(0.25, slagPerTakt - slag)) * 1000) / 1000,
          midi: i[k].midi,
        });
        andel += rom[k] / sum;
      }
    }
    return ut;
  }

  const api = {
    finnFortegn: finnFortegn, lesStav: lesStav, leggPaaRytme: leggPaaRytme,
    finnHals: finnHals, tellBjelker: tellBjelker, harPunkt: harPunkt,
    byggTakt: byggTakt, finnPauser: finnPauser, klumper: klumper,
    noteVarighet: noteVarighet,
    fjernNotelinjer: fjernNotelinjer,
    finnNotehoder: finnNotehoder,
    finnNokkel: finnNokkel, nokkelMaal: nokkelMaal,
    tonehoyde: tonehoyde,
    fortegnTabell: fortegnTabell,
    integral: integral, sum: sum,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else rot.Notegjenkjenning = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
