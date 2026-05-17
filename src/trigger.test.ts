// trigger.test.ts - run with `bun test`
import { test, expect } from "bun:test";
import { isAnesthesiaCorpusQuery, isReferential } from "./trigger";

const should_fire = [
  "what did we decide about the appeal",
  "remind me about Madison's PEI plan",
  "where are we on the protocol",
  "continue what we were working on",
  "you mentioned the videolaryngoscopy paper",
  "the deck I was building",
  "Search through your index",
  "My textbooks were indexed though",
  "It was a custom index",
  "It should be with miller",
  "Yes, it’s an anesthesia textbook",
  "Anesthesia textbook",
  "What does Cote say about indications for intubation?",
  "What does Chestnut say about fetal heart rate variability?",
  "What does Stoelting say about magnesium sulfate?",
  "What does Fleisher say about uncommon diseases and anesthesia?",
  "Keep searching",
  "Keep looking",
  "Keep going",
  "Keep trying",
];

const should_not_fire = [
  "what's 2 plus 2",
  "how do I install bun",
  "set a timer for 10 minutes",
  "what's the weather like",
  "translate this to french",
  "I keep my notes in obsidian",
];

test("triggers on referential messages", () => {
  for (const m of should_fire) {
    expect(isReferential(m)).toBe(true);
  }
});

test("does not trigger on non-referential messages", () => {
  for (const m of should_not_fire) {
    expect(isReferential(m)).toBe(false);
  }
});

test("routes anesthesia-domain questions to the textbook corpus", () => {
  for (const m of [
    "Rocuronium dosing and onset for RSI adult vs pediatric",
    "How does neuraxial anesthesia affect fetal heart rate variability?",
    "Malignant hyperthermia treatment dose",
    "Epidural hypotension after spinal anesthesia",
  ]) {
    expect(isAnesthesiaCorpusQuery(m)).toBe(true);
  }
});

test("does not route ordinary non-medical text to the anesthesia corpus", () => {
  for (const m of [
    "how do I install bun",
    "set a timer for 10 minutes",
    "is my Mac still running the relay",
    "draft a note to Dad",
  ]) {
    expect(isAnesthesiaCorpusQuery(m)).toBe(false);
  }
});
