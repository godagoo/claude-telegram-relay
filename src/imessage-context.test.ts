import { expect, test } from "bun:test";
import {
  detectIMessageWriteIntent,
  extractIMessageDraftRequest,
  renderIMessageContext,
  type IMessageContextResult,
} from "./imessage-context";

test("extracts contact, context flag, and placement flag from a full context+placement request", () => {
  expect(
    extractIMessageDraftRequest(
      "Go through my last 5-10 text messages with Peggy for context and draft an iMessage to her (directly in the iMessage box)",
    ),
  ).toEqual({
    contact: "Peggy",
    wantsContext: true,
    contextLimit: 10,
    wantsPlacement: true,
  });
});

test("plain 'Draft a message to William saying hey wuddup' still triggers placement", () => {
  expect(
    extractIMessageDraftRequest(
      "Draft a message to William (me) saying hey wuddup",
    ),
  ).toEqual({
    contact: "William",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
  });
});

test("'iMessage' keyword still works even without explicit placement phrasing", () => {
  expect(
    extractIMessageDraftRequest("Draft an iMessage to Peggy saying thanks"),
  ).toEqual({
    contact: "Peggy",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
  });
});

test("returns null when there is no draft verb", () => {
  expect(
    extractIMessageDraftRequest("Tell me about Peggy's cleaning business"),
  ).toBeNull();
});

test("returns null when there is no contact", () => {
  expect(
    extractIMessageDraftRequest("Draft a message saying hey"),
  ).toBeNull();
});

test("suppresses placement when the user asks for Telegram-only output", () => {
  expect(
    extractIMessageDraftRequest(
      "Just show me the text of a message to Peggy — don't open Messages",
    ),
  ).toMatchObject({
    contact: "Peggy",
    wantsPlacement: false,
  });
});

test("detectIMessageWriteIntent still recognizes explicit placement phrasings", () => {
  expect(
    detectIMessageWriteIntent(
      "draft an iMessage to her (directly in the iMessage box) letting her know...",
    ),
  ).toBe(true);
  expect(
    detectIMessageWriteIntent("put it in the iMessage chatbox when I have it configured"),
  ).toBe(true);
  expect(detectIMessageWriteIntent("drop it into Messages")).toBe(true);
  expect(detectIMessageWriteIntent("open Messages on her thread")).toBe(true);
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
