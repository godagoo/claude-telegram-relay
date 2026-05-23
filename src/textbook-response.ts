import { CATALOG_BOOK_LIST } from "./books";
import { CATALOG_HIT_PATH, type Hit } from "./retrieval";

const TEXTBOOK_REQUEST =
  /\b(barash|miller|textbooks?|anesthesia\s+textbooks?|anesthesia\s+book)\b/i;

// Narrow follow-up form: only the three phrases the user specified. Bare
// `keep` (e.g. "I keep my notes in Obsidian") must not match.
const CONTINUATION_FOLLOWUP = /\bkeep (going|searching|looking)\b/i;

export interface BuildContext {
  referentialFired: boolean;
  contentTokenCount: number;
}

function isSkippedTextbookPath(hit: Hit): boolean {
  return (
    hit.file_path.includes("/Desktop/Exam_Prep/Textbooks/") &&
    hit.content.includes("extraction_status=skipped") &&
    hit.content.includes("chunk_count=0")
  );
}

function displayPath(path: string): string {
  return path.replace(`${process.env.HOME}/`, "");
}

export function buildSkippedTextbookResponse(
  message: string,
  hits: Hit[],
  context?: BuildContext,
): string | null {
  const matchesOriginal = TEXTBOOK_REQUEST.test(message);
  // Continuation path: caller must have observed a referential trigger and
  // zero new content anchors, and every hit must be a skipped textbook path.
  // Without all five conditions we fall through and let Claude handle it.
  const matchesContinuation =
    !!context &&
    context.referentialFired &&
    context.contentTokenCount === 0 &&
    CONTINUATION_FOLLOWUP.test(message) &&
    hits.length > 0 &&
    hits.every(isSkippedTextbookPath);

  if (!matchesOriginal && !matchesContinuation) return null;

  // Unified semantics: only fire when EVERY hit is a skipped textbook path.
  // If the result also contains extractable content (markdown notes, chunks
  // from extracted PDFs, memory hits), let Claude reason over it instead of
  // bailing out with the canned "extraction skipped" message.
  if (hits.length === 0 || !hits.every(isSkippedTextbookPath)) return null;

  const skippedHits = hits.filter(isSkippedTextbookPath).slice(0, 3);

  const files = skippedHits
    .map((hit) => `- ${displayPath(hit.file_path)}`)
    .join("\n");

  return [
    "I found the textbook files in your index, but they were indexed only as file paths, not extracted into searchable text yet.",
    "",
    files,
    "",
    "So I can confirm the files exist, but I cannot quote or answer from Barash/Miller content until we fix PDF extraction for those files.",
    "",
    "If you already converted these to Markdown notes, reply: \"search my notes for <topic>\".",
    "To force a textbook search anyway, reply: \"keep searching textbooks\".",
  ].join("\n");
}

// Deterministic short-circuit for broad textbook-inventory questions. When
// retrieval has already collapsed the query to the synthetic catalog hit
// (see retrieval.isBroadTextbookInventoryQuery / textbookCatalogHits), there is
// nothing for Claude to synthesize — the answer is "here are the books".
// Returning a formatted bullet list directly avoids a 30-150s Claude round
// trip on a pure inventory prompt.
export function buildCatalogResponse(hits: Hit[]): string | null {
  if (hits.length !== 1) return null;
  if (hits[0].file_path !== CATALOG_HIT_PATH) return null;
  return [
    "Your indexed anesthesia textbooks (per-page Markdown):",
    "",
    ...CATALOG_BOOK_LIST.map((b) => `• ${b}`),
    "",
    "Ask a book/topic question, e.g. \"What does Miller say about arterial line indications?\"",
  ].join("\n");
}
