'use strict';
/**
 * pdf.js — rastrerer sider fra PDF til raa gratonebuffere.
 *
 * pdfjs kjoerer uten egen worker her, og med isEvalSupported=false:
 * filene kommer utenfra, og de skal ikke faa kjoere kode.
 */

const fs = require('node:fs/promises');
const { createCanvas } = require('@napi-rs/canvas');

let pdfjs = null;
async function lastPdfjs() {
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

/** Aapner et PDF-dokument og sier hvor mange sider det har. */
async function aapne(sti) {
  const lib = await lastPdfjs();
  const data = new Uint8Array(await fs.readFile(sti));
  const doc = await lib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  }).promise;
  return doc;
}

/**
 * Rastrerer én side til gratone.
 * @returns {{g:Uint8Array,b:number,h:number}}
 */
async function rasterSide(doc, nr, dpi = 300, maksLang = 3600) {
  const side = await doc.getPage(nr);
  const raa = side.getViewport({ scale: 1 });

  // Noen PDF-er er skannede bilder der sidestoerrelsen er oppgitt i
  // piksler, ikke punkt. Da gir 300 dpi en side paa 90 megapiksler, og
  // bade minnebruk og deteksjon bryter sammen. Taket holder lengste kant
  // rundt det en A4 i 300 dpi gir, uansett hva PDF-en paastaar.
  const skala = Math.min(dpi / 72, maksLang / Math.max(raa.width, raa.height));
  const utsyn = side.getViewport({ scale: skala });
  const b = Math.round(utsyn.width);
  const h = Math.round(utsyn.height);

  const lerret = createCanvas(b, h);
  const ctx = lerret.getContext('2d');
  // Hvitt papir i bunn: PDF-sider er gjennomsiktige der det ikke er blekk.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, b, h);

  await side.render({ canvasContext: ctx, viewport: utsyn }).promise;

  const rgba = ctx.getImageData(0, 0, b, h).data;
  const g = new Uint8Array(b * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    // Rec. 601-luma. Notene er i praksis graa alt, men skannede sider kan
    // ha fargestikk fra lysstoffroer, og da teller kanalene ulikt.
    g[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  side.cleanup();
  return { g, b, h };
}

/** Alle sider i en PDF, én om gangen saa minnet ikke fylles opp. */
async function* sider(sti, dpi = 300) {
  const doc = await aapne(sti);
  try {
    for (let nr = 1; nr <= doc.numPages; nr++) {
      yield { nr, antall: doc.numPages, ...(await rasterSide(doc, nr, dpi)) };
    }
  } finally {
    await doc.destroy();
  }
}

module.exports = { aapne, rasterSide, sider };
