/**
 * dokument.js — finner arket i et kamerabilde og retter det ut.
 *
 * Delt mellom nettleseren og Node, som `noteanalyse.js`: ingen DOM,
 * ingen sharp, bare Uint8Array inn og tall ut.
 *
 * Hvorfor kanter og ikke lysstyrke: et ark paa et lyst trebord er ikke
 * lysere enn underlaget, saa «finn det lyse omraadet» finner hele bildet.
 * Det som derimot alltid gjelder, er at arket har fire lange, rette
 * kanter med kontrast mot underlaget. Derfor: gradient -> Hough -> to
 * par linjer -> firkant -> perspektivretting.
 */
(function (rot) {
  'use strict';

  /** Nedskalering med ruteutjevning. Deteksjonen trenger ikke full skarphet. */
  function krymp(g, b, h, maalBredde) {
    if (b <= maalBredde) return { d: g, b: b, h: h, skala: 1 };
    const nb = maalBredde;
    const nh = Math.max(1, Math.round(h * nb / b));
    const ut = new Uint8Array(nb * nh);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.floor(y * h / nh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / nh));
      for (let x = 0; x < nb; x++) {
        const x0 = Math.floor(x * b / nb), x1 = Math.max(x0 + 1, Math.floor((x + 1) * b / nb));
        let sum = 0, n = 0;
        for (let yy = y0; yy < y1 && yy < h; yy++) {
          for (let xx = x0; xx < x1 && xx < b; xx++) { sum += g[yy * b + xx]; n++; }
        }
        ut[y * nb + x] = n ? sum / n : 0;
      }
    }
    return { d: ut, b: nb, h: nh, skala: b / nb };
  }

  /** Sobel. Gir styrke og retning per piksel. */
  function gradient(g, b, h) {
    const styrke = new Float32Array(b * h);
    const vinkel = new Float32Array(b * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < b - 1; x++) {
        const i = y * b + x;
        const gx =
          -g[i - b - 1] + g[i - b + 1] +
          -2 * g[i - 1] + 2 * g[i + 1] +
          -g[i + b - 1] + g[i + b + 1];
        const gy =
          -g[i - b - 1] - 2 * g[i - b] - g[i - b + 1] +
          g[i + b - 1] + 2 * g[i + b] + g[i + b + 1];
        styrke[i] = Math.sqrt(gx * gx + gy * gy);
        // Kantens egen retning staar normalt paa gradienten.
        vinkel[i] = Math.atan2(gy, gx);
      }
    }
    return { styrke: styrke, vinkel: vinkel };
  }

  /**
   * Hough-transform, men bare for piksler hvis egen gradientretning
   * passer med vinkelen de stemmer paa. Det skjerper toppene kraftig og
   * hindrer at tremoenster i underlaget bygger opp falske linjer.
   */
  function hough(grad, b, h, minStyrke) {
    const GRADER = 180;
    const diag = Math.ceil(Math.sqrt(b * b + h * h));
    const rhoAntall = diag * 2 + 1;
    const akk = new Float32Array(GRADER * rhoAntall);

    const cos = new Float32Array(GRADER), sin = new Float32Array(GRADER);
    for (let t = 0; t < GRADER; t++) {
      const r = (t * Math.PI) / GRADER;
      cos[t] = Math.cos(r); sin[t] = Math.sin(r);
    }

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < b - 1; x++) {
        const i = y * b + x;
        const s = grad.styrke[i];
        if (s < minStyrke) continue;
        // Gradientretning -> linjeretning i Hough (0..179)
        let t0 = Math.round(((grad.vinkel[i] * 180) / Math.PI + 180) % 180);
        for (let d = -8; d <= 8; d++) {
          const t = (t0 + d + GRADER) % GRADER;
          const rho = Math.round(x * cos[t] + y * sin[t]) + diag;
          if (rho >= 0 && rho < rhoAntall) akk[t * rhoAntall + rho] += s;
        }
      }
    }
    return { akk: akk, grader: GRADER, diag: diag, rhoAntall: rhoAntall, cos: cos, sin: sin };
  }

  /**
   * Henter arkets to kanter innenfor et vinkelbaand.
   *
   * Her er det avgjoerende valget: vi tar de to **ytterste** sterke
   * linjene, ikke de to sterkeste. Notelinjene paa arket er lange,
   * rette og kontrastrike — ofte sterkere i Hough enn selve arkkanten —
   * men de ligger alltid innenfor den. Velger vi etter styrke, finner vi
   * notesystemet; velger vi ytterst, finner vi arket.
   *
   * Posisjonen maales der linja krysser bildets midtakse, ikke paa rho.
   * For samme fysiske linje varierer rho med vinkelen, saa rho duger
   * ikke til aa sortere i rom.
   */
  function toppLinjer(H, senter, spenn, minAvstand, b, h, loddrett) {
    const funn = [];
    let maksV = 0;
    for (let dt = -spenn; dt <= spenn; dt++) {
      const t = (senter + dt + H.grader) % H.grader;
      for (let r = 1; r < H.rhoAntall - 1; r++) {
        const v = H.akk[t * H.rhoAntall + r];
        if (v <= 0) continue;
        if (v < H.akk[t * H.rhoAntall + r - 1] || v < H.akk[t * H.rhoAntall + r + 1]) continue;
        const rho = r - H.diag;
        // Hvor krysser linja midtaksen?
        const pos = loddrett
          ? (rho - (h / 2) * H.sin[t]) / (H.cos[t] || 1e-6)
          : (rho - (b / 2) * H.cos[t]) / (H.sin[t] || 1e-6);
        if (!isFinite(pos)) continue;
        funn.push({ t: t, rho: rho, v: v, pos: pos });
        if (v > maksV) maksV = v;
      }
    }
    if (!funn.length) return [];

    // Bare linjer som er kraftige nok til aa kunne vaere en arkkant.
    const sterke = funn.filter(function (f) { return f.v >= maksV * 0.3; });
    sterke.sort(function (a, c) { return a.pos - c.pos; });

    // Ytterst paa hver side, med krav om at de ligger langt nok fra
    // hverandre til aa kunne vaere to motstaaende kanter.
    for (let i = 0; i < sterke.length; i++) {
      for (let j = sterke.length - 1; j > i; j--) {
        if (sterke[j].pos - sterke[i].pos >= minAvstand) return [sterke[i], sterke[j]];
      }
    }
    return [];
  }

  /** Skjaeringspunkt mellom to linjer paa (theta, rho)-form. */
  function skjaering(l1, l2, H) {
    const c1 = H.cos[l1.t], s1 = H.sin[l1.t];
    const c2 = H.cos[l2.t], s2 = H.sin[l2.t];
    const det = c1 * s2 - c2 * s1;
    if (Math.abs(det) < 1e-6) return null;
    return [
      (l1.rho * s2 - l2.rho * s1) / det,
      (c1 * l2.rho - c2 * l1.rho) / det,
    ];
  }

  /** Sorterer fire punkter som topp-venstre, topp-hoeyre, bunn-hoeyre, bunn-venstre. */
  function ordne(p) {
    const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4;
    const cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
    const med = p.map(function (q) {
      return { q: q, v: Math.atan2(q[1] - cy, q[0] - cx) };
    });
    med.sort(function (a, c) { return a.v - c.v; });
    // Etter sortering ligger de med klokka fra ca. -180 grader. Start paa
    // den som er oeverst til venstre.
    let start = 0, best = Infinity;
    for (let i = 0; i < 4; i++) {
      const s = med[i].q[0] + med[i].q[1];
      if (s < best) { best = s; start = i; }
    }
    return [0, 1, 2, 3].map(function (i) { return med[(start + i) % 4].q; });
  }

  /** Er firkanten konveks? En gyldig arkkontur er alltid det. */
  function konveks(p) {
    let fortegn = 0;
    for (let i = 0; i < 4; i++) {
      const a = p[i], b2 = p[(i + 1) % 4], c = p[(i + 2) % 4];
      const kryss = (b2[0] - a[0]) * (c[1] - b2[1]) - (b2[1] - a[1]) * (c[0] - b2[0]);
      const s = Math.sign(kryss);
      if (!s) continue;
      if (!fortegn) fortegn = s;
      else if (s !== fortegn) return false;
    }
    return true;
  }

  function les(g, b, h, x, y) {
    const xi = Math.max(0, Math.min(b - 1, Math.round(x)));
    const yi = Math.max(0, Math.min(h - 1, Math.round(y)));
    return g[yi * b + xi];
  }

  /**
   * Gir en firkant en poengsum. Tre ting maa stemme samtidig, og det er
   * kombinasjonen som skiller arket fra en stripe i bordplata:
   *   kantstoette  ligger det faktisk kant langs alle fire sidene?
   *   kontrast     er innsida lysere enn utsida hele veien rundt?
   *   jevnhet      er innsida roligere enn utsida? Papir er glatt, tre ikke.
   */
  function poeng(p, g, grad, b, h, minStyrke) {
    const PROVER = 48;
    let stotte = 0, kontrast = 0, roligere = 0;

    for (let s = 0; s < 4; s++) {
      const a = p[s], c = p[(s + 1) % 4];
      const dx = c[0] - a[0], dy = c[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      // Normalen peker innover mot firkantens midtpunkt.
      let nx = -dy / len, ny = dx / len;
      const mx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4;
      const my = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
      if ((mx - a[0]) * nx + (my - a[1]) * ny < 0) { nx = -nx; ny = -ny; }

      let traff = 0, inn = 0, ut = 0, innVar = 0, utVar = 0, n = 0;
      for (let i = 1; i < PROVER; i++) {
        const t = i / PROVER;
        const x = a[0] + dx * t, y = a[1] + dy * t;
        if (x < 1 || y < 1 || x >= b - 1 || y >= h - 1) continue;
        n++;
        if (les(grad.styrke, b, h, x, y) >= minStyrke * 0.6) traff++;

        const i1 = les(g, b, h, x + nx * 5, y + ny * 5);
        const i2 = les(g, b, h, x + nx * 11, y + ny * 11);
        const u1 = les(g, b, h, x - nx * 8, y - ny * 8);
        const u2 = les(g, b, h, x - nx * 16, y - ny * 16);
        inn += (i1 + i2) / 2;
        ut += (u1 + u2) / 2;
        innVar += Math.abs(i1 - i2);
        utVar += Math.abs(u1 - u2);
      }
      if (!n) return -1;
      stotte += traff / n;
      kontrast += (inn - ut) / n;
      roligere += (utVar - innVar) / n;
    }

    stotte /= 4;
    kontrast /= 4;
    roligere /= 4;

    // Kantstoette er grunnkravet; de to andre justerer opp og ned.
    return stotte *
      (1 + Math.max(-0.6, Math.min(0.9, kontrast / 40))) *
      (1 + Math.max(-0.3, Math.min(0.5, roligere / 14)));
  }

  /** Otsu: terskelen som best deler histogrammet i to. */
  function otsu(g) {
    const hist = new Float64Array(256);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    const n = g.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, terskel = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mellom = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
      if (mellom > best) { best = mellom; terskel = t; }
    }
    return terskel;
  }

  /** Boksutjevning via integralbilde. */
  function jevnUt(g, b, h, r) {
    const bb = b + 1;
    const sum = new Float64Array(bb * (h + 1));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < b; x++) {
        sum[(y + 1) * bb + x + 1] =
          g[y * b + x] + sum[y * bb + x + 1] + sum[(y + 1) * bb + x] - sum[y * bb + x];
      }
    }
    const ut = new Uint8Array(b * h);
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - r), c = Math.min(h - 1, y + r);
      for (let x = 0; x < b; x++) {
        const e = Math.max(0, x - r), f = Math.min(b - 1, x + r);
        const n = (f - e + 1) * (c - a + 1);
        ut[y * b + x] =
          (sum[(c + 1) * bb + f + 1] - sum[(c + 1) * bb + e] -
           sum[a * bb + f + 1] + sum[a * bb + e]) / n;
      }
    }
    return ut;
  }

  /** Stoerste sammenhengende omraade av satte piksler. */
  function storsteFlate(maske, b, h) {
    const merke = new Int32Array(b * h).fill(-1);
    const ko = new Int32Array(b * h);
    let beste = null, besteStorrelse = 0, neste = 0;

    for (let start = 0; start < maske.length; start++) {
      if (!maske[start] || merke[start] !== -1) continue;
      const id = neste++;
      let hode = 0, hale = 0, antall = 0;
      ko[hale++] = start; merke[start] = id;
      const piksler = [];
      while (hode < hale) {
        const p = ko[hode++];
        antall++; piksler.push(p);
        const px = p % b, py = (p / b) | 0;
        if (px > 0 && maske[p - 1] && merke[p - 1] === -1) { merke[p - 1] = id; ko[hale++] = p - 1; }
        if (px < b - 1 && maske[p + 1] && merke[p + 1] === -1) { merke[p + 1] = id; ko[hale++] = p + 1; }
        if (py > 0 && maske[p - b] && merke[p - b] === -1) { merke[p - b] = id; ko[hale++] = p - b; }
        if (py < h - 1 && maske[p + b] && merke[p + b] === -1) { merke[p + b] = id; ko[hale++] = p + b; }
      }
      if (antall > besteStorrelse) { besteStorrelse = antall; beste = piksler; }
    }
    return beste;
  }

  /**
   * Finner arket som FLATE, ikke som linjer.
   *
   * Dette er kjernen i hele greia. Et ark har fire kanter, men det har
   * ogsaa noter paa seg, og notelinjene er lengre og rettere enn
   * arkkanten — en ren kantmetode finner notesystemet i stedet for arket.
   * Krymper vi derimot bildet kraftig (~260 px bredt), blir notelinjene
   * og treaaringa visket ut, mens arket blir staaende igjen som én stor,
   * lys, sammenhengende flate. Da er det bare aa ta de fire ytterpunktene.
   */
  function finnFlate(g, b, h, detBredde) {
    const liten = krymp(g, b, h, detBredde || 260);
    const jevn = jevnUt(liten.d, liten.b, liten.h, 2);
    const t = otsu(jevn);

    const maske = new Uint8Array(jevn.length);
    for (let i = 0; i < jevn.length; i++) maske[i] = jevn[i] > t ? 1 : 0;

    const flate = storsteFlate(maske, liten.b, liten.h);
    if (!flate) return null;
    const del = flate.length / (liten.b * liten.h);
    // For lite er ikke et ark; naer 100 % betyr at ingenting ble skilt ut.
    if (del < 0.10 || del > 0.97) return null;

    // Hjoernene langs de to diagonalretningene — men ROBUST.
    //
    // Ett enkelt ytterpunkt holdt ikke. Er flata bundet til en lys
    // flekk i bakgrunnen med en tynn bro — en lysstripe paa gulvet,
    // en kant av bordet — saa ligger det ÉN piksel langt utenfor
    // arket, og den ene piksel drar hjoernet med seg. Det var derfor
    // nedre hoeyre hjoerne stadig havnet utenfor papiret.
    //
    // I stedet brukes en persentil: vi tar den ytterste halve promillen
    // av punktene langs hver diagonal, og midtpunktet av DEM. En tynn
    // bro har for faa piksler til aa naa opp, mens et ekte hjoerne har
    // hele hjoernesonen bak seg.
    const hjorne = (vekt) => {
      const verdier = new Float64Array(flate.length);
      for (let i = 0; i < flate.length; i++) {
        const x = flate[i] % liten.b, y = (flate[i] / liten.b) | 0;
        verdier[i] = vekt(x, y);
      }
      const sortert = Float64Array.from(verdier).sort();
      const grense = sortert[Math.max(0, Math.floor(sortert.length * 0.9995) - 1)];
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < flate.length; i++) {
        if (verdier[i] < grense) continue;
        sx += flate[i] % liten.b; sy += (flate[i] / liten.b) | 0; n++;
      }
      return n ? [sx / n, sy / n] : null;
    };
    const tl = hjorne((x, y) => -(x + y));
    const br = hjorne((x, y) => x + y);
    const tr = hjorne((x, y) => x - y);
    const bl = hjorne((x, y) => y - x);
    if (!tl || !tr || !br || !bl) return null;
    const q = [tl, tr, br, bl];
    if (!konveks(q)) return null;
    if (Math.abs(polygonAreal(q)) < liten.b * liten.h * 0.08) return null;

    return q.map(function (p) { return [p[0] * liten.skala, p[1] * liten.skala]; });
  }

  /**
   * Kantbasert variant. Beholdt som reserve: den er skarpere naar den
   * foerst treffer, men lar seg lure av notelinjene.
   */
  function finnDokumentKanter(g, b, h, valg) {
    valg = valg || {};
    const liten = krymp(g, b, h, valg.detBredde || 480);
    const grad = gradient(liten.d, liten.b, liten.h);

    const kopi = Float32Array.from(grad.styrke);
    kopi.sort();
    const minStyrke = Math.max(24, kopi[Math.floor(kopi.length * 0.92)]);

    const H = hough(grad, liten.b, liten.h, minStyrke);
    const loddrett = linjeKandidater(H, 0, 28, liten.b * 0.05, liten.b, liten.h, true, 14);
    const vannrett = linjeKandidater(H, 90, 28, liten.h * 0.05, liten.b, liten.h, false, 14);
    if (loddrett.length < 2 || vannrett.length < 2) return null;

    const minAreal = liten.b * liten.h * 0.10;
    let beste = null, bestePoeng = 0;

    for (let a = 0; a < loddrett.length - 1; a++) {
      for (let c = a + 1; c < loddrett.length; c++) {
        if (loddrett[c].pos - loddrett[a].pos < liten.b * 0.3) continue;
        for (let d = 0; d < vannrett.length - 1; d++) {
          for (let e = d + 1; e < vannrett.length; e++) {
            if (vannrett[e].pos - vannrett[d].pos < liten.h * 0.3) continue;

            const hj = [];
            let ok = true;
            for (const v of [loddrett[a], loddrett[c]]) {
              for (const w of [vannrett[d], vannrett[e]]) {
                const pt = skjaering(v, w, H);
                if (!pt) { ok = false; break; }
                hj.push(pt);
              }
              if (!ok) break;
            }
            if (!ok) continue;

            const q = ordne(hj);
            if (!konveks(q)) continue;
            if (Math.abs(polygonAreal(q)) < minAreal) continue;
            let utenfor = false;
            for (const pt of q) {
              if (pt[0] < -liten.b * 0.06 || pt[0] > liten.b * 1.06 ||
                  pt[1] < -liten.h * 0.06 || pt[1] > liten.h * 1.06) { utenfor = true; break; }
            }
            if (utenfor) continue;

            const s = poeng(q, liten.d, grad, liten.b, liten.h, minStyrke);
            if (s > bestePoeng) { bestePoeng = s; beste = q; }
          }
        }
      }
    }

    if (!beste || bestePoeng < 0.35) return null;
    return beste.map(function (p) {
      return [p[0] * liten.skala, p[1] * liten.skala];
    });
  }

  /** De sterkeste linjene i et vinkelbaand, spredt i rom. */
  function linjeKandidater(H, senter, spenn, minAvstand, b, h, loddrett, antall) {
    const funn = [];
    for (let dt = -spenn; dt <= spenn; dt++) {
      const t = (senter + dt + H.grader) % H.grader;
      for (let r = 1; r < H.rhoAntall - 1; r++) {
        const v = H.akk[t * H.rhoAntall + r];
        if (v <= 0) continue;
        if (v < H.akk[t * H.rhoAntall + r - 1] || v < H.akk[t * H.rhoAntall + r + 1]) continue;
        const rho = r - H.diag;
        const pos = loddrett
          ? (rho - (h / 2) * H.sin[t]) / (H.cos[t] || 1e-6)
          : (rho - (b / 2) * H.cos[t]) / (H.sin[t] || 1e-6);
        if (!isFinite(pos)) continue;
        funn.push({ t: t, rho: rho, v: v, pos: pos });
      }
    }
    funn.sort(function (a, c) { return c.v - a.v; });

    const valgt = [];
    for (const f of funn) {
      if (valgt.length >= antall) break;
      let ok = true;
      for (const v of valgt) if (Math.abs(f.pos - v.pos) < minAvstand) { ok = false; break; }
      if (ok) valgt.push(f);
    }
    return valgt;
  }

  function polygonAreal(p) {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length];
      a += p[i][0] * q[1] - q[0] * p[i][1];
    }
    return a / 2;
  }

  /** Loeser et lineaert likningssystem med Gauss-eliminasjon. */
  function loes(A, b2) {
    const n = b2.length;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      if (Math.abs(A[p][i]) < 1e-12) return null;
      const tA = A[i]; A[i] = A[p]; A[p] = tA;
      const tb = b2[i]; b2[i] = b2[p]; b2[p] = tb;
      for (let r = 0; r < n; r++) {
        if (r === i) continue;
        const f = A[r][i] / A[i][i];
        if (!f) continue;
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b2[r] -= f * b2[i];
      }
    }
    const x = new Array(n);
    for (let i = 0; i < n; i++) x[i] = b2[i] / A[i][i];
    return x;
  }

  /**
   * Homografi som tar punkter i maalbildet over til kildebildet.
   * Den veien, fordi utrettinga henter farge per maalpiksel.
   */
  function homografi(fra, til) {
    const A = [], b2 = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = fra[i], [u, v] = til[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b2.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b2.push(v);
    }
    const l = loes(A, b2);
    if (!l) return null;
    return [l[0], l[1], l[2], l[3], l[4], l[5], l[6], l[7], 1];
  }

  /** Maalstoerrelse ut fra firkantens egne sidelengder. */
  function maalStorrelse(hjorner, maks) {
    const d = function (a, c) {
      return Math.hypot(hjorner[a][0] - hjorner[c][0], hjorner[a][1] - hjorner[c][1]);
    };
    let b = Math.max(d(0, 1), d(3, 2));
    let h = Math.max(d(0, 3), d(1, 2));
    const skala = Math.min(1, maks / Math.max(b, h));
    return { b: Math.max(8, Math.round(b * skala)), h: Math.max(8, Math.round(h * skala)) };
  }

  /** Retter ut firkanten til et rektangel, med bilineaer avlesing. */
  function rettUt(g, b, h, hjorner, utB, utH) {
    const H = homografi(
      [[0, 0], [utB - 1, 0], [utB - 1, utH - 1], [0, utH - 1]],
      hjorner,
    );
    if (!H) return null;
    const ut = new Uint8Array(utB * utH);
    for (let y = 0; y < utH; y++) {
      for (let x = 0; x < utB; x++) {
        const w = H[6] * x + H[7] * y + H[8];
        const sx = (H[0] * x + H[1] * y + H[2]) / w;
        const sy = (H[3] * x + H[4] * y + H[5]) / w;
        if (sx < 0 || sy < 0 || sx >= b - 1 || sy >= h - 1) { ut[y * utB + x] = 255; continue; }
        const x0 = sx | 0, y0 = sy | 0;
        const fx = sx - x0, fy = sy - y0;
        const i = y0 * b + x0;
        ut[y * utB + x] =
          g[i] * (1 - fx) * (1 - fy) + g[i + 1] * fx * (1 - fy) +
          g[i + b] * (1 - fx) * fy + g[i + b + 1] * fx * fy;
      }
    }
    return ut;
  }


  /**
   * Hovedinngang. Flatemetoden foerst, fordi den er den robuste; den
   * kantbaserte brukes bare naar flaten ikke lar seg skille ut (for
   * eksempel naar underlaget er like lyst som arket).
   */
  function finnDokument(g, b, h, valg) {
    return finnFlate(g, b, h, (valg || {}).flateBredde) ||
           finnDokumentKanter(g, b, h, valg);
  }

  const api = {
    krymp: krymp, gradient: gradient, finnDokument: finnDokument,
    finnFlate: finnFlate, finnDokumentKanter: finnDokumentKanter, otsu: otsu,
    homografi: homografi, rettUt: rettUt, maalStorrelse: maalStorrelse,
    polygonAreal: polygonAreal,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else rot.Dokument = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
