// Central knobs for the DMI bot. Everything else reads from here.
//
// Strategy defaults below are copied from Chart0bserver's "DMI Toolbox
// Strategy" (TradingView, Pine v6, MPL-2.0) exactly as published, so this
// bot trades the same signals that script shows with its default inputs.
'use strict';

module.exports = {
  // Top 20 coins by market cap (CoinGecko, Sep 2026) that OKX lists as a
  // USDT spot pair — stablecoins, wrapped/tokenised assets and exchange
  // tokens with no OKX market (USDT, USDC, WBT, LEO, XMR, ...) skipped.
  SYMBOLS: [
    'BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'TRX', 'ZEC', 'HYPE', 'DOGE', 'LINK',
    'ADA', 'XLM', 'BCH', 'NEAR', 'UNI', 'LTC', 'AVAX', 'SUI', 'HBAR', 'SHIB',
  ],

  // Each coin trades out of its own isolated paper balance, the same way a
  // TradingView strategy tester run is one symbol against its own capital.
  BALANCE_PER_SYMBOL: 1000,

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

  // Exits.
  EXIT_ON_BEARISH_DI: false,         // +DI crosses under smoothed -DI
  EXIT_ON_ADX_REVERSAL: true,        // ADX crosses under smoothed ADX...
  MIN_ADX_FOR_REVERSAL_EXIT: 38,     // ...while ADX is above this level
  USE_STOP_LOSS: true,
  STOP_LOSS_PCT: 2.5,                // open loss as % of realised equity (strategy.openprofit_percent)
  USE_TAKE_PROFIT: false,
  TAKE_PROFIT_PCT: 8,

  // ---- Position sizing / costs (script's strategy() header) ----
  ORDER_PCT_OF_EQUITY: 10,  // default_qty_value=10, percent_of_equity
  PYRAMIDING: 5,            // up to 5 stacked entries per coin
  COMMISSION_PCT: 0.1,      // per side

  // Candles pulled per run — enough for the 200 SMA plus indicator warmup
  // and the 150-candle cross window.
  LOOKBACK_BARS: 600,
};
