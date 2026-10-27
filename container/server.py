"""server.py — tar imot et notebilde og gir MusicXML tilbake.

Dette er hele containerens jobb. Den gjenkjenner noter og svarer; alt
annet — stemmefordeling, tekst, lydfiler, katalogen — gjoer Worker-en.
Den delingen er med vilje: Worker-en er billig og alltid oppe, mens
containeren bare vaakner naar noen faktisk skanner noe.

  POST /les        bildebytes i kroppen  ->  MusicXML som tekst
  GET  /oppe       er den klar?

Bare standardbiblioteket, saa det er ingenting ekstra aa holde ved like.
"""

import os
import sys
import tempfile
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Importeres ved oppstart, ikke ved foerste foresporsel: aa laste
# modellene tar sekunder, og de sekundene skal ikke ligge paa den
# foerste noten noen skanner.
from homr.main import ProcessingConfig, process_image
from homr.music_xml_generator import XmlGeneratorArguments

MAKS = 40 * 1024 * 1024          # et notebilde er aldri i naerheten


def les_noter(bytes_inn: bytes, filendelse: str = ".jpg") -> str:
    """Kjoerer gjenkjenneren paa ett bilde og gir MusicXML tilbake."""
    mappe = tempfile.mkdtemp(prefix="noter-")
    bilde = os.path.join(mappe, "side" + filendelse)
    with open(bilde, "wb") as f:
        f.write(bytes_inn)

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
            xml = les_noter(bytes_inn, endelse)
        except Exception as e:                      # noqa: BLE001
            traceback.print_exc()
            # De nederste linjene i sporet staar ogsaa i svaret, ikke
            # bare i containerloggen. Worker-en sender dem videre, og da
            # ser man aarsaken i stedet for «kunne ikke lese noten».
            spor = "".join(traceback.format_exc().splitlines(True)[-4:]).strip()
            self._svar(500, "kunne ikke lese noten: %s\n%s" % (e, spor))
            return

        self._svar(200, xml, "application/vnd.recordare.musicxml+xml; charset=utf-8")


def main():
    port = int(os.environ.get("PORT", "8080"))
    tjener = ThreadingHTTPServer(("0.0.0.0", port), Behandler)
    sys.stderr.write("notegjenkjenner lytter paa %d\n" % port)
    tjener.serve_forever()


if __name__ == "__main__":
    main()
