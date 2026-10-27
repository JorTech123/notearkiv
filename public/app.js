/* Notearkiv — visning og avspilling.
   Klassiske script-tagger, ingen byggesteg: fila kan aapnes rett fra
   disk og virker uendret paa server. */
(function () {
  'use strict';

  // Data kan vaere lagt rett inn i sida (demo) eller hentes som JSON.
  var BILDEROT = window.BILDEROT || './';
  var arkiv = null;

  var el = function (id) { return document.getElementById(id); };
  var S = {
    stykke: null, side: 0, stemme: 0,
    spiller: false, takt: 0, tempo: 80,
    overlay: true, hudTimer: null, oving: false, partitur: null,
    visning: 'noter',   // 'noter' = de nye notene, 'original' = skanningen
    visKlaver: false,   // klaveret hoeres alltid, men vises paa forespoersel
    valgte: null,   // null = alle stemmer hoeres; ellers en liste med navn
    klang: 'kor',   // 'kor' = hele koret synger teksten, 'piano' = din stemme
  };

  /* ──────────────────────────────── data ───────────────────────────── */

  function last() {
    if (window.ARKIV) { klar(window.ARKIV); return; }
    fetch(BILDEROT + 'arkiv.json')
      .then(function (r) { return r.json(); })
      .then(klar)
      .catch(function () {
        el('laster').textContent = 'Fant ikke arkiv.json. Kjor tools/src/cli.js forst.';
      });
  }

  function klar(data) {
    arkiv = data;
    el('laster').classList.add('ferdig');
    byggFiltre();
    tegnListe('');
  }

  /**
   * Alle takter i et stykke, flatet ut.
   *
   * Taktnummeret som brukes er LOEPENDE gjennom hele stykket, ikke det
   * sida selv oppgir. Hver side teller fra 1, saa uten dette ville
   * noter fra side 1 takt 3 ogsaa klinge paa side 2 takt 3.
   */
  function alleTakter(stykke) {
    var ut = [];
    stykke.sider.forEach(function (side, si) {
      side.systemer.forEach(function (sys, yi) {
        (sys.takter || []).forEach(function (t) {
          // nr kommer fra dataene, ikke fra tellinga her. Bygginga av
          // overlayet har alt passet paa at dette er samme taktnummer
          // som notene bruker.
          ut.push({ side: si, system: yi, nr: t.nummer, x0: t.x0, x1: t.x1,
                    yTopp: sys.yTopp, yBunn: sys.yBunn });
        });
      });
    });
    return ut;
  }

  /** Takten med dette nummeret, eller den naermeste som finnes. */
  function taktMedNr(takter, nr) {
    for (var i = 0; i < takter.length; i++) if (takter[i].nr === nr) return takter[i];
    return takter[Math.max(0, Math.min(takter.length - 1, nr - 1))] || null;
  }

  /* ─────────────────────────────── bibliotek ───────────────────────── */

  var aktivtFilter = null;

  function byggFiltre() {
    var alle = {};
    arkiv.stykker.forEach(function (s) {
      (s.stemmer || []).forEach(function (v) { alle[v] = (alle[v] || 0) + 1; });
    });
    var boks = el('filtre');
    boks.innerHTML = '';
    Object.keys(alle).sort().forEach(function (navn) {
      var b = document.createElement('button');
      b.className = 'brikke';
      b.textContent = navn;
      b.onclick = function () {
        aktivtFilter = aktivtFilter === navn ? null : navn;
        Array.prototype.forEach.call(boks.children, function (c) {
          c.classList.toggle('paa', c.textContent === aktivtFilter);
        });
        tegnListe(el('sok').value);
      };
      boks.appendChild(b);
    });
  }

  /** Har stykket sangtekst noe sted i det hele tatt? */
  function harSangtekst(stykke) {
    var noter = stykke.noter || {};
    for (var navn in noter) {
      var liste = noter[navn] || [];
      for (var i = 0; i < liste.length; i++) if (liste[i].tekst) return true;
    }
    return false;
  }

  /**
   * Linja som sier fra naar et stykke staar uten sangtekst.
   *
   * Uten den ser et stykke uten ord ut som en feil i appen, og man vet
   * ikke om det er noe som mangler eller noe som gikk galt. Grunnen
   * ligger i katalogen, skrevet om til vanlig spraak av Worker-en.
   */
  function tekstmerknad(stykke) {
    if (stykke.venter) return null;             // tonene er ikke lest ennaa
    if (!stykke.noter || !Object.keys(stykke.noter).length) return null;
    if (harSangtekst(stykke)) return null;
    var mangler = ((stykke.tekst || {}).mangler || [])[0];
    return mangler && mangler.hvorfor
      ? 'uten sangtekst — ' + mangler.hvorfor
      : 'uten sangtekst';
  }

  function tegnListe(sok) {
    var q = (sok || '').toLowerCase().trim();
    var liste = el('liste');
    liste.innerHTML = '';
    var treff = arkiv.stykker.filter(function (s) {
      if (aktivtFilter && (s.stemmer || []).indexOf(aktivtFilter) < 0) return false;
      if (!q) return true;
      return (s.tittel + ' ' + (s.toneart || '') + ' ' + (s.stemmer || []).join(' '))
        .toLowerCase().indexOf(q) >= 0;
    });

    treff.forEach(function (s) {
      var k = document.createElement('div');
      k.className = 'kort';
      k.tabIndex = 0;

      var h = document.createElement('h2');
      h.textContent = s.tittel;
      k.appendChild(h);

      var m = document.createElement('div');
      m.className = 'meta';
      m.textContent = s.antallSider + (s.antallSider === 1 ? ' side' : ' sider') +
        ' · ' + s.antallTakter + ' takter';
      k.appendChild(m);

      var merker = document.createElement('div');
      merker.className = 'merker';
      if (s.toneart) {
        var tm = document.createElement('span');
        tm.className = 'merke toneart';
        tm.textContent = s.toneart;
        merker.appendChild(tm);
      }
      (s.stemmer || []).forEach(function (v) {
        var sm = document.createElement('span');
        sm.className = 'merke';
        sm.textContent = v;
        merker.appendChild(sm);
      });
      k.appendChild(merker);

      k.onclick = function () { aapne(s); };
      k.onkeydown = function (e) { if (e.key === 'Enter') aapne(s); };
      liste.appendChild(k);
    });

    el('tomt').hidden = treff.length > 0;
  }

  /* ──────────────────────────────── leser ──────────────────────────── */

  function aapne(stykke) {
    S.stykke = stykke;
    S.side = 0;
    S.takt = 0;
    S.stemme = 0;
    stopp();

    el('bibliotek').classList.remove('vis');
    el('leser').classList.add('vis');
    el('leser-tittel').textContent = stykke.tittel;

    var valg = el('stemmevalg');
    valg.innerHTML = '';
    (stykke.stemmer || []).forEach(function (v, i) {
      var o = document.createElement('option');
      o.value = i;
      // Si med én gang om stemmen kan spilles, eller om det bare blir
      // taktslag. Ellers trykker man «Spill» og lurer paa hvorfor det
      // ikke kommer toner.
      var antall = ((stykke.noter || {})[v] || []).length;
      o.textContent = antall ? v + ' · ' + antall + ' noter' : v + ' · bare taktslag';
      valg.appendChild(o);
    });
    if (stykke.venter) {
      el('partiturspor').innerHTML = '';
      el('partiturnokkel').hidden = true;
    }
    el('leser-under').textContent =
      [stykke.toneart, stykke.antallSider + ' sider', stykke.antallTakter + ' takter',
       stykke.venter ? 'tonene er ikke lest ennå' : null,
       tekstmerknad(stykke)]
        .filter(Boolean).join(' · ');

    tegnSider();
    visSide(0, true);
    oppdaterLastNed();
    byggStemmebrikker();
    byggPartitur();
    visHud();
  }

  function bildeKilde(side) {
    return side.bilde || (BILDEROT + side.fil);
  }

  function tegnSider() {
    var spor = el('spor');
    spor.innerHTML = '';
    var loepende = 0;
    S.stykke.sider.forEach(function (side) {
      var d = document.createElement('div');
      d.className = 'side';

      var innhold = document.createElement('div');
      innhold.className = 'side-innhold';

      var img = document.createElement('img');
      img.src = bildeKilde(side);
      img.alt = S.stykke.tittel + ', side ' + side.nr;
      img.draggable = false;
      innhold.appendChild(img);
      side.systemer.forEach(function (sy) { loepende += (sy.takter || []).length; });

      d.appendChild(innhold);
      spor.appendChild(d);
    });
  }


  function visSide(i, straks) {
    var n = S.stykke.sider.length;
    S.side = Math.max(0, Math.min(n - 1, i));
    var spor = el('spor');
    if (straks) spor.classList.add('drar');
    spor.style.transform = 'translateX(' + (-S.side * 100) + '%)';
    if (straks) requestAnimationFrame(function () { spor.classList.remove('drar'); });
    el('sidetall').textContent = 'Side ' + (S.side + 1) + ' / ' + n;
  }


  /* ───────────────────────────── sveip og bla ──────────────────────── */

  (function sveip() {
    var scene = el('scene'), spor = el('spor');
    var x0 = 0, y0 = 0, dx = 0, drar = false, laast = null, t0 = 0;

    scene.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      drar = true; laast = null; dx = 0;
      x0 = e.clientX; y0 = e.clientY; t0 = Date.now();
      spor.classList.add('drar');
    });

    scene.addEventListener('pointermove', function (e) {
      if (!drar) return;
      var ex = e.clientX - x0, ey = e.clientY - y0;
      if (laast === null && (Math.abs(ex) > 8 || Math.abs(ey) > 8)) {
        laast = Math.abs(ex) > Math.abs(ey) ? 'x' : 'y';
      }
      if (laast !== 'x') return;
      e.preventDefault();
      dx = ex;
      // Demping i endene saa det kjennes at det ikke er flere sider.
      var n = S.stykke.sider.length;
      if ((S.side === 0 && dx > 0) || (S.side === n - 1 && dx < 0)) dx *= .3;
      spor.style.transform =
        'translateX(calc(' + (-S.side * 100) + '% + ' + dx + 'px))';
    });

    function slipp() {
      if (!drar) return;
      drar = false;
      spor.classList.remove('drar');
      var fart = Math.abs(dx) / Math.max(1, Date.now() - t0);
      var terskel = scene.clientWidth * 0.22;
      if (laast === 'x' && (Math.abs(dx) > terskel || fart > 0.5)) {
        visSide(S.side + (dx < 0 ? 1 : -1));
      } else {
        visSide(S.side);
      }
      dx = 0;
    }
    scene.addEventListener('pointerup', slipp);
    scene.addEventListener('pointercancel', slipp);
    scene.addEventListener('pointerleave', slipp);
  })();

  el('forrige').onclick = function () { visSide(S.side - 1); visHud(); };
  el('neste').onclick = function () { visSide(S.side + 1); visHud(); };

  document.addEventListener('keydown', function (e) {
    if (!el('leser').classList.contains('vis')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') visSide(S.side + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') visSide(S.side - 1);
    else if (e.key === 'Escape') tilbake();
    else if (e.key === ' ') { e.preventDefault(); S.spiller ? stopp() : start(); }
    visHud();
  });

  /* ──────────────────────────── HUD som gjemmer seg ────────────────── */

  function visHud() {
    var hud = el('hud');
    hud.classList.remove('gjemt');
    clearTimeout(S.hudTimer);
    S.hudTimer = setTimeout(function () {
      if (S.spiller) hud.classList.add('gjemt');
    }, 2600);
  }
  el('scene').addEventListener('pointerdown', visHud);

  /* ───────────────────────────── avspilling ────────────────────────── */

  var lyd = null, planTimer = null, rammeId = null, okt = null;

  var mester = null;

  function lydUt() {
    if (!lyd) {
      lyd = new (window.AudioContext || window.webkitAudioContext)();
      // Alt gaar gjennom én kjede: lavpass tar av den hardeste toppen,
      // og kompressoren fanger opp at flere toner klinger samtidig.
      // Uten den summerer overlappende toner seg forbi 1.0 og klipper,
      // og da hoeres det ut som stoey i stedet for musikk.
      var lavpass = lyd.createBiquadFilter();
      lavpass.type = 'lowpass';
      // Hoeyt nok til at den tredje formanten slipper igjennom (den
      // ligger paa 2,4–3,0 kHz, og uten den blir «ii» til «uu»), lavt
      // nok til aa ta av sagtannas hvesing.
      lavpass.frequency.value = 4000;
      lavpass.Q.value = 0.4;

      var grense = lyd.createDynamicsCompressor();
      grense.threshold.value = -18;
      grense.knee.value = 12;
      grense.ratio.value = 8;
      grense.attack.value = 0.004;
      grense.release.value = 0.2;

      mester = lyd.createGain();
      mester.gain.value = 0.5;

      mester.connect(lavpass);
      lavpass.connect(grense);
      grense.connect(lyd.destination);
    }
    if (lyd.state === 'suspended') lyd.resume();
    return lyd;
  }

  /**
   * Floeyelsmykt klaver.
   *
   * Tre ting skiller et flygel fra en sinus, og alle tre maa med:
   *
   *  1. DELTONENE DOER I REKKEFOELGE. Diskanten forsvinner foerst, og
   *     grunntonen staar lengst. Derfor har hver deltone sin egen
   *     utklang i stedet for at hele tonen demres likt — det er
   *     nettopp dette oeret hoerer som «mykt» framfor «elektronisk».
   *  2. STRENGENE ER IKKE HARMONISKE. En klaverstreng er stiv, saa
   *     deltone n ligger litt OVER n ganger grunntonen. Uten den lille
   *     skjevheten klinger tonen dodt og syntetisk.
   *  3. HVER TONE HAR FLERE STRENGER, ganske smaatt ustemt mot
   *     hverandre. Det er det som gir den levende svevingen.
   *
   * I tillegg lukker et lavpass seg sakte gjennom tonen, slik lokket
   * paa et flygel demper diskanten.
   */
  function tone(frekvens, naar, lengde, styrke) {
    var ac = lydUt();
    if (!(frekvens > 20) || !(frekvens < 5000)) return;
    var ut = okt || mester;

    var topp = Math.max(0.02, Math.min(0.4, styrke));
    var klang = Math.max(0.9, Math.min(7, lengde * 1.9 + 0.8));   // naturlig utklang
    var slutt = naar + klang;

    var lokk = ac.createBiquadFilter();
    lokk.type = 'lowpass';
    lokk.Q.value = 0.0001;
    // Maalt: med et sluttpunkt paa 3,5 x grunntonen forsvant hele
    // diskanten (energien over 1,2 kHz laa 25 dB under bassen og endret
    // seg ikke gjennom tonen). Da er det ikke floeyel, det er filt over
    // strengene. Lokket skal dempe, ikke lukke.
    lokk.frequency.setValueAtTime(Math.min(9500, frekvens * 22 + 1400), naar);
    lokk.frequency.exponentialRampToValueAtTime(
      Math.max(1500, frekvens * 7), naar + Math.min(2.4, klang));
    lokk.connect(ut);

    // [ordenstall, styrke, hvor fort den doer]
    var DELTONER = [
      [1, 1.00, 1.00], [2, 0.38, 0.80], [3, 0.22, 0.64],
      [4, 0.14, 0.52], [5, 0.085, 0.44], [6, 0.055, 0.37],
      [7, 0.032, 0.31], [8, 0.022, 0.27], [10, 0.011, 0.22],
    ];
    var STIVHET = 0.0004;          // strengens stivhet: deltonene drar oppover
    var STRENGER = [0, -2.5, 3];   // cent, tre strenger per tone

    for (var d = 0; d < DELTONER.length; d++) {
      var n = DELTONER[d][0];
      var hz = frekvens * n * (1 + STIVHET * n * n);
      if (hz > 11000) continue;

      var g = ac.createGain();
      var niva = topp * DELTONER[d][1];
      var doer = naar + klang * DELTONER[d][2];
      // Mykt anslag: 14 ms opp. Hardere gir det klirrete «elektriske»
      // anslaget som gjorde at det ikke laat som et flygel.
      g.gain.setValueAtTime(0.0001, naar);
      g.gain.exponentialRampToValueAtTime(niva, naar + 0.014 + n * 0.0015);
      g.gain.exponentialRampToValueAtTime(Math.max(0.00005, niva * 0.08), doer);
      g.gain.exponentialRampToValueAtTime(0.00002, slutt);
      g.connect(lokk);

      // Bare grunntonen faar alle tre strengene; deltonene klarer seg
      // med én, ellers blir det hundrevis av oscillatorer i en akkord.
      var antall = n === 1 ? STRENGER.length : 1;
      for (var k = 0; k < antall; k++) {
        var o = ac.createOscillator();
        o.type = 'sine';
        o.frequency.value = hz;
        o.detune.value = STRENGER[k];
        var sg = ac.createGain();
        sg.gain.value = 1 / antall;
        o.connect(sg); sg.connect(g);
        o.start(naar); o.stop(slutt + 0.05);
      }
    }

    // Hammerslaget: et kort, dempet dunk som gir anslaget kropp.
    var dunk = ac.createBufferSource();
    dunk.buffer = stoeyBuffer(ac);
    var dl = ac.createBiquadFilter();
    dl.type = 'lowpass';
    dl.frequency.value = Math.min(2600, frekvens * 5);
    var dg = ac.createGain();
    dg.gain.setValueAtTime(topp * 0.17, naar);
    dg.gain.exponentialRampToValueAtTime(0.00005, naar + 0.055);
    dunk.connect(dl); dl.connect(dg); dg.connect(lokk);
    dunk.start(naar); dunk.stop(naar + 0.07);
  }

  var stoeyen = null;
  function stoeyBuffer(ac) {
    if (stoeyen && stoeyen.sampleRate === ac.sampleRate) return stoeyen;
    var b = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.2), ac.sampleRate);
    var d = b.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    stoeyen = b;
    return b;
  }

  function klikk(naar, sterk) {
    var ac = lydUt();
    var o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = sterk ? 1500 : 1000;
    g.gain.setValueAtTime(sterk ? 0.22 : 0.1, naar);
    g.gain.exponentialRampToValueAtTime(0.0001, naar + 0.05);
    o.connect(g); g.connect(ac.destination);
    o.start(naar); o.stop(naar + 0.06);
  }

  function midiTilHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  /**
   * Alle toner som skal klinge, flatet ut og sortert etter tid.
   *
   * «Min stemme» staar fram; de andre ligger under. Hvilke som er med
   * i det hele tatt bestemmer brukeren — alle, én, eller et utvalg.
   */
  function spillelisteFor(stykke) {
    var navn = stykke.stemmer || [];
    var minStemme = navn[S.stemme];
    var slagPerTakt = stykke.slagPerTakt || 4;
    var ut = [];
    navn.forEach(function (n) {
      if (!erValgt(n)) return;
      var liste = (stykke.noter || {})[n] || [];
      var egen = n === minStemme;
      liste.forEach(function (x) {
        ut.push({
          slag: (x.takt - 1) * slagPerTakt + x.slag,
          varighet: x.varighet || 1,
          midi: x.midi, tekst: x.tekst, stemme: n, egen: egen,
          takt: x.takt,
        });
      });
    });
    ut.sort(function (a, b) { return a.slag - b.slag; });
    return ut;
  }

  /**
   * Binder sammen toner som synges paa én pust.
   *
   * To toner henger sammen naar den neste begynner der den forrige
   * slutter, OG den ikke har en ny stavelse. Da er det samme ord som
   * fortsetter, og en sanger holder stroemmen gaaende gjennom det.
   *
   * Lange toner og nye ord bryter bindinga — der puster man.
   */
  function bindSammen(liste) {
    var perStemme = {};
    liste.forEach(function (n) {
      (perStemme[n.stemme] = perStemme[n.stemme] || []).push(n);
    });
    var ut = [];
    for (var navn in perStemme) {
      var v = perStemme[navn];
      var i = 0;
      while (i < v.length) {
        var ledd = [{ hz: null, midi: v[i].midi, lengde: v[i].varighet }];
        var j = i + 1;
        while (j < v.length &&
               Math.abs(v[j].slag - (v[j - 1].slag + v[j - 1].varighet)) < 0.02 &&
               !v[j].tekst &&
               ledd.length < 8) {
          ledd.push({ hz: null, midi: v[j].midi, lengde: v[j].varighet });
          j++;
        }
        ut.push({
          slag: v[i].slag, ledd: ledd, tekst: v[i].tekst,
          stemme: navn, egen: v[i].egen, takt: v[i].takt,
          varighet: ledd.reduce(function (a, l) { return a + l.lengde; }, 0),
          midi: v[i].midi,
        });
        i = j;
      }
    }
    ut.sort(function (a, b) { return a.slag - b.slag; });
    return ut;
  }

  /** Er stemmen en klaverstemme? Da spilles den alltid paa klaver. */
  function erKlaver(navn) { return /^klaver/.test(String(navn || '').toLowerCase()); }

  /** Er stemmen med i avspillinga? */
  function erValgt(navn) {
    if (!S.valgte) return true;                 // null = alle
    return S.valgte.indexOf(navn) >= 0;
  }

  /**
   * Avspillinga gaar paa LYDKLOKKA, ikke paa setTimeout.
   *
   * Foer ble hver takt satt i gang av en timer, og markoeren flyttet
   * seg samtidig. En timer i nettleseren driver — noen millisekunder
   * for hver takt, hele veien — og da sklir bildet fra lyden. Naa
   * leses `currentTime` fra lydkortet hver ramme, og BAADE notebildet
   * og overlayet regnes ut av den. De kan ikke gli fra hverandre, for
   * de leser samme klokke.
   */
  function start() {
    var takter = alleTakter(S.stykke);
    S.spiller = true;
    el('spill').textContent = '⏸ Stopp';
    var ac = lydUt();

    var slagPerTakt = S.stykke.slagPerTakt || 4;
    var sekPerSlag = 60 / S.tempo;
    var liste = bindSammen(spillelisteFor(S.stykke));
    if (!liste.length && !takter.length) { stopp(); return; }

    // Egen utgangsport for denne avspillinga, saa «stopp» kan kutte
    // toner som alt er planlagt fram i tid.
    okt = ac.createGain();
    okt.gain.value = 1;
    okt.connect(mester);

    var fraSlag = (Math.max(1, S.takt || 1) - 1) * slagPerTakt;
    var sisteSlag = liste.length
      ? liste[liste.length - 1].slag + liste[liste.length - 1].varighet
      : takter.length * slagPerTakt;
    var t0 = ac.currentTime + 0.18;

    var k = 0;
    while (k < liste.length && liste[k].slag < fraSlag) k++;

    function planlegg() {
      if (!S.spiller) return;
      var fram = (ac.currentTime - t0) + 1.2;        // planlegg 1,2 s foran
      var samtidig = 0;
      while (k < liste.length && (liste[k].slag - fraSlag) * sekPerSlag < fram) {
        var n = liste[k];
        var naar = t0 + (n.slag - fraSlag) * sekPerSlag;
        var lengde = Math.max(0.16, n.varighet * sekPerSlag * 0.96);
        var hz = midiTilHz(n.midi);
        samtidig++;
        var styrke = (n.egen ? 0.19 : 0.1) * (liste.length > 400 ? 0.85 : 1);
        // Klaveret er akkompagnement: alltid klaverklang, og litt
        // tilbake i lydbildet saa koret staar foran.
        if (erKlaver(n.stemme)) {
          for (var q = 0; q < n.ledd.length; q++) {
            tone(midiTilHz(n.ledd[q].midi), naar, Math.max(0.16, n.ledd[q].lengde * sekPerSlag * 0.96), styrke * 0.75);
            naar += n.ledd[q].lengde * sekPerSlag;
          }
        } else if (S.klang === 'kor' && window.Stemmelyd) {
          var rekke = n.ledd.map(function (l) {
            return { hz: midiTilHz(l.midi), lengde: l.lengde * sekPerSlag };
          });
          window.Stemmelyd.syng(ac, okt, rekke, naar, lengde, styrke,
            n.tekst, n.stemme, samtidig > 24 ? 2 : 3);
        } else {
          for (var w = 0; w < n.ledd.length; w++) {
            tone(midiTilHz(n.ledd[w].midi), naar, Math.max(0.16, n.ledd[w].lengde * sekPerSlag * 0.96), styrke);
            naar += n.ledd[w].lengde * sekPerSlag;
          }
        }
        k++;
      }
      if (k < liste.length) planTimer = setTimeout(planlegg, 150);
    }

    var sisteTakt = -1;
    function ramme() {
      if (!S.spiller) return;
      var slag = fraSlag + (ac.currentTime - t0) / sekPerSlag;
      if (slag > sisteSlag + 1) { stopp(); return; }

      rullTil(slag);

      var nr = Math.floor(slag / slagPerTakt) + 1;
      if (nr !== sisteTakt && nr >= 1) {
        sisteTakt = nr;
        S.takt = nr;
      }
      rammeId = requestAnimationFrame(ramme);
    }

    planlegg();
    rammeId = requestAnimationFrame(ramme);
    return;

  }

  function stopp() {
    S.spiller = false;
    clearTimeout(planTimer);
    if (rammeId) cancelAnimationFrame(rammeId);
    rammeId = null;
    // Toner er planlagt opptil halvannet sekund fram i tid. De lar seg
    // ikke kalle tilbake, men hele avspillinga gaar gjennom én port,
    // og den kan lukkes.
    if (okt && lyd) {
      var g = okt;
      try {
        g.gain.cancelScheduledValues(lyd.currentTime);
        g.gain.setValueAtTime(g.gain.value, lyd.currentTime);
        g.gain.linearRampToValueAtTime(0.0001, lyd.currentTime + 0.08);
      } catch (e) { /* ingen */ }
      setTimeout(function () { try { g.disconnect(); } catch (e) {} }, 2000);
      okt = null;
    }
    el('spill').textContent = '▶ Spill';
    el('hud').classList.remove('gjemt');
  }


  /* ──────────────────────────── kontroller ─────────────────────────── */

  el('spill').onclick = function () { S.spiller ? stopp() : start(); visHud(); };

  /**
   * Peker nedlastingsknappen paa oevingsfila for den valgte stemmen:
   * din linje paa flygel, de andre svakt under. Finnes den ikke, vises
   * ingen knapp i stedet for en lenke som ikke virker.
   */
  function oppdaterLastNed() {
    var a = el('last-ned');
    var midi = S.stykke && S.stykke.midi;
    var navn = (S.stykke && S.stykke.stemmer || [])[S.stemme];
    var sti = midi && ((midi.stemmer || {})[navn] || midi.alle);
    if (!sti) { a.hidden = true; return; }
    a.hidden = false;
    a.href = BILDEROT + sti;
    a.download = (S.stykke.tittel + ' - ' + (navn || 'alle') + '.mid')
      .replace(/[\\/:*?"<>|]/g, '');
  }

  /* ───────────────── partituret: noter, tekst og markoer ──────────────── */

  /**
   * Setter sammen stavelsene i en takt til lesbare ord.
   *
   * MusicXML merker hver stavelse med om den staar alene, begynner,
   * fortsetter eller avslutter et ord. Uten det blir «Glo» og «ry» to
   * ord i stedet for «Glory».
   */
  function ordAv(noter) {
    var ut = '', henger = false;
    for (var i = 0; i < noter.length; i++) {
      var t = noter[i].tekst;
      if (!t) continue;
      if (henger) ut += t;
      else ut += (ut ? ' ' : '') + t;
      henger = noter[i].del === 'begin' || noter[i].del === 'middle';
    }
    return ut;
  }

  /**
   * Setter hele partituret: alle stemmene under hverandre.
   *
   * Dette er hovedvisninga. Notene tegnes av de samme dataene som
   * spilles, saa markoeren kan ikke peke feil — den peker paa den tonen
   * som faktisk klinger.
   *
   * I «Min stemme» vises bare din egen linje, i stoerre skrift.
   */
  function byggPartitur() {
    var spor = el('partiturspor');
    var fast = el('partiturnokkel');
    spor.innerHTML = '';
    fast.innerHTML = '';
    S.partitur = null;
    if (!window.Noteskrift || !S.stykke) return;

    var alle = (S.stykke.stemmer || []).filter(function (n) {
      var v = (S.stykke.noter || {})[n];
      return v && v.length;
    });
    if (!alle.length) return;

    var min = (S.stykke.stemmer || [])[S.stemme];

    // Klaveret hoeres, men vises ikke uten videre.
    //
    // Et klaverakkompagnement er hundrevis av toner over fem oktaver.
    // Tegnet paa én stav ved siden av korstemmene blir det en vegg av
    // notehoder med hjelpelinjer i alle retninger, og korstemmene — som
    // er det du skal synge etter — drukner. De ligger bak «Klaver».
    var syngende = alle.filter(function (x) { return !erKlaver(x); });
    var vis = S.oving && alle.indexOf(min) >= 0 ? [min]
      : (S.visKlaver ? alle : (syngende.length ? syngende : alle));

    var flate = el('partitur');
    var h = Math.max(160, flate.clientHeight - 150);     // plass til knappene
    // Vises bare én stemme, er det plass til mye stoerre noter. Et
    // fast tak gjorde at én stav laa som en tynn strek midt paa en
    // ellers tom skjerm.
    var L = Math.max(7, Math.min(vis.length <= 1 ? 26 : 18,
      Math.floor(h / (vis.length * window.Noteskrift.STAVHOYDE))));

    var satt = window.Noteskrift.tegnPartitur(
      // Teksten staar under DIN stemme, ikke under alle. Den er den
      // samme for hele koret, og gjentatt under seks staver ble den
      // bare stoey som dekket notene.
      vis.map(function (n) {
        return {
          navn: n, noter: S.stykke.noter[n],
          visTekst: !erKlaver(n) && (vis.length === 1 || n === min),
        };
      }),
      {
        L: L, perSlag: Math.round(L * 3.2),
        slagPerTakt: S.stykke.slagPerTakt || 4,
        toneart: S.stykke.toneart,
        venstre: L * 10,
      });
    spor.appendChild(satt.svg);
    spor.style.top = Math.max(0, (flate.clientHeight - satt.hoyde) / 2 - 40) + 'px';
    S.partitur = satt;

    // Stemmenavnene i margen
    var ns = 'http://www.w3.org/2000/svg';
    satt.stemmer.forEach(function (st) {
      var t = document.createElementNS(ns, 'text');
      t.setAttribute('class', 'ns-stemmenavn');
      t.setAttribute('x', 2);
      t.setAttribute('y', st.midtY - L * 2.8);
      t.setAttribute('font-size', L * 1.15);
      t.textContent = st.navn;
      satt.svg.appendChild(t);
    });

    // Fast venstremarg: noekler, fortegn og navn staar stille mens
    // musikken glir forbi. Uten dette scroller noekkelen bort, og da
    // vet man ikke lenger hvilken stemme man ser paa.
    var klipp = satt.svg.cloneNode(true);
    klipp.setAttribute('width', satt.venstre);
    klipp.setAttribute('viewBox', '0 0 ' + satt.venstre + ' ' + satt.hoyde);
    var vekk = klipp.querySelectorAll('.ns-noter, .ns-tekst, .ns-taktstrek');
    for (var i = 0; i < vekk.length; i++) vekk[i].remove();
    fast.appendChild(klipp);
    fast.style.width = satt.venstre + 'px';
    fast.style.top = spor.style.top;
    fast.hidden = false;
  }

  /**
   * Flytter partituret slik at naavaerende slag staar ved spillelinja,
   * og lyser opp tonene som klinger.
   *
   * Tar et BRUDDENT slagtall, ikke et taktnummer: det er det som gjoer
   * at notene glir jevnt forbi i stedet for aa hoppe ved hver takt.
   */
  function rullTil(slag) {
    var satt = S.partitur;
    if (!satt) return;
    var flate = el('partitur');
    var x = satt.xAvSlag(Math.max(0, slag));
    var dx = flate.clientWidth * 0.30 - x;
    el('partiturspor').style.transform = 'translate3d(' + dx + 'px,0,0)';
    // Den faste margen skal bare staa der naar partiturets egen
    // venstremarg har rullet forbi — ellers staar noekkelen dobbelt.
    var fast = el('partiturnokkel');
    var skjul = dx > -2;
    if (fast.hidden !== skjul) fast.hidden = skjul;

    for (var i = 0; i < satt.stemmer.length; i++) {
      var hoder = satt.stemmer[i].hoder;
      for (var j = 0; j < hoder.length; j++) {
        var h = hoder[j];
        var klinger = slag >= h.start - 0.04 && slag < h.slutt;
        if (klinger !== h.paa) {
          h.paa = klinger;
          h.e.classList.toggle('naa', klinger);
        }
      }
    }
  }

  window.addEventListener('resize', function () { byggPartitur(); });


  /**
   * Brikkene som bestemmer hvilke stemmer som hoeres.
   *
   * «Alle» er standard. Trykker du paa én stemme alene, hoerer du bare
   * den. Du kan ogsaa slaa paa et hvilket som helst utvalg — to tenorer
   * mot hverandre, eller din egen mot bassen.
   *
   * Brikka med ramme er «min stemme»: den som staar fram i lyden, og
   * den notebildet viser. Den velges i nedtrekkslista.
   */
  function byggStemmebrikker() {
    var hus = el('stemmebrikker');
    hus.innerHTML = '';
    var navn = (S.stykke.stemmer || []);
    if (!navn.length) return;

    var alle = document.createElement('button');
    alle.className = 'brikke' + (S.valgte === null ? ' paa' : '');
    alle.textContent = 'Alle';
    alle.onclick = function () { S.valgte = null; byggStemmebrikker(); omstart(); };
    hus.appendChild(alle);

    navn.forEach(function (n, i) {
      var b = document.createElement('button');
      b.className = 'brikke' + (erValgt(n) ? ' paa' : '') + (i === S.stemme ? ' min' : '');
      b.textContent = n;
      b.onclick = function () {
        if (S.valgte === null) {
          // Fra «alle»: ett trykk velger den ene stemmen alene.
          S.valgte = [n];
        } else {
          var j = S.valgte.indexOf(n);
          if (j >= 0) S.valgte.splice(j, 1); else S.valgte.push(n);
          if (!S.valgte.length) S.valgte = null;
        }
        // Staar bare én stemme igjen, er det ogsaa DEN du ser paa.
        // Ellers maatte man bytte to steder for det samme.
        if (S.valgte && S.valgte.length === 1) {
          var k = (S.stykke.stemmer || []).indexOf(S.valgte[0]);
          if (k >= 0) {
            S.stemme = k;
            el('stemmevalg').value = k;
            oppdaterLastNed();
          }
        }
        byggStemmebrikker();
        byggPartitur();
        rullTil(((S.takt || 1) - 1) * (S.stykke.slagPerTakt || 4));
        omstart();
      };
      hus.appendChild(b);
    });
  }

  /** Starter avspillinga paa nytt fra samme takt, med nye valg. */
  function omstart() {
    if (!S.spiller) return;
    var t = S.takt;
    stopp();
    S.takt = t;
    start();
  }

  el('klang').onclick = function () {
    S.klang = S.klang === 'kor' ? 'piano' : 'kor';
    this.classList.toggle('paa', S.klang === 'kor');
    this.textContent = S.klang === 'kor' ? '♫ Kor' : '♩ Piano';
    this.title = S.klang === 'kor'
      ? 'Hele koret synger teksten — din stemme fremst'
      : 'Bare din stemme, paa klaver';
    // Bytte midt i en takt ville la gamle toner klinge ut i den andre
    // klangen. Start takta paa nytt i stedet.
    if (S.spiller) { var t = S.takt; stopp(); S.takt = t; start(); }
    visHud();
  };

  el('ovingsmodus').onclick = function () {
    S.oving = !S.oving;
    this.classList.toggle('paa', S.oving);
    this.textContent = S.oving ? '♪ Min stemme' : '♪ Alle stemmer';
    byggPartitur();
    rullTil(((S.takt || 1) - 1) * (S.stykke.slagPerTakt || 4));
    visHud();
  };

  /**
   * Flytter spillestedet til et gitt slag.
   *
   * Spiller den alt, startes den paa nytt derfra — WebAudio kan ikke
   * spole i toner som alt er planlagt, saa det maa settes opp paa nytt.
   */
  function gaaTil(slag) {
    var sPT = (S.stykke && S.stykke.slagPerTakt) || 4;
    var takt = Math.max(1, Math.floor(slag / sPT) + 1);
    var spilte = S.spiller;
    if (spilte) stopp();
    S.takt = takt;
    rullTil((takt - 1) * sPT);
    if (spilte) start();
    visHud();
  }

  el('tilstart').onclick = function () { gaaTil(0); };

  /**
   * Panelet der du sier hvilken stemme hver notelinje er.
   *
   * Dette er den ene opplysningen maskinen ikke kan lese paalitelig ut
   * av et skannet partitur — er den nederste staven «baryton og bass»
   * eller «1. bass og 2. bass»? Begge finnes, og de ser like ut paa
   * papiret. Opuscan spoer om det samme. Her er svaret ditt, lagret.
   */
  var NAVNEVALG = [
    '1. sopran', '2. sopran', 'sopran', '1. alt', '2. alt', 'alt',
    '1. tenor', '2. tenor', 'tenor', 'baryton',
    '1. bass', '2. bass', 'bass',
    'klaver h', 'klaver v', 'melodi',
  ];

  function visStemmepanel() {
    var panel = el('stemmepanel');
    var liste = el('stemmeliste');
    liste.innerHTML = '';
    (S.stykke.stemmer || []).forEach(function (navn, i) {
      var rad = document.createElement('label');
      rad.className = 'stemmerad';
      var merke = document.createElement('span');
      merke.className = 'stemmerad-nr';
      merke.textContent = (i + 1) + '. linje';
      var velg = document.createElement('select');
      velg.className = 'velg';
      NAVNEVALG.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v; o.textContent = v;
        if (v === navn) o.selected = true;
        velg.appendChild(o);
      });
      if (NAVNEVALG.indexOf(navn) < 0) {
        var eget = document.createElement('option');
        eget.value = navn; eget.textContent = navn; eget.selected = true;
        velg.insertBefore(eget, velg.firstChild);
      }
      rad.appendChild(merke);
      rad.appendChild(velg);
      liste.appendChild(rad);
    });
    panel.hidden = false;
  }

  el('stemmenavn').onclick = function () { visStemmepanel(); };
  el('stemmepanel-lukk').onclick = function () { el('stemmepanel').hidden = true; };

  el('stemmepanel-lagre').onclick = function () {
    var navn = [].map.call(el('stemmeliste').querySelectorAll('select'),
      function (v) { return v.value; });
    var knapp = this;
    knapp.disabled = true;
    knapp.textContent = 'Lagrer…';
    fetch('/api/stemmer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: S.stykke.id, navn: navn }),
    }).then(function (r) { return r.json(); }).then(function () {
      // Hent katalogen paa nytt saa alt — noter, lyd og notebilde —
      // bruker de nye navnene.
      return fetch(BILDEROT + 'arkiv.json?' + Date.now()).then(function (r) { return r.json(); });
    }).then(function (data) {
      arkiv = data;
      var id = S.stykke.id;
      var nytt = arkiv.stykker.find(function (x) { return x.id === id; });
      el('stemmepanel').hidden = true;
      knapp.disabled = false;
      knapp.textContent = 'Lagre';
      if (nytt) { if (S.stemme >= nytt.stemmer.length) S.stemme = 0; aapne(nytt); }
    }).catch(function () {
      knapp.disabled = false;
      knapp.textContent = 'Lagre';
      alert('Kunne ikke lagre stemmenavnene.');
    });
  };

  el('visklaver').onclick = function () {
    S.visKlaver = !S.visKlaver;
    this.classList.toggle('paa', S.visKlaver);
    byggPartitur();
    rullTil(((S.takt || 1) - 1) * (S.stykke.slagPerTakt || 4));
    visHud();
  };

  // Trykk i noten for aa begynne der. Spillelinja staar paa 30 % av
  // bredden, saa det som ligger DER er det som klinger naa.
  el('partitur').addEventListener('pointerdown', function (e) {
    var satt = S.partitur;
    if (!satt) return;
    var flate = el('partitur');
    var r = flate.getBoundingClientRect();
    var spor = el('partiturspor').getBoundingClientRect();
    var x = e.clientX - spor.left;                 // i partiturets koordinater
    var slag = (x - satt.venstre) / satt.perSlag;
    if (slag < 0) slag = 0;
    gaaTil(slag);
  });

  el('visning').onclick = function () {
    S.visning = S.visning === 'noter' ? 'original' : 'noter';
    this.classList.toggle('paa', S.visning === 'original');
    this.textContent = S.visning === 'noter' ? '⎙ Original' : '♪ Noter';
    el('partitur').hidden = S.visning !== 'noter';
    el('spor').hidden = S.visning !== 'original';
    if (S.visning === 'noter') {
      byggPartitur();
      rullTil(((S.takt || 1) - 1) * (S.stykke.slagPerTakt || 4));
    }
    visHud();
  };

  el('stemmevalg').onchange = function () {
    S.stemme = +this.value;
    oppdaterLastNed();
    byggStemmebrikker();
    byggPartitur();
    rullTil(((S.takt || 1) - 1) * (S.stykke.slagPerTakt || 4));
  };


  el('tempo').oninput = function () {
    S.tempo = +this.value;
    el('tempo-tall').textContent = S.tempo;
  };

  el('fullskjerm').onclick = function () {
    var d = document.documentElement;
    if (!document.fullscreenElement) (d.requestFullscreen || d.webkitRequestFullscreen).call(d);
    else document.exitFullscreen();
    visHud();
  };

  function tilbake() {
    stopp();
    el('leser').classList.remove('vis');
    el('bibliotek').classList.add('vis');
  }
  /**
   * Tar imot en ferdig lest notefil.
   *
   * Dette er den ene veien inn som gir riktig resultat hver gang:
   * gjenkjenninga er gjort av et verktoey som er bygget for det, og
   * fila oppgir baade stemmer, oktaver og sangtekst. Vi leser den
   * bare — ingen gjetting.
   */
  el('notefil').onchange = function () {
    var fil = this.files && this.files[0];
    this.value = '';
    if (!fil) return;
    var status = el('import-status');
    var tittel = fil.name.replace(/\.(musicxml|mxl|xml)$/i, '').trim();
    status.textContent = 'Leser ' + tittel + '…';

    fil.arrayBuffer().then(function (buf) {
      return fetch('/api/import?tittel=' + encodeURIComponent(tittel), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: buf,
      });
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res.feil) { status.textContent = res.feil; return; }
      status.textContent = res.stemmer.length + ' stemmer, ' + res.takter + ' takter — lagt inn.';
      return fetch(BILDEROT + 'arkiv.json?' + Date.now())
        .then(function (r) { return r.json(); })
        .then(function (data) {
          arkiv = data;
          byggFiltre();
          tegnListe(el('sok').value || '');
          setTimeout(function () { status.textContent = ''; }, 6000);
        });
    }).catch(function (e) {
      status.textContent = 'Kunne ikke lese fila: ' + e.message;
    });
  };

  el('tilbake').onclick = tilbake;

  el('sok').oninput = function () {
    el('nullstill').hidden = !this.value;
    tegnListe(this.value);
  };
  el('nullstill').onclick = function () {
    el('sok').value = '';
    this.hidden = true;
    tegnListe('');
  };

  // Hold skjermen vaaken mens man synger.
  if ('wakeLock' in navigator) {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && S.spiller) {
        navigator.wakeLock.request('screen').catch(function () {});
      }
    });
  }

  last();
})();
