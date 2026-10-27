/* Notearkiv — skanning med mobilkamera.

   Gangen er: ta bilde -> finn arket -> bekreft rammen -> rett ut ->
   rens -> analyser struktur -> legg i stripa. Bekreftelsessteget er med
   fordi en feilbeskjaering ellers oppdages foerst naar sida er lagret.

   Opprenskinga er den samme som i Node-pipelinen: bakgrunnsdivisjon og
   nivaajustering i gratone. Hard terskling er med vilje unngaatt — den
   bryter opp notehoder og tekst. */
(function () {
  'use strict';

  var MAKS_SIDE = 2200;          // lengste kant paa lagret side
  var el = function (id) { return document.getElementById(id); };

  var sider = [];                // {blob, miniatyr, bredde, hoyde, struktur}
  var stroem = null;
  var bakkamera = true;
  var ramme = null;              // {g, b, h} frosset bilde under bekreftelse
  var hjorner = null;            // firkanten som bekreftes

  /* ───────────────────────────── kamera ────────────────────────────── */

  function startKamera() {
    if (stroem) stroem.getTracks().forEach(function (t) { t.stop(); });
    navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: bakkamera ? { ideal: 'environment' } : 'user',
        width: { ideal: 2560 },
        height: { ideal: 1920 },
      },
      audio: false,
    })
      .then(function (s) {
        stroem = s;
        el('video').srcObject = s;
        el('kamera-melding').hidden = true;
      })
      .catch(function (e) {
        el('kamera-melding').hidden = false;
        el('kamera-melding').textContent =
          'Fikk ikke tilgang til kameraet (' + e.name + '). ' +
          'Du kan bruke «Fra galleri» i stedet.';
      });
  }

  el('bytt-kamera').onclick = function () { bakkamera = !bakkamera; startKamera(); };

  /* ──────────────────────── bildebehandling ────────────────────────── */

  function graa(bilde) {
    var d = bilde.data, n = bilde.width * bilde.height;
    var g = new Uint8Array(n);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      g[i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000;
    }
    return g;
  }

  function krympTil(g, b, h, faktor) {
    var nb = Math.max(1, Math.round(b / faktor));
    var nh = Math.max(1, Math.round(h / faktor));
    var ut = new Float32Array(nb * nh);
    for (var y = 0; y < nh; y++) {
      var y0 = Math.floor(y * h / nh), y1 = Math.min(h, Math.floor((y + 1) * h / nh));
      for (var x = 0; x < nb; x++) {
        var x0 = Math.floor(x * b / nb), x1 = Math.min(b, Math.floor((x + 1) * b / nb));
        var sum = 0, n = 0;
        for (var yy = y0; yy < y1; yy++) {
          for (var xx = x0; xx < x1; xx++) { sum += g[yy * b + xx]; n++; }
        }
        ut[y * nb + x] = n ? sum / n : 255;
      }
    }
    return { d: ut, b: nb, h: nh };
  }

  function slor(bilde, radius) {
    var b = bilde.b, h = bilde.h, d = bilde.d, bb = b + 1;
    var sum = new Float64Array(bb * (h + 1));
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < b; x++) {
        sum[(y + 1) * bb + x + 1] =
          d[y * b + x] + sum[y * bb + x + 1] + sum[(y + 1) * bb + x] - sum[y * bb + x];
      }
    }
    var ut = new Float32Array(b * h);
    for (var yy = 0; yy < h; yy++) {
      var a = Math.max(0, yy - radius), c = Math.min(h - 1, yy + radius);
      for (var xx = 0; xx < b; xx++) {
        var e = Math.max(0, xx - radius), f = Math.min(b - 1, xx + radius);
        var n = (f - e + 1) * (c - a + 1);
        ut[yy * b + xx] =
          (sum[(c + 1) * bb + f + 1] - sum[(c + 1) * bb + e] -
           sum[a * bb + f + 1] + sum[a * bb + e]) / n;
      }
    }
    return { d: ut, b: b, h: h };
  }

  /**
   * Bakgrunnsdivisjon: papiret jevnes ut, blekket staar igjen.
   * Bakgrunnen regnes paa en liten kopi og hentes opp igjen bilineaert —
   * den er lavfrekvent, saa det koster ingenting i kvalitet og gjoer at
   * det gaar raskt nok paa en telefon.
   */
  function flatfelt(g, b, h) {
    var liten = krympTil(g, b, h, Math.max(1, Math.round(b / 160)));
    var bg = slor(liten, Math.max(2, Math.round(liten.b / 10)));
    var ut = new Uint8Array(b * h);
    for (var y = 0; y < h; y++) {
      var sy = (y / h) * (bg.h - 1);
      var y0 = Math.floor(sy), fy = sy - y0, y1 = Math.min(bg.h - 1, y0 + 1);
      for (var x = 0; x < b; x++) {
        var sx = (x / b) * (bg.b - 1);
        var x0 = Math.floor(sx), fx = sx - x0, x1 = Math.min(bg.b - 1, x0 + 1);
        var v =
          bg.d[y0 * bg.b + x0] * (1 - fx) * (1 - fy) +
          bg.d[y0 * bg.b + x1] * fx * (1 - fy) +
          bg.d[y1 * bg.b + x0] * (1 - fx) * fy +
          bg.d[y1 * bg.b + x1] * fx * fy;
        var r = (g[y * b + x] / Math.max(1, v)) * 255;
        ut[y * b + x] = r > 255 ? 255 : r;
      }
    }
    return ut;
  }

  /** Setter papiret til hvitt og blekket til sort, med myk overgang. */
  function nivaa(g) {
    var hist = new Float64Array(256), i, v;
    for (i = 0; i < g.length; i++) hist[g[i]]++;
    var papir = 200, best = -1;
    for (v = 128; v < 256; v++) if (hist[v] > best) { best = hist[v]; papir = v; }
    var sum = 0, blekk = 0;
    for (v = 0; v < 256; v++) { sum += hist[v]; if (sum >= g.length * 0.004) { blekk = v; break; } }
    var svart = Math.min(papir - 30, blekk + 16);
    var spenn = Math.max(1, Math.max(papir - 10, 140) - svart);
    for (i = 0; i < g.length; i++) {
      var r = ((g[i] - svart) / spenn) * 255;
      g[i] = r > 255 ? 255 : r < 0 ? 0 : r;
    }
    return g;
  }

  /* ─────────────────────── frys bilde og bekreft ───────────────────── */

  /** Henter gratone i full opploesning fra en video eller et bilde. */
  function frys(kilde, bredde, hoyde) {
    var lerret = el('arbeid');
    lerret.width = bredde; lerret.height = hoyde;
    var ctx = lerret.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(kilde, 0, 0, bredde, hoyde);
    return { g: graa(ctx.getImageData(0, 0, bredde, hoyde)), b: bredde, h: hoyde };
  }

  function visBekreft() {
    el('kamera-skjerm').hidden = true;
    el('bekreft-skjerm').hidden = false;

    // Vis det frosne bildet i håndterlig størrelse.
    var vis = el('bekreft-lerret');
    var maks = 1400;
    var skala = Math.min(1, maks / Math.max(ramme.b, ramme.h));
    vis.width = Math.round(ramme.b * skala);
    vis.height = Math.round(ramme.h * skala);
    vis.getContext('2d').drawImage(el('arbeid'), 0, 0, vis.width, vis.height);

    var svg = el('bekreft-svg');
    svg.setAttribute('viewBox', '0 0 ' + ramme.b + ' ' + ramme.h);
    tegnRamme();
  }

  function tegnRamme() {
    var svg = el('bekreft-svg');
    var ns = 'http://www.w3.org/2000/svg';
    svg.innerHTML = '';
    var r = Math.max(14, ramme.b * 0.018);

    var poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', hjorner.map(function (p) { return p[0] + ',' + p[1]; }).join(' '));
    poly.setAttribute('class', 'bekreft-ramme');
    svg.appendChild(poly);

    hjorner.forEach(function (p, i) {
      var c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', p[0]); c.setAttribute('cy', p[1]);
      c.setAttribute('r', r);
      c.setAttribute('class', 'bekreft-hjorne');
      c.dataset.i = i;
      svg.appendChild(c);
    });
  }

  (function dragHjorne() {
    var svg = el('bekreft-svg');
    var aktiv = -1;

    function tilBilde(e) {
      var r = svg.getBoundingClientRect();
      return [
        (e.clientX - r.left) / r.width * ramme.b,
        (e.clientY - r.top) / r.height * ramme.h,
      ];
    }

    svg.addEventListener('pointerdown', function (e) {
      if (!hjorner) return;
      var p = tilBilde(e);
      var naermest = -1, best = Infinity;
      hjorner.forEach(function (q, i) {
        var d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < best) { best = d; naermest = i; }
      });
      if (best > ramme.b * 0.12) return;
      aktiv = naermest;
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    svg.addEventListener('pointermove', function (e) {
      if (aktiv < 0) return;
      var p = tilBilde(e);
      hjorner[aktiv] = [
        Math.max(0, Math.min(ramme.b - 1, p[0])),
        Math.max(0, Math.min(ramme.h - 1, p[1])),
      ];
      tegnRamme();
      e.preventDefault();
    });

    function slipp(e) {
      if (aktiv < 0) return;
      aktiv = -1;
      try { svg.releasePointerCapture(e.pointerId); } catch (x) { /* ikke fanget */ }
    }
    svg.addEventListener('pointerup', slipp);
    svg.addEventListener('pointercancel', slipp);
  })();

  /** Tar bilde, finner arket og gaar til bekreftelse. */
  function fangst(kilde, bredde, hoyde) {
    ramme = frys(kilde, bredde, hoyde);
    var funnet = null;
    try {
      funnet = window.Dokument.finnDokument(ramme.g, ramme.b, ramme.h);
    } catch (e) { funnet = null; }

    if (funnet) {
      hjorner = funnet;
      el('bekreft-melding').textContent = 'Fant arket';
      el('bekreft-melding').className = 'bekreft-melding ok';
    } else {
      // Ingen ramme funnet: foresla hele bildet, og si fra.
      var m = Math.round(Math.min(ramme.b, ramme.h) * 0.04);
      hjorner = [
        [m, m], [ramme.b - 1 - m, m],
        [ramme.b - 1 - m, ramme.h - 1 - m], [m, ramme.h - 1 - m],
      ];
      el('bekreft-melding').textContent = 'Fant ikke arket — dra hjørnene på plass';
      el('bekreft-melding').className = 'bekreft-melding feil';
    }
    visBekreft();
  }

  /** Retter ut, renser, analyserer og legger sida i stripa. */
  function bruk(utenUtretting) {
    var lerret = el('arbeid');
    var ctx = lerret.getContext('2d', { willReadFrequently: true });
    var g, b, h;

    if (utenUtretting) {
      var skala = Math.min(1, MAKS_SIDE / Math.max(ramme.b, ramme.h));
      b = Math.round(ramme.b * skala); h = Math.round(ramme.h * skala);
      var tmp = document.createElement('canvas');
      tmp.width = b; tmp.height = h;
      tmp.getContext('2d').drawImage(lerret, 0, 0, b, h);
      g = graa(tmp.getContext('2d').getImageData(0, 0, b, h));
    } else {
      var mal = window.Dokument.maalStorrelse(hjorner, MAKS_SIDE);
      b = mal.b; h = mal.h;
      g = window.Dokument.rettUt(ramme.g, ramme.b, ramme.h, hjorner, b, h);
      if (!g) { g = ramme.g; b = ramme.b; h = ramme.h; }
    }

    g = nivaa(flatfelt(g, b, h));

    // Strukturanalysen kjoerer her, mens gratonebildet fortsatt ligger i
    // minnet — samme algoritme som Node-pipelinen, fra den delte fila.
    var struktur = null;
    try {
      struktur = window.Noteanalyse.tilJson(
        window.Noteanalyse.analyser(window.Noteanalyse.terskle(g, 150), b, h), b, h);
    } catch (e) { struktur = null; }

    lerret.width = b; lerret.height = h;
    var bilde = ctx.createImageData(b, h);
    for (var i = 0, p = 0; i < g.length; i++, p += 4) {
      bilde.data[p] = bilde.data[p + 1] = bilde.data[p + 2] = g[i];
      bilde.data[p + 3] = 255;
    }
    ctx.putImageData(bilde, 0, 0);

    lerret.toBlob(function (blob) {
      sider.push({
        blob: blob,
        miniatyr: lerret.toDataURL('image/jpeg', 0.5),
        bredde: b, hoyde: h, struktur: struktur,
      });
      tegnStripe();
      ramme = null; hjorner = null;
      el('bekreft-skjerm').hidden = true;
      el('kamera-skjerm').hidden = false;
    }, 'image/jpeg', 0.88);
  }

  el('bruk-utsnitt').onclick = function () { bruk(false); };
  el('hele-bildet').onclick = function () { bruk(true); };
  el('ta-om-igjen').onclick = function () {
    ramme = null; hjorner = null;
    el('bekreft-skjerm').hidden = true;
    el('kamera-skjerm').hidden = false;
  };

  /* ───────────────────────────── sider ─────────────────────────────── */

  function tegnStripe() {
    var s = el('stripe');
    s.innerHTML = '';
    sider.forEach(function (side, i) {
      var d = document.createElement('div');
      d.className = 'mini';
      var img = document.createElement('img');
      img.src = side.miniatyr;
      img.alt = 'Side ' + (i + 1);
      var nr = document.createElement('span');
      nr.className = 'mini-nr';
      // Taktantallet er tilbakemelding paa at analysen traff. Null takter
      // betyr at sida blir lagret, men uten overlay.
      var takter = side.struktur && side.struktur.antallTakter;
      nr.textContent = takter ? (i + 1) + ' · ' + takter + ' t' : (i + 1);
      if (!takter) nr.className += ' mini-nr-tom';
      var slett = document.createElement('button');
      slett.className = 'mini-slett';
      slett.textContent = '✕';
      slett.title = 'Fjern siden';
      slett.onclick = function () { sider.splice(i, 1); tegnStripe(); };
      d.appendChild(img); d.appendChild(nr); d.appendChild(slett);
      s.appendChild(d);
    });
    s.scrollLeft = s.scrollWidth;
    el('lagre').disabled = sider.length === 0;
    el('lagre').textContent = sider.length
      ? 'Lagre ' + sider.length + (sider.length === 1 ? ' side' : ' sider')
      : 'Lagre';
  }

  el('utloser').onclick = function () {
    var v = el('video');
    if (!v.videoWidth) return;
    fangst(v, v.videoWidth, v.videoHeight);
  };

  el('fra-fil').onchange = function () {
    var filer = Array.prototype.slice.call(this.files || []);
    this.value = '';
    if (!filer.length) return;
    // Én om gangen: hver side skal bekreftes for seg.
    var bilde = new Image();
    bilde.onload = function () {
      fangst(bilde, bilde.naturalWidth, bilde.naturalHeight);
      URL.revokeObjectURL(bilde.src);
    };
    bilde.src = URL.createObjectURL(filer[0]);
    if (filer.length > 1) {
      el('bekreft-melding').textContent = 'Tar én og én — velg de neste etterpå';
    }
  };

  /* ───────────────────────────── lagring ───────────────────────────── */

  function framdrift(tekst, andel) {
    el('framdrift').hidden = false;
    el('framdrift-tekst').textContent = tekst;
    el('stolpe-fyll').style.width = Math.round(andel * 100) + '%';
  }

  function lagPdf() {
    var jsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDF) return Promise.resolve(null);
    var dok = null;
    return sider.reduce(function (kjede, side) {
      return kjede.then(function () {
        return new Promise(function (ok) {
          var leser = new FileReader();
          leser.onload = function () {
            // Hver side faar sitt eget papirformat, saa ingenting strekkes.
            var mm = [side.bredde, side.hoyde].map(function (p) { return p * 25.4 / 200; });
            var retning = side.bredde > side.hoyde ? 'l' : 'p';
            if (!dok) dok = new jsPDF({ orientation: retning, unit: 'mm', format: mm });
            else dok.addPage(mm, retning);
            dok.addImage(leser.result, 'JPEG', 0, 0, mm[0], mm[1]);
            ok();
          };
          leser.readAsDataURL(side.blob);
        });
      });
    }, Promise.resolve()).then(function () {
      return dok ? dok.output('blob') : null;
    });
  }

  /**
   * Hvor mange notelinjer har det fulleste systemet?
   *
   * Strukturanalysen har alt talt stavene paa hver side. Det fulleste
   * systemet er det som viser hele satsen — et system kan mangle en
   * stav der en stemme hviler, men ingen har FLERE enn satsen har.
   */
  function antallLinjer() {
    var flest = 0;
    sider.forEach(function (si) {
      var st = si.struktur;
      if (!st || !st.systemer) return;
      st.systemer.forEach(function (sy) {
        var n = (sy.staver || []).length;
        if (n > flest) flest = n;
      });
    });
    return flest;
  }

  var NAVNEVALG = [
    '1. tenor', '2. tenor', 'tenor', 'baryton',
    '1. bass', '2. bass', 'bass',
    '1. sopran', '2. sopran', 'sopran', '1. alt', '2. alt', 'alt',
    'klaver h', 'klaver v', 'melodi', '(hopp over)',
  ];

  // Et vanlig utgangspunkt etter hvor mange linjer satsen har. En
  // kvalifisert gjetning som du retter paa — ikke noe som er lest.
  var FORSLAG = {
    1: ['melodi'],
    2: ['tenor', 'bass'],
    3: ['tenor', 'baryton', 'bass'],
    4: ['1. tenor', '2. tenor', '1. bass', '2. bass'],
    5: ['1. tenor', '2. tenor', '1. bass', '2. bass', 'klaver h'],
    6: ['1. tenor', '2. tenor', '1. bass', '2. bass', 'klaver h', 'klaver v'],
  };

  // Linjene slik de staar naa. Starter som det analysen fant, men du
  // kan rette det: deteksjonen bommer paa en svak stav fra tid til
  // annen, og da er det raskere aa legge til en linje enn aa skanne
  // sida paa nytt.
  var linjer = [];

  function tegnStemmerader() {
    var liste = el('stemme-liste');
    liste.innerHTML = '';
    linjer.forEach(function (navn, i) {
      var rad = document.createElement('div');
      rad.className = 'stemme-rad';

      var merke = document.createElement('span');
      merke.className = 'stemme-nr';
      merke.textContent = (i + 1) + '. linje';

      var velg = document.createElement('select');
      velg.className = 'velg';
      NAVNEVALG.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v; o.textContent = v;
        velg.appendChild(o);
      });
      velg.value = navn;
      velg.onchange = function () { linjer[i] = this.value; };

      var vekk = document.createElement('button');
      vekk.className = 'stemme-vekk';
      vekk.type = 'button';
      vekk.textContent = '−';
      vekk.title = 'Fjern linja';
      vekk.onclick = function () { linjer.splice(i, 1); tegnStemmerader(); };

      rad.appendChild(merke);
      rad.appendChild(velg);
      rad.appendChild(vekk);
      liste.appendChild(rad);
    });
    el('stemme-antall').textContent = linjer.length;
  }

  function visStemmesteg() {
    var funnet = antallLinjer();
    var n = funnet || 4;
    var forslag = FORSLAG[n] || FORSLAG[4];
    linjer = [];
    for (var i = 0; i < n; i++) linjer.push(forslag[i] || 'klaver h');

    el('stemme-hjelp').textContent = funnet
      ? 'Jeg fant ' + funnet + ' linjer i hvert system. Stemmer det? Rett om nødvendig.'
      : 'Jeg klarte ikke telle linjene. Sett dem opp selv, ovenfra og ned.';
    tegnStemmerader();
    var vis = el('stemme-tittel');
    if (vis) vis.textContent = el('tittel').value.trim();
    el('kamera-skjerm').hidden = true;
    el('stemme-skjerm').hidden = false;
  }

  el('stemme-legg-til').onclick = function () {
    linjer.push(linjer.length >= 4 ? 'klaver h' : 'bass');
    tegnStemmerader();
  };

  function valgteStemmer() {
    return linjer.filter(function (v) { return v !== '(hopp over)'; });
  }

  el('stemme-tilbake').onclick = function () {
    el('stemme-skjerm').hidden = true;
    el('kamera-skjerm').hidden = false;
  };
  el('stemme-ferdig').onclick = function () { lagreAlt(); };

  el('lagre').onclick = function () {
    if (!sider.length) return;
    // Tittelen maa paa plass mens feltet fortsatt er synlig. Sjekkes
    // den foerst inne i lagringa, staar brukeren paa stemmesteget og
    // trykker paa en knapp som ikke gjoer noe — feltet som mangler er
    // da gjemt bak.
    var tittel = el('tittel').value.trim();
    if (!tittel) {
      el('tittel').classList.add('mangler');
      el('tittel').focus();
      return;
    }
    el('tittel').classList.remove('mangler');
    visStemmesteg();
  };

  function lagreAlt() {
    var tittel = el('tittel').value.trim();
    if (!tittel) {
      el('stemme-skjerm').hidden = true;
      el('kamera-skjerm').hidden = false;
      el('tittel').classList.add('mangler');
      el('tittel').focus();
      return;
    }
    el('tittel').classList.remove('mangler');
    el('lagre').disabled = true;

    var id = null;
    framdrift('Starter…', 0.02);

    fetch('/api/skann/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tittel: tittel }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.feil) throw new Error(d.feil);
        id = d.id;
        return sider.reduce(function (kjede, side, i) {
          return kjede.then(function () {
            framdrift('Laster opp side ' + (i + 1) + ' av ' + sider.length,
                      0.05 + 0.7 * (i / sider.length));
            return fetch('/api/skann/' + id + '/side/' + (i + 1), {
              method: 'POST',
              headers: { 'content-type': 'image/jpeg' },
              body: side.blob,
            }).then(function (r) {
              // fetch avviser bare paa nettverksfeil. Uten denne
              // sjekken gaar en side som svarte 500 videre som om den
              // laa trygt oppe, og stykket blir lagret med et hull.
              if (!r.ok) throw new Error('Side ' + (i + 1) + ' ble ikke lagret (' + r.status + ')');
            });
          });
        }, Promise.resolve());
      })
      .then(function () {
        framdrift('Lager PDF…', 0.8);
        return lagPdf();
      })
      .then(function (pdf) {
        if (!pdf) return false;
        framdrift('Laster opp PDF…', 0.9);
        return fetch('/api/skann/' + id + '/pdf', {
          method: 'POST',
          headers: { 'content-type': 'application/pdf' },
          body: pdf,
        }).then(function (r) { return r.ok; });
      })
      .then(function (harPdf) {
        framdrift('Fullfører…', 0.97);
        return fetch('/api/skann/' + id + '/ferdig', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tittel: tittel,
            antallSider: sider.length,
            harPdf: harPdf,
            // Strukturen er regnet ut ved opptak; her sendes den bare med.
            sider: sider.map(function (s) {
              return s.struktur || { bredde: s.bredde, hoyde: s.hoyde };
            }),
            // Svaret ditt paa hvilken stemme hver linje er.
            stemmer: valgteStemmer(),
          }),
        });
      })
      .then(function (r) { return r.json(); })
      .then(function () {
        // SIDENE ER LAGRET — men et notesett uten toner er bare bilder.
        //
        // Lesinga skjer paa serveren og tar et par minutter: to lesere
        // over hver side, den ene for tonene og den andre for teksten.
        // Uten dette kallet blir stykket staaende merket «venter», og
        // skanninga foeles like daarlig som foer den fantes.
        framdrift('Leser notene… dette tar et par minutter', 0.98);
        el('framdrift-tittel').textContent = 'Leser notene';
        return fetch('/api/gjenkjenn', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: id }),
        }).then(function (r) { return r.json().catch(function () { return {}; }); });
      })
      .then(function (res) {
        framdrift('Ferdig', 1);
        if (res && res.ok) {
          el('framdrift-tittel').textContent =
            res.takter + ' takter, ' + (res.stemmer || []).length + ' stemmer';
        } else {
          // Sidene ER lagret. Lesinga kan proeves igjen fra stykket.
          el('framdrift-tittel').textContent = 'Lagret, men notene ble ikke lest';
          el('framdrift-tekst').textContent =
            'Du kan prøve lesinga igjen fra stykket i arkivet.';
        }
        setTimeout(function () { location.href = './'; }, res && res.ok ? 1200 : 2600);
      })
      .catch(function (e) {
        el('framdrift-tittel').textContent = 'Det gikk galt';
        el('framdrift-tekst').textContent = e.message + '. Sidene ligger fortsatt her — prøv igjen.';
        el('lagre').disabled = false;
      });
  };

  startKamera();
})();
