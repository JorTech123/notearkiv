# Notegjenkjenneren, som en container Cloudflare kan kjoere.
#
# Hvorfor den finnes: gjenkjenninga kan ikke bo i en Worker. Modellene
# er 150 MB ONNX og trenger Python. Den kan heller ikke bo paa en
# utviklermaskin — da virker skanningen bare naar noen sitter og kjoerer
# et skript. Her kjoerer den paa serveren, ved siden av resten.
#
# Imaget blir rundt 1,5 GB. Grensa er instansens diskplass: 12 GB paa
# standard-2, saa det er god plass.

FROM python:3.12-slim

# OpenCV trenger disse to; resten av homr er rene hjul.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "homr[cpu]"

# Modellvektene hentes ved BYGGING, ikke ved foerste kjoering.
# «--init» finnes nettopp for dette. Uten den ville foerste side etter
# hver oppstart betalt for en nedlasting paa 150 MB.
RUN homr --init

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 8080
CMD ["python", "-u", "server.py"]
