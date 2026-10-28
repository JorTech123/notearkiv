/**
 * musicxml.js (Worker) — leser en notefil fra et ordentlig OMR-verktoey.
 *
 * Hvorfor denne finnes: vi skal ikke gjenkjenne noter selv. Det er en
 * egen disiplin, og verktoey som Opuscan er bygget for den. Det de
 * leverer er MusicXML, og det er ren tekst — lett nok aa lese her, uten
 * modeller eller Java.
 *
 * Og fila oppgir ALT vi ellers har maattet gjette:
 *   <part-name>Kor tenor</part-name>
 *   <instrument-sound>voice.tenor</instrument-sound>
 *   <clef-octave-change>-1</clef-octave-change>
 *   <voice>1</voice> / <voice>2</voice>
 *
 * Tidsmarkoeren krever omtanke: noter i en akkord deler starttid, og
 * `backup`/`forward` spoler fram og tilbake slik at flere stemmer kan
 * ligge i samme part. Foelges ikke dette, havner alt paa feil slag.
 */

const TRINN = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function tag(blokk, navn) {
  const m = blokk.match(new RegExp('<' + navn + '[^>]*>([\\s\\S]*?)</' + navn + '>'));
  return m ? m[1] : null;
}

function tall(blokk, navn, standard) {
  const t = tag(blokk, navn);
  const v = t === null ? NaN : parseFloat(t);
  return isNaN(v) ? standard : v;
}

function rydd(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function lyrikk(blokk) {
  const l = tag(blokk, 'lyric');
  if (!l) return null;
  const t = tag(l, 'text');
  if (t === null) return null;
  const ord = rydd(t).trim();
  if (!ord) return null;
  return { ord, del: tag(l, 'syllabic') || 'single' };
}

function midiAv(pitch) {
  const steg = tag(pitch, 'step');
  if (!steg || !(steg in TRINN)) return null;
  return (tall(pitch, 'octave', 4) + 1) * 12 + TRINN[steg] + tall(pitch, 'alter', 0);
}

/**
 * Tonearten, som antall kryss (+) eller b (−).
 *
 * Uten denne maa hver eneste svarte tangent skrives ut med et loest
 * fortegn, og da staar det kryss over hele arket selv om noten er i
 * Ass-dur med fire b-er. Lesinga oppgir den faktisk — «Hark» kommer ut
 * med <fifths>-4</fifths>, akkurat som det staar i noten.
 *
 * Et ark kan ha flere: et taktskifte, eller en feillesing i et enkelt
 * system. Den som gaar igjen oftest er den som gjelder.
 */
function fortegnAv(xml) {
  const re = /<fifths>\s*(-?\d+)\s*<\/fifths>/g;
  const teller = new Map();
  let m;
  while ((m = re.exec(xml)) !== null) {
    // Tallet hentes ut av fangstgruppa. Et forsoek paa aa skrelle vekk
    // taggene med \D+ spiser minustegnet — det er ogsaa et ikke-siffer —
    // og da ble Ass-dur med fire b-er til E-dur med fire kryss.
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && Math.abs(n) <= 7) teller.set(n, (teller.get(n) || 0) + 1);
  }
  if (!teller.size) return null;
  let beste = null, flest = 0;
  for (const [n, antall] of teller) if (antall > flest) { flest = antall; beste = n; }
  return beste;
}

/** Taktarten som antall fjerdedeler per takt. 4/4 og 2/2 gir begge 4. */
function slagPerTakt(xml) {
  const m = xml.match(/<beats>(\d+)<\/beats>\s*<beat-type>(\d+)<\/beat-type>/);
  if (!m) return 4;
  const slag = parseInt(m[1], 10), type = parseInt(m[2], 10);
  return slag && type ? slag * (4 / type) : 4;
}

function noklerAv(attr) {
  const ut = {};
  const re = /<clef(?:\s+number="(\d+)")?[^>]*>([\s\S]*?)<\/clef>/g;
  let m;
  while ((m = re.exec(attr)) !== null) {
    ut[parseInt(m[1] || '1', 10)] = {
      tegn: (tag(m[2], 'sign') || '').toUpperCase(),
      oktavskift: parseInt(tag(m[2], 'clef-octave-change') || '0', 10) || 0,
    };
  }
  return ut;
}

function delNavn(xml) {
  const liste = xml.match(/<score-part\s+id="[^"]*"[^>]*>[\s\S]*?<\/score-part>/g) || [];
  return liste.map((d) => ({
    navn: (tag(d, 'part-name') || '').trim(),
    lyd: (tag(d, 'instrument-sound') || '').trim(),
  }));
}

export function les(xml) {
  const navn = delNavn(xml);
  const deler = [];
  const partRe = /<part\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/part>/g;
  let pm;

  while ((pm = partRe.exec(xml)) !== null) {
    const kropp = pm[2];
    const noter = [];
    const nokler = {};
    let divisjoner = 1;
    let taktNr = 0;

    const taktRe = /<measure\s+[^>]*>([\s\S]*?)<\/measure>/g;
    let tm;
    while ((tm = taktRe.exec(kropp)) !== null) {
      const takt = tm[1];
      taktNr++;

      // En takt kan ha flere <attributes>: divisjoner i den ene,
      // noekler i den neste. Begge maa leses.
      const attrRe = /<attributes>([\s\S]*?)<\/attributes>/g;
      let am;
      while ((am = attrRe.exec(takt)) !== null) {
        const d = tall(am[1], 'divisions', NaN);
        if (!isNaN(d) && d > 0) divisjoner = d;
        const n = noklerAv(am[1]);
        for (const k in n) if (!nokler[k]) nokler[k] = n[k];
      }

      const hendelse = /<note[\s>][\s\S]*?<\/note>|<backup>[\s\S]*?<\/backup>|<forward>[\s\S]*?<\/forward>/g;
      let hm, markor = 0, forrigeStart = 0;
      while ((hm = hendelse.exec(takt)) !== null) {
        const blokk = hm[0];
        if (blokk.startsWith('<backup')) {
          markor = Math.max(0, markor - tall(blokk, 'duration', 0));
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
              midi,
              stemme: parseInt(tag(blokk, 'voice') || '1', 10),
              stav: parseInt(tag(blokk, 'staff') || '1', 10),
              tekst: lyrikk(blokk),
            });
          }
        }
        if (!akkord) { forrigeStart = markor; markor += varighet; }
      }
    }

    const meta = navn[deler.length] || {};
    deler.push({
      id: pm[1], takter: taktNr, noter, nokler,
      navn: meta.navn || '', lyd: meta.lyd || '',
    });
  }

  return {
    deler, slagPerTakt: slagPerTakt(xml), fortegn: fortegnAv(xml),
    tittel: (tag(xml, 'work-title') || '').trim(),
  };
}

/**
 * Pakker ut én fil fra et zip-arkiv (.mxl).
 *
 * Worker-en har ingen zlib, men den har `DecompressionStream`, og det
 * er det samme deflate-formatet.
 */
async function lesZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 70000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const antall = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const tekst = new TextDecoder();

  for (let k = 0; k < antall; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const metode = dv.getUint16(p + 10, true);
    const komprimert = dv.getUint32(p + 20, true);
    const navnLengde = dv.getUint16(p + 28, true);
    const ekstra = dv.getUint16(p + 30, true);
    const kommentar = dv.getUint16(p + 32, true);
    const lokal = dv.getUint32(p + 42, true);
    const navn = tekst.decode(bytes.subarray(p + 46, p + 46 + navnLengde));

    if (/\.(xml|musicxml)$/i.test(navn) && !/^META-INF/i.test(navn)) {
      const lNavn = dv.getUint16(lokal + 26, true);
      const lEkstra = dv.getUint16(lokal + 28, true);
      const start = lokal + 30 + lNavn + lEkstra;
      const data = bytes.subarray(start, start + komprimert);
      if (metode === 0) return tekst.decode(data);
      const ut = new Response(
        new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
      return await ut.text();
    }
    p += 46 + navnLengde + ekstra + kommentar;
  }
  return null;
}

/** Leser en opplastet fil, enten den er .musicxml eller zippet .mxl. */
export async function lesBytes(bytes) {
  // Zip begynner med «PK».
  if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const xml = await lesZip(bytes);
    if (!xml) throw new Error('Fant ingen notefil i arkivet');
    return les(xml);
  }
  return les(new TextDecoder().decode(bytes));
}
