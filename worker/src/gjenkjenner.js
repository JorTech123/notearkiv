/**
 * gjenkjenner.js — containeren som leser noter, sett fra Worker-en.
 *
 * Arbeidsdelinga:
 *
 *   Worker      alltid oppe, millisekunder, gratis aa ha staaende.
 *               Tar imot skanningen, henter sidene, setter sammen
 *               stemmene, lager katalogen.
 *   Container   vaakner bare naar noen skanner. Kjoerer de 150 MB med
 *               modeller som ikke kan bo i en Worker, leser ett bilde,
 *               og sovner igjen.
 *
 * Den sover etter fem minutter uten arbeid. Da koster den ingenting —
 * du betaler bare for de sekundene den faktisk leser.
 */

import { Container } from '@cloudflare/containers';

export class Notegjenkjenner extends Container {
  defaultPort = 8080;

  // Et notesett er flere sider som kommer rett etter hverandre. Holder
  // vi den vaaken noen minutter, slipper side to og tre aa vente paa
  // at modellene lastes paa nytt.
  sleepAfter = '5m';

  onStart() { console.log('notegjenkjenneren er oppe'); }
  onStop() { console.log('notegjenkjenneren sovnet'); }
  onError(feil) { console.log('notegjenkjenneren feilet:', feil); }
}

/**
 * Leser ett bilde og gir MusicXML tilbake.
 *
 * Alle sidene i samme stykke gaar til SAMME instans (navngitt etter
 * stykket). Da er modellene alt lastet naar side to kommer.
 */
export async function lesSide(env, stykkeId, bilde, type) {
  const id = env.GJENKJENNER.idFromName('les:' + stykkeId);
  const instans = env.GJENKJENNER.get(id);

  const svar = await instans.fetch('http://container/les', {
    method: 'POST',
    headers: { 'content-type': type || 'image/jpeg' },
    body: bilde,
  });
  if (!svar.ok) {
    throw new Error(`gjenkjenneren svarte ${svar.status}: ${(await svar.text()).slice(0, 200)}`);
  }
  return await svar.text();
}
