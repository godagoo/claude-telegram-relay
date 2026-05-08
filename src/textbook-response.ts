import type { Hit } from "./retrieval";

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

  const skippedHits = hits.filter(isSkippedTextbookPath).slice(0, 3);
  if (skippedHits.length === 0) return null;

  const files = skippedHits
    .map((hit) => `- ${displayPath(hit.file_path)}`)
    .join("\n");

  return [
    "I found the textbook files in your index, but they were indexed only as file paths, not extracted into searchable text yet.",
    "",
    files,
    "",
    "So I can confirm the files exist, but I cannot quote or answer from Barash/Miller content until we fix PDF extraction for those files.",
  ].join("\n");
}
