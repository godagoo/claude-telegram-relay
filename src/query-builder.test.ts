import { expect, test } from "bun:test";
import { buildSearchQuery, type Turn } from "./query-builder";

const recentTextbookTurns: Turn[] = [
  {
    role: "user",
    content: "Okay, so you did not get it from one of my textbooks in your index/corpus then? Like Barash for example?",
    ts: "2026-05-08T17:34:12.540Z",
  },
  {
    role: "assistant",
    content: "I can use indexed context when retrieval fires.",
    ts: "2026-05-08T17:34:30.000Z",
  },
  {
    role: "user",
    content: "It should be with Miller",
    ts: "2026-05-08T17:41:50.225Z",
  },
];

test("drops retrieval-control words from FTS query", () => {
  expect(buildSearchQuery("Please continue to look for my anesthesia textbooks", [])).toBe(
    '"anesthesia" "textbooks"',
  );
});

test("uses recent user turns when current retrieval command is too thin", () => {
  expect(buildSearchQuery("Search through your index", recentTextbookTurns)).toBe(
    '"miller" "textbooks"',
  );
});

test("recovers anchor from recent turns for bare continuation commands", () => {
  expect(buildSearchQuery("Keep searching", recentTextbookTurns)).toBe(
    '"miller" "textbooks"',
  );
});

test("keeps strong textbook anchors from current message", () => {
  expect(buildSearchQuery("Anesthesia textbook", recentTextbookTurns)).toBe(
    '"anesthesia" "textbook"',
  );
});

test("drops conversational say/says/said words from textbook questions", () => {
  expect(
    buildSearchQuery("What does Miller say are the indications for an arterial line?", []),
  ).toBe('"miller" "indications" "arterial" "line"');
});

test("still skips broad single-token searches without context", () => {
  expect(buildSearchQuery("Search through your index", [])).toBe("");
});

const millerArterialAnchor: Turn[] = [
  {
    role: "user",
    content: "What does miller say are the indications for an arterial line?",
    ts: "2026-05-09T03:00:00.000Z",
  },
  {
    role: "assistant",
    content: "Indications include hemodynamic monitoring, frequent ABGs, ...",
    ts: "2026-05-09T03:00:01.000Z",
  },
];

// Live decision-log evidence (decisions-2026-05-09.jsonl entry 3): user
// followed a Miller arterial-line question with a source/format redirection
// containing only source-control vocabulary. Prior FTS query was
// `"instead" "relevant" "markdown" "converted" "today"` -> 0 hits.
test("topic-pivot source-redirection recovers prior clinical anchor", () => {
  expect(
    buildSearchQuery(
      "No, I want you to instead search through their relevant markdown files that I converted today",
      millerArterialAnchor,
    ),
  ).toBe('"miller" "indications" "arterial" "line"');
});

test("topic-pivot with new clinical content does not pull in prior anchor", () => {
  // "actually" is a pivot signal but the message still has its own clinical
  // anchor (chestnut + anesthesia). Source-control words ("actually") drop,
  // and the prior miller anchor is *not* merged in.
  expect(
    buildSearchQuery(
      "actually, what about chestnut anesthesia",
      millerArterialAnchor,
    ),
  ).toBe('"chestnut" "anesthesia"');
});

test("source-redirection without prior context still returns no query", () => {
  expect(
    buildSearchQuery(
      "No, I want you to instead look at the converted markdown files",
      [],
    ),
  ).toBe("");
});
