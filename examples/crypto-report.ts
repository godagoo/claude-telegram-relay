/**
 * Crypto Report — Price Updates, Trade Setup & Weekly Recap
 *
 * Single consolidated script. Auto-detects what to send based on time/day (ET):
 *   - Every hour 7am–11pm: Price snapshot (price, 24h change, 7d change, bull/bear)
 *   - Daily at 7pm:        + Trade setup (trend, support/resistance, key levels)
 *   - Sunday at 7pm:       + Weekly recap (macro analysis, predictions — Ivan on Tech style)
 *
 * Required env vars:
 *   CMC_API_KEY         - CoinMarketCap Pro API key
 *   TELEGRAM_BOT_TOKEN  - Telegram bot token
 *   TELEGRAM_USER_ID    - Your Telegram user ID
 *
 * Optional env vars:
 *   CMC_SYMBOLS         - Override coin list, comma-separated (e.g. "BTC,ETH,SOL")
 *                         If unset, fetches your watchlist; falls back to defaults.
 *
 * Replace your two cron jobs with this single entry:
 *   0 7-23 * * * cd /root/claude-telegram-relay && /usr/bin/bun run examples/crypto-report.ts >> /tmp/crypto-report.log 2>&1
 */

import { spawn } from "bun";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CMC_API_KEY =
  process.env.CMC_API_KEY || process.env.COINMARKETCAP_API_KEY || "";

// All chat IDs that should receive crypto reports.
// CRYPTO_REPORT_CHAT_IDS overrides the default (personal only).
// Set to a comma-separated list of group IDs + your personal ID.
// Example: CRYPTO_REPORT_CHAT_IDS=-1001234567890,-1009876543210,7105876857
const REPORT_CHAT_IDS: string[] = process.env.CRYPTO_REPORT_CHAT_IDS
  ? process.env.CRYPTO_REPORT_CHAT_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [CHAT_ID];
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

const WATCHLIST_ID = "67453707ad745f0bbd4ad54f";

const DEFAULT_SYMBOLS = [
  "BTC", "ETH", "SOL", "BNB", "XRP", "AVAX", "LINK", "DOT",
];

// ============================================================
// TYPES
// ============================================================

interface QuoteUSD {
  price: number;
  percent_change_1h: number;
  percent_change_24h: number;
  percent_change_7d: number;
  percent_change_30d: number;
  volume_24h: number;
  market_cap: number;
}

interface CoinData {
  id: number;
  name: string;
  symbol: string;
  quote: { USD: QuoteUSD };
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message: string, chatId = CHAT_ID): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }
    );
    if (!res.ok) {
      const body = await res.text();
      console.error(`Telegram error [chat:${chatId}]:`, res.status, body);
    }
    return res.ok;
  } catch (e) {
    console.error(`Telegram send failed [chat:${chatId}]:`, e);
    return false;
  }
}

/** Send a message to all configured report chat IDs. */
async function broadcast(message: string): Promise<void> {
  await Promise.all(REPORT_CHAT_IDS.map((id) => sendTelegram(message, id)));
}

// ============================================================
// CMC API
// ============================================================

async function fetchWatchlistSymbols(): Promise<string[]> {
  try {
    const res = await fetch(
      `https://pro-api.coinmarketcap.com/v3/watchlist/quotes/latest?id=${WATCHLIST_ID}`,
      { headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY } }
    );
    if (!res.ok) throw new Error(`Watchlist API ${res.status}`);
    const json = (await res.json()) as any;
    // Handle both response shapes CMC has returned
    const list =
      json?.data?.cryptoCurrencyList ??
      json?.data ??
      [];
    const symbols: string[] = list
      .map((c: any) => c.symbol as string)
      .filter(Boolean);
    if (symbols.length) {
      console.log(`Watchlist loaded: ${symbols.join(", ")}`);
    }
    return symbols;
  } catch (e) {
    console.log("Watchlist fetch failed, using fallback:", String(e));
    return [];
  }
}

async function fetchCoinData(symbols: string[]): Promise<CoinData[]> {
  const symbolStr = [...new Set(symbols)].join(",");
  const res = await fetch(
    `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${symbolStr}&convert=USD`,
    { headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY } }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CMC quotes API ${res.status}: ${body}`);
  }
  const json = (await res.json()) as any;

  const coins: CoinData[] = [];
  for (const sym of symbols) {
    const entries = json.data?.[sym];
    if (Array.isArray(entries) && entries.length > 0) {
      coins.push(entries[0] as CoinData);
    } else if (entries && !Array.isArray(entries)) {
      coins.push(entries as CoinData);
    }
  }
  return coins;
}

async function getCoins(): Promise<CoinData[]> {
  // Priority: env override → watchlist → defaults
  const envSymbols = (process.env.CMC_SYMBOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let symbols = envSymbols.length ? envSymbols : await fetchWatchlistSymbols();

  if (!symbols.length) {
    console.log("No watchlist data — using default coin list");
    symbols = DEFAULT_SYMBOLS;
  }

  return fetchCoinData(symbols);
}

// ============================================================
// FORMATTING HELPERS
// ============================================================

function fmtPrice(price: number): string {
  if (price >= 10_000)
    return `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (price >= 100)
    return `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (price >= 1)
    return `$${price.toFixed(3)}`;
  return `$${price.toFixed(5)}`;
}

function fmtPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function arrow(pct: number): string {
  if (pct > 5) return "⬆️";
  if (pct > 1) return "↗️";
  if (pct < -5) return "⬇️";
  if (pct < -1) return "↘️";
  return "➡️";
}

function sentiment(q: QuoteUSD): string {
  const { percent_change_24h: h24, percent_change_7d: w7 } = q;
  if (h24 > 4 && w7 > 5) return "🟢 <b>Strong Bull</b>";
  if (h24 > 1.5 && w7 > 0) return "🟢 Bullish";
  if (h24 < -4 && w7 < -5) return "🔴 <b>Strong Bear</b>";
  if (h24 < -1.5 && w7 < 0) return "🔴 Bearish";
  if (h24 > 0) return "🟡 Neutral+";
  if (h24 < 0) return "🟡 Neutral−";
  return "⚪ Neutral";
}

function trendLabel(coin: CoinData): string {
  const { percent_change_24h: h24, percent_change_7d: w7, percent_change_30d: m30 } =
    coin.quote.USD;
  // Weighted momentum score
  const score = h24 * 0.4 + w7 * 0.35 + m30 * 0.25;
  if (score > 10) return "🚀 Strong Uptrend";
  if (score > 3) return "📈 Uptrend";
  if (score > -3) return "↔️ Sideways / Consolidating";
  if (score > -10) return "📉 Downtrend";
  return "🩸 Strong Downtrend";
}

function estimateSR(coin: CoinData): {
  r2: number; r1: number; s1: number; s2: number;
} {
  const price = coin.quote.USD.price;
  const w7 = coin.quote.USD.percent_change_7d / 100;
  const m30 = coin.quote.USD.percent_change_30d / 100;

  // Reconstruct approximate period open prices
  const weekOpen = price / (1 + w7);
  const monthOpen = price / (1 + m30);

  const rangeHigh7 = Math.max(price, weekOpen) * 1.015;
  const rangeLow7 = Math.min(price, weekOpen) * 0.985;
  const rangeHigh30 = Math.max(price, monthOpen) * 1.02;
  const rangeLow30 = Math.min(price, monthOpen) * 0.97;

  const round = (n: number) =>
    n >= 100 ? Math.round(n * 10) / 10 : Math.round(n * 1000) / 1000;

  return {
    r2: round(rangeHigh30),
    r1: round(rangeHigh7),
    s1: round(rangeLow7),
    s2: round(rangeLow30),
  };
}

// ============================================================
// MESSAGE BUILDERS
// ============================================================

function buildPriceSnapshot(coins: CoinData[]): string {
  const ts = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const rows = coins.map((coin) => {
    const q = coin.quote.USD;
    return (
      `<b>${coin.symbol}</b>  ${fmtPrice(q.price)}\n` +
      `  24h ${fmtPct(q.percent_change_24h)} ${arrow(q.percent_change_24h)}` +
      `   7d ${fmtPct(q.percent_change_7d)} ${arrow(q.percent_change_7d)}\n` +
      `  ${sentiment(q)}`
    );
  });

  return `📊 <b>Crypto Snapshot</b>  —  ${ts} ET\n\n${rows.join("\n\n")}`;
}

function buildTradeSetup(coins: CoinData[]): string {
  const blocks = coins.map((coin) => {
    const q = coin.quote.USD;
    const sr = estimateSR(coin);
    const vol = (q.volume_24h / 1_000_000).toFixed(0);
    const mcap = (q.market_cap / 1_000_000_000).toFixed(1);

    return (
      `<b>${coin.name} (${coin.symbol})</b>  ${fmtPrice(q.price)}\n` +
      `Trend: ${trendLabel(coin)}\n` +
      `🔺 R2 ${fmtPrice(sr.r2)}   R1 ${fmtPrice(sr.r1)}\n` +
      `🔹 S1 ${fmtPrice(sr.s1)}   S2 ${fmtPrice(sr.s2)}\n` +
      `Vol 24h $${vol}M  ·  MCap $${mcap}B  ·  30d ${fmtPct(q.percent_change_30d)}`
    );
  });

  const sep = "\n\n─────────────────\n\n";
  return `🎯 <b>Trade Setup</b>\n\n${blocks.join(sep)}`;
}

async function buildWeeklyRecap(coins: CoinData[]): Promise<string> {
  const today = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const coinSummary = coins
    .map((c) => {
      const q = c.quote.USD;
      return (
        `${c.symbol} (${c.name}): $${q.price.toFixed(2)} | ` +
        `24h ${fmtPct(q.percent_change_24h)} | ` +
        `7d ${fmtPct(q.percent_change_7d)} | ` +
        `30d ${fmtPct(q.percent_change_30d)} | ` +
        `vol $${(q.volume_24h / 1e9).toFixed(2)}B`
      );
    })
    .join("\n");

  const prompt = `You are a crypto market analyst writing in the style of Ivan on Tech — clear, direct, educational, data-driven. No hype, no FUD. Give real analysis.

Today is ${today}. Here is this week's market data:

${coinSummary}

Write a Sunday evening weekly recap for Telegram. Structure it exactly like this:

1. MARKET SUMMARY — Was this week bullish, bearish, or mixed? 2 sentences max. Include the overall % for BTC and ETH.

2. WHY DID MARKETS MOVE? — Based on the price action and likely macro context (Fed policy, ETF flows, regulatory news, macro risk-off/on, etc.), explain 3–4 key drivers as bullet points. Be specific.

3. CHART ANALYSIS — Pick the 3 most interesting movers from the list. For each, describe what the price action signals (accumulation, distribution, breakout above resistance, failed retest, bearish divergence, etc.). Ivan-style: commit to a read.

4. NEXT WEEK OUTLOOK — Give a clear directional bias (Bullish / Bearish / Neutral) with 2–3 supporting reasons. Name specific price levels to watch on BTC. Be direct. Ivan never hedges — he states his view and explains why.

5. KEY LEVELS TO WATCH — List 3–4 critical price levels (support and resistance) across BTC and ETH.

Format: plain text only, no markdown. Keep the full response under 700 words. Use "—" for section headers. Write like you're speaking to your audience on YouTube.`;

  try {
    const proc = spawn([CLAUDE_PATH, "-p", prompt, "--output-format", "text"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    return (
      `📰 <b>Weekly Recap — ${today}</b>\n\n` +
      output.trim()
    );
  } catch (e) {
    console.error("Claude weekly recap error:", e);
    return `📰 <b>Weekly Recap — ${today}</b>\n\nFailed to generate AI analysis. Check Claude CLI: ${String(e)}`;
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`[crypto-report] Starting — ${new Date().toISOString()}`);

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }
  if (!CMC_API_KEY) {
    console.error("Missing CMC_API_KEY — add it to .env");
    process.exit(1);
  }

  // Determine current time in ET
  const nowET = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const hour = nowET.getHours();
  const isSunday = nowET.getDay() === 0;
  const isTradeHour = hour === 19; // 7pm ET

  console.log(
    `ET time: ${nowET.toLocaleString()} | hour=${hour} | sunday=${isSunday} | tradeHour=${isTradeHour}`
  );

  // Fetch coin data
  let coins: CoinData[];
  try {
    coins = await getCoins();
    console.log(`Fetched ${coins.length} coins: ${coins.map((c) => c.symbol).join(", ")}`);
  } catch (e) {
    console.error("Failed to fetch coin data:", e);
    process.exit(1);
  }

  if (!coins.length) {
    console.error("No coin data returned — check CMC_API_KEY and CMC_SYMBOLS");
    process.exit(1);
  }

  console.log(`Broadcasting to ${REPORT_CHAT_IDS.length} chat(s): ${REPORT_CHAT_IDS.join(", ")}`);

  // 1. Always: hourly price snapshot
  const priceMsg = buildPriceSnapshot(coins);
  await broadcast(priceMsg);
  console.log(`Price snapshot broadcast done`);

  // 2. At 7pm ET: trade setup
  if (isTradeHour) {
    const tradeMsg = buildTradeSetup(coins);
    await broadcast(tradeMsg);
    console.log(`Trade setup broadcast done`);

    // 3. Sunday 7pm: weekly recap (Claude-powered)
    if (isSunday) {
      console.log("Sunday — generating weekly recap via Claude...");
      const recapMsg = await buildWeeklyRecap(coins);
      await broadcast(recapMsg);
      console.log(`Weekly recap broadcast done`);
    }
  }

  console.log("[crypto-report] Done.");
}

main();
