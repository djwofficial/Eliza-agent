import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';

function pickSymbol(text: string): string {
  const t = (text || '').toLowerCase();
  if (/\bbtc(?:oin)?\b/.test(t) || /\bbitcoin\b/.test(t)) return 'BTC';
  if (/\beth(?:ereum)?\b/.test(t)) return 'ETH';
  if (/\bsol(?:ana)?\b/.test(t)) return 'SOL';
  if (/\bbnb\b/.test(t)) return 'BNB';
  if (/\bxrp\b/.test(t)) return 'XRP';
  if (/\bada\b/.test(t)) return 'ADA';
  if (/\bdoge(?:coin)?\b/.test(t)) return 'DOGE';
  if (/\bmatic\b/.test(t) || /\bpolygon\b/.test(t)) return 'MATIC';
  return 'BTC';
}

const BINANCE_API_KEY = process.env.BINANCE_API_KEY ?? '';

const HOSTS = [
  'https://api.binance.com',        // main first
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://data-api.binance.vision',
  'https://api.binance.us',         // last resort
];

const QUOTES = ['USDT', 'FDUSD', 'BUSD', 'USD', 'USDC', 'TUSD'];

async function fetchJSON(url: string, ms = 7000) {
  const u = url + (url.includes('?') ? '&' : '?') + `_=${Date.now()}`; // cache buster
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort('timeout'), ms);
  try {
    const r = await fetch(u, {
      headers: {
        accept: 'application/json',
        'user-agent': 'eliza-bot/1.0',
        ...(BINANCE_API_KEY ? { 'X-MBX-APIKEY': BINANCE_API_KEY } : {}),
      },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      // Read a little of the body for diagnostics
      let body = '';
      try { body = await r.text(); } catch {}
      const short = body.length > 200 ? body.slice(0, 200) + '…' : body;
      throw new Error(`[${r.status}] ${u} :: ${short || 'no-body'}`);
    }
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

/**
 * Try to find a valid trading symbol for a given base across common quote assets on a host.
 * Uses /api/v3/exchangeInfo?symbol=BASEQUOTE to avoid downloading the full symbol list.
 */
async function resolveSymbolOnHost(host: string, base: string): Promise<string | null> {
  for (const quote of QUOTES) {
    const symbol = `${base}${quote}`;
    try {
      const info = await fetchJSON(`${host}/api/v3/exchangeInfo?symbol=${symbol}`);
      const s = info?.symbols?.[0];
      if (s && s.status === 'TRADING') return symbol;
    } catch (e: any) {
      // If it's -1121 invalid symbol, just continue to next quote.
      // We logged the body in fetchJSON; no need to spam logs here.
      continue;
    }
  }
  return null;
}

/** Get 24h ticker first; if not available, fall back to last price endpoints. */
async function getBinanceTicker(base: string) {
  let lastError: any = null;

  for (const host of HOSTS) {
    try {
      // 1) Resolve a valid symbol on this host (USDT, FDUSD, USD, etc.)
      const symbol = await resolveSymbolOnHost(host, base);
      if (!symbol) {
        continue; // try next host
      }

      // 2) Try 24hr first to get pct/open/high/low
      try {
        const t24 = await fetchJSON(`${host}/api/v3/ticker/24hr?symbol=${symbol}`);
        return { ...t24, __host: host, __symbol: symbol, __kind: '24hr' as const };
      } catch (e24) {
        lastError = e24;
      }

      // 3) Fall back to last price
      try {
        const tp = await fetchJSON(`${host}/api/v3/ticker/price?symbol=${symbol}`);
        // try to get 24h open for pct from stats endpoint if available
        let openPrice = NaN;
        try {
          const stats = await fetchJSON(`${host}/api/v3/ticker?symbol=${symbol}`); // legacy; may 400
          openPrice = Number(stats?.openPrice);
        } catch {}
        return {
          price: tp?.price,
          openPrice,
          __host: host,
          __symbol: symbol,
          __kind: 'price' as const,
        };
      } catch (ePrice) {
        lastError = ePrice;
        continue; // try next host
      }
    } catch (e) {
      lastError = e;
      continue;
    }
  }

  throw lastError ?? new Error('binance_unreachable');
}

export const PRICE_BINANCE: Action = {
  name: 'PRICE_BINANCE',
  description: 'Fetch the latest crypto price from Binance (smart symbol/quote resolution), with Coinbase fallback.',
  similes: ['price', 'crypto price', 'btc price', 'eth price', 'harga'],

  validate: async (_rt, msg) => {
    const text = msg.content?.text ?? '';
    const ok = /\b(price|harga|rate|btc|bitcoin|eth|ethereum|sol|bnb|xrp|ada|doge|dogecoin|matic)\b/i.test(text);
    console.log('[PRICE_BINANCE] validate:', text, '=>', ok);
    return ok;
  },

  handler: async (
    _rt: IAgentRuntime,
    msg: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<ActionResult> => {
    const text = msg.content?.text ?? '';
    const base = pickSymbol(text);

    try {
      console.log('[PRICE_BINANCE] handler start');

      // ---------- Binance ----------
      let data: any | null = null;
      try {
        data = await getBinanceTicker(base);
      } catch (e) {
        console.warn('[PRICE_BINANCE] binance fail:', String(e));
      }

      if (!data) {
        // ---------- Coinbase fallback ----------
        console.log('[PRICE_BINANCE] falling back to Coinbase');
        const cb = await fetchJSON(`https://api.coinbase.com/v2/prices/${base}-USD/spot`);
        const amount = Number(cb?.data?.amount);
        if (!Number.isFinite(amount)) throw new Error('coinbase_no_price');
        data = { lastPrice: String(amount), __source: 'coinbase' };
      }

      // ---------- Normalize fields ----------
      const last =
        Number(data?.lastPrice ?? data?.price ?? data?.bitcoin?.usd);
      if (!Number.isFinite(last)) throw new Error('no_price');

      // Prefer provided 24h percent; if missing, compute from openPrice if available.
      const pctField =
        data?.priceChangePercent != null ? Number(data.priceChangePercent) : NaN;
      const open = Number(data?.openPrice);
      const pct = Number.isFinite(pctField)
        ? pctField
        : Number.isFinite(open) && open > 0
          ? ((last / open) - 1) * 100
          : NaN;

      const usd = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 6,
      }).format(last);

      const arrow = Number.isFinite(pct) ? (pct > 0 ? '▲' : pct < 0 ? '▼' : '•') : '';
      const pctStr = Number.isFinite(pct) ? ` (${arrow}${Math.abs(pct).toFixed(2)}%)` : '';

      const content: Content = {
        text: `${base} ≈ ${usd}${pctStr}`,
        actions: ['PRICE_BINANCE'],
        source: msg.content.source,
      };

      await callback(content);
      console.log('[PRICE_BINANCE] replied:', content.text);

      return { success: true };
    } catch (e: any) {
      console.error('[PRICE_BINANCE] error:', e?.message ?? e);

      const content: Content = {
        text: 'I couldn’t fetch the price right now.',
        actions: ['PRICE_BINANCE'],
        source: msg.content.source,
      };
      await callback(content);

      return { success: false, error: e?.message ?? 'fetch_failed' };
    }
  },
};
