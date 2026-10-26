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

    def do_POST(self):
        if not self.path.startswith("/les"):
            self._svar(404, "ukjent")
            return
        try:
            lengde = int(self.headers.get("content-length") or 0)
        except ValueError:
            lengde = 0
        if lengde <= 0 or lengde > MAKS:
            self._svar(400, "mangler eller for stort bilde")
            return

        bytes_inn = self.rfile.read(lengde)
        type_ = (self.headers.get("content-type") or "").lower()
        endelse = ".png" if "png" in type_ else ".jpg"

        try:
            xml = les_noter(bytes_inn, endelse)
        except Exception as e:                      # noqa: BLE001
            traceback.print_exc()
            self._svar(500, "kunne ikke lese noten: %s" % e)
            return

        self._svar(200, xml, "application/vnd.recordare.musicxml+xml; charset=utf-8")


def main():
    port = int(os.environ.get("PORT", "8080"))
    tjener = ThreadingHTTPServer(("0.0.0.0", port), Behandler)
    sys.stderr.write("notegjenkjenner lytter paa %d\n" % port)
    tjener.serve_forever()


if __name__ == "__main__":
    main()
