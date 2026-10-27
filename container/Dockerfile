# Notegjenkjenneren, som en container Cloudflare kan kjoere.
#
# Hvorfor den finnes: gjenkjenninga kan ikke bo i en Worker. Modellene
# er 150 MB ONNX og trenger Python. Den kan heller ikke bo paa en
# utviklermaskin — da virker skanningen bare naar noen sitter og kjoerer
# et skript. Her kjoerer den paa serveren, ved siden av resten.
#
# To lesere, med hver sin styrke:
#   homr        nevral, treffer notene, men leser INGEN tekst
#   Audiveris   klassisk, leser sangteksten under notene
# Begge kjoerer paa samme bilde, og Worker-en legger tekstlesinga over
# notelesinga. Se worker/src/import.js.
#
# Imaget blir rundt 2 GB. Grensa er instansens diskplass: 16 GB paa
# standard-3, saa det er god plass.

FROM python:3.12-slim

# libgl/libglib: OpenCV, som homr bruker.
# libfreetype/libfontconfig: Audiveris tegner opp sider med AWT, og den
# bundlede Java-kjoeretiden finner ingen fonter uten dem.
#
# libgtk-3: Audiveris laster GTK gjennom JNA ved OPPSTART, ogsaa med
# «-batch» og uten skjerm. Uten den doer den foer den har lest ett
# eneste argument:
#   UnsatisfiedLinkError: Unable to load library 'gtk-3'
# Pakka heter «libgtk-3-0t64» etter at Debian doepte om bibliotekene i
# time_t-overgangen, og «libgtk-3-0» foer det — vi tar den som finnes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 libfreetype6 libfontconfig1 \
      curl ca-certificates \
 && (apt-get install -y --no-install-recommends libgtk-3-0t64 \
     || apt-get install -y --no-install-recommends libgtk-3-0) \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "homr[cpu]"

# Modellvektene hentes ved BYGGING, ikke ved foerste kjoering.
# «--init» finnes nettopp for dette. Uten den ville foerste side etter
# hver oppstart betalt for en nedlasting paa 150 MB.
RUN homr --init

# ── Audiveris ────────────────────────────────────────────────────────
#
# Pakka UT av .deb-en, ikke installert: «dpkg-deb -x» legger bare ut
# filene uten aa loese avhengigheter. Det gaar fordi pakka har med ALT
# den trenger — sin egen Java-kjoeretid under lib/runtime, og native
# Tesseract og Leptonica for linux-x86_64 som jar-er under lib/app.
# Et «apt install» ville dratt inn Ubuntu-pakker som ikke finnes her.
ARG AUDIVERIS=5.11.0
RUN curl -fsSL -o /tmp/audiveris.deb \
      "https://github.com/Audiveris/audiveris/releases/download/${AUDIVERIS}/Audiveris-${AUDIVERIS}-ubuntu22.04-x86_64.deb" \
 && dpkg-deb -x /tmp/audiveris.deb / \
 && rm /tmp/audiveris.deb \
 && test -x /opt/audiveris/bin/Audiveris

# Spraakdataene MAA vaere STANDARD-utgaven fra «tessdata», ikke
# «tessdata_fast». Audiveris ber Tesseract om legacy-modus, og
# fast-utgaven har bare LSTM:
#   Could not initialize TessBaseAPI languages: eng in legacy mode
# «nor» trengs fordi koret synger norsk: uten den leses «Ånders Herre,
# en sangers bønn» med et alfabet uten æ, ø og å.
RUN mkdir -p /usr/local/share/tessdata \
 && for s in eng nor; do \
      curl -fsSL -o "/usr/local/share/tessdata/$s.traineddata" \
        "https://github.com/tesseract-ocr/tessdata/raw/main/$s.traineddata"; \
    done

# TESSDATA_PREFIX peker paa mappa som INNEHOLDER .traineddata-filene.
#
# useLegacyMergeSort: «Comparison method violates its general contract»
# rammer mange ark. Det er TimSort som oppdager at en av Audiveris sine
# sammenlikninger ikke er transitiv; den gamle flettesorteringen er
# mindre kresen og kommer gjennom.
# headless: det finnes ingen skjerm her.
#
# -Xmx: Java tar som standard en fjerdedel av maskinens minne, og
# modellene til homr ligger fortsatt i det samme minnet. To gigabyte
# holder godt til ett ark, og da er det rikelig igjen til resten.
#
# ActiveProcessorCount/parallelism: Audiveris gaar parallelt fra og med
# STEMS-steget, og det er NOEYAKTIG der den blir drept med signal 9 i
# denne containeren — hver gang, med sju gigabyte ledig. Java sizer
# traadpuljene og GC-traadene sine etter antall kjerner, saa her
# holdes den til én.
#
# ExitOnOutOfMemoryError gjoer en minnefeil synlig i stedet for at den
# druknes i et halvdoedt program. Den er satt fordi Audiveris paa én av
# sidene blir drept med signal 9 i det den gaar inn i STEMS — uten en
# eneste linje etterpaa. Et tak paa 1 GB ga ingen minnefeil i det hele
# tatt, saa Java-haugen er IKKE det som vokser; taket staar derfor paa
# 2 GB, som er rikelig til ett ark.
ENV TESSDATA_PREFIX=/usr/local/share/tessdata \
    JAVA_TOOL_OPTIONS="-Djava.util.Arrays.useLegacyMergeSort=true -Djava.awt.headless=true -Xmx2g -XX:+ExitOnOutOfMemoryError -XX:ActiveProcessorCount=1 -Djava.util.concurrent.ForkJoinPool.common.parallelism=1"

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 8080
CMD ["python", "-u", "server.py"]
