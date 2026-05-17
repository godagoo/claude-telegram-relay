import { expect, test } from "bun:test";
import {
  parseIPhoneMirrorHelperOutput,
  shouldUseIPhoneMirrorPlacement,
} from "./iphone-mirror-draft";

const {
  isLikelyMessagesComposeSurface,
} = require("../scripts/iphone-mirror-screen.cjs");

test("iPhone mirror placement is opt-in", () => {
  expect(shouldUseIPhoneMirrorPlacement({})).toBe(false);
  expect(shouldUseIPhoneMirrorPlacement({ RELAY_IPHONE_MIRROR_PLACEMENT: "0" })).toBe(false);
  expect(shouldUseIPhoneMirrorPlacement({ RELAY_IPHONE_MIRROR_PLACEMENT: "1" })).toBe(true);
  expect(shouldUseIPhoneMirrorPlacement({ RELAY_IPHONE_MIRROR_PLACEMENT: "true" })).toBe(true);
  expect(shouldUseIPhoneMirrorPlacement({ RELAY_IPHONE_MIRROR_PLACEMENT: "yes" })).toBe(true);
});

test("iPhone mirror helper parser tolerates mirroir startup noise", () => {
  expect(
    parseIPhoneMirrorHelperOutput(
      [
        "[startup] noisy line",
        "Screen elements...",
        '{"ok":true,"mode":"typed","verified":true}',
      ].join("\n"),
    ),
  ).toEqual({ ok: true, mode: "typed", verified: true });
});

test("iPhone mirror helper parser returns diagnostic when no JSON is present", () => {
  const result = parseIPhoneMirrorHelperOutput("startup only");
  expect(result.ok).toBe(false);
  expect(result.error).toContain("did not emit JSON");
});

test("iPhone mirror screen verifier rejects search and Telegram false positives", () => {
  expect(
    isLikelyMessagesComposeSurface(
      "Google Suggestions heading to London Search Web heading to london meaning",
    ),
  ).toBe(false);
  expect(
    isLikelyMessagesComposeSurface(
      "TELEGRAM William Claude Code bot Message heading to London",
    ),
  ).toBe(false);
  expect(
    isLikelyMessagesComposeSurface(
      "Dad iMessage heading to London",
    ),
  ).toBe(true);
});
