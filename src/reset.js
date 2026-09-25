#!/usr/bin/env node
// Puts the account back to its starting balance and drops open positions
// without recording them as trades. Trade history is kept. Run via
// .github/workflows/reset.yml.
'use strict';

const config = require('../config');
const broker = require('./broker');
const state = require('./state');

const st = state.loadState(config);
st.account = broker.newAccount(config.TOTAL_BALANCE);
st.lastBar = {};
st.signals = {};
state.saveState(st);
console.log(`Reset account to $${config.TOTAL_BALANCE}, all positions closed.`);
