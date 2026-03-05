/**
 * Web Search Skill — Brave Search API
 *
 * Free tier: 2000 queries/month
 * No npm package needed — raw fetch.
 */

import type Anthropic from "@anthropic-ai/sdk";

const BRAVE_API_KEY = process.env.BRAVE_API_KEY || "";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export const definition: Anthropic.Tool = {
  name: "web_search",
  description:
    "Search the web for current information. Use this for real-time data, news, prices, facts, or anything that requires up-to-date information beyond your training data.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
      count: {
        type: "number",
        description: "Number of results to return (default 5, max 10)",
      },
    },
    required: ["query"],
  },
};

export async function handler(input: Record<string, unknown>): Promise<string> {
  if (!BRAVE_API_KEY) {
    return "Web search is not configured. Set BRAVE_API_KEY in .env (get one free at brave.com/search/api).";
  }

  const query = input.query as string;
  const count = Math.min((input.count as number) || 5, 10);

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", count.toString());

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": BRAVE_API_KEY,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return `Search failed (${response.status}): ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`;
  }

  const data = await response.json();
  const results = data.web?.results || [];

  if (results.length === 0) {
    return `No results found for "${query}"`;
  }

  return results
    .slice(0, count)
    .map((r: { title: string; url: string; description: string }, i: number) =>
      `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`
    )
    .join("\n\n");
}
