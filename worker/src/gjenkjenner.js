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

    // «images.base» er navnet fra containers[].images i wrangler.jsonc.
    // Wrangler har alt bygget det og festet det til en digest; her
    // velger vi bare hvilket av dem som skal kjoere.
    //
    // Kartet finnes bare under «durable_object»-policyen. Er det tomt,
    // er det nesten alltid fordi utrullinga brukte det gamle
    // «image»-feltet — en feil som ellers ville dukket opp som et
    // uforstaaelig TypeError inne i start().
    if (!c.images || !c.images.base) {
      throw new Error('ctx.container.images.base mangler — sjekk at containers[] i wrangler.jsonc har scheduling_policy "durable_object" og et images-kart');
    }

    const frist = Date.now() + KLAR_INNEN;
    const sett = new Set();

    // start() MAA kunne forsoekes om igjen. Plattformen har ikke alltid
    // en maskin aa gi med en gang:
    //
    //   «There is no container instance that can be provided to this
    //    Durable Object, try again later»
    //
    // Det er kapasitet, ikke en feil i oppsettet — og «try again later»
    // er bokstavelig ment. Hjelpeklassen vi ikke kan bruke her gjorde
    // dette selv; kaller man start() én gang og bare venter etterpaa,
    // venter man paa noe som aldri ble startet.
    for (let forsok = 0; Date.now() < frist; forsok++) {
      if (!c.running) {
        // Etter en stund forsoekes en mindre stoerrelse. Den er lettere
        // aa finne plass til, og en halv kjerne er bedre enn ingenting.
        const storrelse = forsok < 8 ? 'standard-2' : 'standard-1';
        try {
          c.start({ image: c.images.base, instance: storrelse, enableInternet: false });
          // monitor() avvises naar oppstarten ikke lykkes, og avvisninga
          // MAA hentes — ellers blir det en ubehandlet avvisning per
          // forsoek, og de drukner loggen i feil som ikke betyr noe.
          this.ctx.waitUntil(c.monitor().then(
            () => console.log('notegjenkjenneren sovnet'),
            (feil) => console.log('notegjenkjenneren startet ikke:', feil && feil.message),
          ));
        } catch (e) {
          sett.add('start: ' + e.message);
        }
      }

      // Porten hentes paa nytt ved hvert forsoek. Hentes den én gang
      // foer containeren finnes, peker den paa en instans som aldri kom
      // opp, og den fortsetter aa svare «ingen instans» lenge etter at
      // en ny er oppe og lytter.
      const port = c.getTcpPort(PORT);

      // start() er ferdig lenge foer containeren svarer paa noe. Den har
      // en «/oppe» som svarer naar modellene er lastet, saa vi banker
      // paa den i stedet for aa gjette paa en ventetid.
      try {
        const svar = await port.fetch('http://container/oppe');
        if (svar.ok) {
          // Settes naar den er oppe, og ved hvert kall: etter en
          // utrulling starter Durable Object-en uten sovevindu selv om
          // containeren gaar, og da ryddes den bort med en gang.
          await c.setInactivityTimeout(SOVNER_ETTER);
          return port;
        }
        sett.add(`/oppe svarte ${svar.status}`);
      } catch (e) {
        sett.add(e.message);
      }

      await scheduler.wait(Math.min(400 * (forsok + 1), 3000));
    }
    // ALLE de ulike feilene tas med, ikke bare den siste. Oppstart gaar
    // gjennom flere tilstander — ingen instans, ingen som lytter ennaa,
    // modellene lastes — og med bare den siste ser de helt like ut.
    throw new Error(`containeren ble ikke klar paa ${KLAR_INNEN / 1000}s: ${[...sett].join(' | ')}`);
  }

  /**
   * Leser ett bilde og gir begge lesingene tilbake.
   *
   * {noter}      homr sin MusicXML — tonene
   * {tekst}      Audiveris sin MusicXML — sangteksten, eller null
   * {tekstfeil}  hvorfor teksten mangler, naar den gjoer det
   *
   * At teksten mangler er ingen feil: homr leser ingen tekst i det hele
   * tatt, saa noter uten tekst er det normale minimumet.
   */
  async les(bilde, type) {
    const port = await this.vekk();
    const svar = await port.fetch('http://container/les', {
      method: 'POST',
      headers: { 'content-type': type || 'image/jpeg' },
      body: bilde,
    });
    const kropp = await svar.text();
    if (!svar.ok) {
      throw new Error(`gjenkjenneren svarte ${svar.status}: ${kropp.slice(0, 600)}`);
    }
    try {
      return JSON.parse(kropp);
    } catch (e) {
      throw new Error(`gjenkjenneren svarte noe annet enn JSON: ${kropp.slice(0, 300)}`);
    }
  }
}

/**
 * Leser ett bilde og gir {noter, tekst, tekstfeil} tilbake.
 *
 * Alle sidene i samme stykke gaar til SAMME instans (navngitt etter
 * stykket). Da er modellene alt lastet naar side to kommer.
 */
export async function lesSide(env, stykkeId, bilde, type) {
  const id = env.GJENKJENNER.idFromName('les:' + stykkeId);
  return await env.GJENKJENNER.get(id).les(bilde, type);
}
