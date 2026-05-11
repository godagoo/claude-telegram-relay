import { expect, test } from "bun:test";
import {
  sanitizeClaudeResponse,
  stripMemoryTags,
  stripProseDashes,
  stripWrapperTags,
} from "./response-sanitize";

// Live failure 2026-05-10T21:08:25 and 21:58:25: Claude emitted just
// "<response>" as its entire reply. The bare tag must be stripped so the
// ensureSendableResponse fallback fires instead of forwarding it.
test("strips a bare <response> output to empty", () => {
  const r = stripWrapperTags("<response>");
  expect(r.clean).toBe("");
  expect(r.stripped).toBe(1);
});

test("strips a bare closing tag", () => {
  const r = stripWrapperTags("</response>");
  expect(r.clean).toBe("");
  expect(r.stripped).toBe(1);
});

test("unwraps matched <response>...</response> and keeps inner text", () => {
  const r = stripWrapperTags("<response>Here is the answer.</response>");
  expect(r.clean).toBe("Here is the answer.");
  expect(r.stripped).toBeGreaterThanOrEqual(1);
});

test("handles other wrapper variants (answer/reply/message/output/result)", () => {
  expect(stripWrapperTags("<answer>").clean).toBe("");
  expect(stripWrapperTags("<reply>hi</reply>").clean).toBe("hi");
  expect(stripWrapperTags("</message>").clean).toBe("");
  expect(stripWrapperTags("<output>x</output>").clean).toBe("x");
  expect(stripWrapperTags("<result/>").clean).toBe("");
});

test("leaves ordinary prose untouched", () => {
  const text = "From Barash: opioids blunt laryngeal reflexes → aspiration risk.";
  const r = stripWrapperTags(text);
  expect(r.clean).toBe(text);
  expect(r.stripped).toBe(0);
});

test("collapses triple-or-more newlines after stripping", () => {
  const r = stripWrapperTags("<response>\n\n\n\nactual text\n\n\n</response>");
  expect(r.clean).toBe("actual text");
});

test("stripMemoryTags still strips the three memory intent tags", () => {
  const input = "Hello [REMEMBER: user likes bullets] world [GOAL: ship MVP] [DONE: launch]!";
  const r = stripMemoryTags(input);
  expect(r.clean).toBe("Hello  world  !");
  expect(r.stripped).toBe(3);
});

test("replaces prose em/en dashes outside code spans", () => {
  const input = "This reads like AI — too stiff. Use pages 10–12, not `a—b`.";
  const r = stripProseDashes(input);
  expect(r.clean).toBe("This reads like AI, too stiff. Use pages 10 to 12, not `a—b`.");
  expect(r.stripped).toBe(2);
});

test("sanitizes memory tags, wrapper tags, and prose dashes in one pass", () => {
  const r = sanitizeClaudeResponse(
    "<response>Hello — world [REMEMBER: user likes short replies]</response>",
  );
  expect(r.clean).toBe("Hello, world");
  expect(r.memoryTagsStripped).toBe(1);
  expect(r.wrapperTagsStripped).toBeGreaterThanOrEqual(1);
  expect(r.proseDashesStripped).toBe(1);
});
