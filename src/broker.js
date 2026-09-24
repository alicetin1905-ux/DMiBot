// Paper futures broker (USDT-margined perpetuals, long AND short). Mirrors
// TradingView's strategy tester for this script: orders are decided on a
// bar's close and filled at the next bar's open, with up to PYRAMIDING
// stacked entries in one direction. Futures on top of that:
//   - each entry posts ORDER_PCT_OF_EQUITY of equity as margin at LEVERAGE,
//   - each coin's balance is its own cross-margin account, liquidated when
//     equity at a candle's low (long) or high (short) reaches maintenance
//     margin,
//   - a held position pays or receives funding every bar it's open.
//
// A book holds only one direction at a time (side: +1 long, -1 short, 0
// flat) — the mandatory long/short conditions are built to be mutually
// exclusive, so this doesn't get exercised in practice, but a same-bar
// conflict resolves to "no new entry until flat" rather than mixing sides.
//
// The live bot and the backtester both drive these functions, so what the
// backtest reports is exactly what the live bot would have done.
'use strict';

const EIGHT_HOURS = 8 * 3.6e6;

function newBook(balance) {
  return { cash: balance, side: 0, entries: [], funding: 0 };
}

function positionQty(book) {
  return book.entries.reduce((s, e) => s + e.qty, 0);
}

function positionCost(book) {
  return book.entries.reduce((s, e) => s + e.qty * e.price, 0);
}

// Signed open P&L: positive when price has moved in the position's favour.
function openProfit(book, price) {
  return book.side * (positionQty(book) * price - positionCost(book));
}

function closePosition(book, price, t, reason, cfg, symbol) {
  const qty = positionQty(book);
  const cost = positionCost(book);
  const side = book.side;
  const exitFee = qty * price * cfg.COMMISSION_PCT / 100;
  const entryFees = book.entries.reduce((s, e) => s + e.fee, 0);
  const funding = book.funding || 0;
  const gross = side * (qty * price - cost);
  // Entry fees and funding already came out of cash as they were charged.
  book.cash += gross - exitFee;
  // A gap through the liquidation price can't take the account below zero:
  // on an exchange the insurance fund absorbs that.
  if (book.cash < 0) book.cash = 0;
  const pnl = gross - exitFee - entryFees - funding;
  const margin = cost / cfg.LEVERAGE;
  const ev = {
    type: 'exit', symbol, side, reason,
    entries: book.entries.length, qty, avgEntry: cost / qty, price,
    openedAt: book.entries[0].t, closedAt: t, pnl,
    pnlPct: (pnl / margin) * 100, // return on margin posted
    leverage: cfg.LEVERAGE, funding,
  };
  book.entries = [];
  book.side = 0;
  book.funding = 0;
  return ev;
}

// Runs over a whole candle a position was held through, before that
// candle's close is evaluated by step(): liquidation check, then funding.
// barMs is the timeframe's length.
function holdBar(book, candle, cfg, symbol, barMs) {
  if (!book.entries.length) return [];
  const qty = positionQty(book);
  const cost = positionCost(book);
  const side = book.side;
  const mmr = cfg.MAINT_MARGIN_PCT / 100;

  // Price at which equity (cash + side * open P&L) equals maintenance
  // margin: cash + side*(qty*p - cost) = mmr*qty*p, solved for p.
  const liqPrice = (book.cash - side * cost) / (qty * (mmr - side));
  const hitLiq = side === 1 ? candle.l <= liqPrice : candle.h >= liqPrice;
  if (hitLiq) {
    // Gapped straight through it: long fills no better than the open, short
    // no worse.
    const px = side === 1 ? Math.min(candle.o, liqPrice) : Math.max(candle.o, liqPrice);
    return [closePosition(book, px, candle.t, `liquidated at ${cfg.LEVERAGE}x (liq price ${liqPrice.toPrecision(5)})`, cfg, symbol)];
  }

  // Longs pay funding when the rate is positive (the common case); shorts
  // receive it. fee is subtracted from cash either way, so a negative fee
  // (short receiving) increases cash.
  const fee = side * qty * candle.c * (cfg.FUNDING_PCT_PER_8H / 100) * (barMs / EIGHT_HOURS);
  book.cash -= fee;
  book.funding = (book.funding || 0) + fee;
  return [];
}

// sig: one row from computeSignals(), evaluated at its bar's close.
// fill: { price, t } of the next bar's open, where any order executes.
function step(book, sig, fill, cfg, symbol) {
  const events = [];
  const inPosition = book.entries.length > 0;

  // strategy.openprofit_percent = open profit / realised equity.
  const openPct = inPosition && book.cash > 0 ? (openProfit(book, sig.close) / book.cash) * 100 : 0;

  let exitReason = null;
  if (inPosition) {
    const sigExit = book.side === 1 ? sig.exitLongReason : sig.exitShortReason;
    if (sigExit) exitReason = sigExit;
    else if (cfg.USE_STOP_LOSS && openPct < -cfg.STOP_LOSS_PCT) exitReason = `stop loss (open loss ${openPct.toFixed(2)}% of equity)`;
    else if (cfg.USE_TAKE_PROFIT && openPct >= cfg.TAKE_PROFIT_PCT) exitReason = `take profit (open profit ${openPct.toFixed(2)}% of equity)`;
  }

  if (exitReason) {
    events.push(closePosition(book, fill.price, fill.t, exitReason, cfg, symbol));
    return events;
  }

  const side = book.side || (sig.longEntry ? 1 : sig.shortEntry ? -1 : 0);
  const entrySignal = side === 1 ? sig.longEntry : side === -1 ? sig.shortEntry : false;
  const entryReason = side === 1 ? sig.longEntryReason : sig.shortEntryReason;

  if (side !== 0 && entrySignal && book.entries.length < cfg.PYRAMIDING) {
    // Margin is a % of equity including open profit, priced at the signal
    // bar's close (how percent_of_equity sizes); notional is margin x leverage.
    const equity = book.cash + openProfit(book, sig.close);
    const usedMargin = positionCost(book) / cfg.LEVERAGE;
    const margin = Math.min(equity * cfg.ORDER_PCT_OF_EQUITY / 100, equity - usedMargin);
    const qty = (margin * cfg.LEVERAGE) / sig.close;
    // Skip dust: a wiped-out coin (under $1 of free margin) stops trading.
    if (margin >= 1 && qty > 0) {
      const fee = qty * fill.price * cfg.COMMISSION_PCT / 100;
      book.cash -= fee;
      book.side = side;
      book.entries.push({ qty, price: fill.price, t: fill.t, fee });
      events.push({
        type: 'enter', symbol, side, reason: entryReason, qty, price: fill.price, t: fill.t,
        layer: book.entries.length, notional: qty * fill.price, margin: qty * fill.price / cfg.LEVERAGE,
        leverage: cfg.LEVERAGE,
      });
    }
  }
  return events;
}

module.exports = { newBook, step, holdBar, positionQty, positionCost, openProfit };
