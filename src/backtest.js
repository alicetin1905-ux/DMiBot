#!/usr/bin/env node
// Replays the strategy over OKX history for all 20 coins at once, through
// the same broker the live bot uses. This has to walk every coin in strict
// timestamp order in a single shared account — not one coin at a time —
// because margin for a new trade on one coin comes out of the same pot
// every other coin draws from, so what one coin can do depends on what's
// already open on the others at that exact moment.
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

async function main() {
  const tf = process.argv[2] || config.TIMEFRAME;
  const days = +(process.argv[3] || 730);
  const cfg = { ...config, TIMEFRAME: tf };
  const startTs = Date.now() - days * 8.64e7;
  const barMs = BAR_MS[tf];

  // Load every coin's candles + signals, and index each by timestamp so the
  // joint loop below can look up "this coin's bar at time t" in O(1).
  const bySymbol = {};
  for (const symbol of cfg.SYMBOLS) {
    try {
      const candles = await loadHistory(symbol, tf, days);
      const sigs = computeSignals(candles, cfg);
      const byTime = new Map(candles.map((c, i) => [c.t, i]));
      bySymbol[symbol] = { candles, sigs, byTime, firstCandleAt: null, lastPrice: null };
    } catch (err) {
      console.error(`${symbol}: ${err.message}`);
    }
  }
  const symbols = Object.keys(bySymbol);

  // The global timeline: every timestamp any coin has a candle at, sorted.
  // Coins with a shorter history (ZEC, HYPE) simply have no entry before
  // their listing and are skipped at those timestamps.
  const allTimes = new Set();
  for (const symbol of symbols) for (const c of bySymbol[symbol].candles) allTimes.add(c.t);
  const timeline = Array.from(allTimes).sort((a, b) => a - b);

  const account = broker.newAccount(cfg.TOTAL_BALANCE);
  const trades = [];
  const perSymbol = Object.fromEntries(symbols.map((s) => [s, { trades: [], firstIdx: -1 }]));
  let peak = cfg.TOTAL_BALANCE, maxDD = 0;

  for (let ti = 0; ti < timeline.length - 1; ti++) {
    const t = timeline[ti];
    if (t < startTs) continue;

    for (const symbol of symbols) {
      const S = bySymbol[symbol];
      const idx = S.byTime.get(t);
      if (idx === undefined) continue; // this coin has no candle at this timestamp
      if (S.firstCandleAt === null) S.firstCandleAt = t;
      const candle = S.candles[idx];
      S.lastPrice = candle.c;

      for (const ev of broker.holdBar(account, symbol, candle, cfg, barMs)) {
        if (ev.type === 'exit') { trades.push(ev); perSymbol[symbol].trades.push(ev); }
      }

      const nextIdx = S.byTime.get(t + barMs);
      if (nextIdx === undefined) continue; // no next bar for this coin yet (gap or end of its history)
      const fill = { price: S.candles[nextIdx].o, t: t + barMs };
      for (const ev of broker.step(account, symbol, S.sigs[idx], fill, cfg)) {
        if (ev.type === 'exit') { trades.push(ev); perSymbol[symbol].trades.push(ev); }
      }
    }

    // Equity across the whole account: free cash, margin locked in every
    // open position, and each open position's unrealized P&L at this
    // instant's price.
    let equity = account.cash;
    for (const symbol of symbols) {
      const p = account.positions[symbol];
      if (p) equity += p.margin * (p.qty / p.initialQty) + broker.openProfit(p, bySymbol[symbol].lastPrice);
    }
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
  }

  const rows = symbols.map((symbol) => {
    const S = bySymbol[symbol];
    const t = perSymbol[symbol].trades;
    const wins = t.filter((x) => x.pnl > 0);
    const grossWin = wins.reduce((s, x) => s + x.pnl, 0);
    const grossLoss = -t.filter((x) => x.pnl <= 0).reduce((s, x) => s + x.pnl, 0);
    const last = S.candles[S.candles.length - 1];
    const firstIdx = S.firstCandleAt !== null ? S.byTime.get(S.firstCandleAt) : -1;
    return {
      symbol,
      from: S.firstCandleAt,
      to: last.t,
      buyHoldPct: firstIdx >= 0 ? (last.c / S.candles[firstIdx].c - 1) * 100 : 0,
      trades: t.length,
      winRate: t.length ? (wins.length / t.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      pnl: t.reduce((s, x) => s + x.pnl, 0),
      stopOuts: t.filter((x) => x.reason.includes('stop loss') || x.reason.includes('breakeven stop')).length,
      liquidations: t.filter((x) => x.reason.includes('liquidated')).length,
      tp1: t.filter((x) => x.reason.includes('TP1')).length,
      tp2: t.filter((x) => x.reason.includes('TP2')).length,
      tp3: t.filter((x) => x.reason.includes('TP3')).length,
      fundingPaid: t.reduce((s, x) => s + (x.funding || 0), 0),
      longTrades: t.filter((x) => x.side === 1).length,
      shortTrades: t.filter((x) => x.side === -1).length,
      longPnl: t.filter((x) => x.side === 1).reduce((s, x) => s + x.pnl, 0),
      shortPnl: t.filter((x) => x.side === -1).reduce((s, x) => s + x.pnl, 0),
      openAtEnd: !!account.positions[symbol],
    };
  });

  const finalEquity = account.cash + symbols.reduce((s, symbol) => {
    const p = account.positions[symbol];
    return s + (p ? p.margin * (p.qty / p.initialQty) + broker.openProfit(p, bySymbol[symbol].lastPrice) : 0);
  }, 0);

  const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '∞');
  console.log(`\nDMI Toolbox backtest — OKX perps, long${cfg.ALLOW_SHORTS ? '+short' : ' only'}, ${cfg.LEVERAGE}x, ${tf}, last ${days} days`);
  console.log(`shared $${cfg.TOTAL_BALANCE} account, $${cfg.MARGIN_PER_TRADE}/trade, $${cfg.STOP_LOSS_USD} stop, TP ${cfg.TP_LEVELS.map((l) => l.r + 'R@' + l.closePct + '%').join('/')}, ${cfg.COMMISSION_PCT}% fee, ${cfg.FUNDING_PCT_PER_8H}%/8h funding\n`);
  console.log('coin   P&L $   b&h%   trades(L/S)  win%   PF    stop  liq  TP1/2/3  since');
  for (const r of rows) {
    console.log(
      `${r.symbol.padEnd(5)} ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(0).padStart(6)} ${f(r.buyHoldPct).padStart(7)} ` +
      `${(String(r.trades) + ' (' + r.longTrades + '/' + r.shortTrades + ')').padStart(12)} ` +
      `${f(r.winRate).padStart(5)} ${f(r.profitFactor, 2).padStart(5)} ${String(r.stopOuts).padStart(5)} ${String(r.liquidations).padStart(4)}  ${r.tp1}/${r.tp2}/${r.tp3}      ${r.from ? new Date(r.from).toISOString().slice(0, 10) : 'n/a'}`
    );
  }
  const allTrades = rows.reduce((s, r) => s + r.trades, 0);
  const allLong = rows.reduce((s, r) => s + r.longTrades, 0);
  const allShort = rows.reduce((s, r) => s + r.shortTrades, 0);
  const profitable = rows.filter((r) => r.pnl > 0).length;
  const liqs = rows.reduce((s, r) => s + r.liquidations, 0);
  const netPct = (finalEquity / cfg.TOTAL_BALANCE - 1) * 100;
  console.log(`\naccount: $${cfg.TOTAL_BALANCE} -> $${finalEquity.toFixed(0)} (${netPct >= 0 ? '+' : ''}${netPct.toFixed(1)}%)  |  max drawdown ${(maxDD * 100).toFixed(1)}%`);
  console.log(`${allTrades} trades (${allLong} long / ${allShort} short) | ${liqs} liquidations | ${profitable}/${rows.length} coins net positive`);
  const longPnl = rows.reduce((s, r) => s + r.longPnl, 0), shortPnl = rows.reduce((s, r) => s + r.shortPnl, 0);
  console.log(`long P&L $${longPnl.toFixed(0)}  |  short P&L $${shortPnl.toFixed(0)}`);

  const out = path.join(__dirname, '..', 'backtest');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `results-${tf}.json`), JSON.stringify({
    tf, days, market: 'OKX USDT perpetuals', allowShorts: cfg.ALLOW_SHORTS, leverage: cfg.LEVERAGE,
    totalBalance: cfg.TOTAL_BALANCE, marginPerTrade: cfg.MARGIN_PER_TRADE, maxOpenPositions: cfg.MAX_OPEN_POSITIONS, stopLossUsd: cfg.STOP_LOSS_USD,
    tpLevels: cfg.TP_LEVELS, feePct: cfg.COMMISSION_PCT, fundingPctPer8h: cfg.FUNDING_PCT_PER_8H,
    finalEquity, netPct, maxDDPct: maxDD * 100, liquidations: liqs, generatedAt: new Date().toISOString(), rows,
  }, null, 2) + '\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
