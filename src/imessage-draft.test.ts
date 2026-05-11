import { expect, test } from "bun:test";
import {
  DRAFT_MARKER_CLOSE,
  DRAFT_MARKER_OPEN,
  extractDraftBody,
  replaceDraftBlock,
} from "./imessage-draft";

const wrap = (body: string) =>
  `Here's the draft for Peggy:\n\n${DRAFT_MARKER_OPEN}\n${body}\n${DRAFT_MARKER_CLOSE}\n`;

test("extracts the body between marker pair", () => {
  const body = "Hey Peggy, hoping for a deep clean this week.";
  expect(extractDraftBody(wrap(body))).toBe(body);
});

test("returns null when markers are missing", () => {
  expect(
    extractDraftBody("Here's the draft for Peggy: \"Hey Peggy...\""),
  ).toBeNull();
});

test("returns null when only the opening marker is present", () => {
  expect(extractDraftBody(`Hey there ${DRAFT_MARKER_OPEN}\nbody only`)).toBeNull();
});

test("returns null when the body is whitespace only", () => {
  expect(
    extractDraftBody(`${DRAFT_MARKER_OPEN}\n   \n${DRAFT_MARKER_CLOSE}`),
  ).toBeNull();
});

test("replaceDraftBlock swaps in the confirmation line", () => {
  const input = wrap("Hey Peggy, hoping for a deep clean.");
  const out = replaceDraftBlock(input, "[placed in Messages]");
  expect(out).toContain("[placed in Messages]");
  expect(out).not.toContain(DRAFT_MARKER_OPEN);
  expect(out).not.toContain(DRAFT_MARKER_CLOSE);
});

test("replaceDraftBlock strips orphan markers when no pair exists", () => {
  const input = `Draft preview: ${DRAFT_MARKER_OPEN} body without close`;
  const out = replaceDraftBlock(input, "ignored");
  expect(out).not.toContain(DRAFT_MARKER_OPEN);
  expect(out).not.toContain(DRAFT_MARKER_CLOSE);
  expect(out).toContain("Draft preview:");
});
