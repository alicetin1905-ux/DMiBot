// Paper futures broker: one shared account (not one balance per coin), a
// fixed $MARGIN_PER_TRADE posted on every entry, a fixed-dollar stop, and a
// 3-tier scaled take-profit in R-multiples of that stop. A coin holds at
// most one position at a time — this fixed-R model doesn't have a clean way
// to average multiple entries at different prices into one R, so there's no
// pyramiding.
//
// account: { cash, positions: { SYMBOL: position | undefined } }
// position: { symbol, side, qty, initialQty, entryPrice, t, margin,
//             stopPrice, tp: [{price, pct, done}], stopMovedToBE,
//             legs: [{qty, price, t, reason, pnl}], entryFee, funding }
//
// The live bot and the backtester both drive these functions, so what the
// backtest reports is exactly what the live bot would have done.
'use strict';

const EIGHT_HOURS = 8 * 3.6e6;

function newAccount(totalBalance) {
  return { cash: totalBalance, positions: {} };
}

function openProfit(position, price) {
  return position.side * (position.qty * (price - position.entryPrice));
}

// One trade's total P&L so far: every leg closed plus whatever's still open
// at `price`, minus fees and funding. Used for reporting, not for sizing.
function positionPnl(position, price) {
  const realized = position.legs.reduce((s, l) => s + l.pnl, 0);
  return realized + openProfit(position, price) - position.entryFee - position.funding;
}

function openPosition(account, symbol, side, price, t, cfg) {
  if (account.positions[symbol]) return null; // already in a trade on this coin
  if (Object.keys(account.positions).length >= cfg.MAX_OPEN_POSITIONS) return null; // at the slot cap
  const margin = cfg.MARGIN_PER_TRADE;
  if (account.cash < margin) return null; // not enough free margin left
  const qty = (margin * cfg.LEVERAGE) / price;
  if (!(qty > 0)) return null;
  const fee = qty * price * cfg.COMMISSION_PCT / 100;
  account.cash -= margin + fee;

  // stopDist is the price move that loses exactly STOP_LOSS_USD on this
  // qty; the take-profit ladder is this same distance times each R-level.
  const stopDist = cfg.STOP_LOSS_USD / qty;
  const stopPrice = side === 1 ? price - stopDist : price + stopDist;
  const tp = cfg.TP_LEVELS.map((lvl) => ({
    price: side === 1 ? price + lvl.r * stopDist : price - lvl.r * stopDist,
    pct: lvl.closePct,
    done: false,
  }));

  account.positions[symbol] = {
    symbol, side, qty, initialQty: qty, entryPrice: price, t, margin,
    stopPrice, initialStopPrice: stopPrice, tp, stopMovedToBE: false,
    legs: [], entryFee: fee, funding: 0,
  };
  return { type: 'enter', symbol, side, qty, price, t, margin, notional: qty * price, leverage: cfg.LEVERAGE, stopPrice, tp };
}

// Closes `qty` of the position at `price`, crediting back that share of the
// margin plus its P&L. Returns the leg (and, if this empties the position,
// the finished trade — the caller checks `done`).
function closePartial(account, position, qty, price, t, reason, cfg) {
  qty = Math.min(qty, position.qty);
  const fee = qty * price * cfg.COMMISSION_PCT / 100;
  const gross = position.side * qty * (price - position.entryPrice);
  const marginBack = position.margin * (qty / position.initialQty);
  account.cash += marginBack + gross - fee;
  position.qty -= qty;
  const leg = { qty, price, t, reason, pnl: gross - fee };
  position.legs.push(leg);

  if (position.qty <= position.initialQty * 1e-6) {
    delete account.positions[position.symbol];
    const totalQty = position.legs.reduce((s, l) => s + l.qty, 0);
    const avgExit = position.legs.reduce((s, l) => s + l.qty * l.price, 0) / totalQty;
    const pnl = position.legs.reduce((s, l) => s + l.pnl, 0) - position.entryFee - position.funding;
    const margin = position.margin;
    return {
      leg,
      trade: {
        type: 'exit', symbol: position.symbol, side: position.side,
        qty: totalQty, avgEntry: position.entryPrice, price: avgExit,
        openedAt: position.t, closedAt: t, pnl, pnlPct: (pnl / margin) * 100,
        leverage: cfg.LEVERAGE, funding: position.funding,
        legs: position.legs, reason: position.legs.map((l) => l.reason).join(' + '),
      },
    };
  }
  return { leg, trade: null };
}

// Runs over one whole candle a position was held through, before that
// candle's close is evaluated by step(): liquidation, then the stop and
// take-profit ladder (all intrabar, using the candle's high/low), then
// funding on whatever quantity is still open. barMs is the timeframe's
// length. Returns the events (enter/partial/exit) that happened.
function holdBar(account, symbol, candle, cfg, barMs) {
  const position = account.positions[symbol];
  if (!position) return [];
  const events = [];
  const side = position.side;
  const mmr = cfg.MAINT_MARGIN_PCT / 100;

  // Isolated margin: liquidation price for *this trade's own* margin, not
  // the whole account — prorated for whatever share of the position (and
  // its margin) is still open after any TP fills. p solves
  // remainingMargin + side*qty*(p-entry) = mmr*qty*p.
  const remainingMargin = position.margin * (position.qty / position.initialQty);
  const cost = position.qty * position.entryPrice;
  const liqPrice = (remainingMargin - side * cost) / (position.qty * (mmr - side));

  // A continuous price path crosses whichever of these two is nearer to
  // entry first — normally the stop (liquidation sits well beyond it), but
  // check rather than assume, in case config values ever put them the other
  // way round. Only the nearer one can matter this bar: if it fires, the
  // position is gone before price could reach the farther one anyway.
  const stopIsNearer = side === 1 ? position.stopPrice >= liqPrice : position.stopPrice <= liqPrice;
  const nearPrice = stopIsNearer ? position.stopPrice : liqPrice;
  const hitNear = side === 1 ? candle.l <= nearPrice : candle.h >= nearPrice;
  if (hitNear) {
    const px = side === 1 ? Math.min(candle.o, nearPrice) : Math.max(candle.o, nearPrice);
    if (stopIsNearer) {
      const reason = position.stopMovedToBE ? 'breakeven stop' : `stop loss (-$${cfg.STOP_LOSS_USD})`;
      const { leg, trade } = closePartial(account, position, position.qty, px, candle.t, reason, cfg);
      events.push({ type: 'partial', symbol, side, reason, qty: leg.qty, price: leg.price, pnl: leg.pnl, remainingQty: 0 });
      if (trade) events.push(trade);
    } else {
      const { trade } = closePartial(account, position, position.qty, px, candle.t, `liquidated at ${cfg.LEVERAGE}x (liq price ${liqPrice.toPrecision(5)})`, cfg);
      events.push(trade);
    }
    return events; // position is gone; nothing left to do this bar
  }

  for (let i = 0; i < position.tp.length; i++) {
    const level = position.tp[i];
    if (level.done || !account.positions[symbol]) continue;
    const hit = side === 1 ? candle.h >= level.price : candle.l <= level.price;
    if (!hit) continue;
    level.done = true;
    const qty = position.initialQty * (level.pct / 100);
    const reason = `TP${i + 1} (${cfg.TP_LEVELS[i].r}R, ${level.pct}%)`;
    const { leg, trade } = closePartial(account, position, qty, level.price, candle.t, reason, cfg);
    events.push({ type: 'partial', symbol, side, reason, qty: leg.qty, price: leg.price, pnl: leg.pnl, remainingQty: trade ? 0 : position.qty });
    if (trade) { events.push(trade); return events; }
    if (i === 0 && cfg.MOVE_STOP_TO_BREAKEVEN_AFTER_TP1 && !position.stopMovedToBE) {
      position.stopMovedToBE = true;
      position.stopPrice = position.entryPrice;
    }
  }

  const stillOpen = account.positions[symbol];
  if (stillOpen) {
    const fee = side * stillOpen.qty * candle.c * (cfg.FUNDING_PCT_PER_8H / 100) * (barMs / EIGHT_HOURS);
    account.cash -= fee;
    stillOpen.funding += fee;
  }
  return events;
}

// sig: one row from computeSignals(), evaluated at its bar's close.
// fill: { price, t } of the next bar's open, where any order executes.
function step(account, symbol, sig, fill, cfg) {
  const events = [];
  const position = account.positions[symbol];

  if (position) {
    const sigExit = position.side === 1 ? sig.exitLongReason : sig.exitShortReason;
    if (sigExit) {
      const { leg, trade } = closePartial(account, position, position.qty, fill.price, fill.t, sigExit, cfg);
      events.push({ type: 'partial', symbol, side: position.side, reason: sigExit, qty: leg.qty, price: leg.price, pnl: leg.pnl, remainingQty: 0 });
      if (trade) events.push(trade);
    }
    return events;
  }

  const side = sig.longEntry ? 1 : sig.shortEntry ? -1 : 0;
  if (side !== 0) {
    const enter = openPosition(account, symbol, side, fill.price, fill.t, cfg);
    if (enter) events.push({ ...enter, reason: side === 1 ? sig.longEntryReason : sig.shortEntryReason });
  }
  return events;
}

module.exports = { newAccount, openPosition, closePartial, holdBar, step, openProfit, positionPnl };
