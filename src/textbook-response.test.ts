import { expect, test } from "bun:test";
import { buildCatalogResponse, buildSkippedTextbookResponse } from "./textbook-response";
import { CATALOG_HIT_PATH, type Hit } from "./retrieval";

function hit(path: string, content: string): Hit {
  return {
    chunk_id: -1,
    file_path: path,
    content,
    chunk_index: 0,
    rank_score: -1,
    display_score: 1,
    score: 1,
  };
}

test("returns deterministic response for skipped textbook path hits", () => {
  const response = buildSkippedTextbookResponse("What does Barash say?", [
    hit(
      `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/Miller_Barash/Barash 9.pdf`,
      "Indexed file path match. extraction_status=skipped; chunk_count=0",
    ),
  ]);

  expect(response).toContain("I found the textbook files");
  expect(response).toContain("Barash 9.pdf");
  expect(response).toContain("cannot quote or answer");
  expect(response).toContain('search my notes for <topic>');
  expect(response).toContain('keep searching textbooks');
});

test("does not intercept non-textbook retrieval", () => {
  const response = buildSkippedTextbookResponse("What did we decide?", [
    hit(
      `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/Miller_Barash/Barash 9.pdf`,
      "Indexed file path match. extraction_status=skipped; chunk_count=0",
    ),
  ]);

  expect(response).toBeNull();
});

test("does not intercept extracted textbook content", () => {
  const response = buildSkippedTextbookResponse("What does Miller say?", [
    hit(
      `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/Miller_Barash/Miller.pdf`,
      "Airway management chapter content",
    ),
  ]);

  expect(response).toBeNull();
});

const skippedBarashHit = hit(
  `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/Miller_Barash/Barash 9.pdf`,
  "Indexed file path match. extraction_status=skipped; chunk_count=0",
);

test("fires for 'Keep searching' continuation with skipped textbook hits", () => {
  const response = buildSkippedTextbookResponse(
    "Keep searching",
    [skippedBarashHit],
    { referentialFired: true, contentTokenCount: 0 },
  );

  expect(response).toContain("I found the textbook files");
  expect(response).toContain("Barash 9.pdf");
});

test("does not fire for 'I keep my notes in Obsidian' even with skipped textbook hits", () => {
  const response = buildSkippedTextbookResponse(
    "I keep my notes in Obsidian",
    [skippedBarashHit],
    { referentialFired: true, contentTokenCount: 0 },
  );

  expect(response).toBeNull();
});

test("does not fire for continuation when trigger did not fire", () => {
  const response = buildSkippedTextbookResponse(
    "Keep searching",
    [skippedBarashHit],
    { referentialFired: false, contentTokenCount: 0 },
  );

  expect(response).toBeNull();
});

test("does not fire for continuation when message still has content anchors", () => {
  const response = buildSkippedTextbookResponse(
    "Keep searching for the appeal",
    [skippedBarashHit],
    { referentialFired: true, contentTokenCount: 2 },
  );

  expect(response).toBeNull();
});

test("does not fire for continuation when hits include non-skipped-textbook entries", () => {
  const response = buildSkippedTextbookResponse(
    "Keep searching",
    [
      skippedBarashHit,
      hit(`${process.env.HOME}/Notes/random.md`, "Some unrelated note content"),
    ],
    { referentialFired: true, contentTokenCount: 0 },
  );

  expect(response).toBeNull();
});

test("fires for live phrasing 'What does barash say about the indications for intubation?'", () => {
  const response = buildSkippedTextbookResponse(
    "What does barash say about the indications for intubation?",
    [skippedBarashHit],
  );

  expect(response).toContain("I found the textbook files");
  expect(response).toContain("Barash 9.pdf");
});

test("fires for live phrasing 'What does miller say about the indications for intubation?'", () => {
  const response = buildSkippedTextbookResponse(
    "What does miller say about the indications for intubation?",
    [
      hit(
        `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/Miller_Barash/Miller.pdf`,
        "Indexed file path match. extraction_status=skipped; chunk_count=0",
      ),
    ],
  );

  expect(response).toContain("I found the textbook files");
  expect(response).toContain("Miller.pdf");
});

test("does not fire for original phrasing when an extractable hit exists alongside skipped textbook", () => {
  const response = buildSkippedTextbookResponse(
    "What does Barash say about indications for intubation?",
    [
      hit(
        `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/Miller_Barash/Barash 9.pdf`,
        "Some extracted chapter content about intubation",
      ),
      skippedBarashHit,
    ],
  );

  expect(response).toBeNull();
});

test("does not fire for original phrasing when a non-textbook markdown hit exists", () => {
  const response = buildSkippedTextbookResponse(
    "What does miller say are the indications for an arterial line?",
    [
      skippedBarashHit,
      hit(
        `${process.env.HOME}/ObsidianVault/Anesthesia/arterial-line-indications.md`,
        "Indications: hemodynamic instability, frequent ABG sampling, vasoactive drugs",
      ),
    ],
  );

  expect(response).toBeNull();
});

test("buildCatalogResponse returns formatted bullet list for the synthetic catalog hit", () => {
  const response = buildCatalogResponse([
    hit(
      CATALOG_HIT_PATH,
      "Converted anesthesia textbook corpus indexed as per-page Markdown.\nAvailable books: Barash 9, Chestnut 6, Cote Pediatric Anesthesia 6, Fleisher Uncommon Diseases, Miller 10, Stoelting 8.\nFor clinical retrieval, ask a book-specific or topic-specific question such as: What does Miller say about arterial line indications?",
    ),
  ]);

  expect(response).not.toBeNull();
  expect(response).toContain("Your indexed anesthesia textbooks");
  expect(response).toContain("• Barash 9");
  expect(response).toContain("• Chestnut 6");
  expect(response).toContain("• Cote Pediatric Anesthesia 6");
  expect(response).toContain("• Fleisher Uncommon Diseases");
  expect(response).toContain("• Miller 10");
  expect(response).toContain("• Stoelting 8");
  expect(response).toContain("Ask a book/topic question");
});

test("buildCatalogResponse returns null for non-catalog hits", () => {
  expect(
    buildCatalogResponse([
      hit(
        `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown/miller10/pages/page_42.md`,
        "Some real textbook content.",
      ),
    ]),
  ).toBeNull();
});

test("buildCatalogResponse returns null when catalog is mixed with other hits", () => {
  expect(
    buildCatalogResponse([
      hit(CATALOG_HIT_PATH, "catalog content"),
      hit(`${process.env.HOME}/ObsidianVault/note.md`, "some note"),
    ]),
  ).toBeNull();
});

test("buildCatalogResponse returns null for empty hits", () => {
  expect(buildCatalogResponse([])).toBeNull();
});

test("fires for live phrasing 'What does miller say are the indications for an arterial line?' with only skipped textbook hits", () => {
  const response = buildSkippedTextbookResponse(
    "What does miller say are the indications for an arterial line?",
    [
      hit(
        `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/Miller_Barash/Miller.pdf`,
        "Indexed file path match. extraction_status=skipped; chunk_count=0",
      ),
      hit(
        `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/Miller_Barash/Cote Ped Anesthesia 6 copy (optimized).pdf`,
        "Indexed file path match. extraction_status=skipped; chunk_count=0",
      ),
    ],
  );

  expect(response).toContain("I found the textbook files");
  expect(response).toContain("Miller.pdf");
});
