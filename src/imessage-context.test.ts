import { expect, test } from "bun:test";
import {
  extractIMessageContextRequest,
  renderIMessageContext,
  type IMessageContextResult,
} from "./imessage-context";

test("extracts contact and upper bound from iMessage context draft request", () => {
  expect(
    extractIMessageContextRequest(
      "Go through my last 5-10 text messages with Peggy for context and draft an iMessage to her",
    ),
  ).toEqual({
    contact: "Peggy",
    limit: 10,
  });
});

test("ignores ordinary draft requests without a context request", () => {
  expect(
    extractIMessageContextRequest("Draft an iMessage to Peggy saying thanks"),
  ).toBeNull();
});

test("renders found context without telling Claude access failed", () => {
  const result: IMessageContextResult = {
    request: { contact: "Peggy", limit: 10 },
    status: "found",
    messages: [
      { id: 2, sender: "them", ts: "2026-05-11 10:01:00", text: "Sounds good." },
      { id: 1, sender: "me", ts: "2026-05-11 10:00:00", text: "Can we book a clean?" },
    ],
  };

  const rendered = renderIMessageContext(result);
  expect(rendered).toContain("IMESSAGE CONTEXT FOR Peggy");
  expect(rendered).toContain("me: Can we book a clean?");
  expect(rendered).toContain("them: Sounds good.");
  expect(rendered).toContain("Do not claim you lacked iMessage access");
});

test("renders empty lookup as contact mismatch, not FDA failure", () => {
  const result: IMessageContextResult = {
    request: { contact: "Peggy", limit: 10 },
    status: "empty",
    messages: [],
  };

  const rendered = renderIMessageContext(result);
  expect(rendered).toContain("no matching messages");
  expect(rendered).toContain("Full Disk Access worked");
});
