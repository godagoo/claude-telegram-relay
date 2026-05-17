// trigger.ts
// Decides whether an inbound Telegram message references prior context.
// High-precision regex set; missed cases are fine for v1, false-positives
// are more painful (irrelevant context injection).

import { BOOK_TRIGGER_PATTERN } from "./books";

export { isAnesthesiaCorpusQuery } from "./anesthesia-corpus";

const BOOK_REFERENCE = new RegExp(
  `\\b(textbooks?|anesthesia textbook|${BOOK_TRIGGER_PATTERN})\\b`,
  "i",
);

const PATTERNS: RegExp[] = [
  // Explicit requests to use the local index/corpus. These are not merely
  // conversational references; they are retrieval commands.
  /\b(search|find|look through|check|query)\b.*\b(my|your|the|custom)?\s*(index|corpus|vault|notes?|files?|textbooks?|books?)\b/i,
  /\b(my|your|the|custom)\s+(index|corpus|vault)\b/i,
  BOOK_REFERENCE,
  /\b(indexed|index\/corpus)\b/i,

  // Explicit memory verbs and time anchors
  /\b(remember|recall|remind me|you (told|said|mentioned)|we (discussed|talked|agreed|decided)|i told you|earlier|previously|last time|the other day|before)\b/i,

  // "the X" / "that X" / "those X" referring to a specific past entity
  /\b(the|that|those|this|these) (appeal|plan|email|message|note|paper|case|patient|resident|attending|protocol|draft|deck|repo|PR|commit|bug|ticket|issue|project|client|study|trial)\b/i,

  // Possessive references to people we've discussed
  /\b[A-Z][a-z]+(['']s)? (PEI|plan|email|note|case|appointment|message|reply)\b/,

  // Continuation cues
  /\b(continue|finish|update|status of|progress on|where (are|did) we|pick up|follow up|resume|keep (going|searching|looking|trying))\b/i,

  // Question forms about past state
  /\bwhat (did|was|were) (we|you|i)\b/i,
  /\bhow (did|was) (we|that|the)\b/i,
];

export function isReferential(message: string): boolean {
  return PATTERNS.some((rx) => rx.test(message));
}

// Exported for unit-style ad-hoc testing.
export const _PATTERNS = PATTERNS;
