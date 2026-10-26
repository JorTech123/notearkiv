# Notearkiv

Opprensking, analyse, skanning og fullskjermsvisning av korneter.
Bygget for mannskor: TBB- og TTBB-arrangementer, ofte fotokopier av
fotokopier.

Live: **https://notearkiv.jortech.no**

## Kjøring

Node ligger ikke på PATH. Prefiks den i samme kommando:

```bash
export PATH="/c/Prosjekter/.tools/node-v24.22.1-win-x64:$PATH"
```

```bash
node tools/src/cli.js data/pdf      # PDF-er og bilder -> data/ut
node tools/src/prov.js <bilde>      # én side, med kontrollbilder
node tools/src/flytt-til-r2.js      # legger sidene og PDF-ene i R2
node tools/src/last-opp.js          # skriver katalogen til KV
node node_modules/wrangler/bin/wrangler.js deploy
```

## Behandlingskjeden

`tools/src/pipeline.js` kjører én side gjennom sju trinn, i denne
rekkefølgen fordi hvert trinn bygger på det forrige:

| # | Trinn | Hvorfor der |
|---|-------|-------------|
| 1 | Kantskygge | Bokryggen fjernes før noe måles, ellers forgifter den både histogram og linjesøk |
| 2 | Deskew | Alt senere forutsetter vannrette notelinjer |
| 3 | Mål notestørrelsen | Linjeavstanden styrer hver eneste terskel under |
| 4 | Flatfelt | Papiret jevnes ut i **gråtone**, ikke binært |
| 5 | Struktur | Binariseres *internt* for å finne linjer, staver, systemer, takter |
| 6 | Sotfjerning | Hardt i margene, varsomt mellom notelinjene |
| 7 | Linjehull | Fyller brudd i notelinjene — tegner dem ikke på nytt |

Det viktigste valget er trinn 4: **utdata er gråtone, ikke svart/hvitt.**
Hard terskling brøt opp bokstaver og notehoder på de verste skannene.
Bakgrunnsdivisjon gir jevnt hvitt papir med teksten bevart intakt.

Trinn 7 var opprinnelig full opptegning av notelinjene. Det var feil: den
strakte linjer ut i marger der deteksjonen bommet, og sida så verre ut enn
originalen. Nå fylles bare hull som har blekk på begge sider.

## PDF inn

`tools/src/pdf.js` rastrerer i 300 dpi, men med **tak på lengste kant**
(~3600 px). Noen PDF-er er skannede bilder der sidestørrelsen er oppgitt i
piksler, ikke punkt; uten taket ble de 8400×12454 px og deteksjonen fant
null staver.

Blanke baksider fra tosidige skann hoppes over, og sidetallene teller
videre uten hull.

## Deteksjon

`tools/src/noter.js` finner strukturen. Tre grep bærer resten:

- **Tynnmaske** (`rens.tynnMaske`) fjerner alt som er tykt i vertikal
  retning før notelinjer søkes. Uten den broer notehoder, halser og
  tekst seg sammen til falske «lange løp».
- **Forventet-posisjon-matching** i `grupperStaver`: senteravstanden
  låses lokalt, og de resterende linjene søkes der de *skal* ligge.
  Mangler én linje, rekonstrueres den — en stav har alltid fem.
- **Taktstreker måles direkte:** andel blekk i kolonnen gjennom hele
  stavens høyde (≥85 %), i de fleste av systemets staver. Å lete etter
  sammenhengende vertikale løp ga 5–10× for mange takter.

## Visning (`public/`)

Rene script-tagger, ingen byggesteg.

- Fullskjerm, sveip sideveis, piltaster og trykksoner
- Overlay som rammer inn valgt stemme og markerer gjeldende takt
- Stemmevalg per stykke, tempo, metronom
- Søk og filtrering på stemme

Overlay-koordinatene ligger i bildets egne piksler, og SVG-laget har
`viewBox` lik bildets mål. Dermed følger markøren uansett skalering.

## Skanning med mobil

`/skann`. Kameraet tar sida, nettleseren kjører samme opprensking som
Node-pipelinen (bakgrunnsdivisjon og nivåjustering, ikke terskling),
finner arket og beskjærer til det. Flere sider legges i en stripe, og
«Lagre» bygger en PDF med jsPDF og laster opp side for side.

**Strukturanalysen kjører på telefonen**, rett etter opprenskingen mens
gråtonebildet fortsatt ligger i minnet. Det koster ~50 ms per side på en
1700×2405-side, og gjør at skannede sider får takt-overlay på linje med
resten av arkivet. Alternativet — å analysere i Worker-en — ville krevd
JPEG-dekoding og CPU-tid per opplasting, uten å gi noe tilbake.

Miniatyren viser taktantallet som tilbakemelding. Står det bare et
sidetall, ble ingen struktur funnet; sida lagres likevel, men uten
overlay. `tools/src/analyser-kv.js` kan kjøre analysen i etterkant:

```bash
node tools/src/analyser-kv.js            # viser hva som mangler
node tools/src/analyser-kv.js --skriv    # analyserer og lagrer
```

Uten kameratilgang virker «Fra galleri» på samme måte.

## Én analyse, to kjøretider

`public/noteanalyse.js` holder hele strukturanalysen og er **delt**
mellom Node-pipelinen og skanneren. Den rører hverken filsystem, sharp
eller DOM — bare `Uint8Array` inn og vanlige objekter ut — og lastes som
klassisk `<script>` i nettleseren og med `require()` i Node.

`tools/src/noter.js` er bare inngangen for Node-koden. Poenget er at det
ikke finnes to utgaver av algoritmen som kan gro fra hverandre.

## Cloudflare

Worker `notearkiv`. Lagringen er delt i to, med vilje:

| | Hva | Hvorfor |
|---|---|---|
| **R2** `FILER` | notesider og PDF-er | store, uforanderlige, strømmes rett ut med lang cache og ETag |
| **KV** `NOTER` | katalogen (`katalog`) | ~85 kB, leses ved hvert sidelast — det KV er raskest til |

Bøtta `notearkiv` ligger i **EU-jurisdiksjonen**. Bindingen må si
`"jurisdiction": "eu"`, ellers finner wrangler den ikke i det hele tatt —
`r2 bucket list` uten flagget gir tom liste.

All lagring går gjennom `worker/src/lager.js`. Resten av Worker-en kjenner
bare det grensesnittet.

| Rute | Gjør |
|------|------|
| `GET /arkiv.json` | katalogen |
| `GET /fil/<nøkkel>` | en lagret side eller PDF |
| `POST /api/skann/start` | `{tittel}` → `{id}` |
| `POST /api/skann/<id>/side/<n>` | rå JPEG |
| `POST /api/skann/<id>/pdf` | rå PDF |
| `POST /api/skann/<id>/ferdig` | lager katalogoppføringen |
| `DELETE /api/noter/<id>` | fjerner et stykke |

Cloudflare Assets dropper `.html`: `/skann.html` gir 307 til `/skann`.

## Lydfiler per stemme

```bash
node tools/src/lag-midi.js        # MIDI av stemmene -> data/ut/midi/
node tools/src/flytt-til-r2.js    # legger dem i R2 sammen med sidene
```

For hvert stykke skrives `alle.mid` pluss én fil per stemme. I
stemmefilene står **din** linje på flygel mens de andre ligger svakt
under som støtte — slik et korøvingsspor skal være. Leseren har en
nedlastingsknapp som følger stemmevalget.

`tools/src/midi.js` skriver filene uten eksterne pakker. Det eneste
som krever omtanke er tidsangivelsene, som ligger som variabel lengde
(7 bit per byte, høyeste bit satt på alle unntatt den siste).

Verifisert mot Opuscans egen MIDI for samme stykke: identiske toner.
Deres tenorspor har 340 toner med begge tenorstemmene blandet; mine er
delt i to navngitte spor på 170 hver, som er mer brukbart til øving.

## Noter inn fra Opuscan (anbefalt)

Opuscan leser disse notene bedre enn noe jeg har bygget — også fra
mobilbilder tatt på skrå. Legg MusicXML-filene i `data/musicxml-inn/`
og kjør:

```bash
node tools/src/noter-fra-import.js
```

Filnavnet avgjør hvilket stykke de hører til, og importerte filer
**overstyrer alltid** Audiveris. Grunnen er at de er bedre på nettopp
det Audiveris må gjette: `<part-name>` gir «Kor tenor» og «Kor bass»,
og `<voice>` skiller 1. og 2. stemme i hver stav. Da trengs ingen
gjetning ut fra tonehøyde.

Målt på «Hark, the Herald Angels Sing»: 668 noter, fire balanserte
stemmer, og bare **10 av 187 takter** måtte justeres for å gå opp —
mot 22–42 % for Audiveris.

## Notegjenkjenning

Notene leses av **Audiveris 5.11**, satt opp portabelt i
`C:Prosjekter.toolsaudiveris` — ingen systeminstallasjon, og den har
med sin egen OpenJDK. Den gir MusicXML med stemmer, nøkler, faste
fortegn, varigheter og pauser.

```bash
node tools/src/audiveris.js              # PDF -> MusicXML (gjenopptakbar)
node tools/src/noter-fra-musicxml.js     # MusicXML -> stemmer i katalogen
```

Tre ting måtte håndteres rundt Audiveris:

| Felle | Hva som gjøres |
|-------|----------------|
| Ett krasjet ark stopper hele boka | Transkriber først, eksporter så **ark for ark** |
| `-output` ignoreres ved eksport fra bokfil | Døp om resultatet med én gang |
| `Comparison method violates its general contract` | `JAVA_TOOL_OPTIONS=-Djava.util.Arrays.useLegacyMergeSort=true` |

Tesseract-dataene må være **standardutgaven**, ikke `tessdata_fast`:
Audiveris ber om den gamle motoren, som fast-utgaven ikke har.

`tools/src/musicxml.js` leser `.mxl` uten eksterne pakker (zip via zlib).
Det viktige der er at tidsmarkøren ikke flytter seg per note: `<chord/>`
deler starttid med forrige, og `<backup>` spoler tilbake så flere stemmer
får plass i samme part. Et sammentrengt mannskorpartitur ligger som to
parts med to stemmer i hver.

Min egen notegjenkjenning ligger igjen i `public/notegjenkjenning.js`.
Den nådde 33,8 % gyldige takter og er erstattet, men brukes fortsatt til
strukturen (staver, systemer, takter) som overlayet bygger på.

## Hva som ikke er ferdig

- **Pianostemmer per stemmegruppe.** Krever notegjenkjenning — tonehøyde
  og varighet lest av bildet. `app.js` leser allerede
  `stykke.noter[stemmenavn]` og spiller det når det finnes; uten notedata
  går markøren med metronom.
- **Toneart.** Feltet finnes i katalogen og i søket, men fylles ikke.
- **Systemgruppering** treffer på omtrent halvparten av sidene.
- **Stemmenavn** gjettes fra antall staver, ikke fra teksten i margen.
  OCR er installert, men ikke koblet på.

## Mapper

```
public/       noteanalyse.js   <- delt analyse, Node + nettleser
              index.html stil.css app.js
              skann.html skann.js
tools/src/    rens.js pipeline.js pdf.js cli.js prov.js
              noter.js         <- inngang til den delte analysen
              last-opp.js flytt-til-r2.js analyser-kv.js
worker/src/   worker.js lager.js
data/pdf/     originalene fra Jotta
data/ut/      rensede sider + arkiv.json
```
