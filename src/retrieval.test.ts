import { expect, test } from "bun:test";
import { __test__buildPathAnchorSql } from "./retrieval";

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
