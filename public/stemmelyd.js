'use strict';
/**
 * stemmelyd.js — korklang bygd av formanter.
 *
 * En sinus blir aldri sang. Det som skiller en menneskestemme fra en
 * orgelpipe er formantene: tre faste resonanser i svelget og munnhulen
 * som ligger paa omtrent samme frekvens uansett hvilken tone du synger.
 * De er hele grunnen til at du hoerer forskjell paa «aa» og «ii».
 *
 * Kjeden per tone:
 *
 *   kilde      sagtann paa grunntonen — en grov, men brukbar modell av
 *              stemmebaandene: alle deltoner, 1/n i styrke
 *   formanter  tre baandpass i parallell, satt etter vokalen i teksten
 *   vibrato    ~5,4 Hz, ulik fase per sanger
 *   sangere    to-tre pr. tone, smaatt forstemt. Dette er det som gjoer
 *              et KOR av én stemme: like stemmer i utakt gir den brede
 *              klangen, ikke mer volum
 *   konsonant  kort pust foran stavelser som begynner paa s, t, k
 *
 * Vokalen hentes fra sangteksten paa noten, saa koret synger faktisk
 * «Hark» med a og «sing» med i.
 *
 * Verdiene under er maalte formanter for mannsstemmer (Peterson og
 * Barney), avrundet. Oppsettet er [frekvens, styrke, bredde].
 */

(function (global) {

  // Tre vokalformanter, pluss SANGERFORMANTEN — en fjerde resonans
  // rundt 2,8-3,0 kHz som skolerte sangere lager ved aa senke strupen.
  // Det er den som gjoer at et kor baerer over et orkester, og uten
  // den hoeres en formantsyntese ut som en orgelpipe med filter paa.
  // Den ligger paa samme sted uansett vokal; bare styrken varierer.
  var SANGER = [2850, 0.22, 240];

  var VOKAL = {
    a: [[730, 1, 90], [1090, 0.45, 110], [2440, 0.15, 140], SANGER],
    e: [[530, 1, 70], [1840, 0.35, 100], [2480, 0.18, 130], SANGER],
    i: [[280, 1, 60], [2290, 0.10, 100], [3010, 0.06, 140], SANGER],
    o: [[570, 1, 70], [840, 0.50, 90], [2410, 0.10, 130], SANGER],
    u: [[310, 1, 55], [870, 0.13, 70], [2240, 0.04, 120], SANGER],
    'ø': [[440, 1, 70], [1620, 0.30, 100], [2400, 0.12, 130], SANGER],
    y: [[290, 1, 60], [1870, 0.14, 95], [2250, 0.08, 120], SANGER],
    'æ': [[660, 1, 85], [1720, 0.50, 100], [2410, 0.16, 130], SANGER]
  };

  // Vokalpar som ikke uttales som bokstavene sine.
  var PAR = {
    ee: 'i', ea: 'i', ie: 'i', ey: 'i',
    oo: 'u', ou: 'o', ow: 'o', oa: 'o', oi: 'o', oy: 'o',
    ai: 'e', ay: 'e', ei: 'e', ae: 'e',
    au: 'o', aw: 'o', eu: 'ø', oe: 'ø',
    aa: 'o', uo: 'u', io: 'o', ia: 'a', ua: 'a'
  };

  var ENKEL = {
    a: 'a', e: 'e', i: 'i', o: 'o', u: 'u', y: 'y',
    'å': 'o', 'ø': 'ø', 'æ': 'æ', 'é': 'e', 'è': 'e', 'ü': 'y', 'ö': 'ø'
  };

  /**
   * Vokalen i en stavelse.
   *
   * Ikke fonetikk, men nok til at teksten former klangen: foerste
   * vokalgruppe vinner, og par slaas opp foer enkeltbokstaver, slik at
   * «moon» blir u og ikke o.
   */
  function vokalAv(ord) {
    if (!ord) return 'a';
    var s = String(ord).toLowerCase().replace(/[^a-zæøåéèüö]/g, '');
    var norsk = /[æøå]/.test(s);
    for (var i = 0; i < s.length; i++) {
      // Fremst i stavelsen er y en konsonant, ikke en vokal: «you»
      // synges u, ikke y.
      if (s[i] === 'y' && i === 0 && s.length > 1) continue;
      var en = ENKEL[s[i]];
      if (!en) continue;
      var par = PAR[s.substr(i, 2)];
      if (par) return par;
      // Engelsk y til slutt er en i — «glory», «fly». Den norske,
      // rundede y-en staar bare naar stavelsen ellers ser norsk ut.
      if (en === 'y' && !norsk && i === s.length - 1) return 'i';
      return en;
    }
    return 'a';   // stavelse uten vokal, som «-s» — syng den aapen
  }

  /** Hvor mye pust stavelsen begynner med, og hvor lenge. */
  function pustAv(ord) {
    if (!ord) return null;
    var reng = String(ord).toLowerCase().replace(/[^a-zæøå]/g, '');
    var f = reng.charAt(0);
    if (!f) return null;
    if ('szfvh'.indexOf(f) >= 0) return { lengde: 0.055, styrke: 0.11, hz: 5200 };
    if ('tkpcx'.indexOf(f) >= 0) return { lengde: 0.022, styrke: 0.16, hz: 3400 };
    if ('bdg'.indexOf(f) >= 0) return { lengde: 0.018, styrke: 0.07, hz: 1800 };
    return null;      // m, n, l, r og vokaler trenger ingen pust
  }

  /** Stemmeleiet flytter formantene litt: en bass har lengre rør. */
  function leie(navn) {
    var n = String(navn || '').toLowerCase();
    if (n.indexOf('bass') >= 0) return 0.93;
    if (n.indexOf('baryton') >= 0) return 0.97;
    if (n.indexOf('tenor') >= 0) return 1.04;
    if (n.indexOf('alt') >= 0) return 1.08;
    if (n.indexOf('sopran') >= 0) return 1.14;
    return 1;
  }

  /**
   * Stemmebaandenes boelgeform.
   *
   * En sagtann har deltoner som faller av som 1/n. Strupen faller
   * brattere — noe slikt som 1/n^1,4 — og det er forskjellen paa en
   * stemme og en synth: sagtanna har for mye energi hoeyt oppe og
   * surrer. Boelgen bygges én gang og gjenbrukes.
   */
  var strupe = null;
  function strupeBoelge(ac) {
    if (strupe && strupe._sr === ac.sampleRate) return strupe;
    var N = 40;
    var re = new Float32Array(N), im = new Float32Array(N);
    for (var n = 1; n < N; n++) {
      im[n] = -1 / Math.pow(n, 1.4);
      // Litt ujevnhet i fasen gjoer boelgen mindre maskinell.
      re[n] = 0.12 * Math.sin(n * 1.7) / Math.pow(n, 2);
    }
    strupe = ac.createPeriodicWave(re, im, { disableNormalization: false });
    strupe._sr = ac.sampleRate;
    return strupe;
  }

  var stoey = null;
  function stoeyBuffer(ac) {
    if (stoey && stoey.length && stoey.sampleRate === ac.sampleRate) return stoey;
    var b = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.3), ac.sampleRate);
    var d = b.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    stoey = b;
    return b;
  }

  /**
   * Synger én tone.
   *
   * @param ac       AudioContext
   * @param ut       noden klangen skal inn i
   * @param hz       grunntone
   * @param naar     starttid i ac.currentTime-skala
   * @param lengde   sekunder
   * @param styrke   0–1
   * @param ord      stavelsen som synges, eller null
   * @param stemme   «tenor», «bass» … — flytter formantene
   * @param sangere  hvor mange i unison (2 er nok naar hele koret gaar)
   */
  function syng(ac, ut, hz, naar, lengde, styrke, ord, stemme, sangere) {
    // `hz` kan vaere ett tall, eller en rekke [{hz, lengde}] som
    // synges BUNDET — én pust, med glid mellom tonene.
    //
    // Dette er det som skiller sang fra et keyboard. Gir man hver tone
    // sitt eget anslag, hoerer oeret et instrument som slaas an paa
    // nytt og paa nytt. En sanger holder stroemmen gaaende gjennom
    // hele ordet og flytter bare tonehoeyden.
    var ledd = Array.isArray(hz) ? hz : [{ hz: hz, lengde: lengde }];
    ledd = ledd.filter(function (l) { return l.hz > 20 && l.hz < 2000; });
    if (!ledd.length) return;
    lengde = ledd.reduce(function (a, l) { return a + l.lengde; }, 0);
    hz = ledd[0].hz;
    var vokal = VOKAL[vokalAv(ord)] || VOKAL.a;
    var skala = leie(stemme);
    var antall = sangere || 3;
    var slutt = naar + Math.max(0.18, lengde);

    // Felles innhylling. Sang svulmer opp og slipper mykt — ikke
    // klaverets harde anslag.
    //
    // KOMPENSASJON: tre smale baandpass slipper bare en flis av
    // sagtannas energi igjennom. Maalt i nettleseren gav styrke 0,19
    // en topp paa 0,031 — 30 dB under klaverklangen, altsaa nesten
    // uhoerlig ved siden av den. Faktoren loefter den tilbake, saa
    // `styrke` betyr det samme for begge klangene.
    var hylle = ac.createGain();
    hylle.connect(ut);
    var topp = Math.max(0.01, Math.min(0.5, styrke));
    var niva = topp * 7;
    var reis = Math.min(0.13, Math.max(0.045, lengde * 0.16));
    hylle.gain.setValueAtTime(0.0001, naar);
    hylle.gain.exponentialRampToValueAtTime(niva, naar + reis);
    hylle.gain.setValueAtTime(niva, Math.max(naar + reis, slutt - 0.12));
    hylle.gain.exponentialRampToValueAtTime(0.0001, slutt);

    // Formantene er felles for sangerne — det er samme vokal.
    var kilder = ac.createGain();
    for (var f = 0; f < vokal.length; f++) {
      var bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      // F1 skal aldri ligge under grunntonen; da forsvinner vokalen.
      // Sangere loefter den selv paa hoeye toner, av samme grunn.
      var mid = vokal[f][0] * skala;
      bp.frequency.value = f === 0 ? Math.max(mid, hz * 1.05) : mid;
      bp.Q.value = bp.frequency.value / vokal[f][2];
      var g = ac.createGain();
      g.gain.value = vokal[f][1];
      kilder.connect(bp); bp.connect(g); g.connect(hylle);
    }

    // Litt uformet kilde rett igjennom gir kropp;
    // bare formanter klinger som et filter, ikke som et menneske.
    var luft = ac.createGain();
    luft.gain.value = 0.05;
    kilder.connect(luft); luft.connect(hylle);

    // Pust. En stille stoeystroem gjennom de SAMME formantene legger
    // seg som luft rundt tonen. Uten den er klangen for ren til aa
    // vaere et menneske.
    var pust = ac.createBufferSource();
    pust.buffer = stoeyBuffer(ac);
    pust.loop = true;
    var pg = ac.createGain();
    pg.gain.value = 0.055;
    pust.connect(pg); pg.connect(kilder);
    pust.start(naar); pust.stop(slutt + 0.05);

    var AVVIK = [0, -11, 13, -7, 9];
    for (var s = 0; s < antall; s++) {
      var o = ac.createOscillator();
      o.setPeriodicWave(strupeBoelge(ac));
      o.detune.value = AVVIK[s % AVVIK.length];

      // Ansatsen: sangere treffer ikke tonen helt rent fra foerste
      // oeyeblikk, de glir opp i den. Noen titalls cent over ~70 ms er
      // nok til at det hoeres menneskelig ut i stedet for kvantisert.
      var t = naar + s * 0.013;
      o.frequency.setValueAtTime(hz * 0.978, t);
      o.frequency.exponentialRampToValueAtTime(hz, t + 0.07);
      t += ledd[0].lengde;
      // Bundne toner: glid over paa neste tonehoeyde i stedet for aa
      // sette den. 45 ms er omtrent det en sanger bruker.
      for (var q = 1; q < ledd.length; q++) {
        o.frequency.setValueAtTime(ledd[q - 1].hz, Math.max(t - 0.045, naar + 0.08));
        o.frequency.exponentialRampToValueAtTime(ledd[q].hz, t + 0.02);
        t += ledd[q].lengde;
      }

      // Vibrato: ulik fart og fase per sanger, ellers svever de i takt
      // og det hoeres ut som én stemme gjennom en effekt.
      var v = ac.createOscillator();
      v.frequency.value = 5.0 + s * 0.5;
      var vd = ac.createGain();
      // Vibratoet kommer ETTER ansatsen og vokser. Et vibrato som
      // ligger der fra foerste oeyeblikk hoeres ut som en effekt;
      // et som vokser fram hoeres ut som en stemme som baerer tonen.
      vd.gain.setValueAtTime(0.0001, naar);
      vd.gain.setValueAtTime(0.0001, naar + Math.min(0.12, lengde * 0.25));
      vd.gain.linearRampToValueAtTime(hz * 0.013, naar + Math.min(0.75, lengde));
      v.connect(vd); vd.connect(o.frequency);
      v.start(naar + s * 0.021); v.stop(slutt + 0.05);

      var sg = ac.createGain();
      sg.gain.value = 1 / Math.sqrt(antall);
      o.connect(sg); sg.connect(kilder);
      // Sangere setter ikke an helt samtidig. Noen millisekunder sprik
      // er forskjellen paa et kor og en synth.
      o.start(naar + s * 0.013); o.stop(slutt + 0.05);
    }

    var p = pustAv(ord);
    if (p) {
      var sb = ac.createBufferSource();
      sb.buffer = stoeyBuffer(ac);
      var hp = ac.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = p.hz * 0.5;
      var bp2 = ac.createBiquadFilter();
      bp2.type = 'bandpass';
      bp2.frequency.value = p.hz;
      bp2.Q.value = 0.8;
      var pg = ac.createGain();
      var start = Math.max(0, naar - p.lengde);
      pg.gain.setValueAtTime(0.0001, start);
      pg.gain.linearRampToValueAtTime(p.styrke * topp * 3, start + p.lengde * 0.4);
      pg.gain.exponentialRampToValueAtTime(0.0001, start + p.lengde);
      sb.connect(hp); hp.connect(bp2); bp2.connect(pg); pg.connect(ut);
      sb.start(start); sb.stop(start + p.lengde + 0.02);
    }
  }

  var api = { syng: syng, vokalAv: vokalAv, pustAv: pustAv, leie: leie, VOKAL: VOKAL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Stemmelyd = api;

})(typeof window !== 'undefined' ? window : globalThis);
