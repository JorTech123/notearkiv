/**
 * worker.js — Notearkiv paa Cloudflare.
 *
 *   GET  /arkiv.json              katalogen visningsverktoeyet leser
 *   GET  /fil/<nokkel>            en lagret side eller PDF
 *   POST /api/skann/start         {tittel} -> {id}
 *   POST /api/skann/<id>/side/<n> raa JPEG i kroppen
 *   POST /api/skann/<id>/pdf      raa PDF i kroppen
 *   POST /api/skann/<id>/ferdig   {antallSider, stemmer} -> katalogoppfoering
 *   DELETE /api/noter/<id>        fjerner et stykke
 *
 * Alt annet serveres som statiske filer fra public/.
 */

import { lager } from './lager.js';
import { importer, importerFlere } from './import.js';
import { lesSide } from './gjenkjenner.js';

export { Notegjenkjenner } from './gjenkjenner.js';

const JSON_HODE = { 'content-type': 'application/json; charset=utf-8' };

function svar(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HODE });
}

/**
 * Standardoppsett for mannskor etter hvor mange staver systemet har.
 * Samme tabell som Node-pipelinen bruker. En kvalifisert gjetning som
 * skal kunne overstyres — ikke noe som er lest ut av notene.
 */
const STEMMEOPPSETT = {
  1: ['melodi'],
  2: ['overstemme', 'understemme'],
  3: ['tenor', 'baryton', 'bass'],
  4: ['1. tenor', '2. tenor', 'baryton', 'bass'],
  5: ['1. tenor', '2. tenor', 'baryton', 'bass', 'piano'],
  6: ['1. tenor', '2. tenor', 'baryton', 'bass', 'piano h.h.', 'piano v.h.'],
};

/** Gjetter stemmene ut fra det systemet som har flest staver. */
function stemmerFra(sider) {
  let flest = 0;
  for (const side of sider) {
    for (const sys of side.systemer || []) {
      if (sys.staver && sys.staver.length > flest) flest = sys.staver.length;
    }
  }
  if (!flest) return [];
  const sett = STEMMEOPPSETT[flest] || STEMMEOPPSETT[4];
  // Merk stavene, ovenfra og ned i hvert system, saa visningen kan ramme
  // inn den stemmen sangeren har valgt.
  for (const side of sider) {
    for (const sys of side.systemer || []) {
      const s = STEMMEOPPSETT[(sys.staver || []).length] || sett;
      (sys.staver || []).forEach((st, k) => { st.stemme = s[k] || `stemme ${k + 1}`; });
    }
  }
  return sett;
}

function slugg(s) {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'uten-tittel';
}

/**
 * Bytter stemmenavn i katalogen til dem brukeren har satt.
 *
 * Navnene brukes som noekler baade i `noter` og i `midi.stemmer`, saa
 * alle tre maa foelges ad. Rekkefoelgen er ovenfra og ned, slik den
 * staar i noten.
 */
async function settStemmenavn(env, katalog) {
  for (const stykke of katalog.stykker || []) {
    let satt;
    try {
      const raa = await env.NOTER.get('stemmer:' + stykke.id);
      satt = raa ? JSON.parse(raa) : null;
    } catch (e) { satt = null; }
    if (!satt || !satt.length) continue;

    const gamle = stykke.stemmer || [];
    const nyeNoter = {}, nyeMidi = {};
    const nye = [];
    // To linjer kan ikke bære samme navn: navnet er noekkelen til baade
    // notene og lydfila, saa en dublett ville slettet den ene stemmen.
    const brukt = new Set();
    gamle.forEach((g, i) => {
      let n = satt[i] || g;
      if (brukt.has(n)) { let k = 2; while (brukt.has(n + ' ' + k)) k++; n = n + ' ' + k; }
      brukt.add(n);
      nye.push(n);
      if (stykke.noter && stykke.noter[g]) nyeNoter[n] = stykke.noter[g];
      if (stykke.midi && stykke.midi.stemmer && stykke.midi.stemmer[g]) {
        nyeMidi[n] = stykke.midi.stemmer[g];
      }
    });
    stykke.stemmer = nye;
    if (stykke.noter) stykke.noter = nyeNoter;
    if (stykke.midi && stykke.midi.stemmer) stykke.midi.stemmer = nyeMidi;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const sti = url.pathname;
    const L = lager(env);

    try {
      // ── katalogen ───────────────────────────────────────────────────
      if (sti === '/arkiv.json') {
        const katalog = await L.lesKatalog();
        await settStemmenavn(env, katalog);
        return new Response(JSON.stringify(katalog), {
          headers: { ...JSON_HODE, 'cache-control': 'no-store' },
        });
      }

      // ── stemmenavn satt for haand ───────────────────────────────────
      //
      // Hvilken stemme hver notelinje er, kan ikke leses paalitelig ut
      // av et skannet partitur. Baade Opuscan og vi selv maa spoerre.
      // Her lagres svaret, og katalogen bruker det heretter.
      if (sti === '/api/stemmer' && request.method === 'POST') {
        const { id, navn } = await request.json();
        if (!id || !Array.isArray(navn)) return svar({ feil: 'Mangler id eller navn' }, 400);
        const rene = navn.map((n) => String(n || '').trim()).filter(Boolean);
        if (!rene.length) return svar({ feil: 'Tomt' }, 400);
        await env.NOTER.put('stemmer:' + id, JSON.stringify(rene));
        return svar({ ok: true, navn: rene });
      }
      if (sti === '/api/stemmer' && request.method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (id) await env.NOTER.delete('stemmer:' + id);
        return svar({ ok: true });
      }

      // ── lagrede filer ───────────────────────────────────────────────
      if (sti.startsWith('/fil/')) {
        const nokkel = decodeURIComponent(sti.slice(5));
        const fil = await L.lesFil(nokkel);
        if (!fil) return new Response('Ikke funnet', { status: 404 });

        const hoder = {
          'content-type': fil.type,
          // En skanning faar alltid ny id (tittel + tidsstempel), saa en
          // noekkel blir aldri skrevet om med nytt innhold. Arkivsidene
          // fra PDF har faste noekler, men endres bare naar hele arkivet
          // kjoeres paa nytt — en bevisst handling.
          'cache-control': 'public, max-age=31536000, immutable',
          etag: fil.etag,
        };
        // Sparer baade baandbredde og R2-lesinger naar iPaden blar
        // tilbake til en side den allerede har.
        if (request.headers.get('if-none-match') === fil.etag) {
          return new Response(null, { status: 304, headers: hoder });
        }
        return new Response(fil.body, { headers: hoder });
      }

      // ── importer en notefil ─────────────────────────────────────────
      //
      // Dette er veien inn for filer fra et verktoey som er bygget for
      // aa lese noter — Opuscan og liknende. Vi gjenkjenner ikke selv:
      // fila oppgir stemmer, oktaver og tekst, og her leses den bare.
      if (sti === '/api/import' && request.method === 'POST') {
        const tittel = (url.searchParams.get('tittel') || '').trim();
        if (!tittel) return svar({ feil: 'Mangler tittel' }, 400);
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (!bytes.length) return svar({ feil: 'Tom fil' }, 400);
        let stykke;
        try {
          stykke = await importer(bytes, {
            id: slugg(tittel) + '-' + Date.now().toString(36),
            tittel,
          });
        } catch (e) {
          return svar({ feil: 'Kunne ikke lese notefila: ' + e.message }, 400);
        }
        await L.lagreStykke(stykke);
        return svar({ ok: true, id: stykke.id, stemmer: stykke.stemmer,
                      takter: stykke.antallTakter });
      }

      // ── les tonene i en skannet note ────────────────────────────────
      //
      // Skanneren lagrer sidene og merker stykket «venter». Her leses
      // de: hver side sendes til containeren, som gir MusicXML tilbake,
      // og den samme importen som brukes for Opuscan-filer setter
      // stemmene sammen.
      //
      // Stemmenavnene brukeren oppga i skanneren beholdes — de staar
      // alt i katalogen, og containeren vet ingenting om dem.
      if (sti === '/api/gjenkjenn' && request.method === 'POST') {
        // Bindingen mangler bare om utrullinga ikke har naadd fram.
        // Si det rett ut i stedet for aa feile uforstaaelig.
        if (!env.GJENKJENNER) {
          return svar({ feil: 'Notegjenkjenneren er ikke rullet ut. Se containers[] i wrangler.jsonc.' }, 503);
        }
        const { id } = await request.json();
        if (!id) return svar({ feil: 'Mangler id' }, 400);

        const katalog = await L.lesKatalog();
        const stykke = (katalog.stykker || []).find((s) => s.id === id);
        if (!stykke) return svar({ feil: 'Fant ikke stykket' }, 404);
        if (!(stykke.sider || []).length) return svar({ feil: 'Stykket har ingen sider' }, 400);

        const xml = [];
        const feilet = [];
        for (const side of stykke.sider) {
          const fil = await L.lesFil(String(side.fil || '').replace(/^fil\//, ''));
          if (!fil) {
            feilet.push({ nr: side.nr, hvorfor: 'sida ligger ikke i lageret' });
            continue;
          }
          try {
            const tekst = await lesSide(env, id, await new Response(fil.body).arrayBuffer(), fil.type);
            xml.push(new TextEncoder().encode(tekst));
          } catch (e) {
            // Aarsaken MAA med. Gjenkjenneren svarer med sin egen
            // feilmelding i kroppen, og uten den staar man igjen med
            // «fikk ingen toner» og ingen vei videre.
            feilet.push({ nr: side.nr, hvorfor: e.message });
          }
        }
        if (!xml.length) {
          return svar({ feil: 'Fikk ingen toner ut av sidene', feilet }, 502);
        }

        let lest;
        try {
          lest = await importerFlere(xml, {
            id: stykke.id, tittel: stykke.tittel,
            // Stemmene brukeren oppga i skanneren. De er bedre enn noe
            // leseren kan utlede, og styrer baade antall og navn.
            stemmer: stykke.stemmer || [],
          });
        } catch (e) {
          return svar({ feil: 'Kunne ikke sette sammen stemmene: ' + e.message }, 500);
        }

        // Sidene, stemmenavnene og resten av oppfoeringa beholdes; bare
        // tonene kommer til.
        const oppdatert = Object.assign({}, stykke, {
          noter: lest.noter,
          slagPerTakt: lest.slagPerTakt,
          antallTakter: Math.max(stykke.antallTakter || 0, lest.antallTakter || 0),
          stemmer: (stykke.stemmer || []).length === lest.stemmer.length
            ? stykke.stemmer
            : lest.stemmer,
          venter: undefined,
          lest: new Date().toISOString(),
        });
        // Stemmenavnene fra skanneren skal styre noekkel-navnene ogsaa.
        if (oppdatert.stemmer !== lest.stemmer) {
          const nye = {};
          oppdatert.stemmer.forEach((n, i) => {
            const fra = lest.stemmer[i];
            if (fra && lest.noter[fra]) nye[n] = lest.noter[fra];
          });
          if (Object.keys(nye).length) oppdatert.noter = nye;
        }
        delete oppdatert.venter;

        await L.lagreStykke(oppdatert);
        return svar({
          ok: true, stemmer: oppdatert.stemmer, takter: oppdatert.antallTakter,
          sider: xml.length, feilet,
        });
      }

      // ── skanning ────────────────────────────────────────────────────
      if (sti === '/api/skann/start' && request.method === 'POST') {
        const { tittel } = await request.json();
        if (!tittel || !tittel.trim()) return svar({ feil: 'Mangler tittel' }, 400);
        const id = `${slugg(tittel)}-${Date.now().toString(36)}`;
        return svar({ id, tittel: tittel.trim() });
      }

      let m = sti.match(/^\/api\/skann\/([^/]+)\/side\/(\d+)$/);
      if (m && request.method === 'POST') {
        const [, id, nr] = m;
        const nokkel = `${id}/side-${String(nr).padStart(3, '0')}.jpg`;
        const data = await request.arrayBuffer();
        if (!data.byteLength) return svar({ feil: 'Tom side' }, 400);
        const fil = await L.lagreFil(nokkel, data, 'image/jpeg');
        return svar({ fil, bytes: data.byteLength });
      }

      m = sti.match(/^\/api\/skann\/([^/]+)\/pdf$/);
      if (m && request.method === 'POST') {
        const id = m[1];
        const data = await request.arrayBuffer();
        const fil = await L.lagreFil(`${id}/noter.pdf`, data, 'application/pdf');
        return svar({ fil, bytes: data.byteLength });
      }

      m = sti.match(/^\/api\/skann\/([^/]+)\/ferdig$/);
      if (m && request.method === 'POST') {
        const id = m[1];
        const kropp = await request.json();
        // Skanneren har allerede kjoert strukturanalysen paa telefonen og
        // sender den med her, saa Worker-en bare tar imot og teller opp.
        const sider = [];
        const mangler = [];
        for (let nr = 1; nr <= (kropp.antallSider || 0); nr++) {
          const s = (kropp.sider || [])[nr - 1] || {};
          if (!(await L.finnesFil(`${id}/side-${String(nr).padStart(3, '0')}.jpg`))) {
            mangler.push(nr);
            continue;
          }
          sider.push({
            nr,
            fil: `fil/${id}/side-${String(nr).padStart(3, '0')}.jpg`,
            bredde: s.bredde || 1700,
            hoyde: s.hoyde || 2400,
            linjeavstand: s.linjeavstand || 20,
            systemer: s.systemer || [],
            antallTakter: s.antallTakter || 0,
          });
        }
        // Et partitur som mangler en side midt i, men nummererer resten
        // fortloepende, ser helt i orden ut i appen. Da er en feil
        // brukeren kan gjoere noe med langt bedre enn et stille hull.
        if (mangler.length) {
          return svar({
            feil: `Disse sidene kom ikke opp: ${mangler.join(', ')}. Skann stykket paa nytt.`,
            mangler,
          }, 409);
        }
        const stemmer = kropp.stemmer && kropp.stemmer.length
          ? kropp.stemmer
          : stemmerFra(sider);
        const stykke = {
          id,
          tittel: kropp.tittel || id,
          stemmer,
          antallSider: sider.length,
          antallTakter: sider.reduce((a, s) => a + (s.antallTakter || 0), 0),
          skannet: new Date().toISOString(),
          // Sidene er lagret, men tonene er ikke lest ennaa. Gjenkjenninga
          // kjoerer ikke her i Worker-en — den krever modeller paa flere
          // hundre megabyte. Merket forteller baade visningen og
          // behandlingsverktoeyet at dette stykket staar i koe.
          venter: 'gjenkjenning',
          // Ikke «kropp.harPdf»: klienten melder at den lastet opp en
          // PDF ogsaa naar opplastinga svarte 500, og da staar det en
          // lenke i katalogen som gir 404. Vi spoer lageret i stedet.
          pdf: (await L.finnesFil(`${id}/noter.pdf`)) ? `fil/${id}/noter.pdf` : null,
          sider,
        };
        await L.lagreStykke(stykke);
        return svar({ ok: true, stykke });
      }

      // ── sletting ────────────────────────────────────────────────────
      m = sti.match(/^\/api\/noter\/([^/]+)$/);
      if (m && request.method === 'DELETE') {
        await L.slettStykke(m[1]);
        return svar({ ok: true });
      }

      // ── statiske filer ──────────────────────────────────────────────
      return env.ASSETS.fetch(request);
    } catch (e) {
      return svar({ feil: e.message }, 500);
    }
  },
};
