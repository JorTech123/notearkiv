'use strict';
/**
 * lag-midi.js — lager lydfiler av stemmene.
 *
 * For hvert stykke skrives:
 *   alle.mid        alle stemmer like sterkt
 *   <stemme>.mid    din stemme paa flygel, de andre svakt under
 *
 * Den siste er poenget: under oeving vil du hoere din egen linje
 * tydelig, men fortsatt ha de andre som stoette saa du hoerer hvor du
 * ligger i akkorden.
 *
 *   node tools/src/lag-midi.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { lagMidi } = require('./midi.js');

const UT = 'data/ut';

function slugg(s) {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function main() {
  const arkiv = JSON.parse(fs.readFileSync(`${UT}/arkiv.json`, 'utf8'));
  let filer = 0;

  for (const stykke of arkiv.stykker) {
    if (!stykke.noter) { delete stykke.midi; continue; }
    const mappe = path.join(UT, 'midi', stykke.id);
    fs.mkdirSync(mappe, { recursive: true });

    const alle = lagMidi(stykke, null);
    fs.writeFileSync(path.join(mappe, 'alle.mid'), alle);
    filer++;

    const perStemme = {};
    for (const navn of stykke.stemmer || []) {
      const noter = stykke.noter[navn];
      if (!noter || !noter.length) continue;
      const fil = `${slugg(navn)}.mid`;
      fs.writeFileSync(path.join(mappe, fil), lagMidi(stykke, navn));
      perStemme[navn] = `fil/midi/${stykke.id}/${fil}`;
      filer++;
    }

    stykke.midi = { alle: `fil/midi/${stykke.id}/alle.mid`, stemmer: perStemme };
    const toner = Object.keys(stykke.noter)
      .reduce((a, k) => a + stykke.noter[k].length, 0);
    console.log(
      (stykke.tittel + '                              ').slice(0, 30) +
      String(Object.keys(perStemme).length + 1).padStart(2) + ' filer  ' +
      String(toner).padStart(4) + ' toner  ' +
      (alle.length / 1024).toFixed(1).padStart(6) + ' kB',
    );
  }

  fs.writeFileSync(`${UT}/arkiv.json`, JSON.stringify(arkiv, null, 1), 'utf8');
  console.log(`\n${filer} MIDI-filer skrevet til ${UT}/midi/`);
}

main();
