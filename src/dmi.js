// Port of Chart0bserver's "DMI Toolbox Strategy" signal logic (TradingView,
// Pine v6, Mozilla Public License 2.0). The long-side logic below reproduces
// the matching Pine built-in's semantics — including how it seeds and how
// it treats na — so signals line up bar-for-bar with the published script.
//
// The published script is long-only. The short side (bearishPattern,
// shortEntry/exit, everything with "minus"/"plus" swapped below) is this
// project's own mirror of that same logic, not part of the original script:
// short when -DI does everything the long rules require of +DI, using a
// smoothed +DI computed the same way the script smooths -DI.
'use strict';

const ok = (x) => x !== null && x !== undefined && Number.isFinite(x);

// ta.sma: na unless every value in the window is present.
function sma(v, p) {
  const o = Array(v.length).fill(null);
  let s = 0, run = 0;
  for (let i = 0; i < v.length; i++) {
    if (!ok(v[i])) { s = 0; run = 0; continue; }
    s += v[i]; run++;
    if (run > p) s -= v[i - p];
    if (run >= p) o[i] = s / p;
  }
  return o;
}

// ta.rma / ta.ema: seeded with an SMA of the first `p` values, then
// recursive with alpha = 1/p (rma) or 2/(p+1) (ema).
function recursive(v, p, alpha) {
  const o = Array(v.length).fill(null);
  const seed = sma(v, p);
  for (let i = 0; i < v.length; i++) {
    if (ok(o[i - 1]) && ok(v[i])) o[i] = alpha * v[i] + (1 - alpha) * o[i - 1];
    else if (!ok(o[i - 1])) o[i] = seed[i];
  }
  return o;
}
const rma = (v, p) => recursive(v, p, 1 / p);
const ema = (v, p) => recursive(v, p, 2 / (p + 1));

// fixnan: carry the last present value forward.
function fixnan(v) {
  let last = null;
  return v.map((x) => (ok(x) ? (last = x) : last));
}

const crossover = (a, b, i) => i > 0 && ok(a[i]) && ok(b[i]) && ok(a[i - 1]) && ok(b[i - 1]) && a[i] > b[i] && a[i - 1] <= b[i - 1];
const crossunder = (a, b, i) => i > 0 && ok(a[i]) && ok(b[i]) && ok(a[i - 1]) && ok(b[i - 1]) && a[i] < b[i] && a[i - 1] >= b[i - 1];
const constant = (n, x) => Array(n).fill(x);

// candles: oldest-first [{ t, o, h, l, c, v }], all closed.
// Returns per-bar indicator values plus long/short entry+exit flags
// evaluated at each bar's close — the same point the script evaluates its
// (long-only) signals in a backtest.
function computeSignals(candles, cfg) {
  const n = candles.length;
  const d = cfg.DMI;
  const close = candles.map((k) => k.c);

  const plusDM = Array(n).fill(null), minusDM = Array(n).fill(null), tr = Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const down = candles[i - 1].l - candles[i].l;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
  }

  const trur = rma(tr, d.diLength);
  const div = (a, b) => a.map((x, i) => (ok(x) && ok(b[i]) && b[i] !== 0 ? (100 * x) / b[i] : null));
  const plus = rma(fixnan(div(rma(plusDM, d.diLength), trur)), d.plusSmooth);
  const minus = fixnan(div(rma(minusDM, d.diLength), trur));
  const dx = plus.map((p, i) => {
    if (!ok(p) || !ok(minus[i])) return null;
    const sum = p + minus[i];
    return Math.abs(p - minus[i]) / (sum === 0 ? 1 : sum);
  });
  const adx = ema(dx, d.adxSignalLength).map((x) => (ok(x) ? 100 * x : null));
  const smoothMinus = sma(minus, d.smoothMinusPeriod);
  // Mirror of smoothMinus for the short side — not in the original script.
  const smoothPlus = sma(plus, d.smoothMinusPeriod);
  const smoothADX = sma(adx, d.smoothAdxPeriod);

  const sma21 = sma(close, 21);
  const sma200 = sma(close, 200);
  const volSma21 = sma(candles.map((k) => k.v), 21);
  const thirty = constant(n, 30);

  let candleCounterUp = 0, candleCounterDown = 0;
  let bullishPattern = false, bearishPattern = false;
  const out = [];

  for (let i = 0; i < n; i++) {
    const bullishDI = crossover(plus, smoothMinus, i);
    const bearishDI = crossunder(plus, smoothMinus, i);
    // Mirror: -DI crossing smoothed +DI, the short-side equivalent of bullishDI/bearishDI.
    const bearishDI2 = crossover(minus, smoothPlus, i);
    const bullishDI2 = crossunder(minus, smoothPlus, i);

    if (bullishDI) candleCounterUp = 1;
    else if (bearishDI) candleCounterUp = 0;
    else if (candleCounterUp > 0) candleCounterUp++;

    if (bearishDI2) candleCounterDown = 1;
    else if (bullishDI2) candleCounterDown = 0;
    else if (candleCounterDown > 0) candleCounterDown++;

    if (bullishDI) bullishPattern = true;
    if (bullishPattern && bearishDI) bullishPattern = false;

    if (bearishDI2) bearishPattern = true;
    if (bearishPattern && bullishDI2) bearishPattern = false;

    // Pine comparisons against na are false, so a missing SMA fails its check.
    const mandatoryLong =
      bullishPattern && candleCounterUp <= cfg.MAX_CANDLES_SINCE_PLUS_CROSS &&
      (!cfg.REQUIRE_PRICE_BELOW_SMA21 || (ok(sma21[i]) && close[i] < sma21[i])) &&
      (!cfg.REQUIRE_PRICE_ABOVE_SMA200 || (ok(sma200[i]) && close[i] > sma200[i])) &&
      (!cfg.REQUIRE_VOLUME_ABOVE_SMA21 || (ok(volSma21[i]) && candles[i].v > volSma21[i])) &&
      (!cfg.REQUIRE_BULL_PATTERN || bullishPattern);

    const mandatoryShort = cfg.ALLOW_SHORTS &&
      bearishPattern && candleCounterDown <= cfg.MAX_CANDLES_SINCE_MINUS_CROSS &&
      (!cfg.REQUIRE_PRICE_ABOVE_SMA21 || (ok(sma21[i]) && close[i] > sma21[i])) &&
      (!cfg.REQUIRE_PRICE_BELOW_SMA200 || (ok(sma200[i]) && close[i] < sma200[i])) &&
      (!cfg.REQUIRE_VOLUME_ABOVE_SMA21 || (ok(volSma21[i]) && candles[i].v > volSma21[i])) &&
      (!cfg.REQUIRE_BEAR_PATTERN || bearishPattern);

    const longTriggers = [];
    if (cfg.ENTRY_PLUS_DI_CROSS_30 && crossover(plus, thirty, i)) longTriggers.push('+DI crossed above 30');
    if (cfg.ENTRY_SMOOTH_ADX_CROSS_SMOOTH_MINUS && crossover(smoothADX, smoothMinus, i)) longTriggers.push('smooth ADX crossed above smooth -DI');

    const shortTriggers = [];
    if (cfg.ALLOW_SHORTS) {
      if (cfg.ENTRY_MINUS_DI_CROSS_30 && crossover(minus, thirty, i)) shortTriggers.push('-DI crossed above 30');
      if (cfg.ENTRY_SMOOTH_ADX_CROSS_SMOOTH_PLUS && crossover(smoothADX, smoothPlus, i)) shortTriggers.push('smooth ADX crossed above smooth +DI');
    }

    const volAboveAvg = ok(volSma21[i]) && candles[i].v > volSma21[i];

    // How close each side is to actually firing, for the dashboard's
    // readiness bar — not part of the strategy logic itself. Requires the
    // pattern gate first (with no pattern there's no setup at all), then
    // blends the remaining mandatory gates with how close the trigger lines
    // sit to each other right now.
    //
    // A trigger only fires on the bar a line actually crosses its level —
    // sitting far past it isn't "more ready" (it already fired, or missed
    // its moment and needs a pullback-and-recross). So this uses symmetric
    // distance to the level, not a ratio: 100% exactly at the level, falling
    // off on either side, which reads as "how live is this trigger right
    // now" whether it's about to cross up into range or has just crossed.
    const closeness = (value, level, scale) => (ok(value) && scale > 0 ? Math.max(0, 100 - (Math.abs(value - level) / scale) * 100) : 0);
    const longTriggerPct = Math.max(
      cfg.ENTRY_PLUS_DI_CROSS_30 ? closeness(plus[i], 30, 30) : 0,
      cfg.ENTRY_SMOOTH_ADX_CROSS_SMOOTH_MINUS ? closeness(smoothADX[i], smoothMinus[i], Math.max(smoothMinus[i], 5)) : 0,
    );
    const shortTriggerPct = cfg.ALLOW_SHORTS ? Math.max(
      cfg.ENTRY_MINUS_DI_CROSS_30 ? closeness(minus[i], 30, 30) : 0,
      cfg.ENTRY_SMOOTH_ADX_CROSS_SMOOTH_PLUS ? closeness(smoothADX[i], smoothPlus[i], Math.max(smoothPlus[i], 5)) : 0,
    ) : 0;
    const longGates = [
      !cfg.REQUIRE_PRICE_ABOVE_SMA200 || (ok(sma200[i]) && close[i] > sma200[i]),
      !cfg.REQUIRE_VOLUME_ABOVE_SMA21 || volAboveAvg,
      longTriggerPct / 100,
    ];
    const shortGates = [
      !cfg.REQUIRE_PRICE_BELOW_SMA200 || (ok(sma200[i]) && close[i] < sma200[i]),
      !cfg.REQUIRE_VOLUME_ABOVE_SMA21 || volAboveAvg,
      shortTriggerPct / 100,
    ];
    const avg = (gates) => (gates.reduce((s, g) => s + (g === true ? 1 : g === false ? 0 : g), 0) / gates.length) * 100;
    const longReadyPct = bullishPattern ? Math.round(avg(longGates)) : 0;
    const shortReadyPct = cfg.ALLOW_SHORTS && bearishPattern ? Math.round(avg(shortGates)) : 0;

    let exitLongReason = null;
    if (cfg.EXIT_ON_BEARISH_DI && bearishDI) exitLongReason = '+DI crossed under -DI';
    else if (cfg.EXIT_ON_ADX_REVERSAL && crossunder(adx, smoothADX, i) && adx[i] > cfg.MIN_ADX_FOR_REVERSAL_EXIT) {
      exitLongReason = `ADX trend reversal (ADX ${adx[i].toFixed(1)} crossed under smooth ADX)`;
    }

    let exitShortReason = null;
    if (cfg.EXIT_ON_BULLISH_DI && bullishDI2) exitShortReason = '-DI crossed under +DI';
    else if (cfg.EXIT_ON_ADX_REVERSAL && crossunder(adx, smoothADX, i) && adx[i] > cfg.MIN_ADX_FOR_REVERSAL_EXIT) {
      exitShortReason = `ADX trend reversal (ADX ${adx[i].toFixed(1)} crossed under smooth ADX)`;
    }

    out.push({
      t: candles[i].t,
      close: close[i],
      plus: plus[i], minus: minus[i], adx: adx[i], smoothADX: smoothADX[i], smoothMinus: smoothMinus[i], smoothPlus: smoothPlus[i],
      sma200: sma200[i],
      bullishPattern, bearishPattern, candleCounterUp, candleCounterDown,
      longEntry: mandatoryLong && longTriggers.length > 0,
      longEntryReason: longTriggers.join(' + '),
      shortEntry: mandatoryShort && shortTriggers.length > 0,
      shortEntryReason: shortTriggers.join(' + '),
      exitLongReason,
      exitShortReason,
      volAboveAvg, longReadyPct, shortReadyPct,
    });
  }
  return out;
}

module.exports = { computeSignals, sma, rma, ema, fixnan };
