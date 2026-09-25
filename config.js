// Central knobs for the DMI bot. Everything else reads from here.
//
// Entry signals below are copied from Chart0bserver's "DMI Toolbox Strategy"
// (TradingView, Pine v6, MPL-2.0) exactly as published. Sizing and exits are
// this project's own risk model, not the published script's — see the
// "Risk model" section of the README.
'use strict';

module.exports = {
  // Top 20 coins by market cap (CoinGecko, Sep 2026) that OKX lists as a
  // USDT-margined perpetual swap — stablecoins, wrapped/tokenised assets and exchange
  // tokens with no OKX market (USDT, USDC, WBT, LEO, XMR, ...) skipped.
  SYMBOLS: [
    'BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'TRX', 'ZEC', 'HYPE', 'DOGE', 'LINK',
    'ADA', 'XLM', 'BCH', 'NEAR', 'UNI', 'LTC', 'AVAX', 'SUI', 'HBAR', 'SHIB',
  ],

  // OKX bar size signals are read on. The script's author demos it on BTC
  // 2H; see README "Backtest" for how 1H / 2H / 4H compared.
  TIMEFRAME: '4H',

  // ---- Strategy inputs (script defaults) ----
  DMI: {
    adxSignalLength: 20,   // "ADX Signal Length"
    diLength: 14,          // "DI Length"
    plusSmooth: 4,         // "Smoothed +DI Period"
    smoothAdxPeriod: 8,    // "Smoothed ADX Period"
    smoothMinusPeriod: 8,  // "Smoothed -DI Period"
  },

  // Mandatory requirements for a long entry (all must hold).
  REQUIRE_BULL_PATTERN: true,        // +DI above smoothed -DI since its last cross up
  MAX_CANDLES_SINCE_PLUS_CROSS: 150,
  REQUIRE_PRICE_BELOW_SMA21: false,
  REQUIRE_PRICE_ABOVE_SMA200: true,
  REQUIRE_VOLUME_ABOVE_SMA21: true,

  // Entry triggers (any one fires an entry). The script ships with these
  // two switched on; every other trigger it offers is off by default.
  ENTRY_PLUS_DI_CROSS_30: true,             // +DI crosses above 30
  ENTRY_SMOOTH_ADX_CROSS_SMOOTH_MINUS: true, // smoothed ADX crosses above smoothed -DI

  // Trend-exhaustion exit (long) — closes whatever quantity is still open,
  // on top of the stop/take-profit ladder below.
  EXIT_ON_BEARISH_DI: false,         // +DI crosses under smoothed -DI
  EXIT_ON_ADX_REVERSAL: true,        // ADX crosses under smoothed ADX...
  MIN_ADX_FOR_REVERSAL_EXIT: 38,     // ...while ADX is above this level (shared with shorts)

  // ---- Short side ----
  // The published script is long-only. This is this project's own mirror of
  // its long rules onto the short side (see src/dmi.js) — set false to
  // trade the strategy exactly as published, long-only.
  ALLOW_SHORTS: true,

  // Mandatory requirements for a short entry — the mirror of the long block
  // above (-DI/smoothed +DI in place of +DI/smoothed -DI, price vs. SMA
  // flipped). Volume above its average is shared with the long side.
  REQUIRE_BEAR_PATTERN: true,
  MAX_CANDLES_SINCE_MINUS_CROSS: 150,
  REQUIRE_PRICE_ABOVE_SMA21: false,
  REQUIRE_PRICE_BELOW_SMA200: true,

  // Entry triggers (any one fires a short) — mirror of the long triggers.
  ENTRY_MINUS_DI_CROSS_30: true,
  ENTRY_SMOOTH_ADX_CROSS_SMOOTH_PLUS: true,

  // Exit (short) — mirror of EXIT_ON_BEARISH_DI. ADX reversal above is
  // shared with the long side.
  EXIT_ON_BULLISH_DI: false,         // -DI crosses under smoothed +DI

  // ---- Risk model ----
  // One shared account, not one balance per coin: a $2,000 pot, with a
  // fixed $100 posted as margin on every new trade — so free margin, not a
  // per-coin allocation, is what limits how many positions can be open at
  // once — one per coin, since a coin only ever holds one position (no
  // pyramiding under this model, because stacking entries at different
  // prices would break the fixed-R stop/target math below) — but capped at
  // MAX_OPEN_POSITIONS regardless of how much free margin is left, so the
  // account is never spread across more trades at once than that.
  TOTAL_BALANCE: 2000,
  MARGIN_PER_TRADE: 100,
  MAX_OPEN_POSITIONS: 6,
  LEVERAGE: 10,                  // margin x leverage = $1,000 notional per trade

  // Stop loss is a fixed dollar amount, not a percentage: whatever price
  // move makes the trade lose exactly this much closes the whole position.
  // R (one "risk unit") equals this amount, and the take-profit ladder below
  // is expressed as multiples of it.
  STOP_LOSS_USD: 35,

  // Scaled exit in R-multiples of STOP_LOSS_USD, each closing that % of the
  // position's *original* size. Once TP1 fills, the stop moves to breakeven
  // (entry price) on what's left, so a full stop-out can't happen twice.
  TP_LEVELS: [
    { r: 1.5, closePct: 30 },
    { r: 3, closePct: 30 },
    { r: 4.5, closePct: 40 },
  ],
  MOVE_STOP_TO_BREAKEVEN_AFTER_TP1: true,

  // Isolated margin per trade (this trade's own $100, not the whole
  // account): liquidated if price reaches maintenance margin. At 10x this
  // sits ~9.5% away from entry — far outside the $35 stop above, so it's a
  // safety net for a violent gap, not something that should fire in normal
  // operation.
  MAINT_MARGIN_PCT: 0.5,

  // Longs pay funding on notional. OKX's baseline rate is 0.01% per 8h;
  // real rates vary, and are usually higher when the market is bullish.
  FUNDING_PCT_PER_8H: 0.01,
  COMMISSION_PCT: 0.05,     // per side, on notional (OKX taker fee for swaps)

  // Candles pulled per run — enough for the 200 SMA plus indicator warmup
  // and the 150-candle cross window.
  LOOKBACK_BARS: 600,
};
