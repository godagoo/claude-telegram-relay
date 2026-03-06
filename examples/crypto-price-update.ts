/**
 * Crypto Price Update
 *
 * Fetches crypto prices from CoinMarketCap and sends a formatted
 * report to Telegram. Designed to run hourly via cron/PM2.
 *
 * Respects a time window: only sends between 7am–11pm EST.
 * Outside that window, exits silently.
 *
 * Requires: CMC_API_KEY in .env
 *
 * Run manually: bun run examples/crypto-price-update.ts
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CMC_API_KEY = process.env.CMC_API_KEY || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || "America/New_York";

// Coins to track — symbols must match CoinMarketCap
const SYMBOLS = [
  "BTC",
  "AVAX",
  "SOL",
  "LINK",
  "COQ",
  "ARENA",
  "BEAM",
  "LAND",
  "XAG",
  "XAUT",
];

// ============================================================
// TIME WINDOW GUARD
// ============================================================

function isWithinActiveHours(): boolean {
  const now = new Date();
  const estTime = new Date(
    now.toLocaleString("en-US", { timeZone: USER_TIMEZONE })
  );
  const hour = estTime.getHours();
  // Active between 7am (7) and 11pm (22, i.e. up to 22:59)
  return hour >= 7 && hour <= 22;
}

// ============================================================
// COINMARKETCAP API
// ============================================================

interface CMCQuote {
  symbol: string;
  name: string;
  quote: {
    USD: {
      price: number;
      percent_change_24h: number;
      percent_change_7d: number;
      volume_24h: number;
    };
  };
}

async function fetchPrices(): Promise<CMCQuote[]> {
  const symbolList = SYMBOLS.join(",");
  const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${symbolList}&convert=USD`;

  const response = await fetch(url, {
    headers: {
      "X-CMC_PRO_API_KEY": CMC_API_KEY,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`CoinMarketCap API error ${response.status}: ${text}`);
  }

  const data = await response.json();

  if (data.status?.error_code !== 0) {
    throw new Error(`CMC error: ${data.status?.error_message || "Unknown"}`);
  }

  // Extract quotes in order of our SYMBOLS list
  const quotes: CMCQuote[] = [];
  for (const symbol of SYMBOLS) {
    const entry = data.data?.[symbol];
    if (entry) {
      // CMC may return an array for symbols with multiple matches
      const coin = Array.isArray(entry) ? entry[0] : entry;
      quotes.push(coin);
    }
  }

  return quotes;
}

// ============================================================
// FORMATTING
// ============================================================

function getTrendEmoji(change24h: number): string {
  if (change24h <= -3) return "🔴 bearish";
  if (change24h < 0) return "📉";
  if (change24h <= 2) return "⚪️ neutral";
  if (change24h <= 5) return "📈";
  return "🟢 bullish";
}

function formatVolume(vol: number): string {
  if (vol >= 1e9) return `$${(vol / 1e9).toFixed(1)}B`;
  if (vol >= 1e6) return `$${(vol / 1e6).toFixed(0)}M`;
  if (vol >= 1e3) return `$${(vol / 1e3).toFixed(0)}K`;
  return `$${vol.toFixed(0)}`;
}

function formatPrice(price: number): string {
  if (price >= 1000) return `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (price >= 1) return `$${price.toFixed(3)}`;
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  if (price >= 0.0001) return `$${price.toFixed(5)}`;
  return `$${price.toFixed(8)}`;
}

function formatPercent(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function formatReport(quotes: CMCQuote[]): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-US", {
    timeZone: USER_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const lines: string[] = [];
  lines.push(`📊 Crypto Report — ${dateStr}, ${timeStr} EST\n`);

  let totalChange = 0;
  let count = 0;

  for (const coin of quotes) {
    const q = coin.quote.USD;
    const symbol = coin.symbol;
    const price = formatPrice(q.price);
    const change24h = formatPercent(q.percent_change_24h);
    const change7d = formatPercent(q.percent_change_7d);
    const vol = formatVolume(q.volume_24h);
    const trend = getTrendEmoji(q.percent_change_24h);

    lines.push(
      `${symbol}  ${price}  24h ${change24h}  7d ${change7d}  Vol ${vol}  [${trend}]`
    );

    totalChange += q.percent_change_24h;
    count++;
  }

  const avgChange = count > 0 ? totalChange / count : 0;
  const marketTrend =
    avgChange <= -1
      ? "🔴 Market trending down"
      : avgChange >= 1
        ? "🟢 Market trending up"
        : "⚪️ Market flat";

  lines.push(`\n—`);
  lines.push(`${marketTrend}  (avg 24h: ${formatPercent(avgChange)})`);

  return lines.join("\n");
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
        }),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  // Time window guard
  if (!isWithinActiveHours()) {
    console.log(
      `Outside active hours (7am-11pm ${USER_TIMEZONE}). Skipping.`
    );
    process.exit(0);
  }

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  if (!CMC_API_KEY) {
    console.error("Missing CMC_API_KEY — get one at coinmarketcap.com/api");
    process.exit(1);
  }

  console.log("Fetching crypto prices...");

  try {
    const quotes = await fetchPrices();
    const report = formatReport(quotes);

    console.log(report);
    console.log("\nSending to Telegram...");

    const success = await sendTelegram(report);

    if (success) {
      console.log("Report sent!");
    } else {
      console.error("Failed to send report to Telegram");
      process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
