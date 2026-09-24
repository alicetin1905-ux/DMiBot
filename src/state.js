// Persistence. GitHub Actions runners are ephemeral, so everything the bot
// remembers between runs lives in state/*.json, which the workflow
// commits back to the repo after each run.
'use strict';

const fs = require('fs');
const path = require('path');
const broker = require('./broker');

const DIR = path.join(__dirname, '..', 'state');
const NAMES = ['books', 'lastBar', 'trades', 'signals'];

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function loadState(config) {
  const books = read('books', {});      // symbol -> { cash, entries: [{ qty, price, t, fee }] }
  for (const s of config.SYMBOLS) if (!books[s]) books[s] = broker.newBook(config.BALANCE_PER_SYMBOL);
  return {
    books,
    lastBar: read('lastBar', {}),       // symbol -> open time (ms) of the last closed bar processed
    trades: read('trades', []),         // append-only closed-trade log
    signals: read('signals', {}),       // symbol -> latest indicator snapshot, for the dashboard
  };
}

function saveState(st) {
  fs.mkdirSync(DIR, { recursive: true });
  for (const name of NAMES) fs.writeFileSync(path.join(DIR, `${name}.json`), JSON.stringify(st[name], null, 2) + '\n');
}

module.exports = { loadState, saveState, DIR };
