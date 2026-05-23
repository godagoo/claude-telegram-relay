// query-builder.ts
// Constructs a bounded FTS5 MATCH expression from a free-form message.
// Returns "" when fewer than two useful content tokens remain, so callers can
// skip broad single-token searches that are both noisy and expensive.

import { BOOK_KEY_SET, canonicalBookToken } from "./books";

export interface Turn {
  role: "user" | "assistant";
  content: string;
  ts: string;
}

const MAX_MATCH_TOKENS = 5;
const MIN_TOKEN_LEN = 3;
const MAX_QUERY_CHARS = 256;

export const ENGLISH_ONLY_DIRECTIVE =
  "Respond in English only. If the user writes in another language, translate it internally but reply in English.";

// Known textbook anchor tokens. retrieval.ts converts these into BOOK_PATH_FILTERS
// scopes — so they are the most valuable tokens we can preserve in the query.
// Pinned ahead of the length-based selection so multi-book comparison queries
// like "compare cote and barash on epidural opioids" don't drop the book names
// in favour of longer clinical adjectives.
const BOOK_NAME_ANCHORS = BOOK_KEY_SET;

const FTS5_RESERVED = new Set(["AND", "OR", "NOT", "NEAR"]);

// Source/format-redirection vocabulary. These words describe *how* the user
// wants the bot to search (use the markdown, look in the converted files),
// not *what* they want searched. Applied only when a topic-pivot signal is
// detected, so legitimate occurrences ("relevant trials", "converted units")
// outside a pivot context still survive.
const SOURCE_CONTROL_STOPWORDS = new Set([
  "instead",
  "rather",
  "actually",
  "different",
  "wait",
  "source",
  "sources",
  "relevant",
  "markdown",
  "converted",
  "today",
]);

// Topic-pivot / source-redirection signals. When any of these match, the
// user is correcting the *route* of the previous question, not asking a new
// clinical question. The query should preserve the prior anchor.
// Source of truth: live decision log `decisions-2026-05-09.jsonl` entry 3
// ("No, I want you to instead search through their relevant markdown files
// that I converted today") with prior anchor "miller arterial line indications".
const TOPIC_PIVOT_RE =
  /\b(instead|rather|actually|different|but|no,|wait|wrong|not that)\b/i;

const TOPIC_PIVOT_PATTERNS: RegExp[] = [
  TOPIC_PIVOT_RE,
  /\bnot (that|the|those|this)\b/i,
  /\b(use|read|check|search)\s+(the|those|these|my|your)?\s*(markdown|md|notes?|files?|pdf|docs?)\b/i,
  /\b(relevant|converted|indexed)\s+(markdown|files?|notes?|docs?|pdf|md)\b/i,
  /^no[,!.]?\s+(i|let|you|search|look|find|use|check|do|don'?t)\b/i,
];

// English stopwords minus negation words that can carry meaning, plus a small
// bot-specific overlay. Keep this local to avoid a runtime dependency.
const CORE_STOPWORDS = new Set([
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

const BOT_CONTROL_STOPWORDS = new Set([
  "remind", "ask", "tell", "show", "get", "find", "search", "look",
  "say", "says", "said",
  "searching", "looking", "keep", "keeping",
  "continue", "finish", "update", "resume", "follow", "status", "progress",
  "message", "messages", "note", "notes", "file", "files",
  "index", "indexed", "corpus", "vault", "custom", "setup",
]);

const STOPWORDS = new Set([...CORE_STOPWORDS, ...BOT_CONTROL_STOPWORDS]);

function isPureDigits(token: string): boolean {
  return /^\d+$/.test(token);
}

function isReserved(token: string): boolean {
  return FTS5_RESERVED.has(token.toUpperCase());
}

function quoteToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function filterContent(raw: string, extraStopwords?: Set<string>): string[] {
  return raw
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .map(canonicalBookToken)
    .filter((token) => token.length >= MIN_TOKEN_LEN)
    .filter((token) => !isPureDigits(token))
    .filter((token) => !STOPWORDS.has(token))
    .filter((token) => !extraStopwords || !extraStopwords.has(token))
    .filter((token) => !isReserved(token));
}

function isTopicPivot(message: string): boolean {
  return TOPIC_PIVOT_PATTERNS.some((rx) => rx.test(message));
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
  const pivot = isTopicPivot(currentMessage);
  // On a topic-pivot/source-redirection follow-up, also drop source-control
  // vocabulary so the FTS query is not "instead/relevant/markdown/converted".
  const chosen = uniqueTokens(
    filterContent(currentMessage, pivot ? SOURCE_CONTROL_STOPWORDS : undefined),
  );
  if (!pivot && chosen.length >= 2) return chosen;

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
      // On a pivot, recover the whole prior clinical anchor up to the cap.
      // Otherwise preserve the historical behavior of returning as soon as
      // we have two tokens.
      if (pivot) {
        if (chosen.length >= MAX_MATCH_TOKENS) return chosen;
      } else if (chosen.length >= 2) {
        return chosen;
      }
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
    // Pin book-name anchors first; they route retrieval to BOOK_PATH_FILTERS
    // scopes in retrieval.ts and are usually the highest-precision signal.
    const bookAnchors = unique.filter((t) => BOOK_NAME_ANCHORS.has(t));
    const others = unique
      .filter((t) => !BOOK_NAME_ANCHORS.has(t))
      .sort((a, b) => b.length - a.length || a.localeCompare(b));
    const cappedAnchors = bookAnchors.slice(0, MAX_MATCH_TOKENS);
    const remaining = MAX_MATCH_TOKENS - cappedAnchors.length;
    chosen = [...cappedAnchors, ...others.slice(0, remaining)];
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
