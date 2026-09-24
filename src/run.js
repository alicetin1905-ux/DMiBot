#!/usr/bin/env node
// Entry point — for every coin, pulls fresh OKX candles, runs the DMI
// Toolbox signals over them, feeds each newly closed bar through the paper
// broker, and saves state. Safe to run as often as you like: a bar is only
// ever processed once (tracked in state/lastBar.json).
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
  const book = st.books[symbol];
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
    for (const ev of broker.holdBar(book, closed[i], config, symbol, BAR_MS[config.TIMEFRAME])) {
      events.push(ev);
      st.trades.push(ev);
    }
    for (const ev of broker.step(book, sigs[i], { price: next.o, t: next.t }, config, symbol)) {
      events.push(ev);
      if (ev.type === 'exit') st.trades.push(ev);
    }
    st.lastBar[symbol] = closed[i].t;
  }

  const s = sigs[sigs.length - 1];
  const price = forming ? forming.c : s.close;
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
    candlesSinceCross: book.side === -1 ? s.candleCounterDown : s.candleCounterUp,
    longEntrySignal: s.longEntry,
    shortEntrySignal: s.shortEntry,
    exitSignal: book.side === 1 ? s.exitLongReason : book.side === -1 ? s.exitShortReason : null,
    side: book.side,
    equity: book.cash + broker.openProfit(book, price),
  };
  if (!events.length) {
    events.push({ type: book.entries.length ? 'hold' : 'flat', symbol, reason: summary(s, book) });
  }
  return events;
}

function summary(s, book) {
  const di = `+DI ${round(s.plus)} / -DI ${round(s.minus)} / ADX ${round(s.adx)}`;
  if (book.entries.length) return `${book.side === 1 ? 'long' : 'short'} ${book.entries.length} layer(s) open — ${di}`;
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
    if (ev.type === 'enter') console.log(`${tag} ${ev.side === 1 ? 'LONG' : 'SHORT'} layer ${ev.layer}/${config.PYRAMIDING} @ ${fmt(ev.price)} — $${ev.notional.toFixed(2)} at ${ev.leverage}x ($${ev.margin.toFixed(2)} margin) — ${ev.reason}`);
    else if (ev.type === 'exit') console.log(`${tag} CLOSE ${ev.side === 1 ? 'LONG' : 'SHORT'} ${ev.entries} layer(s) @ ${fmt(ev.price)} | ${money(ev.pnl)} (${ev.pnlPct.toFixed(2)}% on margin) — ${ev.reason}`);
    else if (ev.type === 'error') console.log(`${tag} ERROR — ${ev.reason}`);
    else console.log(`${tag} ${ev.type} — ${ev.reason}`);
  }

  let total = 0;
  for (const s of config.SYMBOLS) total += st.signals[s] ? st.signals[s].equity : st.books[s].cash;
  const start = config.SYMBOLS.length * config.BALANCE_PER_SYMBOL;
  console.log(`\nTOTAL equity $${total.toFixed(2)} (started $${start}, ${money(total - start)})`);
}

main().catch((err) => { console.error(err); process.exit(1); });
