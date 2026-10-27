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
 * Hvorfor dette er en vanlig DurableObject og ikke «Container»-klassen
 * fra @cloudflare/containers: kontoen her tillater bare den ene
 * planleggingspolicyen.
 *
 *   «This account cannot create applications with the "default"
 *    scheduling policy. Use "durable_object" instead.»
 *
 * Og med «durable_object» velges image og instansstoerrelse av KODEN
 * ved hver oppstart, ikke av wrangler.jsonc. Hjelpeklassen gjoer det
 * motsatte — den regner med at konfigurasjonen bestemmer — saa oppstart,
 * klarmelding og sovevindu staar her i stedet.
 */

import { DurableObject } from 'cloudflare:workers';

const PORT = 8080;

// Et notesett er flere sider som kommer rett etter hverandre. Holder vi
// containeren vaaken noen minutter, slipper side to og tre aa laste
// modellene paa nytt. Etter det sovner den, og da koster den ingenting.
const SOVNER_ETTER = 5 * 60 * 1000;

// Kald oppstart laster 150 MB modellvekter fra containerens egen disk.
// To minutter er slingringsmonn, ikke et maal.
const KLAR_INNEN = 120000;

export class Notegjenkjenner extends DurableObject {
  /**
   * Starter containeren om den sover, og gir tilbake porten naar den
   * faktisk tar imot noe.
   */
  async vekk() {
    const c = this.ctx.container;
    if (!c) throw new Error('ingen container er koblet til Notegjenkjenner');

    if (!c.running) {
      // «images.base» er navnet fra containers[].images i
      // wrangler.jsonc. Wrangler har alt bygget det og festet det til en
      // digest; her velger vi bare hvilket av dem som skal kjoere.
      //
      // Kartet finnes bare under «durable_object»-policyen. Er det tomt,
      // er det nesten alltid fordi utrullinga brukte det gamle
      // «image»-feltet — en feil som ellers ville dukket opp som et
      // uforstaaelig TypeError inne i start().
      if (!c.images || !c.images.base) {
        throw new Error('ctx.container.images.base mangler — sjekk at containers[] i wrangler.jsonc har scheduling_policy "durable_object" og et images-kart');
      }
      c.start({
        image: c.images.base,
        instance: 'standard-2',
        enableInternet: false,
      });
      this.ctx.waitUntil(c.monitor().then(
        () => console.log('notegjenkjenneren sovnet'),
        (feil) => console.log('notegjenkjenneren stoppet:', feil),
      ));
    }

    // Settes ved HVERT kall, ikke bare ved oppstart: etter en utrulling
    // starter Durable Object-en uten sovevindu selv om containeren
    // fortsatt gaar, og da ville den blitt ryddet bort med en gang.
    await c.setInactivityTimeout(SOVNER_ETTER);

    // start() er ferdig lenge foer containeren svarer paa noe. Den har en
    // «/oppe» som svarer naar modellene er lastet, saa vi banker paa den
    // i stedet for aa gjette paa en ventetid.
    const port = c.getTcpPort(PORT);
    const frist = Date.now() + KLAR_INNEN;
    for (let forsok = 0; ; forsok++) {
      let feil = null;
      try {
        const svar = await port.fetch('http://container/oppe');
        if (svar.ok) return port;
        feil = `svarte ${svar.status}`;
      } catch (e) {
        feil = e.message;
      }
      if (Date.now() > frist) {
        throw new Error(`containeren ble ikke klar paa ${KLAR_INNEN / 1000}s (${feil})`);
      }
      await scheduler.wait(Math.min(250 * (forsok + 1), 2000));
    }
  }

  /** Leser ett bilde og gir MusicXML tilbake. */
  async les(bilde, type) {
    const port = await this.vekk();
    const svar = await port.fetch('http://container/les', {
      method: 'POST',
      headers: { 'content-type': type || 'image/jpeg' },
      body: bilde,
    });
    const tekst = await svar.text();
    if (!svar.ok) {
      throw new Error(`gjenkjenneren svarte ${svar.status}: ${tekst.slice(0, 300)}`);
    }
    return tekst;
  }
}

/**
 * Leser ett bilde og gir MusicXML tilbake.
 *
 * Alle sidene i samme stykke gaar til SAMME instans (navngitt etter
 * stykket). Da er modellene alt lastet naar side to kommer.
 */
export async function lesSide(env, stykkeId, bilde, type) {
  const id = env.GJENKJENNER.idFromName('les:' + stykkeId);
  return await env.GJENKJENNER.get(id).les(bilde, type);
}
