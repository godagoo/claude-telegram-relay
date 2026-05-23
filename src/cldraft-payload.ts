// cldraft-payload.ts
// Single source of truth for the CLDRAFT/1 staging payload wire format.
//
// The staging iMessage carries a JSON envelope that an iPhone Shortcut parses
// to open the target Messages compose sheet with the body prefilled. Every
// producer of this payload (relay.ts, scripts/stage-imessage.sh via env var)
// and every consumer (the Shortcut, tests, future tooling) reads the schema
// from this file so the wire contract cannot drift between code paths.
//
// Format decisions, locked:
//   - JSON envelope, compact single-line serialization (no indenting). Easier
//     for iOS Shortcuts to parse via Get Dictionary from Input than a custom
//     line-oriented grammar.
//   - Version is carried in the `version` field, not a sentinel line. Bumping
//     versions means bumping CLDRAFT_VERSION below.
//   - `draft_id` is a UUIDv4 generated at the source. Required so two drafts
//     issued seconds apart can be correlated against decision logs and so the
//     Shortcut can deduplicate if iOS fires the trigger twice.
//   - Unknown fields are tolerated on parse for forward compatibility. New
//     fields can be added without breaking existing consumers.

export const CLDRAFT_VERSION = "CLDRAFT/1" as const;

export interface CldraftPayload {
  readonly version: typeof CLDRAFT_VERSION;
  readonly draft_id: string;
  readonly to: string;
  readonly label: string;
  readonly body: string;
}

export interface BuildCldraftPayloadInput {
  to: string;
  body: string;
  label?: string;
  draftId?: string;
}

export interface BuildCldraftPayloadResult {
  payload: string;
  draftId: string;
}

/** RFC 4122 v4 UUID, case-insensitive. */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function generateDraftId(): string {
  return crypto.randomUUID();
}

export function isUuidV4(value: string): boolean {
  return UUID_V4_RE.test(value);
}

/**
 * Collapse whitespace in header-style fields (`to`, `label`). Matches the
 * normalization the shell helper used previously: any run of whitespace
 * (newlines, tabs, multiple spaces) becomes a single space, then trim.
 */
function normalizeHeader(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Build the canonical CLDRAFT/1 envelope. Pass a draftId to reuse one (so the
 * staging iMessage and the iCloud fallback can correlate); omit it for a fresh
 * UUIDv4 per call.
 */
export function buildCldraftPayload(
  input: BuildCldraftPayloadInput,
): BuildCldraftPayloadResult {
  const draftId = input.draftId ?? generateDraftId();
  const labelSource = input.label ?? input.to;
  const payload: CldraftPayload = {
    version: CLDRAFT_VERSION,
    draft_id: draftId,
    to: normalizeHeader(input.to),
    label: normalizeHeader(labelSource),
    body: input.body,
  };
  // Compact JSON: no indentation, no trailing newline. The Shortcut sees the
  // payload as a single line in the staging thread; humans skimming Messages
  // can still tell it apart from prose at a glance because of the leading
  // `{"version":"CLDRAFT/1"`.
  return {
    payload: JSON.stringify(payload),
    draftId,
  };
}

/**
 * Validate that a string is a well-formed CLDRAFT/1 payload. Throws on any
 * structural problem with a stable, machine-readable error code so callers
 * (the Shortcut, the verifier, the decision log) can branch on the reason.
 */
export function parseCldraftPayload(text: string): CldraftPayload {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("cldraft_payload_empty");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`cldraft_payload_invalid_json: ${message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("cldraft_payload_not_object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== CLDRAFT_VERSION) {
    throw new Error(
      `cldraft_payload_wrong_version: expected=${CLDRAFT_VERSION} got=${JSON.stringify(obj.version)}`,
    );
  }
  if (typeof obj.draft_id !== "string" || obj.draft_id.length === 0) {
    throw new Error("cldraft_payload_missing_draft_id");
  }
  if (typeof obj.to !== "string" || obj.to.length === 0) {
    throw new Error("cldraft_payload_missing_to");
  }
  if (typeof obj.label !== "string") {
    throw new Error("cldraft_payload_missing_label");
  }
  if (typeof obj.body !== "string") {
    throw new Error("cldraft_payload_missing_body");
  }
  return {
    version: CLDRAFT_VERSION,
    draft_id: obj.draft_id,
    to: obj.to,
    label: obj.label,
    body: obj.body,
  };
}
