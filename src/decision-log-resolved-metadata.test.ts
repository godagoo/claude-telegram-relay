import { expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import type { DecisionRecord } from "./decision-log";

// PR3.5 audit #6 regression (Codex 2026-05-21).
//
// Before fix: the decision record only stored the user-typed alias
// (imessage_context_contact) and not the recipient/display_name/recency
// the resolver actually picked. When the relay silently broke a "Mark"
// ambiguity by recency, the log captured "Mark" but never recorded
// which Mark won. If the wrong Mark was picked, the audit trail had no
// way to prove it after the fact.
//
// Fix: DecisionRecord gains imessage_resolved_recipient,
// imessage_resolved_display_name, imessage_resolved_last_messaged_at,
// populated from imessageContextResult in relay.ts.

test("DecisionRecord round-trips resolved iMessage metadata through JSON", () => {
  const rec: DecisionRecord = {
    ts: "2026-05-21T14:23:05.000Z",
    chat_id: 12345,
    message: "draft something to Mark",
    trigger_fired: false,
    hit_count: 0,
    hits_summary: [],
    injected_count: 0,
    total_ms: 100,
    imessage_context_contact: "Mark",
    imessage_resolved_recipient: "+15551234567",
    imessage_resolved_display_name: "Mark Stevens",
    imessage_resolved_last_messaged_at: 706287785000000000,
  };
  const serialized = JSON.stringify(rec);
  const parsed = JSON.parse(serialized);
  expect(parsed.imessage_context_contact).toBe("Mark");
  expect(parsed.imessage_resolved_recipient).toBe("+15551234567");
  expect(parsed.imessage_resolved_display_name).toBe("Mark Stevens");
  expect(parsed.imessage_resolved_last_messaged_at).toBe(706287785000000000);
});

test("DecisionRecord allows resolved fields to be absent when not populated", () => {
  const rec: DecisionRecord = {
    ts: "2026-05-21T14:23:05.000Z",
    chat_id: 12345,
    message: "just chat, no draft request",
    trigger_fired: false,
    hit_count: 0,
    hits_summary: [],
    injected_count: 0,
    total_ms: 100,
  };
  const parsed = JSON.parse(JSON.stringify(rec));
  expect(parsed.imessage_resolved_recipient).toBeUndefined();
  expect(parsed.imessage_resolved_display_name).toBeUndefined();
  expect(parsed.imessage_resolved_last_messaged_at).toBeUndefined();
});

test("relay.ts populates resolved iMessage metadata from imessageContextResult", async () => {
  // Static source check: relay.ts assigns the three new fields from the
  // resolver result. If a future refactor stops populating them, the
  // audit trail goes blind again. Cheap to maintain, catches the
  // specific regression.
  const PROJECT_ROOT = dirname(dirname(import.meta.path));
  const source = await readFile(join(PROJECT_ROOT, "src", "relay.ts"), "utf8");
  expect(source).toContain(
    "imessage_resolved_recipient: imessageContextResult?.resolvedRecipient",
  );
  expect(source).toContain(
    "imessage_resolved_display_name: imessageContextResult?.resolvedDisplayName",
  );
  expect(source).toContain(
    "imessage_resolved_last_messaged_at: imessageContextResult?.resolvedLastMessagedAt",
  );
});
