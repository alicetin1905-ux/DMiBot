# DMI Toolbox Bot

A paper-trading bot that runs Chart0bserver's
[**DMI Toolbox Strategy**](https://www.tradingview.com/script/kgsU4SHu-DMI-Toolbox-Strategy/)
(TradingView, Pine v6, MPL-2.0) for its entry signals on the top 20 crypto
coins as **OKX USDT perpetual futures at 10x leverage**, with a live
dashboard (`index.html`). Sizing and exits are this project's own fixed-risk
model — see **Risk model** below — not the published script's.

## This is paper trading only

**No API keys, no exchange account, no real orders.** The bot reads OKX's
public perpetual-swap candles, decides what the strategy would do, and tracks the
result in `state/*.json` against a simulated balance. Nothing here
can place a real order. Backtest numbers describe the past, not the future.

## Entry signals

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

Set `ALLOW_SHORTS: false` in `config.js` to trade entries exactly as
published, long-only.

**Trend-exhaustion exit.** On top of the stop/take-profit ladder below,
whatever's still open closes if ADX crosses under smoothed ADX while ADX is
above 38 — the script's own reversal signal, shared by both sides.

## Risk model

This part is **not** the published script — TradingView's strategy tester
sizes by `%` of equity and exits with a single close-all. This bot instead
runs one shared account with a fixed dollar risk per trade:

- **One account, not one balance per coin.** $2,000 total (`TOTAL_BALANCE`).
  A coin has no balance of its own — free margin is one shared pool, so how
  many of the 20 coins can have a position open at once depends on what's
  already open on the others, not a per-coin allocation.
- **$100 fixed margin per trade** (`MARGIN_PER_TRADE`) at **10x leverage**,
  so every trade opens the same $1,000 notional regardless of the coin's
  price or the account's current balance — one position per coin; there's
  no pyramiding, because stacking entries at different prices would break
  the fixed-R math below.
- **At most 6 positions open at once** (`MAX_OPEN_POSITIONS`), across all 20
  coins, whichever 6 signal first — this caps concentration risk
  regardless of how much free margin is left (6 × $100 is less than a third
  of the $2,000 account, so margin alone would allow far more than 6).
- **$35 fixed-dollar stop loss** (`STOP_LOSS_USD`), not a percentage. This
  amount is "1R" (one risk unit) — since every trade is the same $1,000
  notional, $35 is always the same ~3.5% move against entry, but it's
  configured and reported as a dollar amount because that's how the risk
  was specified.
- **Scaled take-profit in R-multiples**, each closing that % of the
  position's *original* size (`TP_LEVELS`):

  | Target | R-multiple | Closes |
  |---|---|---|
  | TP1 | 1.5R (+$52.50) | 30% |
  | TP2 | 3R (+$105) | 30% |
  | TP3 | 4.5R (+$157.50) | 40% |

  Once TP1 fills, the stop moves to breakeven (entry price) on what's left
  (`MOVE_STOP_TO_BREAKEVEN_AFTER_TP1`), so a full loss can't happen twice on
  the same trade.
- **Liquidation is a safety net, not a real threshold.** Each trade's own
  $100 margin (isolated, not cross-margined against the other 19 coins) is
  liquidated at ~9.5% adverse move — far outside the 3.5% stop, so it
  should only fire on a violent gap the $35 stop couldn't catch in time.
  The stop and liquidation are both checked intrabar (candle high/low), and
  whichever is actually nearer to entry is what a continuous price path
  would reach first — not always the stop, in principle, though it always
  is with these numbers.
- 0.05% taker fee per side on notional, plus 0.01% funding per 8h on
  notional while a position is open — longs pay it, shorts receive it
  (OKX's baseline rate; real rates vary and skew with market sentiment).
- Entry/exit signals are read on a candle's close and filled at the next
  candle's open, like TradingView's tester; the stop and TP ladder are
  checked intrabar, against that same candle's high/low.

All of this is in `config.js`: `TOTAL_BALANCE`, `MARGIN_PER_TRADE`,
`LEVERAGE`, `STOP_LOSS_USD`, `TP_LEVELS`, `MOVE_STOP_TO_BREAKEVEN_AFTER_TP1`,
`MAINT_MARGIN_PCT`, `FUNDING_PCT_PER_8H`, `COMMISSION_PCT`.

The live bot and the backtester both drive the same broker
(`src/broker.js`), so they trade identically.

## Readiness bar

Each coin tile without an open position shows a bar for whichever side
(long or short) is closer to firing, blending:
- the pattern gate (must be true, or the bar is 0 — no pattern, no setup),
- the price-vs-200-SMA and volume-vs-average gates,
- how close the relevant DI/ADX line sits to the level it needs to cross.

The last part is a *symmetric* distance to the trigger level, not a ratio —
100% right at the level, falling off moving away in either direction —
because triggers fire on the bar a line actually crosses, so sitting far
past a level isn't "more ready," it already fired or missed its moment.
It's a glanceable heuristic for "keep an eye on this one," not a
prediction: computed in `src/dmi.js` (`longReadyPct`/`shortReadyPct`) and
carried into `state/signals.json` by the live bot.

## Coins

The top 20 by market cap (CoinGecko, Sep 2026) that OKX lists as a USDT
perpetual swap. Stablecoins, wrapped and tokenised assets, and coins OKX doesn't list
(XMR, LEO) are skipped:

BTC ETH BNB XRP SOL TRX ZEC HYPE DOGE LINK ADA XLM BCH NEAR UNI LTC AVAX SUI HBAR SHIB

Edit `SYMBOLS` in `config.js` to change the list. If you do, change the
list at the top of `index.html` to match.

## Backtest

Replayed over the last 730 days on OKX **4H** perpetual futures, this risk
model (shared $2,000 account, $100/trade at 10x, $35 stop, 1.5R/3R/4.5R
scaled TP), default entry settings, long **and** short. ZEC and HYPE are
tested only since their OKX listing.

| | |
|---|---|
| Account | **$2,000 → $5,151** (+157.5%) |
| Max drawdown | **33.7%** |
| Liquidations | **0** |
| Trades | 983 (444 long / 539 short) |
| Stopped out (full loss or breakeven) | 679 |
| TP1 / TP2 / TP3 fills | 400 / 185 / 102 |
| Coins net positive | 16 / 20 |

Best: NEAR +$564, ETH +$506, SHIB +$493. Worst: UNI −$532, AVAX −$507, BNB
−$373.

Capping open positions at 6 turns down real signals — with no cap the same
window returned +399.3% on 1,518 trades and 18/20 coins positive — in
exchange for never having more than 6 × $100 = $600 (30% of the account) at
risk at once, instead of, in principle, up to $2,000. Drawdown barely moved
(33.7% vs. 34.1%), because drawdown here comes mostly from strings of
losing trades on the coins that *are* open, not from how many are open at
once — the cap trades return for concentration risk, not for smoother
equity.

Scaling out in R-multiples is still doing its job on top of that: 400
trades hit at least TP1, and once TP1 fills the stop moves to breakeven, so
a trade that reverses after running can't give back a full loss. Zero
liquidations across 983 trades and 20 coins over 2 years confirms the $35
stop is catching everything before the isolated per-trade liquidation
(~9.5% away) would need to.

**Leverage still means real drawdown.** A third of the account down at the
worst point is a real number, even with a hard per-trade stop and a
position-count cap. Both limit concentration, not the risk of a run of
several separate losing trades in a row.

Re-run it yourself:

```
node src/backtest.js 4H 730     # timeframe, days
```

This walks all 20 coins together in strict timestamp order through one
shared account — not one coin at a time — because a trade on one coin can
only open if there's free margin left after whatever's already open on the
others. Results are written to `backtest/results-<TF>.json`; the dashboard
shows the file for the timeframe the bot trades.

## Running it

```
node src/run.js     # Node 18+, no dependencies
```

Each run fetches the last 600 candles per coin and feeds every newly
closed candle through the broker, coin by coin. If runs were missed, it
catches up to 24 candles at each candle's real next open. Otherwise a coin
starts fresh from the latest candle, so history is never replayed into the
account. (The live bot processes coins one at a time rather than in strict
global timestamp order like the backtester — the two can disagree only in
the rare case where catching up several missed bars, on more than one coin,
would have had them compete for the last of the account's free margin in a
different order than they happen to run in here.)

## Automation

`.github/workflows/bot.yml` runs the bot hourly at :20 and commits
`state/` back to the repo. No secrets or API keys are needed. The
dashboard reads state from `main`.

To view the dashboard, turn on GitHub Pages (Settings → Pages → deploy from
`main`, root) and open `https://alicetin1905-ux.github.io/DMiBot/`. You can
also open `index.html` locally.

**Reset account** on the dashboard opens `.github/workflows/reset.yml`.
Click "Run workflow" there to put the account back to $2,000 and close every
position. Trade history is kept.

## Layout

```
config.js        every setting above
index.html       dashboard (reads state from GitHub, live prices from OKX)
src/dmi.js       indicator + signal port of the Pine script
src/broker.js    paper futures broker: shared account, fixed margin/stop/TP ladder, liquidation, funding, fees
src/okx.js       OKX public perpetual-swap candles client
src/run.js       live entry point
src/backtest.js  joint, time-ordered replay of all 20 coins through the same broker
src/state.js     reads/writes state/*.json
src/reset.js     resets the account
state/           account (cash + open positions), lastBar, trades, signals
backtest/        published backtest results
```

## License

`src/dmi.js` is a port of Chart0bserver's Pine Script, published under the
Mozilla Public License 2.0, so this project is MPL-2.0 too.
