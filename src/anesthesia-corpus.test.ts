import { expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import {
  ANESTHESIA_CORPUS_INSTRUCTIONS,
  ANESTHESIA_CORPUS_ROOT,
  ANESTHESIA_CORPUS_ROOTS,
  ANESTHESIA_CORPUS_SUBFOLDERS,
  isAnesthesiaCorpusQuery,
} from "./anesthesia-corpus";

test("corpus roots derive from $HOME and include both Desktop and Downloads", () => {
  expect(ANESTHESIA_CORPUS_ROOTS).toEqual([
    join(homedir(), "Desktop", "Exam_Prep", "Textbooks", "anes-textbooks-markdown"),
    join(homedir(), "Downloads", "anes-textbooks-markdown"),
  ]);
  // ANESTHESIA_CORPUS_ROOT is kept as the primary root for back-compat.
  expect(ANESTHESIA_CORPUS_ROOT).toBe(ANESTHESIA_CORPUS_ROOTS[0]);
});

test("subfolder list matches the indexed textbook corpus", () => {
  expect(ANESTHESIA_CORPUS_SUBFOLDERS).toEqual([
    "barash9",
    "chestnut6",
    "cote_ped6",
    "fleisher_uncommon",
    "miller10",
    "stoelting8",
  ]);
});

test("instructions reference both corpus roots so Claude can cite either path", () => {
  for (const root of ANESTHESIA_CORPUS_ROOTS) {
    expect(ANESTHESIA_CORPUS_INSTRUCTIONS).toContain(root);
  }
});

test("instructions retain the safety contract", () => {
  expect(ANESTHESIA_CORPUS_INSTRUCTIONS).toContain("RELEVANT INDEXED CONTENT");
  expect(ANESTHESIA_CORPUS_INSTRUCTIONS).toContain("Not found in corpus");
  expect(ANESTHESIA_CORPUS_INSTRUCTIONS).toContain(
    "Do not add a fallback answer from general medical knowledge",
  );
  expect(ANESTHESIA_CORPUS_INSTRUCTIONS).toContain("Do not claim you ran live tools");
  expect(ANESTHESIA_CORPUS_INSTRUCTIONS).not.toContain("<role>");
  expect(ANESTHESIA_CORPUS_INSTRUCTIONS).not.toMatch(/\b(?:rg|ripgrep|bash|grep)\b/i);
});

test("classifier fires on terse anesthesia queries", () => {
  expect(isAnesthesiaCorpusQuery("RSI dosing for rocuronium")).toBe(true);
  expect(isAnesthesiaCorpusQuery("epidural placement at L4-L5")).toBe(true);
  expect(isAnesthesiaCorpusQuery("malignant hyperthermia management")).toBe(true);
  expect(isAnesthesiaCorpusQuery("sevoflurane MAC pediatric")).toBe(true);
});

test("classifier does not fire on general-conversation queries", () => {
  expect(isAnesthesiaCorpusQuery("set a reminder for 10pm")).toBe(false);
  expect(isAnesthesiaCorpusQuery("what's on my calendar tomorrow")).toBe(false);
  expect(isAnesthesiaCorpusQuery("text dad saying heading to London")).toBe(false);
  expect(isAnesthesiaCorpusQuery("draft an email to alex")).toBe(false);
});

test("classifier accepts known false positives without crashing (documented behavior)", () => {
  // 'airway' is shared between clinical and ENT/allergy contexts.
  // 'RSI' is shared with repetitive strain injury and rapid serial imaging.
  // 'epidural' is shared with chronic-pain / steroid-injection contexts.
  // These all fire today. The tradeoff is one scoped FTS call (which returns
  // few or zero hits) instead of forcing the user to disambiguate. If a
  // future feedback loop shows these matter, narrow the patterns here.
  expect(isAnesthesiaCorpusQuery("my airway is stuffy from allergies")).toBe(true);
  expect(isAnesthesiaCorpusQuery("RSI from typing all day")).toBe(true);
  expect(isAnesthesiaCorpusQuery("epidural steroid injection for back pain")).toBe(true);
});

test("classifier handles empty and whitespace input safely", () => {
  expect(isAnesthesiaCorpusQuery("")).toBe(false);
  expect(isAnesthesiaCorpusQuery("   ")).toBe(false);
  expect(isAnesthesiaCorpusQuery("\n\t")).toBe(false);
});
