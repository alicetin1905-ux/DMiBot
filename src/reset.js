#!/usr/bin/env node
// Puts every coin back to its starting balance and drops open positions
// without recording them as trades. Trade history is kept. Run via
// .github/workflows/reset.yml.
'use strict';

const config = require('../config');
const broker = require('./broker');
const state = require('./state');

const st = state.loadState(config);
st.books = Object.fromEntries(config.SYMBOLS.map((s) => [s, broker.newBook(config.BALANCE_PER_SYMBOL)]));
st.lastBar = {};
st.signals = {};
state.saveState(st);
console.log(`Reset ${config.SYMBOLS.length} coins to $${config.BALANCE_PER_SYMBOL} each.`);
