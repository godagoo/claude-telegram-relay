#!/usr/bin/env bun
/**
 * Crypto Watchlist — CoinMarketCap Edition
 *
 * Outputs a formatted price snapshot for the watchlist coins.
 * At 7pm in USER_TIMEZONE, adds full leverage trade setups with
 * entry price, exit plan, liquidation price, and recommended leverage.
 *
 * Usage: bun tools/crypto-watchlist.ts
 * Cron action: EXEC:bun tools/crypto-watchlist.ts
 *
 * Required env: COINMARKETCAP_API_KEY
 * Optional env: USER_TIMEZONE (default: America/New_York)
 */

const CMC_KEY = process.env.COINMARKETCAP_API_KEY || "";
const TZ = process.env.USER_TIMEZONE || "America/New_York";

if (!CMC_KEY) {
  process.stderr.write("Error: COINMARKETCAP_API_KEY not set in .env\n");
  process.exit(1);
}

// ── Watchlist ────────────────────────────────────────────────
const COINS: { symbol: string; name: string; liquid: boolean; slug?: string }[] = [
  { symbol: "BTC",   name: "Bitcoin",     liquid: true  },
  { symbol: "AVAX",  name: "Avalanche",   liquid: true  },
  { symbol: "SOL",   name: "Solana",      liquid: true  },
  { symbol: "LINK",  name: "Chainlink",   liquid: true  },
  { symbol: "COQ",   name: "Coq Inu",     liquid: false },
  { symbol: "ARENA", name: "The Arena",   liquid: false },
  { symbol: "BEAM",  name: "Beam",        liquid: false },
  { symbol: "LAND",  name: "Landshare",   liquid: false },
  { symbol: "XAG",   name: "Silver",      liquid: true  },
  { symbol: "XAUT",  name: "Tether Gold", liquid: true, slug: "tether-gold" },
];

// ── CMC API ──────────────────────────────────────────────────
type Quote = {
  price: number;
  volume_24h: number;
  market_cap: number;
  percent_change_24h: number;
  percent_change_7d: number;
  percent_change_30d: number;
};
type CMCCoin = {
  name: string;
  symbol: string;
  quote: { USD: Quote };
};

async function fetchQuotes(symbols: string[]): Promise<Map<string, CMCCoin>> {
  const url = new URL("https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest");
  url.searchParams.set("symbol", symbols.join(","));
  url.searchParams.set("convert", "USD");

  const res = await fetch(url.toString(), {
    headers: { "X-CMC_PRO_API_KEY": CMC_KEY, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`CMC API ${res.status}: ${await res.text()}`);

  const json: any = await res.json();
  const map = new Map<string, CMCCoin>();
  for (const [sym, val] of Object.entries<any>(json.data || {})) {
    // CMC returns array when symbol is ambiguous — take highest market cap (first)
    const coin = Array.isArray(val) ? val[0] : val;
    map.set(sym, coin);
  }
  return map;
}

async function fetchBySlugs(slugToSymbol: Map<string, string>): Promise<Map<string, CMCCoin>> {
  const url = new URL("https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest");
  url.searchParams.set("slug", [...slugToSymbol.keys()].join(","));
  url.searchParams.set("convert", "USD");

  const res = await fetch(url.toString(), {
    headers: { "X-CMC_PRO_API_KEY": CMC_KEY, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`CMC slug API ${res.status}: ${await res.text()}`);

  const json: any = await res.json();
  const map = new Map<string, CMCCoin>();
  // CMC returns slug results keyed by numeric ID — map back using slugToSymbol
  for (const val of Object.values<any>(json.data || {})) {
    const coin = Array.isArray(val) ? val[0] : val;
    // Use our canonical symbol from COINS (CMC may return different casing)
    const slug = coin.slug as string;
    const canonicalSymbol = slugToSymbol.get(slug) || coin.symbol.toUpperCase();
    map.set(canonicalSymbol, coin);
  }
  return map;
}

// ── Number Formatting ────────────────────────────────────────
function fmtPrice(n: number): string {
  if (n >= 10_000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1_000)  return n.toFixed(2);
  if (n >= 1)      return n.toFixed(3);
  if (n >= 0.01)   return n.toFixed(5);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toFixed(8);
}
function fmtVol(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${Math.round(n / 1e6)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n.toFixed(0)}`;
}
function fmtMcap(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(1)}M`;
  return `$${Math.round(n / 1e3)}K`;
}
function sign(n: number, decimals = 2): string {
  return (n >= 0 ? "+" : "") + n.toFixed(decimals);
}

// ── Indicators ───────────────────────────────────────────────
function arrow(pct: number): string {
  if (pct >= 2)    return "⬆️";
  if (pct >= 0.5)  return "↗️";
  if (pct >= -0.5) return "➡️";
  if (pct >= -2)   return "↘️";
  return "⬇️";
}
function sentiment(pct24h: number, pct7d: number): string {
  if (pct7d >= 8)  return "🟢 Strong Bull";
  if (pct7d >= 3)  return "🟢 Bull";
  if (pct24h >= 0) return "🟡 Neutral+";
  if (pct7d >= -3) return "🟡 Neutral−";
  if (pct7d >= -8) return "🔴 Bearish";
  return "🔴 Strong Bear";
}
function trendLabel(pct7d: number): string {
  if (pct7d >= 8)  return "🚀 Strong Uptrend";
  if (pct7d >= 2)  return "📈 Uptrend";
  if (pct7d >= -2) return "↔️ Sideways / Consolidating";
  if (pct7d >= -8) return "📉 Downtrend";
  return "💀 Strong Downtrend";
}

// ── Support / Resistance (estimated from 7d range) ───────────
function calcSR(price: number, pct7d: number) {
  // 7d range estimation: volatility scales with |pct7d|, min 2%
  const range = Math.max(price * Math.abs(pct7d) / 100, price * 0.02);
  return {
    R2: price + range * 4.0,  // Extended resistance
    R1: price + range * 0.4,  // Near resistance
    S2: price - range * 0.5,  // Near support
    S1: price - range * 1.7,  // Deep support
  };
}

// ── Leverage Calculations ────────────────────────────────────
function liqPrice(entry: number, leverage: number, isLong: boolean): number {
  // Approximate liquidation at ~90% margin loss + 0.5% maintenance
  const factor = (1 / leverage) - 0.005;
  return isLong ? entry * (1 - factor) : entry * (1 + factor);
}

function leverageRec(pct7d: number, vol24h: number): { long: number; short: number } {
  const lowLiq = vol24h < 10_000_000; // < $10M daily volume → cap leverage
  const cap = lowLiq ? 3 : 10;

  if (pct7d >= 8)   return { long: Math.min(10, cap), short: Math.min(3, cap) };
  if (pct7d >= 2)   return { long: Math.min(5, cap),  short: Math.min(5, cap) };
  if (pct7d >= -2)  return { long: Math.min(3, cap),  short: Math.min(3, cap) };
  if (pct7d >= -8)  return { long: Math.min(3, cap),  short: Math.min(5, cap) };
  return              { long: Math.min(2, cap),  short: Math.min(10, cap) };
}

// ── Line Formatters ──────────────────────────────────────────
function watchlistBlock(coin: CMCCoin): string {
  const q = coin.quote.USD;
  return [
    `${coin.symbol}  $${fmtPrice(q.price)}`,
    `  24h ${sign(q.percent_change_24h)}% ${arrow(q.percent_change_24h)}   7d ${sign(q.percent_change_7d)}% ${arrow(q.percent_change_7d)}`,
    `  ${sentiment(q.percent_change_24h, q.percent_change_7d)}`,
  ].join("\n");
}

function leverageBlock(coin: CMCCoin): string {
  const q = coin.quote.USD;
  const { price, percent_change_7d: p7d, percent_change_30d: p30d, volume_24h: vol, market_cap: mcap } = q;
  const sr = calcSR(price, p7d);
  const rec = leverageRec(p7d, vol);
  const lowLiq = vol < 10_000_000;

  // Long: limit buy near S2, target R1, stop below S1
  const longEntry  = sr.S2 * 1.005;
  const longTarget = sr.R1;
  const longStop   = sr.S1 * 0.98;
  const longLiq    = liqPrice(longEntry, rec.long, true);

  // Short: limit sell near R1, target S2, stop above R2
  const shortEntry  = sr.R1 * 0.995;
  const shortTarget = sr.S2;
  const shortStop   = sr.R2 * 1.02;
  const shortLiq    = liqPrice(shortEntry, rec.short, false);

  return [
    `${coin.name} (${coin.symbol})  $${fmtPrice(price)}`,
    `Trend: ${trendLabel(p7d)}`,
    `🔺 R2 $${fmtPrice(sr.R2)}   R1 $${fmtPrice(sr.R1)}`,
    `🔹 S1 $${fmtPrice(sr.S1)}   S2 $${fmtPrice(sr.S2)}`,
    `Vol 24h ${fmtVol(vol)}  ·  MCap ${fmtMcap(mcap)}  ·  30d ${sign(p30d)}%${lowLiq ? "  ⚠️ Low Liq" : ""}`,
    ``,
    `📈 Long ${rec.long}x`,
    `  Entry  $${fmtPrice(longEntry)}`,
    `  Target $${fmtPrice(longTarget)}  (R1)`,
    `  Stop   $${fmtPrice(longStop)}`,
    `  Liq    $${fmtPrice(longLiq)}`,
    ``,
    `📉 Short ${rec.short}x`,
    `  Entry  $${fmtPrice(shortEntry)}`,
    `  Target $${fmtPrice(shortTarget)}  (S2)`,
    `  Stop   $${fmtPrice(shortStop)}`,
    `  Liq    $${fmtPrice(shortLiq)}`,
    `─────────────────`,
  ].join("\n");
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  const symbolCoins = COINS.filter(c => !c.slug);
  const slugCoins = COINS.filter(c => c.slug);

  let quotes = new Map<string, CMCCoin>();
  try {
    // Fetch symbol-based coins
    if (symbolCoins.length > 0) {
      const symQuotes = await fetchQuotes(symbolCoins.map(c => c.symbol));
      for (const [k, v] of symQuotes) quotes.set(k, v);
    }
    // Fetch slug-based coins (e.g. XAUT → tether-gold)
    if (slugCoins.length > 0) {
      const slugMap = new Map(slugCoins.map(c => [c.slug!, c.symbol]));
      const slugQuotes = await fetchBySlugs(slugMap);
      for (const [k, v] of slugQuotes) quotes.set(k, v);
    }
  } catch (err) {
    process.stderr.write(`CMC fetch failed: ${err}\n`);
    process.exit(1);
  }

  // Current time in user's timezone
  const now = new Date();
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(now),
    10
  );
  const dateStr = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(now);
  const tzAbbr = now.toLocaleString("en-US", { timeZone: TZ, timeZoneName: "short" }).split(" ").at(-1) || "ET";

  const out: string[] = [];

  // ── WATCHLIST ────────────────────────────────────────────
  out.push(`📊 Crypto Snapshot  —  ${dateStr} ${tzAbbr}`);
  out.push("");

  for (const { symbol } of COINS) {
    const coin = quotes.get(symbol);
    if (!coin) {
      out.push(`${symbol}  ⚠️ Not found on CMC`);
    } else {
      out.push(watchlistBlock(coin));
    }
    out.push("");
  }

  // ── LEVERAGE (7pm only) ──────────────────────────────────
  if (hour === 19) {
    out.push("━━━━━━━━━━━━━━━━━━━━━━");
    out.push("🎯 Trade Setups — 7PM");
    out.push("");

    for (const { symbol } of COINS) {
      const coin = quotes.get(symbol);
      if (!coin) continue;
      out.push(leverageBlock(coin));
      out.push("");
    }
  }

  process.stdout.write(out.join("\n").trimEnd() + "\n");
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
