#!/usr/bin/env bun
/**
 * Watchlist Tracker — Gentech Strategies Group
 *
 * Posts crypto watchlist updates to the Gentech Strategies Telegram group.
 * Fetches CMC quotes, formats with sentiment indicators, sends via Telegram API.
 *
 * Usage:  bun run examples/watchlist-tracker.ts
 * Cron:   0 7-22 * * *  (every hour, 7am-10pm ET)
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
const COINS: { symbol: string; name: string; slug?: string }[] = [
  { symbol: "BTC",   name: "Bitcoin"     },
  { symbol: "AVAX",  name: "Avalanche"   },
  { symbol: "SOL",   name: "Solana"      },
  { symbol: "LINK",  name: "Chainlink"   },
  { symbol: "COQ",   name: "Coq Inu"     },
  { symbol: "ARENA", name: "The Arena"   },
  { symbol: "BEAM",  name: "Beam"        },
  { symbol: "LAND",  name: "Landshare"   },
  { symbol: "XAG",   name: "Silver"      },
  { symbol: "XAUT",  name: "Tether Gold", slug: "tether-gold" },
];

// ── CMC API ──────────────────────────────────────────────────
type Quote = {
  price: number;
  volume_24h: number;
  percent_change_24h: number;
  percent_change_7d: number;
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

function sign(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

// ── Sentiment Indicators ─────────────────────────────────────
function sentiment(pct24h: number, pct7d: number): string {
  if (pct24h >= 10 && pct7d >= 15) return "🚀 BULLISH";
  if (pct24h >= 3)                 return "🟢 bullish";
  if (pct24h >= 1)                 return "📈";
  if (pct24h >= -1)                return "⚪️ neutral";
  if (pct24h >= -3)                return "📉";
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

// ── Telegram ─────────────────────────────────────────────────
const MAX_MSG_LENGTH = 4000;

async function sendTelegram(text: string): Promise<boolean> {
  // Split long messages at natural boundaries
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_MSG_LENGTH) {
    let cut = remaining.lastIndexOf("\n\n", MAX_MSG_LENGTH);
    if (cut <= 0) cut = remaining.lastIndexOf("\n", MAX_MSG_LENGTH);
    if (cut <= 0) cut = MAX_MSG_LENGTH;
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
      console.error(`Telegram API error: ${res.status} ${await res.text()}`);
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

  // Timestamp
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(now);
  const tzAbbr = now.toLocaleString("en-US", { timeZone: TZ, timeZoneName: "short" }).split(" ").at(-1) || "ET";

  // Build message
  const lines: string[] = [];
  lines.push(`📊 Watchlist Update — ${dateStr} ${tzAbbr}`);
  lines.push("");

  let sum24h = 0;
  let count = 0;

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

  // Overall sentiment
  if (count > 0) {
    const avg = sum24h / count;
    lines.push(`—`);
    lines.push(`${overallSentiment(avg)}  (avg 24h: ${sign(avg)}%)`);
  }

  const message = lines.join("\n").trimEnd();

  // Send
  console.log("Sending watchlist to Gentech group...");
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
