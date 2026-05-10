import { expect, test } from "bun:test";
import { buildSkippedTextbookResponse } from "./textbook-response";
import type { Hit } from "./retrieval";

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
