// query-builder.ts
// Constructs a bounded FTS5 MATCH expression from a free-form message.
// Returns "" when fewer than two useful content tokens remain, so callers can
// skip broad single-token searches that are both noisy and expensive.

export interface Turn {
  role: "user" | "assistant";
  content: string;
  ts: string;
}

const MAX_MATCH_TOKENS = 5;
const MIN_TOKEN_LEN = 3;
const MAX_QUERY_CHARS = 256;

const FTS5_RESERVED = new Set(["AND", "OR", "NOT", "NEAR"]);

// English stopwords minus negation words that can carry meaning, plus a small
// bot-specific overlay. Keep this local to avoid a runtime dependency.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "ought",
  "i", "you", "he", "she", "it", "we", "they", "them", "this", "that",
  "these", "those", "me", "my", "your", "his", "her", "its", "our", "their",
  "what", "which", "who", "whom", "when", "where", "why", "how",
  "not", "one",
  "of", "at", "by", "for", "with", "about", "between", "into", "through",
  "during", "before", "after", "above", "below", "from", "over", "under",
  "hey", "hi", "hello", "claude", "please", "thanks", "thank",
  "ok", "okay", "yes",
  "remind", "ask", "tell", "show", "get", "find", "search", "look",
  "say", "says", "said",
  "searching", "looking", "keep", "keeping",
  "continue", "finish", "update", "resume", "follow", "status", "progress",
  "message", "messages", "note", "notes", "file", "files",
  "index", "indexed", "corpus", "vault", "custom", "setup",
  "there", "somewhere", "though",
  "just", "only", "now", "then", "also", "really", "very",
  "like", "want", "know",
]);

function isPureDigits(token: string): boolean {
  return /^\d+$/.test(token);
}

function isReserved(token: string): boolean {
  return FTS5_RESERVED.has(token.toUpperCase());
}

function quoteToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function filterContent(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .filter((token) => token.length >= MIN_TOKEN_LEN)
    .filter((token) => !isPureDigits(token))
    .filter((token) => !STOPWORDS.has(token))
    .filter((token) => !isReserved(token));
}

function uniqueTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      unique.push(token);
    }
  }
  return unique;
}

function chooseTokens(currentMessage: string, recentTurns: Turn[]): string[] {
  const chosen = uniqueTokens(filterContent(currentMessage));
  if (chosen.length >= 2) return chosen;

  const seen = new Set(chosen);
  const priorUserTurns = recentTurns
    .filter((turn) => turn.role === "user")
    .slice(-4)
    .reverse();

  for (const turn of priorUserTurns) {
    for (const token of filterContent(turn.content)) {
      if (seen.has(token)) continue;
      seen.add(token);
      chosen.push(token);
      if (chosen.length >= 2) return chosen;
    }
  }

  return chosen;
}

export function buildSearchQuery(
  currentMessage: string,
  recentTurns: Turn[],
): string {
  const unique = chooseTokens(currentMessage, recentTurns);
  if (unique.length < 2) return "";

  let chosen: string[];
  if (unique.length <= MAX_MATCH_TOKENS) {
    chosen = unique;
  } else {
    chosen = [...unique]
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
      .slice(0, MAX_MATCH_TOKENS);
  }

  // Use implicit AND. On this DB, broad OR/rank queries over common terms can
  // trip the FTS5 virtual table into very slow or corrupt-vtab paths; AND keeps
  // the postings intersection tight and preserves the ORDER BY rank fast path.
  let expr = chosen.map(quoteToken).join(" ");
  if (expr.length > MAX_QUERY_CHARS) {
    expr = chosen.slice(0, MAX_MATCH_TOKENS).map(quoteToken).join(" ");
  }
  return expr;
}

export function countContentTokens(currentMessage: string): number {
  return filterContent(currentMessage).length;
}
