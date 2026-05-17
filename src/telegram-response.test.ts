import { expect, test } from "bun:test";
import {
  DEFAULT_EMPTY_RESPONSE,
  prepareTelegramResponseText,
  sendTelegramResponse,
  splitTelegramResponseText,
} from "./telegram-response";

test("prepareTelegramResponseText applies fallback and phone handoff formatting", () => {
  expect(prepareTelegramResponseText("   ")).toBe(DEFAULT_EMPTY_RESPONSE);
  expect(
    prepareTelegramResponseText(
      "Draft\n\nPhone handoff ready: shortcuts://run-shortcut?name=ClaudeDraft",
    ),
  ).toBe("Draft\n\nRun ClaudeDraft in Shortcuts on your iPhone.");
  expect(
    prepareTelegramResponseText(
      "heading to London\n\nPhone handoff ready: shortcuts://run-shortcut?name=ClaudeDraft",
    ),
  ).toBe("heading to London\n\nRun ClaudeDraft in Shortcuts on your iPhone.");
  expect(
    prepareTelegramResponseText(
      "heading to London\n\nPhone handoff ready for dad (+16048092405): shortcuts://run-shortcut?name=ClaudeDraft",
    ),
  ).toBe("heading to London\n\nDrafting to dad (+16048092405). Run ClaudeDraft in Shortcuts on your iPhone.");
  expect(
    prepareTelegramResponseText(
      "heading to London\n\nClaudeDraft is not installed on your iPhone yet. Open Files > iCloud Drive > ClaudeDraft.shortcut, tap Replace or Add Shortcut, then run ClaudeDraft. Draft target: dad (+16048092405).",
    ),
  ).toBe(
    "heading to London\n\nClaudeDraft is not installed on your iPhone yet. Open Files > iCloud Drive > ClaudeDraft.shortcut, tap Replace or Add Shortcut, then run ClaudeDraft. Draft target: dad (+16048092405).",
  );
  expect(
    prepareTelegramResponseText(
      "Phone handoff ready: shortcuts://run-shortcut?name=ClaudeDraft",
    ),
  ).toBe("Run ClaudeDraft in Shortcuts on your iPhone.");
  expect(
    prepareTelegramResponseText(
      "Draft\n\nOpen on iPhone: shortcuts://run-shortcut?name=ClaudeDraft",
    ),
  ).toBe("Draft\n\nRun ClaudeDraft in Shortcuts on your iPhone.");
});

test("splitTelegramResponseText never emits empty chunks on hard boundaries", () => {
  const chunks = splitTelegramResponseText("a".repeat(10), 3);

  expect(chunks).toEqual(["aaa", "aaa", "aaa", "a"]);
});

test("sendTelegramResponse returns partial failure after at least one accepted chunk", async () => {
  const sent: string[] = [];
  const result = await sendTelegramResponse(
    {
      async reply(text: string, _options?: unknown) {
        sent.push(text);
        if (sent.length === 2) throw new Error("simulated telegram outage");
      },
    },
    "first paragraph\n\nsecond paragraph",
    16,
  );

  expect(sent).toEqual(["first paragraph", "second paragraph"]);
  expect(result.chunksSent).toBe(1);
  expect(result.chunkCount).toBe(2);
  expect(result.partialFailure).toContain("telegram_partial_send_after_1_of_2");
});

test("sendTelegramResponse throws when no chunk was accepted", async () => {
  await expect(
    sendTelegramResponse(
      {
        async reply(_text?: string, _options?: unknown) {
          throw new Error("telegram down");
        },
      },
      "hello",
    ),
  ).rejects.toThrow("telegram down");
});
