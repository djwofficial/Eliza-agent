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
  const t = text.toLowerCase();
  if (/\bbtc(?:oin)?\b/.test(t) || /\bbitcoin\b/.test(t)) return 'BTC';
  if (/\beth(ereum)?\b/.test(t)) return 'ETH';
  if (/\bsol(ana)?\b/.test(t)) return 'SOL';
  if (/\bbnb\b/.test(t)) return 'BNB';
  if (/\bxrp\b/.test(t)) return 'XRP';
  if (/\bada\b/.test(t)) return 'ADA';
  if (/\bdoge(?:coin)?\b/.test(t)) return 'DOGE';
  if (/\bmatic\b/.test(t) || /\bpolygon\b/.test(t)) return 'MATIC';
  return 'BTC';
}

export const PRICE_BINANCE: Action = {
  name: 'PRICE_BINANCE',
  description: 'Fetches the latest crypto price from Binance (USDT pairs).',
  similes: ['price', 'crypto price', 'btc price', 'eth price', 'harga'],

  // liberal while testing
  validate: async (_rt, msg) => {
    const text = msg.content?.text ?? '';
    const ok = /\b(price|harga|rate|btc|bitcoin|eth|ethereum|sol|bnb|xrp|ada|doge|dogecoin|matic)\b/i.test(text);
    console.log('[PRICE_BINANCE] validate:', text, '=>', ok);
    return ok;
  },

  // IMPORTANT: use `callback` to emit the message to the channel
  handler: async (
    _rt: IAgentRuntime,
    msg: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<ActionResult> => {
    const text = msg.content?.text ?? '';
    const base = pickSymbol(text);
    const symbol = `${base}USDT`;

    const BINANCE_API_KEY = process.env.BINANCE_API_KEY ?? '';

    const fetchJSON = async (url: string, ms = 6000) => {
      // cache buster avoids any intermediary caching
      const u = url + (url.includes('?') ? '&' : '?') + `_=${Date.now()}`;
      console.log('[PRICE_BINANCE] try:', u);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort('timeout'), ms);
      try {
        const r = await fetch(u, {
          headers: {
            accept: 'application/json',
            'user-agent': 'eliza-bot/1.0',
            ...(BINANCE_API_KEY ? { 'X-MBX-APIKEY': BINANCE_API_KEY } : {}),
          },
          signal: ctrl.signal,
        });
        console.log('[PRICE_BINANCE] status:', r.status, url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } finally {
        clearTimeout(t);
      }
    };

    try {
      console.log('[PRICE_BINANCE] handler start');

      // Prefer the main cluster first, then mirrors
      const urls = [
        `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
        `https://api1.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
        `https://api2.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
        `https://api3.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
        `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${symbol}`,
        `https://api.binance.us/api/v3/ticker/24hr?symbol=${symbol}`,
      ];

      let data: any | null = null;
      for (const u of urls) {
        try {
          data = await fetchJSON(u);
          break;
        } catch (e) {
          console.warn('[PRICE_BINANCE] fail:', String(e));
        }
      }

      if (!data) {
        console.log('[PRICE_BINANCE] falling back to Coinbase');
        const cb = await fetchJSON(`https://api.coinbase.com/v2/prices/${base}-USD/spot`);
        const amount = Number(cb?.data?.amount);
        if (!isFinite(amount)) throw new Error('coinbase_no_price');
        data = { lastPrice: String(amount), priceChangePercent: null, __source: 'coinbase' };
      }

      const last = Number(data?.lastPrice ?? data?.price ?? data?.bitcoin?.usd);
      const pct = Number(data?.priceChangePercent);
      if (!isFinite(last)) throw new Error('no_price');

      const usd = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 6,
      }).format(last);

      const arrow = isFinite(pct) ? (pct >= 0 ? '▲' : '▼') : '';
      const pctStr = isFinite(pct) ? ` (${arrow}${pct.toFixed(2)}%)` : '';

      const content: Content = {
        text: `${base} ≈ ${usd}${pctStr}`,
        actions: ['PRICE_BINANCE'],
        source: msg.content.source, // ensures reply goes to the right channel (e.g., Telegram)
      };

      // ✅ send immediately to the channel via callback (not options.reply)
      await callback(content);
      console.log('[PRICE_BINANCE] replied:', content.text);

      // ✅ don’t hand text back to the LLM
      return { success: true };
    } catch (e: any) {
      console.error('[PRICE_BINANCE] error:', e?.message ?? e);

      const content: Content = {
        text: "I couldn’t fetch the price right now.",
        actions: ['PRICE_BINANCE'],
        source: msg.content.source,
      };
      await callback(content);

      return { success: false, error: e?.message ?? 'fetch_failed' };
    }
  },
};
