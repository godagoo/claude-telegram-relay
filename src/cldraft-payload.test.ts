import { expect, test } from "bun:test";
import {
  CLDRAFT_VERSION,
  buildCldraftPayload,
  generateDraftId,
  isUuidV4,
  parseCldraftPayload,
} from "./cldraft-payload";

const SAMPLE_UUID = "550e8400-e29b-41d4-a716-446655440000";

test("round-trip preserves every field exactly", () => {
  const { payload, draftId } = buildCldraftPayload({
    to: "+15551234567",
    label: "Conor",
    body: "Hey, see you Friday.",
    draftId: SAMPLE_UUID,
  });

  expect(draftId).toBe(SAMPLE_UUID);

  const parsed = parseCldraftPayload(payload);
  expect(parsed.version).toBe(CLDRAFT_VERSION);
  expect(parsed.draft_id).toBe(SAMPLE_UUID);
  expect(parsed.to).toBe("+15551234567");
  expect(parsed.label).toBe("Conor");
  expect(parsed.body).toBe("Hey, see you Friday.");
});

test("serialization is compact single-line JSON", () => {
  const { payload } = buildCldraftPayload({
    to: "+15551234567",
    label: "Conor",
    body: "Hello",
  });
  expect(payload).not.toMatch(/\n/);
  expect(payload.startsWith("{")).toBe(true);
  expect(payload.endsWith("}")).toBe(true);
  // Compact = no whitespace after structural tokens.
  expect(payload).not.toMatch(/: /);
  expect(payload).not.toMatch(/, /);
});

test("generated draft_id is a UUIDv4", () => {
  const id = generateDraftId();
  expect(isUuidV4(id)).toBe(true);
});

test("isUuidV4 rejects non-UUIDs", () => {
  expect(isUuidV4("not-a-uuid")).toBe(false);
  expect(isUuidV4("")).toBe(false);
  expect(isUuidV4(SAMPLE_UUID.toUpperCase())).toBe(true); // case-insensitive
  // v3 (not v4) — third group must start with 4.
  expect(isUuidV4("550e8400-e29b-31d4-a716-446655440000")).toBe(false);
});

test("body with newlines is preserved", () => {
  const body = "Line one\nLine two\nLine three";
  const { payload } = buildCldraftPayload({
    to: "+15551234567",
    label: "Conor",
    body,
  });
  const parsed = parseCldraftPayload(payload);
  expect(parsed.body).toBe(body);
});

test("body with emoji and unicode is preserved", () => {
  const body = "Hey 👋 see you soon 🍕 café résumé naïve";
  const { payload } = buildCldraftPayload({
    to: "+15551234567",
    label: "Conor",
    body,
  });
  const parsed = parseCldraftPayload(payload);
  expect(parsed.body).toBe(body);
});

test("body with quotes and backslashes survives JSON escaping", () => {
  const body = `She said "hi" and pasted C:\\Users\\test\\path`;
  const { payload } = buildCldraftPayload({
    to: "+15551234567",
    label: "Conor",
    body,
  });
  const parsed = parseCldraftPayload(payload);
  expect(parsed.body).toBe(body);
});

test("header normalization collapses whitespace in to and label", () => {
  const { payload } = buildCldraftPayload({
    to: "+1\n555\n123-4567",
    label: "Conor\nMcGrath",
    body: "Hi",
  });
  const parsed = parseCldraftPayload(payload);
  expect(parsed.to).toBe("+1 555 123-4567");
  expect(parsed.label).toBe("Conor McGrath");
});

test("label defaults to recipient when omitted", () => {
  const { payload } = buildCldraftPayload({
    to: "+15551234567",
    body: "Hi",
  });
  const parsed = parseCldraftPayload(payload);
  expect(parsed.label).toBe("+15551234567");
});

test("empty body is accepted (per spec: body must be a string, may be empty)", () => {
  const { payload } = buildCldraftPayload({
    to: "+15551234567",
    label: "Conor",
    body: "",
  });
  const parsed = parseCldraftPayload(payload);
  expect(parsed.body).toBe("");
});

test("generates a new draft_id per call when none provided", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const { draftId } = buildCldraftPayload({
      to: "+15551234567",
      body: "Hi",
    });
    ids.add(draftId);
  }
  expect(ids.size).toBe(200);
});

test("rejects empty input", () => {
  expect(() => parseCldraftPayload("")).toThrow(/cldraft_payload_empty/);
  expect(() => parseCldraftPayload("   \n\n  ")).toThrow(/cldraft_payload_empty/);
});

test("rejects malformed JSON", () => {
  expect(() => parseCldraftPayload("not json")).toThrow(/cldraft_payload_invalid_json/);
  expect(() => parseCldraftPayload("{")).toThrow(/cldraft_payload_invalid_json/);
  expect(() => parseCldraftPayload("{\"a\":")).toThrow(/cldraft_payload_invalid_json/);
});

test("rejects non-object JSON", () => {
  expect(() => parseCldraftPayload("[]")).toThrow(/cldraft_payload_not_object/);
  expect(() => parseCldraftPayload('"a string"')).toThrow(/cldraft_payload_not_object/);
  expect(() => parseCldraftPayload("123")).toThrow(/cldraft_payload_not_object/);
  expect(() => parseCldraftPayload("null")).toThrow(/cldraft_payload_not_object/);
});

test("rejects wrong version", () => {
  const bad = JSON.stringify({
    version: "CLDRAFT/2",
    draft_id: SAMPLE_UUID,
    to: "+15551234567",
    label: "Conor",
    body: "Hi",
  });
  expect(() => parseCldraftPayload(bad)).toThrow(/cldraft_payload_wrong_version/);
});

test("rejects missing draft_id", () => {
  const bad = JSON.stringify({
    version: CLDRAFT_VERSION,
    to: "+15551234567",
    label: "Conor",
    body: "Hi",
  });
  expect(() => parseCldraftPayload(bad)).toThrow(/cldraft_payload_missing_draft_id/);
});

test("rejects empty draft_id", () => {
  const bad = JSON.stringify({
    version: CLDRAFT_VERSION,
    draft_id: "",
    to: "+15551234567",
    label: "Conor",
    body: "Hi",
  });
  expect(() => parseCldraftPayload(bad)).toThrow(/cldraft_payload_missing_draft_id/);
});

test("rejects missing to", () => {
  const bad = JSON.stringify({
    version: CLDRAFT_VERSION,
    draft_id: SAMPLE_UUID,
    label: "Conor",
    body: "Hi",
  });
  expect(() => parseCldraftPayload(bad)).toThrow(/cldraft_payload_missing_to/);
});

test("rejects missing body", () => {
  const bad = JSON.stringify({
    version: CLDRAFT_VERSION,
    draft_id: SAMPLE_UUID,
    to: "+15551234567",
    label: "Conor",
  });
  expect(() => parseCldraftPayload(bad)).toThrow(/cldraft_payload_missing_body/);
});

test("rejects missing label", () => {
  const bad = JSON.stringify({
    version: CLDRAFT_VERSION,
    draft_id: SAMPLE_UUID,
    to: "+15551234567",
    body: "Hi",
  });
  expect(() => parseCldraftPayload(bad)).toThrow(/cldraft_payload_missing_label/);
});

test("unknown extra fields are tolerated (forward compat)", () => {
  const text = JSON.stringify({
    version: CLDRAFT_VERSION,
    draft_id: SAMPLE_UUID,
    to: "+15551234567",
    label: "Conor",
    body: "Hi",
    future_field_v2: "ignored",
    metadata: { nested: true },
  });
  const parsed = parseCldraftPayload(text);
  expect(parsed.body).toBe("Hi");
  expect(parsed.draft_id).toBe(SAMPLE_UUID);
});

test("tolerates surrounding whitespace on parse", () => {
  const { payload } = buildCldraftPayload({
    to: "+15551234567",
    label: "Conor",
    body: "Hi",
  });
  const padded = `\n\n  ${payload}\n\n`;
  const parsed = parseCldraftPayload(padded);
  expect(parsed.body).toBe("Hi");
});

test("error messages identify the failure cleanly", () => {
  // The error code is the stable, machine-readable part. Surrounding context
  // (the offending value) is allowed but the code must be parseable.
  try {
    parseCldraftPayload('{"version":"CLDRAFT/2","draft_id":"x","to":"y","label":"z","body":""}');
    throw new Error("should have thrown");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg.startsWith("cldraft_payload_wrong_version")).toBe(true);
  }
});
