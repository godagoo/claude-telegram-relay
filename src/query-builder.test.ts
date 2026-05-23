import { expect, test } from "bun:test";
import { buildSearchQuery, ENGLISH_ONLY_DIRECTIVE, type Turn } from "./query-builder";

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

test("exports the exact English-only prompt directive", () => {
  expect(ENGLISH_ONLY_DIRECTIVE).toBe(
    "Respond in English only. If the user writes in another language, translate it internally but reply in English.",
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

test("canonicalizes common textbook typos before building the query", () => {
  expect(
    buildSearchQuery("What does brash say the intubating dose is for rocuronium", []),
  ).toBe('"barash" "intubating" "dose" "rocuronium"');
});

test("drops conversational say/says/said words from textbook questions", () => {
  expect(
    buildSearchQuery("What does Miller say are the indications for an arterial line?", []),
  ).toBe('"miller" "indications" "arterial" "line"');
});

test("builds a bounded query for generic anesthesia corpus questions", () => {
  expect(
    buildSearchQuery("Rocuronium dosing and onset for RSI adult vs pediatric", []),
  ).toBe('"rocuronium" "pediatric" "dosing" "adult" "onset"');
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

test("topic-pivot with new clinical content still recovers prior anchor", () => {
  // Pivot words mean the user is correcting course. Preserve the new clinical
  // content, then recover prior-turn anchors up to the cap.
  expect(
    buildSearchQuery(
      "actually, what about chestnut anesthesia",
      millerArterialAnchor,
    ),
  ).toBe('"chestnut" "anesthesia" "miller" "indications" "arterial"');
});

test("topic pivot keeps current terms and recovers prior anchor up to cap", () => {
  expect(
    buildSearchQuery(
      "Wait, different source for chestnut anesthesia",
      millerArterialAnchor,
    ),
  ).toBe('"chestnut" "anesthesia" "miller" "indications" "arterial"');
});

test("split stopword sets preserve retrieval control behavior", () => {
  expect(buildSearchQuery("Keep searching through the index for Miller arterial line", [])).toBe(
    '"miller" "arterial" "line"',
  );
});

// Live decision-log entry (2026-05-10T21:08:13Z): the message
// "Compare the differences in how opioids affect an epidural in kids
//  versus adults between cote and barash"
// produced FTS query `"differences" "epidural" "compare" "opioids" "adults"`
// — both "cote" and "barash" got pushed out of the top-5 by longer adjectives.
// retrieval.prepareFtsQuery uses book tokens to route to BOOK_PATH_FILTERS
// scopes, so losing them collapsed the search back to the broad scope and
// returned 1 incidental cote hit instead of cote+barash content.
test("pins book-name anchors over longer clinical adjectives", () => {
  const query = buildSearchQuery(
    "Compare the differences in how opioids affect an epidural in kids versus adults between cote and barash",
    [],
  );
  expect(query).toContain('"cote"');
  expect(query).toContain('"barash"');
});

test("book anchors plus longest clinical adjectives fill the rest of the cap", () => {
  // Same message: anchors first (cote, barash), then top-3 by length among
  // the remaining clinical tokens.
  expect(
    buildSearchQuery(
      "Compare the differences in how opioids affect an epidural in kids versus adults between cote and barash",
      [],
    ),
  ).toBe('"cote" "barash" "differences" "epidural" "compare"');
});

test("source-redirection without prior context still returns no query", () => {
  expect(
    buildSearchQuery(
      "No, I want you to instead look at the converted markdown files",
      [],
    ),
  ).toBe("");
});
