import { expect, test } from "bun:test";
import {
  __test__buildPathAnchorSql,
  __test__combineHits,
  __test__filterPathAnchorRows,
  __test__isBroadTextbookInventoryQuery,
  __test__prepareFtsQuery,
  __test__relaxedBookQueries,
  __test__relaxedCorpusQueries,
  __test__rerankFtsHits,
  search,
  type Hit,
} from "./retrieval";

test("path anchor SQL scopes by indexable prefix LIKE per root", () => {
  const { sql } = __test__buildPathAnchorSql(["barash"]);

  // Without an indexable prefix, SQLite full-scans `files` because every GLOB
  // pattern starts with a wildcard. This was Bug B's root cause.
  expect(sql).toMatch(/f\.path LIKE \?/);
  expect(sql).toMatch(/f\.path GLOB \?/);
});

test("path anchor SQL preserves GLOB token clause for token matching", () => {
  const { sql } = __test__buildPathAnchorSql(["miller", "barash"]);

  // Both tokens must still appear as GLOB OR clauses inside the same root.
  const globMatches = sql.match(/f\.path GLOB \?/g) ?? [];
  expect(globMatches.length).toBeGreaterThanOrEqual(2);
});

test("path anchor SQL returns ordered params: prefix-then-globs per root, then deny, then k", () => {
  const { orderedParams, expectedRoots } = __test__buildPathAnchorSql(["barash"]);

  // First param is the LIKE prefix for the first (and currently only) root.
  expect(orderedParams[0]).toMatch(/Desktop\/Exam_Prep\/Textbooks\/%$/);
  expect(expectedRoots).toBe(1);
});

test("path anchor filtering ignores token matches from parent directories", () => {
  const root = `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/Miller_Barash`;
  const hits = __test__filterPathAnchorRows(
    [
      {
        id: -10,
        text: "Indexed file path match. extraction_status=skipped; chunk_count=0",
        path: `${root}/Barash 9 (optimized).pdf`,
        chunk_index: 0,
        rank_score: -1,
      },
      {
        id: -11,
        text: "Indexed file path match. extraction_status=skipped; chunk_count=0",
        path: `${root}/Miller (optimized).pdf`,
        chunk_index: 0,
        rank_score: -1,
      },
    ],
    ["miller"],
    5,
  );

  expect(hits.map((hit) => hit.file_path)).toEqual([
    `${root}/Miller (optimized).pdf`,
  ]);
});

test("book tokens become path filters instead of required FTS terms", () => {
  const prepared = __test__prepareFtsQuery("miller indications arterial line");

  expect(prepared.match).toBe("indications arterial line");
  expect(prepared.scopePatterns).toContain(
    `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown/miller10/%`,
  );
  expect(prepared.scopePatterns).toContain(
    `${process.env.HOME}/Downloads/anes-textbooks-markdown/miller10/%`,
  );
});

test("book alias typos become canonical path filters", () => {
  const prepared = __test__prepareFtsQuery("brash intubating dose rocuronium");

  expect(prepared.match).toBe("intubating dose rocuronium");
  expect(prepared.bookScoped).toBe(true);
  expect(prepared.scopePatterns).toContain(
    `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown/barash9/%`,
  );
  expect(prepared.scopePatterns).toContain(
    `${process.env.HOME}/Downloads/anes-textbooks-markdown/barash9/%`,
  );
});

test("book alias typo search returns canonical book hits", async () => {
  const hits = await search('"barash" "intubating" "dose" "rocuronium"', 5);

  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].file_path).toContain("/barash9/");
  expect(hits[0].content.toLowerCase()).toContain("intubating dose");
  expect(hits[0].content.toLowerCase()).toContain("rocuronium");
});

test("book-filtered FTS refuses broad single-token content queries", () => {
  const prepared = __test__prepareFtsQuery("miller anesthesia");

  expect(prepared.match).toBe("");
  expect(prepared.scopePatterns).toContain(
    `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown/miller10/%`,
  );
  expect(prepared.scopePatterns).toContain(
    `${process.env.HOME}/Downloads/anes-textbooks-markdown/miller10/%`,
  );
});

test("book-scoped fallback relaxes long clinical queries to adjacent pairs", () => {
  expect(
    __test__relaxedBookQueries(["indications", "arterial", "line"]),
  ).toEqual(["arterial line", "indications arterial"]);
});

test("broad textbook FTS is scoped to converted textbook markdown", () => {
  const prepared = __test__prepareFtsQuery("anesthesia textbook");

  expect(prepared.match).toBe("anesthesia textbook");
  expect(prepared.scopePatterns).toContain(
    `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown/%`,
  );
  expect(prepared.scopePatterns).toContain(
    `${process.env.HOME}/Downloads/anes-textbooks-markdown/%`,
  );
});

test("anesthesia-domain FTS is scoped to converted textbook markdown", () => {
  const prepared = __test__prepareFtsQuery("rocuronium pediatric dosing adult onset");

  expect(prepared.match).toBe("rocuronium pediatric dosing adult onset");
  expect(prepared.corpusScoped).toBe(true);
  expect(prepared.scopePatterns).toContain(
    `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown/%`,
  );
  expect(prepared.scopePatterns).toContain(
    `${process.env.HOME}/Downloads/anes-textbooks-markdown/%`,
  );
});

test("non-medical queries are not scoped to the anesthesia corpus", () => {
  // Pin the gate boundary: a query that isAnesthesiaCorpusQuery rejects must
  // fall through to the default SCOPE_PATTERNS, never to the textbook roots.
  // Regression guard for the corpusQuery widening Codex shipped in PR #5:
  // if isAnesthesiaCorpusQuery accidentally grew to match everything, this
  // would silently scope all retrieval to ~/Desktop/.../anes-textbooks-markdown
  // and starve every non-medical answer.
  for (const benign of [
    "set a reminder for 10pm",
    "what is on my calendar tomorrow",
    "remind me to call alex",
    "what is the weather in toronto today",
  ]) {
    const prepared = __test__prepareFtsQuery(benign);
    expect(prepared.corpusScoped).toBe(false);
    expect(prepared.scopePatterns).not.toContain(
      `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown/%`,
    );
    expect(prepared.scopePatterns).not.toContain(
      `${process.env.HOME}/Downloads/anes-textbooks-markdown/%`,
    );
  }
});

test("corpus-scoped fallback pairs the strongest token with later clinical terms", () => {
  expect(
    __test__relaxedCorpusQueries(["rocuronium", "pediatric", "dosing", "adult", "onset"]),
  ).toContain("rocuronium onset");
});

test("bare anesthesia textbook prompts use fast catalog retrieval", () => {
  expect(__test__isBroadTextbookInventoryQuery("anesthesia textbook")).toBe(true);
  expect(__test__isBroadTextbookInventoryQuery("anesthesia textbooks")).toBe(true);
  expect(__test__isBroadTextbookInventoryQuery("miller anesthesia textbook")).toBe(false);
  expect(__test__isBroadTextbookInventoryQuery("pediatric anesthesia textbook")).toBe(false);
});

test("FTS content hits outrank skipped path fallback hits", () => {
  const ftsHit: Hit = {
    chunk_id: 1,
    file_path: `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown/miller10/pages/page_1195.md`,
    content: "adequate intravenous access, an arterial line is paramount",
    chunk_index: 0,
    rank_score: -0.1,
    display_score: 0.1,
    score: 0.1,
  };
  const pathHit: Hit = {
    chunk_id: -2,
    file_path: `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/Miller_Barash/Miller (optimized).pdf`,
    content: "Indexed file path match. extraction_status=skipped; chunk_count=0",
    chunk_index: 0,
    rank_score: -1,
    display_score: 1,
    score: 1,
  };

  expect(__test__combineHits([ftsHit], [pathHit], 2).map((hit) => hit.file_path)).toEqual([
    ftsHit.file_path,
    pathHit.file_path,
  ]);
});

test("path fallback contributes at most floor(k / 2) hits after FTS hits", () => {
  const ftsHit: Hit = {
    chunk_id: 1,
    file_path: `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown/miller10/pages/page_1195.md`,
    content: "adequate intravenous access, an arterial line is paramount",
    chunk_index: 0,
    rank_score: -0.1,
    display_score: 0.1,
    score: 0.1,
  };
  const pathHits: Hit[] = [1, 2, 3].map((n) => ({
    chunk_id: -n,
    file_path: `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/Miller_Barash/Miller ${n}.pdf`,
    content: "Indexed file path match. extraction_status=skipped; chunk_count=0",
    chunk_index: 0,
    rank_score: -1,
    display_score: 1,
    score: 1,
  }));

  expect(__test__combineHits([ftsHit], pathHits, 4).map((hit) => hit.chunk_id)).toEqual([
    1,
    -1,
    -2,
  ]);
});

test("broad textbook queries demote front matter below clinical pages", () => {
  const frontMatterHit: Hit = {
    chunk_id: 1,
    file_path: `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown/cote_ped6/pages/page_0058.md`,
    content: "Clinical subject: Front matter contributor listing for this pediatric anesthesia textbook",
    chunk_index: 0,
    rank_score: -13,
    display_score: 13,
    score: 13,
  };
  const clinicalHit: Hit = {
    chunk_id: 2,
    file_path: `${process.env.HOME}/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown/barash9/pages/page_0280.md`,
    content: "Clinical subject: anesthesia-related mortality rates and patient safety outcomes",
    chunk_index: 0,
    rank_score: -12,
    display_score: 12,
    score: 12,
  };

  expect(
    __test__rerankFtsHits("anesthesia textbook", [frontMatterHit, clinicalHit])
      .map((hit) => hit.file_path),
  ).toEqual([clinicalHit.file_path, frontMatterHit.file_path]);
});
