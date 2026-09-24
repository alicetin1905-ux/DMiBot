// OKX public market data (no API key) for USDT-margined perpetual swaps.
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

const BAR_MS = { '1H': 3.6e6, '2H': 7.2e6, '4H': 1.44e7, '6H': 2.16e7, '12H': 4.32e7, '1D': 8.64e7 };
const instId = (symbol) => `${symbol}-USDT-SWAP`;
// OKX swap rows: [ts, o, h, l, c, vol(contracts), volCcy(base coin), volCcyQuote, confirm]
const parse = (k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6], closed: k[8] === '1' });

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

module.exports = { getCandles, instId, BAR_MS };
