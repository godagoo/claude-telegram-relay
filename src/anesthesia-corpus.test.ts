import { expect, test } from "bun:test";
import {
  ANESTHESIA_CORPUS_INSTRUCTIONS,
  ANESTHESIA_CORPUS_ROOT,
  ANESTHESIA_CORPUS_SUBFOLDERS,
} from "./anesthesia-corpus";

test("anesthesia corpus prompt is adapted for relay-owned retrieval", () => {
  expect(ANESTHESIA_CORPUS_ROOT).toBe(
    "/Users/williamregan/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown",
  );
  expect(ANESTHESIA_CORPUS_SUBFOLDERS).toEqual([
    "barash9",
    "chestnut6",
    "cote_ped6",
    "fleisher_uncommon",
    "miller10",
    "stoelting8",
  ]);
  expect(ANESTHESIA_CORPUS_INSTRUCTIONS).toContain("RELEVANT INDEXED CONTENT");
  expect(ANESTHESIA_CORPUS_INSTRUCTIONS).toContain("Not found in corpus");
  expect(ANESTHESIA_CORPUS_INSTRUCTIONS).toContain("Do not claim you ran live tools");
  expect(ANESTHESIA_CORPUS_INSTRUCTIONS).not.toContain("<role>");
  expect(ANESTHESIA_CORPUS_INSTRUCTIONS).not.toMatch(/\b(?:rg|ripgrep|bash|grep)\b/i);
});
