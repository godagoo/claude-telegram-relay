#!/usr/bin/env bun
/**
 * Crypto Report — Gentech Strategies Group
 *
 * Consolidated crypto script: price snapshots, trade setups, Sunday recap.
 * Posts to Gentech group via Telegram Bot API.
 *
 * Usage:  bun run examples/crypto-report.ts
 * Cron:   0 7-23 * * *  (every hour, 7am-11pm ET)
 *
 * Sections:
 *   - Price Snapshot   (every run)
 *   - Trade Setups     (7pm ET only)
 *   - Weekly Recap     (Sunday 7pm only)
 *
 * Required env: COINMARKETCAP_API_KEY, TELEGRAM_BOT_TOKEN, GENTECH_GROUP_ID
 * Optional env: USER_TIMEZONE (default: America/New_York)
 */

const CMC_KEY = process.env.COINMARKETCAP_API_KEY || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const GROUP_ID = process.env.GENTECH_GROUP_ID || "";
const TZ = process.env.USER_TIMEZONE || "America/New_York";

if (!CMC_KEY || !BOT_TOKEN || !GROUP_ID) {
  console.error("Missing required env: COINMARKETCAP_API_KEY, TELEGRAM_BOT_TOKEN, GENTECH_GROUP_ID");
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
type CMCCoin = { name: string; symbol: string; quote: { USD: Quote } };

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
    map.set(sym, Array.isArray(val) ? val[0] : val);
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
  for (const val of Object.values<any>(json.data || {})) {
    const coin = Array.isArray(val) ? val[0] : val;
    const slug = coin.slug as string;
    const sym = slugToSymbol.get(slug) || coin.symbol.toUpperCase();
    map.set(sym, coin);
  }
  return map;
}

// ── Formatting ───────────────────────────────────────────────
function fmtPrice(n: number): string {
  if (n >= 10_000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1_000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(3);
  if (n >= 0.01) return n.toFixed(5);
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
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${Math.round(n / 1e3)}K`;
}

function sign(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

// ── Sentiment ────────────────────────────────────────────────
function sentiment(pct24h: number, pct7d: number): string {
  if (pct24h >= 10 && pct7d >= 15) return "🚀 BULLISH";
  if (pct24h >= 3)                 return "🟢 bullish";
  if (pct24h >= 1)                 return "📈";
  if (pct24h >= -1)                return "⚪️ neutral";
  if (pct24h <= -10 && pct7d <= -15) return "💀 BEARISH";
  if (pct24h <= -3)                return "🔴 bearish";
  return "📉";
}

function overallSentiment(avg24h: number): string {
  if (avg24h >= 5)  return "🚀 Market is pumping";
  if (avg24h >= 2)  return "🟢 Market trending up";
  if (avg24h >= 0)  return "📈 Slightly bullish";
  if (avg24h >= -2) return "📉 Slightly bearish";
  if (avg24h >= -5) return "🔴 Market trending down";
  return "💀 Market is dumping";
}

function trendLabel(pct7d: number): string {
  if (pct7d >= 8)  return "🚀 Strong Uptrend";
  if (pct7d >= 2)  return "📈 Uptrend";
  if (pct7d >= -2) return "↔️ Sideways";
  if (pct7d >= -8) return "📉 Downtrend";
  return "💀 Strong Downtrend";
}

// ── Support / Resistance ─────────────────────────────────────
function calcSR(price: number, pct7d: number) {
  const range = Math.max(price * Math.abs(pct7d) / 100, price * 0.02);
  return {
    R2: price + range * 4.0,
    R1: price + range * 0.4,
    S2: price - range * 0.5,
    S1: price - range * 1.7,
  };
}

function liqPrice(entry: number, leverage: number, isLong: boolean): number {
  const factor = (1 / leverage) - 0.005;
  return isLong ? entry * (1 - factor) : entry * (1 + factor);
}

function leverageRec(pct7d: number, vol24h: number): { long: number; short: number } {
  const cap = vol24h < 10_000_000 ? 3 : 10;
  if (pct7d >= 8)  return { long: Math.min(10, cap), short: Math.min(3, cap) };
  if (pct7d >= 2)  return { long: Math.min(5, cap),  short: Math.min(5, cap) };
  if (pct7d >= -2) return { long: Math.min(3, cap),  short: Math.min(3, cap) };
  if (pct7d >= -8) return { long: Math.min(3, cap),  short: Math.min(5, cap) };
  return              { long: Math.min(2, cap),  short: Math.min(10, cap) };
}

// ── Telegram ─────────────────────────────────────────────────
const MAX_MSG = 4000;

async function sendTelegram(text: string): Promise<boolean> {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_MSG) {
    let cut = remaining.lastIndexOf("\n\n", MAX_MSG);
    if (cut <= 0) cut = remaining.lastIndexOf("\n", MAX_MSG);
    if (cut <= 0) cut = MAX_MSG;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);

  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: GROUP_ID, text: chunk }),
    });
    if (!res.ok) {
      console.error(`Telegram error: ${res.status} ${await res.text()}`);
      return false;
    }
  }
  return true;
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  // Fetch all quotes
  const symbolCoins = COINS.filter(c => !c.slug);
  const slugCoins = COINS.filter(c => c.slug);
  const quotes = new Map<string, CMCCoin>();

  if (symbolCoins.length > 0) {
    const q = await fetchQuotes(symbolCoins.map(c => c.symbol));
    for (const [k, v] of q) quotes.set(k, v);
  }
  if (slugCoins.length > 0) {
    const slugMap = new Map(slugCoins.map(c => [c.slug!, c.symbol]));
    const q = await fetchBySlugs(slugMap);
    for (const [k, v] of q) quotes.set(k, v);
  }

  // Time context
  const now = new Date();
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(now), 10
  );
  const dayName = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" }).format(now);
  const dateStr = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(now);
  const tzAbbr = now.toLocaleString("en-US", { timeZone: TZ, timeZoneName: "short" }).split(" ").at(-1) || "ET";

  const isTradeHour = hour === 19;
  const isSunday = dayName === "Sunday";

  // ── Section 1: Price Snapshot (every run) ──────────────────
  const lines: string[] = [];
  lines.push(`📊 Crypto Report — ${dateStr} ${tzAbbr}`);
  lines.push("");

  let sum24h = 0, count = 0;

  for (const { symbol } of COINS) {
    const coin = quotes.get(symbol);
    if (!coin) {
      lines.push(`${symbol}  ⚠️ Not found`);
      lines.push("");
      continue;
    }
    const q = coin.quote.USD;
    const tag = sentiment(q.percent_change_24h, q.percent_change_7d);
    lines.push(
      `${coin.symbol}  $${fmtPrice(q.price)}  24h ${sign(q.percent_change_24h)}%  7d ${sign(q.percent_change_7d)}%  Vol ${fmtVol(q.volume_24h)}  [${tag}]`
    );
    lines.push("");
    sum24h += q.percent_change_24h;
    count++;
  }

  if (count > 0) {
    const avg = sum24h / count;
    lines.push(`—`);
    lines.push(`${overallSentiment(avg)}  (avg 24h: ${sign(avg)}%)`);
  }

  // ── Section 2: Trade Setups (7pm only) ─────────────────────
  if (isTradeHour) {
    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("🎯 Trade Setups — 7PM");
    lines.push("");

    for (const { symbol } of COINS) {
      const coin = quotes.get(symbol);
      if (!coin) continue;
      const q = coin.quote.USD;
      const { price, percent_change_7d: p7d, percent_change_30d: p30d, volume_24h: vol, market_cap: mcap } = q;
      const sr = calcSR(price, p7d);
      const rec = leverageRec(p7d, vol);
      const lowLiq = vol < 10_000_000;

      const longEntry  = sr.S2 * 1.005;
      const longTarget = sr.R1;
      const longStop   = sr.S1 * 0.98;
      const longLiq    = liqPrice(longEntry, rec.long, true);

      const shortEntry  = sr.R1 * 0.995;
      const shortTarget = sr.S2;
      const shortStop   = sr.R2 * 1.02;
      const shortLiq    = liqPrice(shortEntry, rec.short, false);

      lines.push(`${coin.name} (${coin.symbol})  $${fmtPrice(price)}`);
      lines.push(`Trend: ${trendLabel(p7d)}`);
      lines.push(`🔺 R2 $${fmtPrice(sr.R2)}   R1 $${fmtPrice(sr.R1)}`);
      lines.push(`🔹 S1 $${fmtPrice(sr.S1)}   S2 $${fmtPrice(sr.S2)}`);
      lines.push(`Vol 24h ${fmtVol(vol)}  ·  MCap ${fmtMcap(mcap)}  ·  30d ${sign(p30d)}%${lowLiq ? "  ⚠️ Low Liq" : ""}`);
      lines.push("");
      lines.push(`📈 Long ${rec.long}x`);
      lines.push(`  Entry  $${fmtPrice(longEntry)}`);
      lines.push(`  Target $${fmtPrice(longTarget)}  (R1)`);
      lines.push(`  Stop   $${fmtPrice(longStop)}`);
      lines.push(`  Liq    $${fmtPrice(longLiq)}`);
      lines.push("");
      lines.push(`📉 Short ${rec.short}x`);
      lines.push(`  Entry  $${fmtPrice(shortEntry)}`);
      lines.push(`  Target $${fmtPrice(shortTarget)}  (S2)`);
      lines.push(`  Stop   $${fmtPrice(shortStop)}`);
      lines.push(`  Liq    $${fmtPrice(shortLiq)}`);
      lines.push(`─────────────────`);
      lines.push("");
    }
  }

  // ── Section 3: Sunday Recap (Sunday 7pm only) ──────────────
  if (isTradeHour && isSunday) {
    const sorted = COINS
      .map(c => ({ symbol: c.symbol, coin: quotes.get(c.symbol) }))
      .filter((x): x is { symbol: string; coin: CMCCoin } => !!x.coin)
      .sort((a, b) => b.coin.quote.USD.percent_change_7d - a.coin.quote.USD.percent_change_7d);

    const totalVol = sorted.reduce((s, x) => s + x.coin.quote.USD.volume_24h, 0);
    const avg7d = sorted.reduce((s, x) => s + x.coin.quote.USD.percent_change_7d, 0) / sorted.length;

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("📅 Weekly Recap");
    lines.push("");

    // Top 3 winners
    lines.push("Winners:");
    for (const x of sorted.slice(0, 3)) {
      const q = x.coin.quote.USD;
      lines.push(`  🟢 ${x.coin.symbol}  ${sign(q.percent_change_7d)}% (7d)  $${fmtPrice(q.price)}`);
    }
    lines.push("");

    // Bottom 3 losers
    lines.push("Losers:");
    for (const x of sorted.slice(-3).reverse()) {
      const q = x.coin.quote.USD;
      lines.push(`  🔴 ${x.coin.symbol}  ${sign(q.percent_change_7d)}% (7d)  $${fmtPrice(q.price)}`);
    }
    lines.push("");

    lines.push(`Total 24h Volume: ${fmtVol(totalVol)}`);
    lines.push(`Avg 7d Change: ${sign(avg7d)}%`);
  }

  const message = lines.join("\n").trimEnd();

  // Send
  console.log("Sending crypto report to Gentech group...");
  const ok = await sendTelegram(message);
  if (ok) {
    console.log("Sent successfully.");
  } else {
    console.error("Failed to send.");
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
