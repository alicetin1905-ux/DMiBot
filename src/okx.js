// OKX public market data (no API key). Spot USDT pairs, since the strategy
// is long-only and unleveraged — the same thing TradingView's tester models.
'use strict';

const BASE = 'https://www.okx.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, tries = 4) {
  for (let a = 1; ; a++) {
    try {
      const r = await fetch(BASE + path);
      const d = await r.json();
      if (d.code === '0') return d.data;
      // 50011 = rate limited; anything else is a real error.
      if (d.code !== '50011' || a >= tries) throw new Error(`${path} -> ${d.msg || 'OKX API error ' + d.code}`);
    } catch (err) {
      if (a >= tries) throw err;
    }
    await sleep(500 * 2 ** a);
  }
}

const instId = (symbol) => `${symbol}-USDT`;
// OKX rows: [ts, o, h, l, c, vol(base), volCcy, volCcyQuote, confirm]
const parse = (k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closed: k[8] === '1' });

// Returns up to `count` candles oldest-first. The newest one is usually the
// still-forming bar (closed: false) — callers use it only for its open.
// `until` (ms) optionally stops paging once candles reach that far back.
async function getCandles(symbol, bar, count, { until = 0, pauseMs = 0 } = {}) {
  const rows = await api(`/api/v5/market/candles?instId=${instId(symbol)}&bar=${bar}&limit=300`);
  let all = rows.map(parse);
  while (all.length < count && all.length > 0 && all[all.length - 1].t > until) {
    const oldest = all[all.length - 1].t;
    const more = await api(`/api/v5/market/history-candles?instId=${instId(symbol)}&bar=${bar}&after=${oldest}&limit=100`);
    if (!more.length) break;
    all = all.concat(more.map(parse));
    if (pauseMs) await sleep(pauseMs);
  }
  return all.slice(0, count).reverse();
}

module.exports = { getCandles, instId };
