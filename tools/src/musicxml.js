'use strict';
/**
 * musicxml.js — leser MusicXML fra Audiveris og gjoer det om til
 * stemmer visningsverktoeyet kan spille.
 *
 * To ting krever omtanke:
 *
 *  1. `.mxl` er en zip. Node har ingen zip-leser, saa den pakkes ut med
 *     zlib her — det er bare deflate med noen hoder rundt.
 *  2. Tidsmarkoeren i MusicXML flytter seg ikke for hver note. Noter i
 *     en akkord deler starttid, og `backup`/`forward` spoler fram og
 *     tilbake slik at flere stemmer kan ligge i samme part. Foelges ikke
 *     dette, havner alt paa feil slag.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

// ────────────────────────────────── zip ──────────────────────────────

/** Henter én fil ut av et zip-arkiv, uten eksterne pakker. */
function lesZip(sti, velg) {
  const buf = fs.readFileSync(sti);

  // Finn slutten av sentralkatalogen (EOCD), bakfra.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ikke et zip-arkiv: ' + sti);

  const antall = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let k = 0; k < antall; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metode = buf.readUInt16LE(p + 10);
    const komprimert = buf.readUInt32LE(p + 20);
    const navnLengde = buf.readUInt16LE(p + 28);
    const ekstra = buf.readUInt16LE(p + 30);
    const kommentar = buf.readUInt16LE(p + 32);
    const lokal = buf.readUInt32LE(p + 42);
    const navn = buf.toString('utf8', p + 46, p + 46 + navnLengde);

    if (!velg || velg(navn)) {
      // Det lokale hodet har egne lengder for navn og ekstrafelt.
      const lNavn = buf.readUInt16LE(lokal + 26);
      const lEkstra = buf.readUInt16LE(lokal + 28);
      const start = lokal + 30 + lNavn + lEkstra;
      const data = buf.subarray(start, start + komprimert);
      return {
        navn: navn,
        innhold: metode === 0 ? data : zlib.inflateRawSync(data),
      };
    }
    p += 46 + navnLengde + ekstra + kommentar;
  }
  return null;
}

// ───────────────────────────────── xml ───────────────────────────────

function tag(blokk, navn) {
  const m = blokk.match(new RegExp('<' + navn + '[^>]*>([\\s\\S]*?)</' + navn + '>'));
  return m ? m[1] : null;
}

function tall(blokk, navn, standard) {
  const t = tag(blokk, navn);
  const v = t === null ? NaN : parseFloat(t);
  return isNaN(v) ? standard : v;
}

/**
 * Sangteksten paa én note.
 *
 * `syllabic` sier om stavelsen staar alene, begynner, fortsetter eller
 * avslutter et ord. Uten den blir «Glo» og «ry» to ord i stedet for
 * «Glory» naar teksten settes sammen igjen.
 */
function lyrikk(blokk) {
  const l = tag(blokk, 'lyric');
  if (!l) return null;
  const t = tag(l, 'text');
  if (t === null) return null;
  const rydd = t.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return { ord: rydd, del: tag(l, 'syllabic') || 'single' };
}

const TRINN = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** MusicXML-tonehoeyde til MIDI-nummer. */
function midiAv(pitch) {
  const steg = tag(pitch, 'step');
  if (!steg || !(steg in TRINN)) return null;
  const oktav = tall(pitch, 'octave', 4);
  const alter = tall(pitch, 'alter', 0);
  return (oktav + 1) * 12 + TRINN[steg] + alter;
}

/**
 * Leser ett MusicXML-dokument.
 * @returns {{deler: Array}} én del per stemme, med noter i slag.
 */
/**
 * Taktarten, regnet om til hvor mange fjerdedeler en takt rommer.
 * 4/4 og 2/2 gir begge 4; 3/4 gir 3; 6/8 gir 3.
 */
function slagPerTakt(xml) {
  const m = xml.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)<\/beat-type>/);
  if (!m) return null;
  const slag = parseInt(m[1], 10), type = parseInt(m[2], 10);
  if (!slag || !type) return null;
  return slag * (4 / type);
}

/** Navnene paa delene, i den rekkefoelgen de staar i part-list. */
function delNavn(xml) {
  const liste = xml.match(/<score-part\s+id="[^"]*"[^>]*>[\s\S]*?<\/score-part>/g) || [];
  return liste.map(function (d) {
    const n = tag(d, 'part-name');
    const lyd = tag(d, 'instrument-sound');
    return { navn: (n || '').trim(), lyd: (lyd || '').trim() };
  });
}

/**
 * Noeklene i en `<attributes>`-blokk, per stav.
 *
 * Noekkelen er det som avgjoer om en stav klinger som den staar. En
 * mannsstemme notert i G-noekkel synger en oktav under det skrevne —
 * det er tenorkonvensjonen, og den gjelder enten den lille 8-en er
 * tegnet under noekkelen eller ikke. Derfor leses noekkelen ut her, i
 * stedet for aa gjette oktaven ut av hvilken stemme vi TROR staven er.
 */
function noklerAv(attr) {
  const ut = {};
  const re = /<clef(?:\s+number="(\d+)")?[^>]*>([\s\S]*?)<\/clef>/g;
  let m;
  while ((m = re.exec(attr)) !== null) {
    const nr = parseInt(m[1] || '1', 10);
    ut[nr] = {
      tegn: (tag(m[2], 'sign') || '').toUpperCase(),
      linje: parseInt(tag(m[2], 'line') || '0', 10) || 0,
      oktavskift: parseInt(tag(m[2], 'clef-octave-change') || '0', 10) || 0,
    };
  }
  return ut;
}

function les(xml) {
  const navn = delNavn(xml);
  const deler = [];
  const partRe = /<part\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/part>/g;
  let pm;

  while ((pm = partRe.exec(xml)) !== null) {
    const id = pm[1];
    const kropp = pm[2];
    const noter = [];
    const nokler = {};        // stav -> noekkelen staven begynner med
    const systemstart = [];   // taktnumre der et nytt notesystem begynner
    let divisjoner = 1;
    let taktNr = 0;

    const taktRe = /<measure\s+[^>]*>([\s\S]*?)<\/measure>/g;
    let tm;
    while ((tm = taktRe.exec(kropp)) !== null) {
      const takt = tm[1];
      taktNr++;
      if (takt.indexOf('<system-layout') >= 0 ||
          /<print[^>]*new-system="yes"/.test(takt)) systemstart.push(taktNr);

      // En takt kan ha FLERE `<attributes>`-blokker — divisjonene i den
      // ene, noeklene i den neste. Leses bare den foerste, finnes ingen
      // noekler, og da gjetter vi oktaven i stedet for aa lese den.
      const attrRe = /<attributes>([\s\S]*?)<\/attributes>/g;
      let am;
      while ((am = attrRe.exec(takt)) !== null) {
        const attr = am[1];
        const d = tall(attr, 'divisions', NaN);
        if (!isNaN(d) && d > 0) divisjoner = d;
        // Bare den FOERSTE noekkelen per stav teller. Skifter noekkelen
        // underveis, gjelder den bare derfra, og da er det den staven
        // begynte med som sier hva slags stemme det er.
        const n = noklerAv(attr);
        for (const k in n) if (!nokler[k]) nokler[k] = n[k];
      }

      // Gaa gjennom note, backup og forward i den rekkefoelgen de staar.
      const hendelse = /<note[\s>][\s\S]*?<\/note>|<backup>[\s\S]*?<\/backup>|<forward>[\s\S]*?<\/forward>/g;
      let hm;
      let markor = 0;        // i divisjoner fra taktstart
      let forrigeStart = 0;  // der forrige note begynte, for akkorder

      while ((hm = hendelse.exec(takt)) !== null) {
        const blokk = hm[0];

        if (blokk.startsWith('<backup')) {
          markor -= tall(blokk, 'duration', 0);
          if (markor < 0) markor = 0;
          continue;
        }
        if (blokk.startsWith('<forward')) {
          markor += tall(blokk, 'duration', 0);
          continue;
        }

        const varighet = tall(blokk, 'duration', 0);
        const akkord = /<chord\s*\/>/.test(blokk);
        const pause = /<rest[\s/>]/.test(blokk);
        const start = akkord ? forrigeStart : markor;

        if (!pause) {
          const pitch = tag(blokk, 'pitch');
          const midi = pitch ? midiAv(pitch) : null;
          if (midi !== null) {
            noter.push({
              takt: taktNr,
              slag: Math.round((start / divisjoner) * 1000) / 1000,
              varighet: Math.round((varighet / divisjoner) * 1000) / 1000,
              midi: midi,
              stemme: parseInt(tag(blokk, 'voice') || '1', 10),
              // En del kan ha flere staver (`<staves>2</staves>`), og da
              // er det `<staff>` som sier hvilken linje noten staar paa.
              // Uten dette slaas to staver sammen til én stemme, og
              // bassens toner havner sammen med tenorens.
              stav: parseInt(tag(blokk, 'staff') || '1', 10),
              // Sangteksten paa noten, med merke for om stavelsen henger
              // sammen med den neste. Det trengs for aa sette ordene
              // sammen igjen: «Glo» + «ry» skal bli «Glory», men
              // «Hark!» og «the» skal staa hver for seg.
              tekst: lyrikk(blokk),
            });
          }
        }
        if (!akkord) { forrigeStart = markor; markor += varighet; }
      }
    }
    deler.push({
      id: id, takter: taktNr, noter: noter, nokler: nokler,
      systemstart: systemstart,
      navn: (navn[deler.length] || {}).navn || '',
      lyd: (navn[deler.length] || {}).lyd || '',
    });
  }
  return {
    deler: deler,
    slagPerTakt: slagPerTakt(xml),
    systemer: systemInndeling(xml),
  };
}

/**
 * Hvor mange takter hvert notesystem rommer.
 *
 * Audiveris merker systemstart med et `<system-layout>` i taktens
 * `<print>`. Denne inndelinga er langt mer paalitelig enn den jeg selv
 * finner i bildet, og den er noekkelen til at overlayet kan foelge
 * lyden takt for takt i stedet for aa hoppe.
 */
function systemInndeling(xml) {
  const del = xml.match(/<part\s+id="[^"]+"[^>]*>([\s\S]*?)<\/part>/);
  if (!del) return [];
  const takter = del[1].match(/<measure\s+[^>]*>[\s\S]*?<\/measure>/g) || [];
  const ut = [];
  for (const t of takter) {
    const nytt = t.indexOf('<system-layout') >= 0 ||
                 /<print[^>]*new-system="yes"/.test(t);
    if (nytt || !ut.length) ut.push(0);
    ut[ut.length - 1]++;
  }
  return ut;
}

/** Leser en .mxl-fil (zippet MusicXML). */
function lesFil(sti) {
  if (/\.mxl$/i.test(sti)) {
    const treff = lesZip(sti, (n) => /\.xml$/i.test(n) && !/^META-INF/i.test(n));
    if (!treff) throw new Error('fant ingen XML i ' + sti);
    return les(treff.innhold.toString('utf8'));
  }
  return les(fs.readFileSync(sti, 'utf8'));
}

module.exports = { les, lesFil, lesZip, midiAv, slagPerTakt, delNavn, noklerAv };
