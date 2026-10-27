/**
 * lager.js — all lagring bak ett grensesnitt.
 *
 * Delt i to med vilje:
 *   R2 (`FILER`)  notesider og PDF-er — store, uforanderlige, serveres
 *                 med lang cache og strømmes rett ut.
 *   KV  (`NOTER`) katalogen — liten og leses ved hvert sidelast, som er
 *                 nøyaktig det KV er raskest til.
 *
 * Resten av Worker-en kjenner bare dette grensesnittet.
 */

const KATALOG = 'katalog';

export function lager(env) {
  return {
    /** Henter hele katalogen. Tom liste foerste gang. */
    async lesKatalog() {
      const raa = await env.NOTER.get(KATALOG, 'json');
      return raa || { generert: null, antall: 0, stykker: [] };
    },

    async skrivKatalog(katalog) {
      katalog.generert = new Date().toISOString();
      katalog.antall = katalog.stykker.length;
      await env.NOTER.put(KATALOG, JSON.stringify(katalog));
      return katalog;
    },

    /** Legger inn eller erstatter ett stykke. */
    async lagreStykke(stykke) {
      const katalog = await this.lesKatalog();
      const i = katalog.stykker.findIndex((s) => s.id === stykke.id);
      if (i >= 0) katalog.stykker[i] = stykke;
      else katalog.stykker.push(stykke);
      katalog.stykker.sort((a, b) => a.tittel.localeCompare(b.tittel, 'nb'));
      return this.skrivKatalog(katalog);
    },

    /**
     * Fjerner et stykke og alle filene under det. Filene ryddes paa
     * prefiks i stedet for paa noekler fra katalogen, saa en halvferdig
     * skanning ikke etterlater seg foreldreloese objekter.
     */
    async slettStykke(id) {
      let markoer;
      do {
        const liste = await env.FILER.list({ prefix: `${id}/`, cursor: markoer });
        if (liste.objects.length) {
          await env.FILER.delete(liste.objects.map((o) => o.key));
        }
        markoer = liste.truncated ? liste.cursor : null;
      } while (markoer);

      const katalog = await this.lesKatalog();
      katalog.stykker = katalog.stykker.filter((s) => s.id !== id);
      return this.skrivKatalog(katalog);
    },

    /** Lagrer en fil og gir tilbake stien den naas paa. */
    async lagreFil(nokkel, data, type) {
      await env.FILER.put(nokkel, data, {
        httpMetadata: { contentType: type },
      });
      return `fil/${nokkel}`;
    },

    /**
     * Sier om en fil faktisk ligger der, uten aa hente bytene.
     *
     * Brukes foer katalogen peker paa noe: en katalog som lover en fil
     * som ikke finnes, gir 404 i appen uten at noe sier fra. Det har
     * skjedd to ganger alt — en gang paa feil noekkel, en gang fordi en
     * opplasting feilet stille.
     */
    async finnesFil(nokkel) {
      return (await env.FILER.head(nokkel)) !== null;
    },

    /**
     * Henter en fil. Returnerer kroppen som stroem, saa store PDF-er
     * aldri samles i minnet i Worker-en.
     */
    async lesFil(nokkel) {
      const obj = await env.FILER.get(nokkel);
      if (!obj) return null;
      return {
        body: obj.body,
        type: (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
        etag: obj.httpEtag,
        storrelse: obj.size,
      };
    },
  };
}
