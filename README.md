# DMI Toolbox Bot

A paper-trading bot that runs Chart0bserver's
[**DMI Toolbox Strategy**](https://www.tradingview.com/script/kgsU4SHu-DMI-Toolbox-Strategy/)
(TradingView, Pine v6, MPL-2.0) on the top 20 crypto coins, with a live dashboard (`index.html`).

## This is paper trading only

**No API keys, no exchange account, no real orders.** The bot reads OKX's
public spot candles, decides what the strategy would do, and tracks the
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

**Exit.** Whichever of these comes first:
- ADX crosses under smoothed ADX while ADX > 38 (trend exhaustion).
- Stop loss: the open loss exceeds 2.5% of the coin's realised equity
  (the script's `strategy.openprofit_percent` check).

**Sizing.** This follows the script's `strategy()` header.
- Each entry is 10% of equity, with up to 5 entries stacked on repeat signals.
- Long only, no leverage.
- 0.1% commission per side.
- Signals are read on a candle's close and filled at the next candle's
  open, the same way TradingView's strategy tester fills them.

The live bot and the backtester both call `broker.step()`, so they trade
identically. A check across all 20 coins found the live bot's 600-candle
window produces the same signals as full history on 5,000 of 5,000 bars.

## Coins

The top 20 by market cap (CoinGecko, Sep 2026) that OKX lists as a USDT spot
pair. Stablecoins, wrapped and tokenised assets, and coins OKX doesn't list
(XMR, LEO) are skipped:

BTC ETH BNB XRP SOL TRX ZEC HYPE DOGE LINK ADA XLM BCH NEAR UNI LTC AVAX SUI HBAR SHIB

Edit `SYMBOLS` in `config.js` to change the list. If you do, change the
list at the top of `index.html` to match.

## Backtest

Replayed over the last 730 days on OKX **4H** candles, $1,000 per coin,
0.1% commission per side, default settings. ZEC and HYPE are tested only
since their OKX listing.

| | |
|---|---|
| Average net return per coin | **+10.0%** (buy & hold: +31.7%) |
| Average max drawdown | **11.1%** |
| Coins profitable | 13 / 20 |
| Coins that beat buy & hold | 9 / 20 |
| Trades | 404 |

Best: DOGE +42.7%, ZEC +30.8%, TRX +26.2%. Worst: ADA −8.8%, BCH −8.6%, UNI −5.0%.

What it does well is sit out downtrends. It stayed small or positive on
coins that fell 40–60% (SUI, AVAX, SHIB, SOL), with drawdowns around a
tenth of buy & hold's. In a strong bull run it lags buy & hold by a lot,
because it is in the market only about 30% of the time and each entry is
just 10% of equity.

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
src/broker.js    paper broker (next-open fills, pyramiding, stop, fees)
src/okx.js       OKX public candles client
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
