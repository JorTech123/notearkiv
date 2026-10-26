'use strict';
/**
 * midi.js — skriver MIDI-filer fra notedataene i katalogen.
 *
 * Ingen eksterne pakker: en MIDI-fil er et hode og noen spor, og
 * hendelsene er noen faa byte hver. Det eneste som krever omtanke er
 * tidsangivelsene, som ligger som variabel lengde (7 bit per byte, med
 * hoeyeste bit satt paa alle unntatt den siste).
 */

const KLOKKER = 480;        // tikk per fjerdedel

/** Variabel lengde, slik MIDI vil ha tidsangivelser. */
function vlq(n) {
  n = Math.max(0, Math.round(n));
  const ut = [n & 0x7f];
  n >>= 7;
  while (n > 0) { ut.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return ut;
}

function tekstHendelse(type, tekst) {
  const b = Buffer.from(tekst, 'latin1');
  return [0x00, 0xff, type, ...vlq(b.length), ...b];
}

/**
 * Bygger ett spor av en liste noter.
 * @param {Array} noter  {takt, slag, varighet, midi}
 * @param {object} valg  {navn, kanal, program, styrke, slagPerTakt}
 */
function spor(noter, valg) {
  const kanal = valg.kanal & 0x0f;
  const hendelser = [];

  // Absolutt tid i tikk, saa alt kan sorteres under ett.
  for (const n of noter) {
    if (!(n.midi >= 0 && n.midi <= 127)) continue;
    const start = ((n.takt - 1) * valg.slagPerTakt + n.slag) * KLOKKER;
    const lengde = Math.max(KLOKKER / 16, n.varighet * KLOKKER);
    hendelser.push({ t: start, d: [0x90 | kanal, n.midi, valg.styrke] });
    // Litt luft foer neste tone, saa de ikke henger i hverandre.
    hendelser.push({ t: start + lengde * 0.92, d: [0x80 | kanal, n.midi, 0] });
  }
  // Stabil rekkefoelge: toneslutt foer tonestart paa samme tidspunkt.
  hendelser.sort((a, b) => a.t - b.t || (a.d[0] & 0xf0) - (b.d[0] & 0xf0));

  const bytes = [];
  bytes.push(...tekstHendelse(0x03, valg.navn || 'stemme'));
  bytes.push(0x00, 0xc0 | kanal, valg.program & 0x7f);

  let forrige = 0;
  for (const h of hendelser) {
    bytes.push(...vlq(h.t - forrige), ...h.d);
    forrige = h.t;
  }
  bytes.push(0x00, 0xff, 0x2f, 0x00);
  return bytes;
}

function sporBlokk(bytes) {
  const hode = Buffer.alloc(8);
  hode.write('MTrk', 0, 'latin1');
  hode.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([hode, Buffer.from(bytes)]);
}

/**
 * Lager en MIDI-fil av stemmene i et stykke.
 *
 * @param {object} stykke   fra katalogen
 * @param {string} framhevet  navnet paa stemmen som skal staa fram,
 *                            eller null for alle like sterkt
 */
function lagMidi(stykke, framhevet) {
  const slagPerTakt = stykke.slagPerTakt || 4;
  const tempo = Math.round(60000000 / (stykke.tempo || 80));

  // Spor 0: bare tempo og tittel.
  const styring = [];
  styring.push(...tekstHendelse(0x03, stykke.tittel || 'Noter'));
  styring.push(0x00, 0xff, 0x51, 0x03,
    (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff);
  styring.push(0x00, 0xff, 0x58, 0x04, slagPerTakt, 0x02, 0x18, 0x08);
  styring.push(0x00, 0xff, 0x2f, 0x00);

  const spordeler = [sporBlokk(styring)];
  const stemmer = stykke.stemmer || [];

  stemmer.forEach((navn, i) => {
    const noter = (stykke.noter || {})[navn];
    if (!noter || !noter.length) return;
    // Oevingsfil: din stemme staar fram paa flygel, de andre ligger
    // svakt under som stoette. Det er slik et korets oevingsspor virker.
    const min = !framhevet || navn === framhevet;
    spordeler.push(sporBlokk(spor(noter, {
      navn: navn,
      kanal: i,
      program: min ? 0 : 52,          // flygel vs. korstemme
      styrke: min ? 100 : 42,
      slagPerTakt: slagPerTakt,
    })));
  });

  const hode = Buffer.alloc(14);
  hode.write('MThd', 0, 'latin1');
  hode.writeUInt32BE(6, 4);
  hode.writeUInt16BE(1, 8);                    // format 1
  hode.writeUInt16BE(spordeler.length, 10);
  hode.writeUInt16BE(KLOKKER, 12);
  return Buffer.concat([hode, ...spordeler]);
}

module.exports = { lagMidi, KLOKKER };
