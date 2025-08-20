import type {
    Action,
    ActionResult,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
  } from '@elizaos/core';
  
  const BINANCE_API_KEY = process.env.BINANCE_API_KEY ?? '';
  
  const isStatsQuery = (t?: string) =>
    /\b(stats?|detail|24h|high|low|volume|vol|mcap|market\s*cap|rank|7d|30d)\b/i.test(t ?? '');
  
  function pickBaseId(text = '') {
    const t = text.toLowerCase();
    if (/\bbitcoin|\bbtc\b/.test(t)) return { id: 'bitcoin',   sym: 'BTC' };
    if (/\beth(ereum)?|\beth\b/.test(t)) return { id: 'ethereum',  sym: 'ETH' };
    if (/\bdoge(coin)?|\bdoge\b/.test(t)) return { id: 'dogecoin', sym: 'DOGE' };
    if (/\bsol(ana)?|\bsol\b/.test(t)) return { id: 'solana',    sym: 'SOL' };
    if (/\bmatic|\bpolygon\b/.test(t)) return { id: 'matic-network', sym: 'MATIC' };
    if (/\bbnb\b/.test(t))             return { id: 'binancecoin', sym: 'BNB' };
    if (/\bxrp\b/.test(t))             return { id: 'ripple',    sym: 'XRP' };
    if (/\bada\b/.test(t))             return { id: 'cardano',   sym: 'ADA' };
    return { id: 'bitcoin', sym: 'BTC' };
  }
  
  const QUOTES = ['USDT', 'FDUSD', 'USD', 'BUSD', 'USDC', 'TUSD'];
  
  async function fetchJSON(url: string, ms = 7000) {
    const u = url + (url.includes('?') ? '&' : '?') + `_=${Date.now()}`; // cache-buster
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
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } finally {
      clearTimeout(to);
    }
  }
  
  // Resolve a BINANCE symbol like BTCUSDT on the main host; try common quotes.
  async function resolveBinanceSymbol(base: string): Promise<string | null> {
    for (const q of QUOTES) {
      const sym = `${base}${q}`;
      try {
        const info = await fetchJSON(`https://api.binance.com/api/v3/exchangeInfo?symbol=${sym}`);
        const s = info?.symbols?.[0];
        if (s?.status === 'TRADING') return sym;
      } catch {
        /* continue */
      }
    }
    return null;
  }
  
  export const CRYPTO_STATS: Action = {
    name: 'CRYPTO_STATS',
    description: 'Show 24h stats + market cap/rank (Binance + CoinGecko).',
    similes: ['stats', 'detail', '24h', 'volume', 'market cap', 'rank'],
  
    validate: async (_rt, msg) => isStatsQuery(msg.content?.text),
  
    handler: async (
      _rt: IAgentRuntime,
      msg: Memory,
      _state: State,
      _opts: any,
      callback: HandlerCallback
    ): Promise<ActionResult> => {
      const q = msg.content?.text ?? '';
      const { id, sym } = pickBaseId(q);
  
      // 1) Try Binance 24h stats (for high/low/volume)
      let t24: any = null;
      try {
        const symbol = await resolveBinanceSymbol(sym);
        if (symbol) {
          t24 = await fetchJSON(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
        }
      } catch {
        /* ignore; we'll still show CoinGecko stats */
      }
  
      // 2) Market cap / rank / % changes from CoinGecko
      const cg = await fetchJSON(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(
          id
        )}&price_change_percentage=24h,7d,30d`
      );
      const c = cg?.[0];
  
      // Compose final numbers
      const last = Number(t24?.lastPrice ?? c?.current_price);
      const pct24 = Number.isFinite(Number(t24?.priceChangePercent))
        ? Number(t24.priceChangePercent)
        : Number(c?.price_change_percentage_24h);
  
      const fmtUSD = (n: number) =>
        new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 6,
        }).format(n);
  
      const arrow = Number.isFinite(pct24) ? (pct24 > 0 ? '▲' : pct24 < 0 ? '▼' : '•') : '';
      const pctStr = Number.isFinite(pct24) ? ` (${arrow}${Math.abs(pct24).toFixed(2)}%)` : '';
  
      const hi = Number(t24?.highPrice);
      const lo = Number(t24?.lowPrice);
      const vol = Number(t24?.volume);
      const qv  = Number(t24?.quoteVolume);
  
      const lines: string[] = [];
      if (Number.isFinite(last)) lines.push(`${sym} ≈ ${fmtUSD(last)}${pctStr}`);
      if (Number.isFinite(hi) && Number.isFinite(lo))
        lines.push(`24h H/L: ${fmtUSD(hi)} / ${fmtUSD(lo)}`);
      if (Number.isFinite(vol))
        lines.push(
          `24h Vol: ${vol.toLocaleString()} ${sym}` +
            (Number.isFinite(qv) ? ` (≈ ${fmtUSD(qv)})` : '')
        );
      if (c?.market_cap) lines.push(`Mkt Cap: ${fmtUSD(c.market_cap)}  •  Rank: ${c.market_cap_rank ?? '—'}`);
      if (c?.price_change_percentage_7d_in_currency != null)
        lines.push(`7d: ${c.price_change_percentage_7d_in_currency.toFixed(2)}%`);
      if (c?.price_change_percentage_30d_in_currency != null)
        lines.push(`30d: ${c.price_change_percentage_30d_in_currency.toFixed(2)}%`);
  
      const content: Content = {
        text: lines.length ? lines.join('\n') : `Sorry, I can’t get stats right now.`,
        actions: ['CRYPTO_STATS'],
        source: msg.content.source,
      };
  
      await callback(content);
      return { success: true };
    },
  };
  