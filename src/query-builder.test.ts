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

test("still skips broad single-token searches without context", () => {
  expect(buildSearchQuery("Search through your index", [])).toBe("");
});
