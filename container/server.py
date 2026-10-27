"""server.py — tar imot et notebilde og gir MusicXML tilbake.

Dette er hele containerens jobb. Den leser arket; alt annet —
stemmefordeling, sammenstilling, lydfiler, katalogen — gjoer Worker-en.
Den delingen er med vilje: Worker-en er billig og alltid oppe, mens
containeren bare vaakner naar noen faktisk skanner noe.

To lesere kjoerer paa det samme bildet, fordi de er gode paa hver sin
ting:

  homr        nevral. Treffer notene, men leser INGEN tekst.
  Audiveris   klassisk. Svakere paa noter, men leser sangteksten.

Begge lesingene sendes tilbake, og Worker-en legger teksten fra den ene
paa tonene fra den andre (se worker/src/import.js). De kjoerer etter
hverandre, ikke samtidig: instansen har én vCPU, saa parallellkjoering
sparer ingen tid — den krever bare minnet til begge paa én gang.

  POST /les        bildebytes i kroppen  ->  JSON {noter, tekst}
  GET  /oppe       er den klar?

Bare standardbiblioteket, saa det er ingenting ekstra aa holde ved like.
"""

import json
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import traceback
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Importeres ved oppstart, ikke ved foerste foresporsel: aa laste
# modellene tar sekunder, og de sekundene skal ikke ligge paa den
# foerste noten noen skanner.
from homr.main import ProcessingConfig, process_image
from homr.music_xml_generator import XmlGeneratorArguments

MAKS = 40 * 1024 * 1024          # et notebilde er aldri i naerheten
AUDIVERIS = "/opt/audiveris/bin/Audiveris"
# Koret synger norsk og engelsk om hverandre. Audiveris tar imot flere
# spraak med pluss mellom.
SPRAAK = os.environ.get("NOTE_SPRAAK", "nor+eng")
# Audiveris kan henge paa et vanskelig ark. Teksten er et tillegg —
# noter uten tekst er mye bedre enn ingen noter — saa den faar en frist
# og blir forlatt om den ikke rekker det.
AUDIVERIS_FRIST = int(os.environ.get("NOTE_TEKSTFRIST", "240"))


def les_tekst(bilde: str, mappe: str):
    """Kjoerer Audiveris paa bildet og graver MusicXML-en ut av .mxl-fila.

    Gir (xml, None) naar det gikk, og (None, grunn) ellers. Ingen
    unntak slipper ut: at teksten mangler skal aldri felle notene.

    Den kjoerer ETTER homr, ikke samtidig. Instansen har én vCPU, saa
    to CPU-tunge oppgaver ved siden av hverandre tar like lang tid
    samlet som etter hverandre — men krever minnet til begge paa én
    gang. Og det er nok til at kjernen rydder bort den ene midt i.
    """
    if not os.path.exists(AUDIVERIS):
        return None, "Audiveris er ikke installert"
    ut = os.path.join(mappe, "aud")
    os.makedirs(ut, exist_ok=True)
    proc = subprocess.Popen(
        [AUDIVERIS, "-batch", "-transcribe", "-export", "-output", ut,
         "-option",
         "org.audiveris.omr.text.Language.defaultSpecification=" + SPRAAK,
         "--", bilde],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        logg = proc.communicate(timeout=AUDIVERIS_FRIST)[0] or ""
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        return None, "Audiveris brukte mer enn %d s" % AUDIVERIS_FRIST
    except Exception as e:                          # noqa: BLE001
        return None, "Audiveris feilet: %s" % e

    # Negativ utfallskode betyr drept av et signal. -9 er SIGKILL, som
    # her stort sett betyr at kjernen tok den for aa frigjoere minne —
    # og da staar det ingen feilmelding noe sted.
    if proc.returncode is not None and proc.returncode < 0:
        return None, "Audiveris ble drept av signal %d" % -proc.returncode

    traff = []
    for rot, _, filer in os.walk(ut):
        for f in filer:
            if f.lower().endswith((".mxl", ".musicxml", ".xml")):
                traff.append(os.path.join(rot, f))
    if not traff:
        # Audiveris melder «Created scores: []» uten feilkode naar den
        # ikke fant noter i det hele tatt. Linjene som sier noe er
        # WARN/ERROR, ikke den siste — den er som regel bare framdrift.
        linjer = [l.strip() for l in logg.splitlines() if l.strip()]
        sier = [l for l in linjer if ("WARN" in l or "ERROR" in l
                                      or "Exception" in l or "Caused by" in l)]
        return None, ("Audiveris (kode %s) eksporterte ingenting. "
                      % proc.returncode) + " | ".join((sier or linjer)[-4:])[:400]

    fil = sorted(traff)[0]
    try:
        if fil.lower().endswith(".mxl"):
            # .mxl er en zip. Scorefila er den ene oppfoeringa som ikke
            # ligger under META-INF.
            with zipfile.ZipFile(fil) as z:
                navn = [n for n in z.namelist()
                        if not n.startswith("META-INF/")
                        and n.lower().endswith((".xml", ".musicxml"))]
                if not navn:
                    return None, "fant ingen score i .mxl-fila"
                return z.read(navn[0]).decode("utf-8", "replace"), None
        with open(fil, "r", encoding="utf-8", errors="replace") as f:
            return f.read(), None
    except Exception as e:                          # noqa: BLE001
        return None, "kunne ikke lese %s: %s" % (os.path.basename(fil), e)


def les_noter(bilde: str) -> str:
    """Kjoerer homr paa ett bilde og gir MusicXML tilbake."""
    # Feltene maa staa akkurat slik homr definerer dem. Containeren har
    # ingen GPU, saa alt kjoerer paa CPU.
    config = ProcessingConfig(
        enable_debug=False,
        enable_cache=False,
        write_staff_positions=False,
        read_staff_positions=False,
        selected_staff=-1,
        transformer_use_gpu=False,
        segnet_use_gpu=False,
        coreml_encoder=False,
    )
    process_image(bilde, config, XmlGeneratorArguments(None, None, None))

    ut = os.path.splitext(bilde)[0] + ".musicxml"
    if not os.path.exists(ut):
        raise RuntimeError("gjenkjenneren skrev ingen fil")
    with open(ut, "r", encoding="utf-8") as f:
        return f.read()


def les(bytes_inn: bytes, filendelse: str = ".jpg") -> dict:
    """Leser ett ark med begge leserne og gir begge lesingene."""
    mappe = tempfile.mkdtemp(prefix="noter-")
    try:
        bilde = os.path.join(mappe, "side" + filendelse)
        with open(bilde, "wb") as f:
            f.write(bytes_inn)

        # Notene foerst: de er poenget, og de skal vaere i hus foer vi
        # bruker tid paa teksten.
        noter = les_noter(bilde)
        tekst, grunn = les_tekst(bilde, mappe)
        if grunn:
            sys.stderr.write("ingen tekst denne gangen: %s\n" % grunn)
        return {"noter": noter, "tekst": tekst, "tekstfeil": grunn}
    finally:
        shutil.rmtree(mappe, ignore_errors=True)


class Behandler(BaseHTTPRequestHandler):
    # Standardloggen skriver én linje per foresporsel til stderr.
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _svar(self, kode, kropp, type_="text/plain; charset=utf-8"):
        data = kropp.encode("utf-8") if isinstance(kropp, str) else kropp
        self.send_response(kode)
        self.send_header("content-type", type_)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/oppe"):
            self._svar(200, "klar")
        elif self.path.startswith("/verktoy"):
            # Finnes begge leserne, og starter Audiveris i det hele tatt?
            # Byggesteget spoer om dette foer noe rulles ut: et image der
            # tekstlesinga mangler, ser ellers helt friskt ut helt til
            # noen skanner et ark og lurer paa hvor teksten ble av.
            svar = {"homr": True, "audiveris": False, "spraak": SPRAAK}
            if os.path.exists(AUDIVERIS):
                try:
                    r = subprocess.run([AUDIVERIS, "-batch", "-help"],
                                       capture_output=True, text=True, timeout=180)
                    ut = ((r.stdout or "") + (r.stderr or "")).strip()
                    # Utfallskoden duger ikke alene: mange kommandolinje-
                    # verktoey gir 1 paa «-help». Det vi trenger aa vite
                    # er om Java-en kom i gang og APPEN svarte, og det
                    # ser vi paa at den skriver sin egen bruksanvisning.
                    svar["audiveris"] = (
                        r.returncode == 0
                        or "-transcribe" in ut
                        or "usage" in ut.lower()
                    )
                    svar["kode"] = r.returncode
                    # Linjene som NAVNGIR feilen, ikke de siste. Et
                    # Java-spor er stort sett rammeverk; det eneste som
                    # sier noe er unntakslinjene oeverst, og de blir
                    # borte om man bare tar halen.
                    viktig = [l.strip() for l in ut.splitlines()
                              if ("Exception" in l or "Error" in l
                                  or l.startswith("Caused by")
                                  or "Unable" in l or "Cannot" in l)]
                    svar["feillinjer"] = viktig[:8]
                    svar["utdrag"] = ut[:400]
                except Exception as e:              # noqa: BLE001
                    svar["utdrag"] = str(e)
            else:
                svar["utdrag"] = AUDIVERIS + " finnes ikke"
            svar["tessdata"] = sorted(
                f for f in os.listdir(os.environ.get("TESSDATA_PREFIX", "/"))
                if f.endswith(".traineddata")
            ) if os.path.isdir(os.environ.get("TESSDATA_PREFIX", "")) else []
            self._svar(200 if svar["audiveris"] else 503,
                       json.dumps(svar, ensure_ascii=False),
                       "application/json; charset=utf-8")
        else:
            self._svar(404, "ukjent")

    def _les_kropp(self):
        """Leser kroppen enten den har content-length eller er chunked.

        BaseHTTPRequestHandler kan bare det foerste. Worker-en sender
        content-length naar kroppen er en ArrayBuffer, men chunked saa
        snart den er en stroem — og da ville vi lest null bytes og
        avvist et helt gyldig bilde.
        """
        if "chunked" in (self.headers.get("transfer-encoding") or "").lower():
            biter = []
            samlet = 0
            while True:
                linje = self.rfile.readline(64).strip()
                storrelse = int(linje.split(b";")[0] or b"0", 16)
                if storrelse == 0:
                    self.rfile.readline()        # den avsluttende CRLF
                    break
                samlet += storrelse
                if samlet > MAKS:
                    raise ValueError("for stort bilde")
                biter.append(self.rfile.read(storrelse))
                self.rfile.readline()            # CRLF etter hver bit
            return b"".join(biter)

        lengde = int(self.headers.get("content-length") or 0)
        if lengde <= 0 or lengde > MAKS:
            raise ValueError("mangler eller for stort bilde")
        return self.rfile.read(lengde)

    def do_POST(self):
        if not self.path.startswith("/les"):
            self._svar(404, "ukjent")
            return
        try:
            bytes_inn = self._les_kropp()
        except ValueError as e:
            self._svar(400, str(e))
            return
        if not bytes_inn:
            self._svar(400, "tom kropp")
            return
        type_ = (self.headers.get("content-type") or "").lower()
        endelse = ".png" if "png" in type_ else ".jpg"

        try:
            resultat = les(bytes_inn, endelse)
        except Exception as e:                      # noqa: BLE001
            traceback.print_exc()
            # De nederste linjene i sporet staar ogsaa i svaret, ikke
            # bare i containerloggen. Worker-en sender dem videre, og da
            # ser man aarsaken i stedet for «kunne ikke lese noten».
            spor = "".join(traceback.format_exc().splitlines(True)[-4:]).strip()
            self._svar(500, "kunne ikke lese noten: %s\n%s" % (e, spor))
            return

        self._svar(200, json.dumps(resultat, ensure_ascii=False),
                   "application/json; charset=utf-8")


class Tjener(ThreadingHTTPServer):
    """ThreadingHTTPServer som ikke slaar opp sitt eget vertsnavn.

    http.server kaller socket.getfqdn() naar den binder. Vertsnavnet i
    en Cloudflare-container er lengre enn de 63 tegnene en DNS-etikett
    kan vaere, og da kaster idna-kodingen:

      UnicodeError: label too long
        File ".../http/server.py", line 142, in server_bind

    Det skjer FOER tjeneren lytter, saa containeren doer ved oppstart,
    hver gang. Utenfra ser det ut som kapasitet — «There is no container
    instance that can be provided to this Durable Object» — for det var
    aldri noe aa rute til.

    Navnet brukes bare i Server-hodet og i feilsider, saa vi setter det
    selv i stedet for aa spoerre DNS om det.
    """

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "notegjenkjenner"
        self.server_port = self.server_address[1]


def main():
    port = int(os.environ.get("PORT", "8080"))
    tjener = Tjener(("0.0.0.0", port), Behandler)
    sys.stderr.write("notegjenkjenner lytter paa %d\n" % port)
    tjener.serve_forever()


if __name__ == "__main__":
    main()
