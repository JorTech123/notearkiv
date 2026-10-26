'use strict';
/**
 * noter.js — strukturanalysen, sett fra Node.
 *
 * Selve algoritmen ligger i `public/noteanalyse.js`, som er delt med
 * skanneren i nettleseren. Den fila rører hverken filsystem, sharp eller
 * DOM, saa den kan lastes begge steder — og da finnes det bare én utgave
 * aa vedlikeholde. Denne fila er bare inngangen for Node-koden.
 */

module.exports = require('../../public/noteanalyse.js');
