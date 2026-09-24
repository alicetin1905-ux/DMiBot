# DMI Toolbox Bot

A paper-trading bot that runs Chart0bserver's
[**DMI Toolbox Strategy**](https://www.tradingview.com/script/kgsU4SHu-DMI-Toolbox-Strategy/)
(TradingView, Pine v6, MPL-2.0) on the top 20 crypto coins as **OKX USDT
perpetual futures at 10x leverage**, with a live dashboard (`index.html`).

## This is paper trading only

**No API keys, no exchange account, no real orders.** The bot reads OKX's
public perpetual-swap candles, decides what the strategy would do, and tracks the
result in `state/*.json` against a simulated balance. Nothing here
can place a real order. Backtest numbers describe the past, not the future.

## The strategy

The signal logic is ported line by line from the published Pine source
(`src/dmi.js`), with the script's **default inputs** (`config.js`):

**Indicators**
- +DI and −DI over 14 bars (Wilder), with +DI smoothed again by a 4-bar RMA.
- ADX = 100 × EMA₂₀(|+DI − −DI| / (+DI + −DI)).
- Smoothed ADX = SMA₈(ADX); smoothed −DI = SMA₈(−DI).

**Long entry.** All of these must be true:
- +DI has crossed above smoothed −DI and hasn't crossed back below
  (the "bullish pattern"), within the last 150 candles.
- Close is above its 200 SMA.
- Volume is above its 21-bar average.

and at least one trigger fires on that candle:
- +DI crosses above 30, or
- smoothed ADX crosses above smoothed −DI.

**Short entry — not in the original script.** Chart0bserver's DMI Toolbox
is long-only. This bot adds a short side that mirrors the long rules exactly,
using a smoothed +DI computed the same way the script smooths −DI. All of
these must be true:
- −DI has crossed above smoothed +DI and hasn't crossed back below
  (the "bearish pattern"), within the last 150 candles.
- Close is below its 200 SMA.
- Volume is above its 21-bar average.

and at least one trigger fires on that candle:
- −DI crosses above 30, or
- smoothed ADX crosses above smoothed +DI.

Set `ALLOW_SHORTS: false` in `config.js` to trade the strategy exactly as
published, long-only.

**Exit.** Whichever of these comes first, checked against whichever side is open:
- ADX crosses under smoothed ADX while ADX > 38 (trend exhaustion) — shared by both sides.
- Stop loss: the open loss exceeds 2.5% of the coin's realised equity
  (the script's `strategy.openprofit_percent` check).

**Sizing and futures.** The script's `strategy()` header, traded on perps:
- Each entry posts 10% of equity as margin at **10x**, so one entry is a
  position the size of the coin's whole balance. Up to 5 entries stack on
  repeat signals, which is up to 5× the balance.
- Long or short, but never both at once per coin — the long and short
  mandatory conditions can't both be true on the same candle (they require
  opposite price/SMA relationships), so a book only ever holds one side.
- Each coin's $1,000 is its own cross-margin account. It's **liquidated**
  when its equity reaches maintenance margin (0.5%) — checked at a candle's
  low for longs, high for shorts. With all 5 layers open, that is roughly a
  20% adverse move from the average entry.
- The 2.5% stop is still measured against equity. At 10x it closes one
  layer after about a 2.5–3% move against it, or all 5 after about 0.5%.
  It's checked on candle closes like the Pine script, so a fast wick can
  reach liquidation first.
- 0.05% taker fee per side on notional, plus 0.01% funding per 8h on
  notional while a position is open — longs pay it, shorts receive it
  (OKX's baseline rate; real rates vary and skew with market sentiment).
- Signals are read on a candle's close and filled at the next candle's
  open, the same way TradingView's strategy tester fills them.

All of this is in `config.js` (`LEVERAGE`, `ORDER_PCT_OF_EQUITY`,
`MAINT_MARGIN_PCT`, `FUNDING_PCT_PER_8H`, `COMMISSION_PCT`, `ALLOW_SHORTS`
and the mirrored short-side requirement/trigger flags).

The live bot and the backtester both call the same broker (`src/broker.js`), so they trade
identically. A check across all 20 coins found the live bot's 600-candle
window produces the same signals as full history on 5,000 of 5,000 bars.

## Coins

The top 20 by market cap (CoinGecko, Sep 2026) that OKX lists as a USDT
perpetual swap. Stablecoins, wrapped and tokenised assets, and coins OKX doesn't list
(XMR, LEO) are skipped:

BTC ETH BNB XRP SOL TRX ZEC HYPE DOGE LINK ADA XLM BCH NEAR UNI LTC AVAX SUI HBAR SHIB

Edit `SYMBOLS` in `config.js` to change the list. If you do, change the
list at the top of `index.html` to match.

## Backtest

Replayed over the last 730 days on OKX **4H** perpetual futures, 10x
leverage, $1,000 per coin, 0.05% taker fee per side, 0.01%/8h funding,
default settings, long **and** short. ZEC and HYPE are tested only since
their OKX listing.

| | |
|---|---|
| Average net return per coin | **+43.6%** (buy & hold: +40.7%) |
| Average max drawdown | **62.2%** |
| Coins profitable | 11 / 20 |
| Coins that beat buy & hold | 8 / 20 |
| Trades | 1,496 (559 long / 937 short) |
| Liquidations | 0 |
| P&L by side | longs **+$17,725**, shorts **−$8,999** |

Best: NEAR +486.8%, ZEC +311.8%, SHIB +95.5%. Worst: HBAR −68.8%, BCH −66.4%,
LINK −65.6%.

At 10x, drawdowns are large — over 60% on average, even with zero
liquidations across 20 coins over 2 years. Shorts lost money overall in
this window: it was mostly an uptrending 2 years, so longs did the work
(+$17.7k) and shorts gave a chunk of it back (−$9.0k). Set
`ALLOW_SHORTS: false` to trade long-only, which was steadier (see the
long-only spot backtest this project started from, in the git history,
or re-run with shorts off).

**This leverage is aggressive.** A single stacked position (5 layers) is
liquidated by roughly a 20% adverse move; the strategy's own 2.5% stop
means most positions close well before that, but the backtest above still
shows 60%+ average drawdown from stacked losing streaks and funding.
Treat 10x as a demonstration of what the strategy does at that leverage,
not a recommendation to run it at that size.

Re-run it yourself:

```
node src/backtest.js 4H 730     # timeframe, days
```

Per-coin results are written to `backtest/results-<TF>.json`. The
dashboard shows the file for the timeframe the bot trades.

## Running it

```
node src/run.js     # Node 18+, no dependencies
```

Each run fetches the last 600 candles per coin and feeds every newly
closed candle through the broker. If runs were missed, it catches up to
24 candles at each candle's real next open. Otherwise a coin starts fresh
from the latest candle, so history is never replayed into the account.

## Automation

`.github/workflows/bot.yml` runs the bot hourly at :20 and commits
`state/` back to the repo. No secrets or API keys are needed. The
dashboard reads state from `main`.

To view the dashboard, turn on GitHub Pages (Settings → Pages → deploy from
`main`, root) and open `https://alicetin1905-ux.github.io/DMiBot/`. You can
also open `index.html` locally.

**Reset account** on the dashboard opens `.github/workflows/reset.yml`.
Click "Run workflow" there to put every coin back to $1,000. Trade history is
kept.

## Layout

```
config.js        every setting above
index.html       dashboard (reads state from GitHub, live prices from OKX)
src/dmi.js       indicator + signal port of the Pine script
src/broker.js    paper futures broker (next-open fills, leverage, liquidation, funding, fees)
src/okx.js       OKX public perpetual-swap candles client
src/run.js       live entry point
src/backtest.js  historical replay through the same broker
src/state.js     reads/writes state/*.json
src/reset.js     resets all balances
state/           books (cash + open entries), lastBar, trades, signals
backtest/        published backtest results
```

## License

`src/dmi.js` is a port of Chart0bserver's Pine Script, published under the
Mozilla Public License 2.0, so this project is MPL-2.0 too.
