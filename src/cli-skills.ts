/**
 * CLI Skills — Pre-processing layer for CLI mode
 *
 * In CLI mode (no ANTHROPIC_API_KEY), tool_use isn't available.
 * This module detects skill intents from the user's message,
 * calls APIs directly, and returns enriched context to inject
 * into the CLI prompt so Claude can reference real data.
 */

import { handler as webSearchHandler } from "./skills/web-search.ts";
import { handler as defiHandler } from "./skills/defi.ts";
import { handler as videoHandler } from "./skills/video.ts";

interface SkillResult {
  skill: string;
  data: string;
}

/**
 * Detect skill intents and fetch data before sending to Claude CLI.
 * Returns enriched context string to prepend to the prompt.
 */
export async function preprocessForCLI(message: string): Promise<string> {
  const results: SkillResult[] = [];
  const lower = message.toLowerCase();

  // Run detections in parallel
  const tasks: Promise<SkillResult | null>[] = [];

  // YouTube URL detection
  if (/youtu\.?be[./]/.test(message)) {
    const urlMatch = message.match(/(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/live\/)[\w-]+)/);
    if (urlMatch) {
      tasks.push(trySkill("youtube", () => videoHandler("youtube_summary", { url: urlMatch[1] })));
    }
  }

  // Crypto price detection
  const priceMatch = lower.match(/(?:price\s+(?:of\s+)?|how\s+much\s+is\s+|what(?:'s|\s+is)\s+)(bitcoin|btc|ethereum|eth|solana|sol|bnb|xrp|cardano|ada|dogecoin|doge|polygon|matic|avalanche|avax|chainlink|link|uniswap|uni|aave|litecoin|ltc|polkadot|dot|near|arbitrum|arb|optimism|op|sui|aptos|apt|pepe|shib|bonk|jup|render|rndr|fetch|fet|injective|inj|sei|tia|pyth|jto|wif|popcat)(?:\s+price)?/i);
  if (priceMatch) {
    const tokenMap: Record<string, string> = {
      btc: "bitcoin", eth: "ethereum", sol: "solana", ada: "cardano",
      doge: "dogecoin", matic: "polygon", avax: "avalanche", link: "chainlink",
      uni: "uniswap", ltc: "litecoin", dot: "polkadot", arb: "arbitrum",
      op: "optimism", apt: "aptos", fet: "fetch-ai", inj: "injective-protocol",
      rndr: "render-token",
    };
    const raw = priceMatch[1].toLowerCase();
    const token = tokenMap[raw] || raw;
    tasks.push(trySkill("crypto_price", () => defiHandler("get_token_price", { token })));
  }

  // Gas price detection
  if (/\b(?:gas\s+price|gas\s+fee|gwei)\b/i.test(message)) {
    const chainMatch = lower.match(/(?:on\s+|for\s+)(ethereum|base|arbitrum|polygon)/);
    const chain = chainMatch ? chainMatch[1] : "ethereum";
    tasks.push(trySkill("gas_price", () => defiHandler("get_gas_price", { chain })));
  }

  // DeFi yields detection
  if (/\b(?:defi\s+yield|best\s+yield|top\s+yield|apy|farming|staking\s+yield)/i.test(message)) {
    const chainMatch = lower.match(/(?:on\s+|for\s+)(ethereum|solana|base|arbitrum|polygon)/);
    tasks.push(trySkill("defi_yields", () => defiHandler("get_defi_yields", { chain: chainMatch?.[1] || "all" })));
  }

  // Protocol TVL detection
  const tvlMatch = lower.match(/(?:tvl\s+(?:of\s+|for\s+)?|(?:about\s+)?)(aave|uniswap|lido|maker|compound|raydium|marinade|jito|drift|jupiter)(?:\s+tvl)?/);
  if (tvlMatch && /tvl|protocol|defi/i.test(message)) {
    tasks.push(trySkill("protocol_tvl", () => defiHandler("get_protocol_tvl", { protocol: tvlMatch[1] })));
  }

  // Chain stats detection
  const chainStatsMatch = lower.match(/(?:stats?\s+(?:for\s+|on\s+)?|(?:how\s+is\s+)?)(ethereum|solana|base|arbitrum|polygon|avalanche)(?:\s+(?:chain|stats?|doing|tvl))/);
  if (chainStatsMatch) {
    tasks.push(trySkill("chain_stats", () => defiHandler("get_chain_stats", { chain: chainStatsMatch[1] })));
  }

  // Web search detection (broad — runs if nothing else matched or explicit search intent)
  const isSearchIntent =
    /\b(?:search\s+(?:for|about)?|look\s+up|google|find\s+(?:me\s+)?info|what(?:'s|\s+is)\s+the\s+latest|current|today(?:'s)?|recent|news\s+(?:about|on)|who\s+(?:is|was|won)|when\s+(?:is|did|does)|where\s+(?:is|can|do))\b/i.test(message);

  if (isSearchIntent && tasks.length === 0) {
    // Extract a search query from the message
    const query = message
      .replace(/^(?:search\s+(?:for|about)\s*|look\s+up\s*|google\s*|find\s+(?:me\s+)?info\s+(?:about|on)\s*)/i, "")
      .trim();
    if (query.length > 2) {
      tasks.push(trySkill("web_search", () => webSearchHandler({ query, count: 5 })));
    }
  }

  // Contract source detection
  const contractMatch = message.match(/(?:contract|address)\s+(0x[a-fA-F0-9]{40})/);
  if (contractMatch && /(?:source|code|verify|verified|fetch|get)/i.test(message)) {
    const smartContract = await import("./skills/smart-contract.ts");
    const chainMatch = lower.match(/(?:on\s+)(ethereum|base|arbitrum|polygon|solana)/);
    tasks.push(trySkill("contract_source", () =>
      smartContract.handler("get_verified_source", { address: contractMatch[1], chain: chainMatch?.[1] || "ethereum" })
    ));
  }

  // Wait for all skill tasks
  const taskResults = await Promise.allSettled(tasks);
  for (const result of taskResults) {
    if (result.status === "fulfilled" && result.value) {
      results.push(result.value);
    }
  }

  if (results.length === 0) return "";

  // Format as context block
  const blocks = results.map((r) =>
    `[${r.skill.toUpperCase()} DATA]\n${r.data}\n[/${r.skill.toUpperCase()} DATA]`
  );

  return "\n\nREAL-TIME DATA (fetched just now — use this to inform your response):\n" + blocks.join("\n\n");
}

async function trySkill(
  skill: string,
  fn: () => Promise<string>
): Promise<SkillResult | null> {
  try {
    const data = await fn();
    if (data && !data.startsWith("Error:") && !data.includes("not configured")) {
      return { skill, data };
    }
    return null;
  } catch (err) {
    console.error(`CLI skill ${skill} failed:`, err);
    return null;
  }
}

