import { describe, expect, test } from "bun:test";
import {
  looksLikeDraftIntent,
  parseClassifierJson,
} from "./imessage-intent.ts";

describe("looksLikeDraftIntent (heuristic gate for LLM fallback)", () => {
  test("fires on natural-language draft phrasings the regex has historically missed", () => {
    // The point of the heuristic is to BE PERMISSIVE on the LLM-fallback
    // side so William's next novel phrasing doesn't silently drop. Each of
    // these has burned us in production at some point.
    expect(
      looksLikeDraftIntent("Please text the following to madison: your memory was correct"),
    ).toBe(true);
    expect(
      looksLikeDraftIntent("Shoot Nater a quick one asking if he's free"),
    ).toBe(true);
    expect(
      looksLikeDraftIntent("Could you let mom know I'll be late"),
    ).toBe(true);
    expect(
      looksLikeDraftIntent("Tell my dad I'll call him tomorrow"),
    ).toBe(true);
  });

  test("skips ordinary tell-me requests while keeping tell-recipient drafts", () => {
    expect(looksLikeDraftIntent("Tell me about the motion timeline")).toBe(false);
    expect(looksLikeDraftIntent("Could you tell me what Miller says about RSI")).toBe(false);
    expect(looksLikeDraftIntent("Tell mom I'll call her tomorrow")).toBe(true);
  });

  test("skips obvious chat that has no draft-verb signal", () => {
    expect(looksLikeDraftIntent("hello, how are you?")).toBe(false);
    expect(looksLikeDraftIntent("what time is it?")).toBe(false);
    expect(looksLikeDraftIntent("ok thanks")).toBe(false);
  });

  test("skips meta-questions about prior drafts so we don't waste an LLM call to be told no", () => {
    // META_PLACEMENT_FAILURE_RE in the main extractor already catches most
    // of these. The heuristic gate is a coarse second layer: anything that
    // starts with an interrogative word is treated as a question, not a
    // request to compose.
    expect(looksLikeDraftIntent("why didn't you write anything in the chatbox?")).toBe(false);
    expect(looksLikeDraftIntent("Is the draft done?")).toBe(false);
    expect(looksLikeDraftIntent("Are you still working on your draft?")).toBe(false);
    expect(looksLikeDraftIntent("Where is the draft?")).toBe(false);
    expect(looksLikeDraftIntent("Did you text mom?")).toBe(false);
    expect(looksLikeDraftIntent("Regarding the text to Mom earlier, can you clarify?")).toBe(false);
  });
});

describe("parseClassifierJson (defensive parser for LLM stdout)", () => {
  test("happy path — single-line JSON exactly per the prompt", () => {
    const out = parseClassifierJson(
      '{"is_draft":true,"recipient":"mom","body_intent":"call me back","wants_context":false,"wants_placement":true}',
    );
    expect(out).toEqual({
      is_draft: true,
      recipient: "mom",
      body_intent: "call me back",
      wants_context: false,
      wants_placement: true,
    });
  });

  test("recovers when the model wraps JSON in markdown despite the prompt", () => {
    const out = parseClassifierJson(
      'Sure thing!\n```json\n{"is_draft":false,"recipient":null,"body_intent":null,"wants_context":false,"wants_placement":true}\n```',
    );
    expect(out?.is_draft).toBe(false);
    expect(out?.recipient).toBeNull();
  });

  test("treats empty/whitespace strings as null recipient/body", () => {
    const out = parseClassifierJson(
      '{"is_draft":true,"recipient":"   ","body_intent":"","wants_context":false,"wants_placement":true}',
    );
    expect(out?.recipient).toBeNull();
    expect(out?.body_intent).toBeNull();
  });

  test("defaults wants_placement to true when the field is missing or null", () => {
    // wants_placement=false should ONLY be set when the user explicitly opts
    // out of placement. Treat missing/null as "yes place it" — same default
    // the regex extractor uses (!detectPlacementSuppression).
    const missing = parseClassifierJson('{"is_draft":true,"recipient":"mom"}');
    expect(missing?.wants_placement).toBe(true);
    const explicitFalse = parseClassifierJson(
      '{"is_draft":true,"recipient":"mom","wants_placement":false}',
    );
    expect(explicitFalse?.wants_placement).toBe(false);
  });

  test("returns null on garbage that contains no JSON object", () => {
    expect(parseClassifierJson("")).toBeNull();
    expect(parseClassifierJson("I'm sorry, I cannot help with that.")).toBeNull();
    expect(parseClassifierJson("   \n\t  ")).toBeNull();
  });

  test("returns null on malformed JSON the model emitted half-way", () => {
    expect(
      parseClassifierJson('{"is_draft":true,"recipient":"mom",'),
    ).toBeNull();
  });

  test("rejects shapes that don't have a boolean is_draft (model hallucinated wrong schema)", () => {
    expect(
      parseClassifierJson('{"is_draft":"yes","recipient":"mom"}'),
    ).toBeNull();
    expect(parseClassifierJson('{"recipient":"mom"}')).toBeNull();
    expect(parseClassifierJson('null')).toBeNull();
    expect(parseClassifierJson('"just a string"')).toBeNull();
  });
});
