// Paper broker that mirrors TradingView's strategy tester for this script:
// long only, orders decided on a bar's close and filled at the next bar's
// open, up to PYRAMIDING stacked entries each sized at ORDER_PCT_OF_EQUITY
// of current equity, commission charged on both sides.
//
// The live bot and the backtester both drive this one function, so what the
// backtest reports is exactly what the live bot would have done.
'use strict';

function newBook(balance) {
  return { cash: balance, entries: [] };
}

function positionQty(book) {
  return book.entries.reduce((s, e) => s + e.qty, 0);
}

function openProfit(book, price) {
  return book.entries.reduce((s, e) => s + e.qty * (price - e.price), 0);
}

// sig: one row from computeSignals(), evaluated at its bar's close.
// fill: { price, t } of the next bar's open, where any order executes.
// Returns the events that happened (for the run log / trade history).
function step(book, sig, fill, cfg, symbol) {
  const events = [];
  const inPosition = book.entries.length > 0;

  // strategy.openprofit_percent = open profit / realised equity.
  const openPct = inPosition ? (openProfit(book, sig.close) / book.cash) * 100 : 0;

  let exitReason = null;
  if (inPosition) {
    if (sig.exitReason) exitReason = sig.exitReason;
    else if (cfg.USE_STOP_LOSS && openPct < -cfg.STOP_LOSS_PCT) exitReason = `stop loss (open loss ${openPct.toFixed(2)}% of equity)`;
    else if (cfg.USE_TAKE_PROFIT && openPct >= cfg.TAKE_PROFIT_PCT) exitReason = `take profit (open profit ${openPct.toFixed(2)}% of equity)`;
  }

  if (exitReason) {
    const qty = positionQty(book);
    const cost = book.entries.reduce((s, e) => s + e.qty * e.price, 0);
    const exitFee = qty * fill.price * cfg.COMMISSION_PCT / 100;
    const entryFees = book.entries.reduce((s, e) => s + e.fee, 0);
    const gross = qty * fill.price - cost;
    // Entry fees were already taken out of cash when each entry filled.
    book.cash += gross - exitFee;
    const pnl = gross - exitFee - entryFees;
    events.push({
      type: 'exit', symbol, reason: exitReason,
      entries: book.entries.length, qty, avgEntry: cost / qty, price: fill.price,
      openedAt: book.entries[0].t, closedAt: fill.t, pnl,
      pnlPct: (pnl / cost) * 100,
    });
    book.entries = [];
    return events;
  }

  if (sig.entry && book.entries.length < cfg.PYRAMIDING) {
    // percent_of_equity sizes off equity including open profit, priced at
    // the signal bar's close.
    const equity = book.cash + openProfit(book, sig.close);
    const qty = (equity * cfg.ORDER_PCT_OF_EQUITY / 100) / sig.close;
    if (qty > 0) {
      const fee = qty * fill.price * cfg.COMMISSION_PCT / 100;
      book.cash -= fee;
      book.entries.push({ qty, price: fill.price, t: fill.t, fee });
      events.push({
        type: 'enter', symbol, reason: sig.entryReason, qty, price: fill.price, t: fill.t,
        layer: book.entries.length, notional: qty * fill.price,
      });
    }
  }
  return events;
}

module.exports = { newBook, step, positionQty, openProfit };
