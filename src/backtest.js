#!/usr/bin/env node
// Replays the strategy over OKX history for every coin, through the same
// broker.step() the live bot uses.
//
//   node src/backtest.js [TIMEFRAME] [DAYS]
//   e.g. node src/backtest.js 2H 730
//
// Candles are cached in .cache so re-runs don't re-download.
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getCandles, BAR_MS } = require('./okx');
const { computeSignals } = require('./dmi');
const broker = require('./broker');

const CACHE = path.join(__dirname, '..', '.cache');
const WARMUP_BARS = 400;

async function loadHistory(symbol, tf, days) {
  const until = Date.now() - days * 8.64e7 - WARMUP_BARS * BAR_MS[tf];
  const file = path.join(CACHE, `${symbol}-SWAP-${tf}-${days}.json`);
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 6 * 3.6e6) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const candles = (await getCandles(symbol, tf, Infinity, { until, pauseMs: 120 })).filter((k) => k.closed);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(candles));
  return candles;
}

function backtestSymbol(symbol, candles, startTs, cfg) {
  const sigs = computeSignals(candles, cfg);
  const book = broker.newBook(cfg.BALANCE_PER_SYMBOL);
  const trades = [];
  let peak = cfg.BALANCE_PER_SYMBOL, maxDD = 0, firstIdx = -1, barsInMarket = 0, bars = 0;

  for (let i = 0; i < candles.length - 1; i++) {
    if (candles[i].t < startTs) continue;
    if (firstIdx < 0) firstIdx = i;
    for (const e of broker.holdBar(book, candles[i], cfg, symbol, BAR_MS[cfg.TIMEFRAME])) trades.push(e);
    const events = broker.step(book, sigs[i], { price: candles[i + 1].o, t: candles[i + 1].t }, cfg, symbol);
    for (const e of events) if (e.type === 'exit') trades.push(e);
    // Drawdown is measured at each candle's low, where leverage bites.
    const eqLow = book.cash + broker.openProfit(book, candles[i + 1].l);
    maxDD = Math.max(maxDD, (peak - eqLow) / peak);
    peak = Math.max(peak, book.cash + broker.openProfit(book, candles[i + 1].c));
    bars++;
    if (book.entries.length) barsInMarket++;
  }
  const last = candles[candles.length - 1];
  const finalEq = book.cash + broker.openProfit(book, last.c);
  const wins = trades.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  return {
    symbol,
    from: firstIdx >= 0 ? candles[firstIdx].t : null,
    to: last.t,
    netPct: (finalEq / cfg.BALANCE_PER_SYMBOL - 1) * 100,
    buyHoldPct: firstIdx >= 0 ? (last.c / candles[firstIdx].c - 1) * 100 : 0,
    trades: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    maxDDPct: maxDD * 100,
    exposurePct: bars ? (barsInMarket / bars) * 100 : 0,
    stopOuts: trades.filter((t) => t.reason.startsWith('stop loss')).length,
    liquidations: trades.filter((t) => t.reason.startsWith('liquidated')).length,
    fundingPaid: trades.reduce((s, t) => s + (t.funding || 0), 0),
    longTrades: trades.filter((t) => t.side === 1).length,
    shortTrades: trades.filter((t) => t.side === -1).length,
    longPnl: trades.filter((t) => t.side === 1).reduce((s, t) => s + t.pnl, 0),
    shortPnl: trades.filter((t) => t.side === -1).reduce((s, t) => s + t.pnl, 0),
    openAtEnd: book.entries.length,
  };
}

async function main() {
  const tf = process.argv[2] || config.TIMEFRAME;
  const days = +(process.argv[3] || 730);
  const cfg = { ...config, TIMEFRAME: tf };
  const startTs = Date.now() - days * 8.64e7;
  const rows = [];

  for (const symbol of cfg.SYMBOLS) {
    try {
      const candles = await loadHistory(symbol, tf, days);
      rows.push(backtestSymbol(symbol, candles, startTs, cfg));
    } catch (err) {
      console.error(`${symbol}: ${err.message}`);
    }
  }

  const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '∞');
  console.log(`\nDMI Toolbox backtest — OKX perps, long${cfg.ALLOW_SHORTS ? '+short' : ' only'}, ${cfg.LEVERAGE}x, ${tf}, last ${days} days, $${cfg.BALANCE_PER_SYMBOL}/coin, ${cfg.COMMISSION_PCT}% fee, ${cfg.FUNDING_PCT_PER_8H}%/8h funding\n`);
  console.log('coin   net%    b&h%   trades(L/S)  win%   PF    maxDD%  exposure%  liq  since');
  for (const r of rows) {
    console.log(
      `${r.symbol.padEnd(5)} ${f(r.netPct).padStart(6)} ${f(r.buyHoldPct).padStart(7)} ` +
      `${(String(r.trades) + ' (' + r.longTrades + '/' + r.shortTrades + ')').padStart(12)} ` +
      `${f(r.winRate).padStart(5)} ${f(r.profitFactor, 2).padStart(5)} ${f(r.maxDDPct).padStart(7)} ${f(r.exposurePct).padStart(9)}  ${String(r.liquidations).padStart(3)}  ${new Date(r.from).toISOString().slice(0, 10)}`
    );
  }
  const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  const allTrades = rows.reduce((s, r) => s + r.trades, 0);
  const allLong = rows.reduce((s, r) => s + r.longTrades, 0);
  const allShort = rows.reduce((s, r) => s + r.shortTrades, 0);
  const profitable = rows.filter((r) => r.netPct > 0).length;
  const beatHold = rows.filter((r) => r.netPct > r.buyHoldPct).length;
  console.log(`\nportfolio (equal $ per coin): net ${f(avg('netPct'))}%  vs buy & hold ${f(avg('buyHoldPct'))}%`);
  const liqs = rows.reduce((s, r) => s + r.liquidations, 0);
  const wiped = rows.filter((r) => r.netPct < -90).length;
  console.log(`liquidations ${liqs} | coins that lost >90% of their balance: ${wiped}`);
  console.log(`avg max drawdown ${f(avg('maxDDPct'))}%  | ${allTrades} trades (${allLong} long / ${allShort} short) | ${profitable}/${rows.length} coins profitable | ${beatHold}/${rows.length} beat buy & hold`);
  const longPnl = rows.reduce((s, r) => s + r.longPnl, 0), shortPnl = rows.reduce((s, r) => s + r.shortPnl, 0);
  console.log(`long P&L $${longPnl.toFixed(0)}  |  short P&L $${shortPnl.toFixed(0)}`);

  const out = path.join(__dirname, '..', 'backtest');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `results-${tf}.json`), JSON.stringify({ tf, days, market: 'OKX USDT perpetuals', allowShorts: cfg.ALLOW_SHORTS, leverage: cfg.LEVERAGE, feePct: cfg.COMMISSION_PCT, fundingPctPer8h: cfg.FUNDING_PCT_PER_8H, generatedAt: new Date().toISOString(), rows }, null, 2) + '\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
