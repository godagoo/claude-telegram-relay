import { expect, test } from "bun:test";
import {
  sanitizeClaudeResponse,
  stripMemoryTags,
  stripProseDashes,
  stripScaffoldingTags,
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

// Live failure 2026-05-11T12:54:45: in response to "draft an email to myself"
// the relay forwarded ~5.4 KB of Claude Code internal scaffolding to Telegram:
// three <system-reminder> blocks containing a /compact continuation marker, a
// bash-escaping rule, and a full conversation summary. Strip these aggressively.
test("strips <system-reminder> blocks with body", () => {
  const r = stripScaffoldingTags(
    "Below is your message.\n\n<system-reminder>internal scaffolding leak</system-reminder>",
  );
  expect(r.clean).toBe("Below is your message.");
  expect(r.stripped).toBe(1);
});

test("strips multiple scaffolding tags in one response", () => {
  const r = stripScaffoldingTags(
    "Hello.\n<system-reminder>a</system-reminder>\n<command-name>x</command-name>\n<local-command-stdout>y</local-command-stdout>\nWorld.",
  );
  expect(r.clean).toBe("Hello.\n\n\n\nWorld.".replace(/\n{3,}/g, "\n\n"));
  expect(r.stripped).toBe(3);
});

test("strips multiline system-reminder containing nested structure", () => {
  const r = stripScaffoldingTags(
    "Result:\n<system-reminder>\nThis session is being continued from a previous conversation.\n\nKey context:\n- thing 1\n- thing 2\n</system-reminder>\nClean reply.",
  );
  expect(r.clean).toBe("Result:\n\nClean reply.");
  expect(r.stripped).toBe(1);
});

test("strips orphan opening scaffolding tag", () => {
  const r = stripScaffoldingTags("real content <system-reminder>");
  expect(r.clean).toBe("real content");
  expect(r.stripped).toBe(1);
});

test("sanitizeClaudeResponse strips scaffolding and reports the count", () => {
  const leaked = [
    "Below is your message.",
    "",
    "<system-reminder>internal compact continuation marker</system-reminder>",
    "",
    "<system-reminder>",
    "This session is being continued from a previous conversation.",
    "Key context: file paths, user details, technical notes.",
    "</system-reminder>",
  ].join("\n");
  const r = sanitizeClaudeResponse(leaked);
  expect(r.clean).toBe("Below is your message.");
  expect(r.scaffoldingTagsStripped).toBe(2);
});
