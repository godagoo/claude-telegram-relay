/**
 * DeFi Skill — Multi-chain (EVM + Solana)
 *
 * Token prices via CoinGecko (free, no key needed for basic)
 * DeFi yields/TVL via DeFiLlama (free, no key)
 * On-chain data via Etherscan/Solscan APIs (optional keys)
 */

import type Anthropic from "@anthropic-ai/sdk";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const DEFILLAMA_BASE = "https://api.llama.fi";

export const definitions: Anthropic.Tool[] = [
  {
    name: "get_token_price",
    description: "Get current price, market cap, and 24h change for a cryptocurrency token.",
    input_schema: {
      type: "object" as const,
      properties: {
        token: { type: "string", description: "Token name or CoinGecko ID (e.g., bitcoin, ethereum, solana, uniswap)" },
        currency: { type: "string", description: "Fiat currency for price (default: usd)" },
      },
      required: ["token"],
    },
  },
  {
    name: "get_defi_yields",
    description: "Get top DeFi yield opportunities across chains. Shows APY, TVL, and protocol info.",
    input_schema: {
      type: "object" as const,
      properties: {
        chain: { type: "string", description: "Filter by chain: ethereum, solana, base, arbitrum, polygon, or 'all'" },
        min_tvl: { type: "number", description: "Minimum TVL in USD (default 1000000)" },
        limit: { type: "number", description: "Number of results (default 10)" },
      },
      required: [],
    },
  },
  {
    name: "get_gas_price",
    description: "Get current gas prices for EVM chains (Ethereum, Base, Arbitrum, Polygon).",
    input_schema: {
      type: "object" as const,
      properties: {
        chain: { type: "string", description: "Chain name: ethereum, base, arbitrum, polygon (default: ethereum)" },
      },
      required: [],
    },
  },
  {
    name: "get_token_info",
    description: "Get detailed token information including contract address, chain, description, and links.",
    input_schema: {
      type: "object" as const,
      properties: {
        token: { type: "string", description: "Token name or CoinGecko ID" },
      },
      required: ["token"],
    },
  },
  {
    name: "get_protocol_tvl",
    description: "Get TVL and chain breakdown for a DeFi protocol (e.g., aave, uniswap, raydium, marinade).",
    input_schema: {
      type: "object" as const,
      properties: {
        protocol: { type: "string", description: "Protocol slug on DeFiLlama (e.g., aave, uniswap, lido)" },
      },
      required: ["protocol"],
    },
  },
  {
    name: "get_chain_stats",
    description: "Get TVL and top protocols for a blockchain.",
    input_schema: {
      type: "object" as const,
      properties: {
        chain: { type: "string", description: "Chain name (e.g., Ethereum, Solana, Base, Arbitrum)" },
      },
      required: ["chain"],
    },
  },
];

export async function handler(toolName: string, input: Record<string, unknown>): Promise<string> {
  switch (toolName) {
    case "get_token_price": return getTokenPrice(input);
    case "get_defi_yields": return getDefiYields(input);
    case "get_gas_price": return getGasPrice(input);
    case "get_token_info": return getTokenInfo(input);
    case "get_protocol_tvl": return getProtocolTvl(input);
    case "get_chain_stats": return getChainStats(input);
    default: return `Unknown DeFi tool: ${toolName}`;
  }
}

async function getTokenPrice(input: Record<string, unknown>): Promise<string> {
  const token = (input.token as string).toLowerCase();
  const currency = ((input.currency as string) || "usd").toLowerCase();

  const response = await fetch(
    `${COINGECKO_BASE}/simple/price?ids=${token}&vs_currencies=${currency}&include_market_cap=true&include_24hr_change=true&include_24hr_vol=true`
  );

  if (!response.ok) {
    // Try searching by name
    const searchResp = await fetch(`${COINGECKO_BASE}/search?query=${token}`);
    if (searchResp.ok) {
      const searchData = await searchResp.json();
      const coin = searchData.coins?.[0];
      if (coin) {
        return getTokenPrice({ token: coin.id, currency });
      }
    }
    return `Could not find price for "${token}". Try using the CoinGecko ID.`;
  }

  const data = await response.json();
  const info = data[token];
  if (!info) return `No price data for "${token}".`;

  const price = info[currency];
  const change = info[`${currency}_24h_change`];
  const mcap = info[`${currency}_market_cap`];
  const vol = info[`${currency}_24h_vol`];

  return [
    `${token.toUpperCase()}: $${formatNumber(price)}`,
    `24h Change: ${change?.toFixed(2)}%`,
    `Market Cap: $${formatNumber(mcap)}`,
    `24h Volume: $${formatNumber(vol)}`,
  ].join("\n");
}

async function getDefiYields(input: Record<string, unknown>): Promise<string> {
  const chain = (input.chain as string) || "all";
  const minTvl = (input.min_tvl as number) || 1_000_000;
  const limit = Math.min((input.limit as number) || 10, 20);

  const response = await fetch(`${DEFILLAMA_BASE}/pools`);
  if (!response.ok) return "Failed to fetch yield data from DeFiLlama.";

  const data = await response.json();
  let pools = data.data || [];

  // Filter
  if (chain !== "all") {
    pools = pools.filter((p: any) => p.chain?.toLowerCase() === chain.toLowerCase());
  }
  pools = pools.filter((p: any) => (p.tvlUsd || 0) >= minTvl && (p.apy || 0) > 0);

  // Sort by APY descending
  pools.sort((a: any, b: any) => (b.apy || 0) - (a.apy || 0));

  if (pools.length === 0) return `No yield pools found matching criteria.`;

  return pools.slice(0, limit).map((p: any, i: number) =>
    `${i + 1}. ${p.project} — ${p.symbol}\n` +
    `   Chain: ${p.chain} | APY: ${p.apy?.toFixed(2)}% | TVL: $${formatNumber(p.tvlUsd)}`
  ).join("\n\n");
}

async function getGasPrice(input: Record<string, unknown>): Promise<string> {
  const chain = ((input.chain as string) || "ethereum").toLowerCase();

  const chainConfig: Record<string, { url: string; keyEnv: string }> = {
    ethereum: { url: "https://api.etherscan.io/api", keyEnv: "ETHERSCAN_API_KEY" },
    base: { url: "https://api.basescan.org/api", keyEnv: "ETHERSCAN_API_KEY" },
    arbitrum: { url: "https://api.arbiscan.io/api", keyEnv: "ETHERSCAN_API_KEY" },
    polygon: { url: "https://api.polygonscan.com/api", keyEnv: "ETHERSCAN_API_KEY" },
  };

  const config = chainConfig[chain];
  if (!config) return `Unsupported chain: ${chain}. Supported: ${Object.keys(chainConfig).join(", ")}`;

  const apiKey = process.env[config.keyEnv] || "";
  const params = new URLSearchParams({
    module: "gastracker",
    action: "gasoracle",
    ...(apiKey ? { apikey: apiKey } : {}),
  });

  const response = await fetch(`${config.url}?${params}`);
  if (!response.ok) return `Gas price fetch failed for ${chain}.`;

  const data = await response.json();
  if (data.status !== "1") return `Gas data unavailable for ${chain}: ${data.message}`;

  const r = data.result;
  return [
    `${chain.charAt(0).toUpperCase() + chain.slice(1)} Gas Prices (Gwei):`,
    `  Low: ${r.SafeGasPrice}`,
    `  Average: ${r.ProposeGasPrice}`,
    `  High: ${r.FastGasPrice}`,
    r.suggestBaseFee ? `  Base Fee: ${r.suggestBaseFee}` : "",
  ].filter(Boolean).join("\n");
}

async function getTokenInfo(input: Record<string, unknown>): Promise<string> {
  const token = (input.token as string).toLowerCase();

  const response = await fetch(`${COINGECKO_BASE}/coins/${token}?localization=false&tickers=false&community_data=false&developer_data=false`);

  if (!response.ok) {
    // Try search
    const searchResp = await fetch(`${COINGECKO_BASE}/search?query=${token}`);
    if (searchResp.ok) {
      const searchData = await searchResp.json();
      const coin = searchData.coins?.[0];
      if (coin) return getTokenInfo({ token: coin.id });
    }
    return `Could not find info for "${token}".`;
  }

  const data = await response.json();
  const platforms = Object.entries(data.platforms || {})
    .filter(([, addr]) => addr)
    .map(([chain, addr]) => `  ${chain}: ${addr}`)
    .join("\n");

  return [
    `${data.name} (${data.symbol?.toUpperCase()})`,
    `Rank: #${data.market_cap_rank || "N/A"}`,
    `Categories: ${(data.categories || []).filter(Boolean).join(", ") || "N/A"}`,
    platforms ? `Contracts:\n${platforms}` : "",
    data.links?.homepage?.[0] ? `Website: ${data.links.homepage[0]}` : "",
    data.description?.en ? `\nDescription: ${data.description.en.substring(0, 300)}...` : "",
  ].filter(Boolean).join("\n");
}

async function getProtocolTvl(input: Record<string, unknown>): Promise<string> {
  const protocol = (input.protocol as string).toLowerCase();

  const response = await fetch(`${DEFILLAMA_BASE}/protocol/${protocol}`);
  if (!response.ok) return `Protocol "${protocol}" not found on DeFiLlama.`;

  const data = await response.json();

  const chains = Object.entries(data.currentChainTvls || {})
    .filter(([, tvl]) => (tvl as number) > 0)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, 10)
    .map(([chain, tvl]) => `  ${chain}: $${formatNumber(tvl as number)}`)
    .join("\n");

  return [
    `${data.name} (${data.symbol || "N/A"})`,
    `Total TVL: $${formatNumber(data.tvl || 0)}`,
    `Category: ${data.category || "N/A"}`,
    chains ? `\nTVL by Chain:\n${chains}` : "",
    data.url ? `Website: ${data.url}` : "",
  ].filter(Boolean).join("\n");
}

async function getChainStats(input: Record<string, unknown>): Promise<string> {
  const chain = input.chain as string;

  const response = await fetch(`${DEFILLAMA_BASE}/v2/chains`);
  if (!response.ok) return "Failed to fetch chain data.";

  const chains = await response.json();
  const chainData = chains.find((c: any) =>
    c.name.toLowerCase() === chain.toLowerCase() || c.gecko_id === chain.toLowerCase()
  );

  if (!chainData) return `Chain "${chain}" not found. Try: Ethereum, Solana, Base, Arbitrum, Polygon`;

  // Get top protocols for this chain
  const protocolsResp = await fetch(`${DEFILLAMA_BASE}/protocols`);
  let topProtocols = "";
  if (protocolsResp.ok) {
    const protocols = await protocolsResp.json();
    const chainProtocols = protocols
      .filter((p: any) => p.chains?.includes(chainData.name))
      .sort((a: any, b: any) => (b.tvl || 0) - (a.tvl || 0))
      .slice(0, 5);

    topProtocols = chainProtocols
      .map((p: any, i: number) => `  ${i + 1}. ${p.name}: $${formatNumber(p.tvl || 0)}`)
      .join("\n");
  }

  return [
    `${chainData.name}`,
    `TVL: $${formatNumber(chainData.tvl || 0)}`,
    topProtocols ? `\nTop Protocols:\n${topProtocols}` : "",
  ].filter(Boolean).join("\n");
}

function formatNumber(n: number): string {
  if (n >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(8);
}
