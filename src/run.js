#!/usr/bin/env node
// Entry point — for every coin, pulls fresh OKX candles, runs the DMI
// Toolbox signals over them, feeds each newly closed bar through the paper
// broker, and saves state. Safe to run as often as you like: a bar is only
// ever processed once (tracked in state/lastBar.json).
//
// All coins share one account (state.account) — margin for a new trade on
// one coin comes out of the same free cash every other coin draws from.
// Coins are still processed one at a time here (simplest for the live bot,
// and correct almost always); the backtester instead walks every coin in
// strict timestamp order, which matters more when replaying a lot of
// history where several coins' entries could otherwise race for margin in
// an order that wouldn't have actually happened live.
'use strict';

const config = require('../config');
const { getCandles, BAR_MS } = require('./okx');
const { computeSignals } = require('./dmi');
const broker = require('./broker');
const state = require('./state');

const MAX_CATCH_UP_BARS = 24;

async function runSymbol(symbol, st) {
  const events = [];
  const raw = await getCandles(symbol, config.TIMEFRAME, config.LOOKBACK_BARS);
  const closed = raw.filter((k) => k.closed);
  const forming = raw.find((k) => !k.closed) || null;
  if (closed.length < 250) return [{ type: 'skip', symbol, reason: `only ${closed.length} closed candles of history` }];

  const sigs = computeSignals(closed, config);
  const account = st.account;
  const last = st.lastBar[symbol];

  // First run for a coin (or after a long pause): start from the latest
  // closed bar instead of replaying history into a live account. A few
  // missed runs are caught up bar by bar, at each bar's real next open.
  let start = last ? closed.findIndex((k) => k.t > last) : closed.length - 1;
  if (start < 0) start = closed.length; // nothing new since last run
  if (closed.length - start > MAX_CATCH_UP_BARS) start = closed.length - 1;

  for (let i = start; i < closed.length; i++) {
    const next = closed[i + 1] || forming;
    if (!next) break; // no next-bar open yet to fill at — pick this bar up next run
    for (const ev of broker.holdBar(account, symbol, closed[i], config, BAR_MS[config.TIMEFRAME])) {
      events.push(ev);
      if (ev.type === 'exit') st.trades.push(ev);
    }
    for (const ev of broker.step(account, symbol, sigs[i], { price: next.o, t: next.t }, config)) {
      events.push(ev);
      if (ev.type === 'exit') st.trades.push(ev);
    }
    st.lastBar[symbol] = closed[i].t;
  }

  const s = sigs[sigs.length - 1];
  const price = forming ? forming.c : s.close;
  const position = account.positions[symbol] || null;
  st.signals[symbol] = {
    at: new Date().toISOString(),
    barTime: s.t,
    close: s.close,
    price,
    plusDI: round(s.plus), minusDI: round(s.minus), adx: round(s.adx),
    smoothADX: round(s.smoothADX), smoothMinusDI: round(s.smoothMinus), smoothPlusDI: round(s.smoothPlus),
    sma200: s.sma200,
    aboveSma200: s.sma200 !== null && s.close > s.sma200,
    bullishPattern: s.bullishPattern,
    bearishPattern: s.bearishPattern,
    candlesSinceCross: position && position.side === -1 ? s.candleCounterDown : s.candleCounterUp,
    longEntrySignal: s.longEntry,
    shortEntrySignal: s.shortEntry,
    exitSignal: position ? (position.side === 1 ? s.exitLongReason : s.exitShortReason) : null,
    side: position ? position.side : 0,
  };
  if (!events.length) {
    events.push({ type: position ? 'hold' : 'flat', symbol, reason: summary(s, position) });
  }
  return events;
}

function summary(s, position) {
  const di = `+DI ${round(s.plus)} / -DI ${round(s.minus)} / ADX ${round(s.adx)}`;
  if (position) return `${position.side === 1 ? 'long' : 'short'} ${position.qty.toFixed(4)} open — ${di}`;
  const why = [];
  if (!s.bullishPattern && !s.bearishPattern) why.push('no +DI/-DI pattern');
  return `${why.length ? why.join(', ') : 'waiting for a trigger'} — ${di}`;
}

const round = (x) => (x === null ? null : Math.round(x * 10) / 10);
const fmt = (x) => (Math.abs(x) >= 1 ? x.toLocaleString('en-US', { maximumFractionDigits: 2 }) : x.toPrecision(4));
const money = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;

async function main() {
  const st = state.loadState(config);
  const all = [];
  for (const symbol of config.SYMBOLS) {
    try {
      all.push(...(await runSymbol(symbol, st)));
    } catch (err) {
      all.push({ type: 'error', symbol, reason: err.message });
    }
  }
  state.saveState(st);

  console.log(`\n=== DMI Toolbox bot (OKX perps ${config.LEVERAGE}x, ${config.TIMEFRAME}) @ ${new Date().toISOString()} ===\n`);
  for (const ev of all) {
    const tag = `[${ev.symbol}]`.padEnd(7);
    if (ev.type === 'enter') console.log(`${tag} ${ev.side === 1 ? 'LONG' : 'SHORT'} @ ${fmt(ev.price)} — $${ev.notional.toFixed(2)} at ${ev.leverage}x ($${ev.margin.toFixed(2)} margin) — ${ev.reason}`);
    else if (ev.type === 'partial') console.log(`${tag} ${ev.side === 1 ? 'LONG' : 'SHORT'} closed ${ev.qty.toFixed(4)} @ ${fmt(ev.price)} | ${money(ev.pnl)} — ${ev.reason}`);
    else if (ev.type === 'exit') console.log(`${tag} FLAT — total ${money(ev.pnl)} (${ev.pnlPct.toFixed(2)}% on margin) — ${ev.reason}`);
    else if (ev.type === 'error') console.log(`${tag} ERROR — ${ev.reason}`);
    else console.log(`${tag} ${ev.type} — ${ev.reason}`);
  }

  const openSymbols = Object.keys(st.account.positions);
  const openMargin = openSymbols.reduce((s, sym) => s + st.account.positions[sym].margin * (st.account.positions[sym].qty / st.account.positions[sym].initialQty), 0);
  const unrealized = openSymbols.reduce((s, sym) => {
    const p = st.account.positions[sym];
    const price = st.signals[sym] ? st.signals[sym].price : p.entryPrice;
    return s + broker.openProfit(p, price);
  }, 0);
  const equity = st.account.cash + openMargin + unrealized;
  console.log(`\nTotal equity $${equity.toFixed(2)} (started $${config.TOTAL_BALANCE}, ${money(equity - config.TOTAL_BALANCE)}) — free cash $${st.account.cash.toFixed(2)}, $${openMargin.toFixed(2)} margin in ${openSymbols.length} open position(s)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
