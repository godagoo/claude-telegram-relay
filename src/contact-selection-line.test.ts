import { expect, test } from "bun:test";
import {
  buildContactSelectionLine,
  formatLastMessagedHint,
  type IMessageContextResult,
} from "./imessage-context";

const APPLE_EPOCH_UNIX_SECONDS = 978307200;

/**
 * Build a chat.db-style Apple-epoch nanosecond timestamp for `daysAgo` days
 * before `now`. The resolver returns this raw value so the formatter can
 * convert it.
 */
function appleEpochNs(daysAgo: number, now: Date): number {
  const unixSeconds = now.getTime() / 1000 - daysAgo * 86400;
  return Math.floor((unixSeconds - APPLE_EPOCH_UNIX_SECONDS) * 1e9);
}

const FIXED_NOW = new Date("2026-05-21T12:00:00.000Z");

test("formatLastMessagedHint returns empty for missing or zero timestamp", () => {
  expect(formatLastMessagedHint(undefined, FIXED_NOW)).toBe("");
  expect(formatLastMessagedHint(0, FIXED_NOW)).toBe("");
  expect(formatLastMessagedHint(-1, FIXED_NOW)).toBe("");
});

test("formatLastMessagedHint returns empty for future timestamps (clock skew)", () => {
  const future = appleEpochNs(-3, FIXED_NOW); // 3 days in the future
  expect(formatLastMessagedHint(future, FIXED_NOW)).toBe("");
});

test("formatLastMessagedHint buckets sub-hour activity as 'earlier today'", () => {
  const fifteenMinutesAgo = appleEpochNs(15 / (60 * 24), FIXED_NOW);
  expect(formatLastMessagedHint(fifteenMinutesAgo, FIXED_NOW)).toBe("earlier today");
});

test("formatLastMessagedHint buckets 1-23h as 'today'", () => {
  const fiveHoursAgo = appleEpochNs(5 / 24, FIXED_NOW);
  expect(formatLastMessagedHint(fiveHoursAgo, FIXED_NOW)).toBe("today");
});

test("formatLastMessagedHint buckets 24-47h as 'yesterday'", () => {
  const thirtyHoursAgo = appleEpochNs(30 / 24, FIXED_NOW);
  expect(formatLastMessagedHint(thirtyHoursAgo, FIXED_NOW)).toBe("yesterday");
});

test("formatLastMessagedHint buckets 2-6 days as 'N days ago'", () => {
  expect(formatLastMessagedHint(appleEpochNs(2, FIXED_NOW), FIXED_NOW)).toBe("2 days ago");
  expect(formatLastMessagedHint(appleEpochNs(3, FIXED_NOW), FIXED_NOW)).toBe("3 days ago");
  expect(formatLastMessagedHint(appleEpochNs(6, FIXED_NOW), FIXED_NOW)).toBe("6 days ago");
});

test("formatLastMessagedHint buckets 7-13 days as 'a week ago'", () => {
  expect(formatLastMessagedHint(appleEpochNs(7, FIXED_NOW), FIXED_NOW)).toBe("a week ago");
  expect(formatLastMessagedHint(appleEpochNs(13, FIXED_NOW), FIXED_NOW)).toBe("a week ago");
});

test("formatLastMessagedHint buckets 14-29 days as 'N weeks ago'", () => {
  expect(formatLastMessagedHint(appleEpochNs(14, FIXED_NOW), FIXED_NOW)).toBe("2 weeks ago");
  expect(formatLastMessagedHint(appleEpochNs(28, FIXED_NOW), FIXED_NOW)).toBe("4 weeks ago");
});

test("formatLastMessagedHint buckets 30-59 days as 'a month ago'", () => {
  expect(formatLastMessagedHint(appleEpochNs(30, FIXED_NOW), FIXED_NOW)).toBe("a month ago");
  expect(formatLastMessagedHint(appleEpochNs(45, FIXED_NOW), FIXED_NOW)).toBe("a month ago");
});

test("formatLastMessagedHint buckets 60-364 days as 'N months ago'", () => {
  expect(formatLastMessagedHint(appleEpochNs(60, FIXED_NOW), FIXED_NOW)).toBe("2 months ago");
  expect(formatLastMessagedHint(appleEpochNs(180, FIXED_NOW), FIXED_NOW)).toBe("6 months ago");
});

test("formatLastMessagedHint buckets 365+ days as 'a year ago' or 'N years ago'", () => {
  expect(formatLastMessagedHint(appleEpochNs(365, FIXED_NOW), FIXED_NOW)).toBe("a year ago");
  expect(formatLastMessagedHint(appleEpochNs(729, FIXED_NOW), FIXED_NOW)).toBe("a year ago");
  expect(formatLastMessagedHint(appleEpochNs(730, FIXED_NOW), FIXED_NOW)).toBe("2 years ago");
});

function ctx(partial: Partial<IMessageContextResult>): IMessageContextResult {
  return {
    request: { contact: "anyone", limit: 10 },
    status: "found",
    messages: [],
    ...partial,
  };
}

test("buildContactSelectionLine prefers display_name over handle over fallback", () => {
  const ts = appleEpochNs(3, FIXED_NOW);
  expect(
    buildContactSelectionLine(
      ctx({
        resolvedDisplayName: "Conor McGrath",
        resolvedRecipient: "+15551234567",
        resolvedLastMessagedAt: ts,
      }),
      "ignored",
      FIXED_NOW,
    ),
  ).toBe("Drafting for Conor McGrath (last messaged 3 days ago).");
});

test("buildContactSelectionLine falls back to handle when display_name is missing", () => {
  const ts = appleEpochNs(1, FIXED_NOW);
  expect(
    buildContactSelectionLine(
      ctx({
        resolvedRecipient: "+15551234567",
        resolvedLastMessagedAt: ts,
      }),
      "ignored",
      FIXED_NOW,
    ),
  ).toBe("Drafting for +15551234567 (last messaged yesterday).");
});

test("buildContactSelectionLine falls back to the fallback contact when nothing is resolved", () => {
  expect(
    buildContactSelectionLine(
      ctx({}),
      "Conor",
      FIXED_NOW,
    ),
  ).toBe("Drafting for Conor.");
});

test("buildContactSelectionLine omits recency clause when no timestamp", () => {
  expect(
    buildContactSelectionLine(
      ctx({
        resolvedDisplayName: "Conor McGrath",
        resolvedRecipient: "+15551234567",
      }),
      "ignored",
      FIXED_NOW,
    ),
  ).toBe("Drafting for Conor McGrath.");
});

test("buildContactSelectionLine returns empty string when no name source is available", () => {
  // No display_name, no handle, empty fallback. The relay caller skips the
  // prepend when this returns empty.
  expect(buildContactSelectionLine(ctx({}), "", FIXED_NOW)).toBe("");
  expect(buildContactSelectionLine(null, "", FIXED_NOW)).toBe("");
  expect(buildContactSelectionLine(undefined, "", FIXED_NOW)).toBe("");
});

test("buildContactSelectionLine handles a null context with the fallback", () => {
  expect(
    buildContactSelectionLine(null, "Mom", FIXED_NOW),
  ).toBe("Drafting for Mom.");
});
