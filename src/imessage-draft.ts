// imessage-draft.ts
// Deterministic post-action: take the iMessage draft body Claude emits between
// marker tokens and hand it to the staging iMessage watcher via
// scripts/stage-imessage.sh. The staging Shortcut opens the final target compose
// sheet; the relay process never drives that compose field directly and never
// sends the target message.
//
// This mirrors imessage-context.ts (deterministic prefetch). The relay owns
// both side effects so Claude never has to call a Bash tool that the headless
// `claude -p` runtime cannot approve.

import { spawn } from "bun";
import { createHash } from "crypto";
import { join } from "path";
import { buildCldraftPayload } from "./cldraft-payload.ts";

export const DRAFT_MARKER_OPEN = "<<<IMESSAGE_DRAFT>>>";
export const DRAFT_MARKER_CLOSE = "<<<END_IMESSAGE_DRAFT>>>";

const DRAFT_BLOCK_RE = /<<<IMESSAGE_DRAFT>>>([\s\S]*?)<<<END_IMESSAGE_DRAFT>>>/;
const ORPHAN_MARKER_RE = /<<<\/?(?:END_)?IMESSAGE_DRAFT>>>/g;
const DRAFT_HELPER_TIMEOUT_MS = 25_000;
// scripts/stage-imessage.sh worst-case budget:
//   ICLOUD_SETTLE_SECONDS (default 20) + SEND_TIMEOUT_SECONDS (default 25) = 45s
// Plus process spawn / SIGTERM overhead. Keep ~12s headroom above the shell so
// the TS-side timeout only fires when the shell genuinely hangs without
// emitting its JSON envelope (catastrophic case), not on routine iCloud lag.
// If you bump either env knob, bump this constant in lockstep.
const STAGE_HELPER_TIMEOUT_MS = 60_000;
const PHONE_HANDOFF_LINE_RE =
  /\n*[ \t]*(?:Phone handoff ready|Open on iPhone)(?:\s+for\s+([^:\n]+))?:\s*(shortcuts:\/\/run-shortcut\?name=[^\s]+)\s*\n*/i;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Claude likes to append boilerplate after a draft: "Draft is in the Messages
// compose box for X. Review and send when ready." or "Draft above, review
// and send manually." These contradict the relay's real status when placement
// fails, and they read as nagging policy reminders the user has explicitly
// asked to never see again (2026-05-11 feedback: "Never say send manually
// again"). The patterns are line-anchored, case-insensitive, and each one
// requires a SPECIFIC tell ("manually"/"yourself"/"the draft"/"Messages
// compose") so we never strip a legitimate body line that happens to begin
// with a common verb.
const PLACEMENT_CLAIM_LINE_RES: RegExp[] = [
  /^[ \t]*draft\s+(?:is|has\s+been|sits|now\s+sits|is\s+now)\s+(?:in|on|placed\s+in|sitting\s+in|inside|waiting\s+in)\s+(?:the\s+|your\s+|a\s+)?(?:messages?|imessages?|compose|clipboard)[^\n]*\n?/gim,
  /^[ \t]*(?:i(?:'ve)?|i\s+have)\s+(?:placed|dropped|put|opened|pasted|loaded|set\s+up)\s+(?:the\s+|this\s+|your\s+)?(?:draft|message|text|body|reply)[^\n]*\n?/gim,
  /^[ \t]*(?:opened|opening)\s+messages?\s+(?:on|with|to|for)[^\n]*\n?/gim,
  /^[ \t]*(?:placed|placing|put|putting|pasted|pasting)\s+(?:the\s+|this\s+|your\s+)?(?:draft|message|text|body|reply)\s+(?:in|into|inside)\s+(?:the\s+|your\s+)?(?:messages?|imessages?|compose|chat\s*box)[^\n]*\n?/gim,
  /^[ \t]*(?:ready\s+to\s+send|review\s+and\s+send)\s+(?:it|this|the\s+draft|manually|yourself|when[^\n]*)\b[^\n]*\n?/gim,
  // "Draft above, review and send manually." and variants. Hard-banned by
  // 2026-05-11 feedback. Requires a specific footer phrasing — never strips
  // a body line that happens to start with the word "Draft".
  /^[ \t]*draft\s+(?:above|below|here|sent\s+below)\s*[,.:;]?\s*(?:review|send|you|paste|copy)[^\n]*\n?/gim,
  // Specific "send it/this/the draft manually|yourself|from Messages" forms
  // only. Anchored at "you" so we don't strip lines that simply mention
  // "send X" without the policy-footer framing. Requires the line ends in
  // one of the policy markers (manually/yourself/from messages/etc).
  /^[ \t]*you[^\n]*\bsend\s+(?:it|this|that|the\s+draft|the\s+message|messages?)\s+(?:manually|yourself|when\s+(?:you'?re\s+)?ready|from\s+messages)\b[^\n]*\n?/gim,
  /^[ \t]*send\s+(?:it|this|the\s+draft|that|the\s+message)\s+(?:manually|yourself|when\s+you'?re\s+ready)[^\n]*\n?/gim,
  /^[ \t]*(?:i\s+can(?:'t|not)|i\s+won'?t|i\s+do\s+not|i\s+cannot)\s+send\s+(?:it|this|that|the\s+(?:draft|message|imessage|email)|messages?|for\s+you)[^\n]*\n?/gim,
  // "I don't/do not have the ability to send messages on your behalf" — relay prompt
  // covers this, but Claude still outputs it when users complain about the draft flow.
  /^[ \t]*i\s+(?:don'?t|do\s+not)\s+have\s+(?:the\s+)?(?:ability|permission|access|capability)\s+to\s+send[^\n]*\n?/gim,
  // "You'll need to send this directly through your Messages app / another messaging platform."
  // Escapes stripPlacementClaims because it uses "directly through" rather than
  // "manually/yourself/from messages". Hard-banned: the relay owns placement status.
  /^[ \t]*you'?ll\s+need\s+to\s+send\s+(?:this|it|that|the\s+(?:draft|message))[^\n]*\n?/gim,
  // "Send this through your Messages app or another messaging platform."
  /^[ \t]*send\s+(?:this|it|that|the\s+(?:draft|message))\s+(?:through|via|using|directly)[^\n]*\n?/gim,
  // PR3.5 #5 (Codex 2026-05-21): generic pre-marker draft-intro leads like
  // "Here's the draft for Sarah:" duplicate the relay-owned selectionLine
  // ("Drafting for Sarah (3d ago):") that the staging-success path inserts.
  // Strip these on the lead slice so the user sees one introduction line,
  // not two. Anchored at a known intro verb and the literal word "draft",
  // "message", "text", or "reply" so legitimate body content survives.
  /^[ \t]*(?:here(?:'s|\s+is|\s+are)|drafting|below\s+is|attached\s+is|this\s+is)\s+(?:a\s+|the\s+)?(?:draft|message|text|reply|note)\s+(?:for|to)\s+[^\n:]+[:.]?\s*\n?/gim,
];

/**
 * Strip placement-claim and policy-footer lines from Claude's response.
 * Safety guard: by default, if the strip removes EVERYTHING, return the
 * original text untouched and log a warning. Better to show the boilerplate
 * once than send "I generated an empty response" to Telegram. Callers that
 * are stripping a fragment before adding the relay-owned placement status can
 * disable the guard, because an empty fragment is the correct result there.
 */
export function stripPlacementClaims(
  text: string,
  options: { preserveNonEmpty?: boolean } = {},
): string {
  const preserveNonEmpty = options.preserveNonEmpty ?? true;
  const draftBlocks: string[] = [];
  let out = text.replace(DRAFT_BLOCK_RE, (block) => {
    const idx = draftBlocks.push(block) - 1;
    return `__IMESSAGE_DRAFT_BLOCK_${idx}__`;
  });
  for (const re of PLACEMENT_CLAIM_LINE_RES) out = out.replace(re, "");
  out = out.replace(/__IMESSAGE_DRAFT_BLOCK_(\d+)__/g, (_m, idx) => {
    return draftBlocks[Number(idx)] ?? "";
  });
  out = out.replace(/\n{3,}/g, "\n\n");
  if (preserveNonEmpty && text.trim().length > 0 && out.trim().length === 0) {
    console.error(
      `[stripPlacementClaims] strip would empty response (${text.length} chars); returning original`,
    );
    return text;
  }
  return out;
}

export type IMessageDraftStatus =
  | "placed"
  | "staging_handoff_sent"
  | "phone_handoff_ready"
  | "phone_shortcut_install_pending"
  | "markers_missing"
  | "empty_body"
  | "no_recipient"
  | "recipient_not_allowlisted"
  | "helper_failed"
  | "unparsed_intent"
  | "no_intent";

/** Sentinel passed to the helper when the contact could not be resolved.
 * The helper opens a fresh Messages compose window with the body prefilled
 * and the recipient blank so the user can pick the contact in Messages.
 * Anything outside {"?", "-", ""} is treated as a real phone/email/identifier.
 */
export const NEW_COMPOSE_SENTINEL = "?";

export interface PlaceDraftResult {
  ok: boolean;
  /**
   * "pasted" → a future verified UI path proved the body is in the Messages
   * compose field. The current helper intentionally does not claim this from
   * `open sms:...` alone.
   * "new_compose" → a future verified UI path proved the body is in a
   * brand-new Messages compose window with the recipient field blank.
   * "clipboard_only" → body is on the clipboard and Messages is open, but
   * the body did not visibly prefill. All three are usable; the relay
   * tells the user which one happened so it never claims compose-box
   * placement that didn't occur.
   */
  mode?: "pasted" | "new_compose" | "clipboard_only";
  /** Helper's reason string when mode is clipboard_only. Diagnostic only. */
  reason?: string;
  /** Hard-failure error message when ok is false. */
  error?: string;
}

export interface StageDraftResult {
  ok: boolean;
  mode?: "staging_imessage";
  payloadSha256?: string;
  /**
   * UUIDv4 generated for this draft. Surfaced so the decision log and the
   * Telegram reply can correlate against the staging Messages thread and the
   * iCloud fallback file (which uses the same draft_id).
   */
  draftId?: string;
  error?: string;
}

/**
 * Extracts the body between the first well-formed marker pair. Returns null
 * if no complete pair is present. Trims surrounding whitespace.
 */
export function extractDraftBody(response: string): string | null {
  const m = response.match(DRAFT_BLOCK_RE);
  if (!m) return null;
  const body = m[1].trim();
  return body.length > 0 ? body : null;
}

/**
 * Replaces the first complete marker pair (including the markers themselves)
 * with `replacement`. If there is no complete pair, strips any orphan markers
 * so the user never sees `<<<IMESSAGE_DRAFT>>>` literally in Telegram.
 */
export function replaceDraftBlock(
  response: string,
  replacement: string,
): string {
  if (DRAFT_BLOCK_RE.test(response)) {
    return response.replace(DRAFT_BLOCK_RE, replacement);
  }
  return response.replace(ORPHAN_MARKER_RE, "").replace(/\n{3,}/g, "\n\n");
}

/**
 * Rebuilds Claude's response around the marker block so the relay owns the
 * placement status line. Keeps Claude's optional lead sentence (everything
 * before the opening marker, with hallucinated placement claims scrubbed) and
 * discards everything after the closing marker. Use this in every placement
 * code path so Claude can never contradict the relay's real status (e.g. the
 * "Draft is in the Messages compose box…" line Claude likes to append even
 * when the relay actually failed to resolve the recipient).
 */
export function rebuildAroundDraftBlock(
  response: string,
  replacement: string,
): string {
  const m = DRAFT_BLOCK_RE.exec(response);
  if (!m || m.index === undefined) {
    const stripped = stripPlacementClaims(
      response.replace(ORPHAN_MARKER_RE, ""),
      { preserveNonEmpty: false },
    ).trim();
    return stripped.length > 0 ? `${stripped}\n\n${replacement}` : replacement;
  }
  const lead = stripPlacementClaims(response.slice(0, m.index), {
    preserveNonEmpty: false,
  }).trim();
  return lead.length > 0 ? `${lead}\n\n${replacement}` : replacement;
}

/**
 * Convert the relay's internal iPhone Shortcut handoff line into Telegram-safe
 * body text. Telegram Bot API rejects custom schemes such as `shortcuts://` in
 * inline keyboard button URLs, so this must never create reply_markup.
 */
export function formatPhoneHandoffForTelegram(response: string): string {
  const match = response.match(PHONE_HANDOFF_LINE_RE);
  if (!match) return response;
  // Strip the internal handoff line but do not append a "Run ClaudeDraft on
  // your iPhone" instruction. The draft body itself is the actionable content;
  // phone_handoff_ready remains an internal decision-log state only.
  return response.replace(PHONE_HANDOFF_LINE_RE, "\n\n").trim();
}

/**
 * Legacy Mac-side helper wrapper. Kept for manual recovery/tests, but the
 * production relay path uses stageIMessageDraft so launchd never drives the
 * final target compose field directly.
 */
export async function placeIMessageDraft(
  projectRoot: string,
  recipient: string,
  body: string,
): Promise<PlaceDraftResult> {
  const script = join(projectRoot, "scripts", "draft-imessage.sh");

  const proc = spawn([script, recipient], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: projectRoot,
    env: { ...process.env },
  });

  proc.stdin?.write(body);
  await proc.stdin?.end();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      reject(new Error(`imessage_draft_timeout_${DRAFT_HELPER_TIMEOUT_MS}ms`));
    }, DRAFT_HELPER_TIMEOUT_MS);
  });

  try {
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeout,
    ]);
    if (timeoutId) clearTimeout(timeoutId);

    if (code !== 0) {
      return {
        ok: false,
        error: stderr.trim() || `draft helper exited ${code}`,
      };
    }

    let envelope: { ok?: boolean; mode?: string; reason?: string };
    try {
      envelope = JSON.parse(stdout.trim() || "{}");
    } catch {
      return {
        ok: false,
        error: `helper stdout was not JSON: ${stdout.slice(0, 120)}`,
      };
    }

    if (envelope.ok && envelope.mode === "pasted") {
      return { ok: true, mode: "pasted" };
    }
    if (envelope.ok && envelope.mode === "new_compose") {
      return { ok: true, mode: "new_compose" };
    }
    if (envelope.ok && envelope.mode === "clipboard_only") {
      return { ok: true, mode: "clipboard_only", reason: envelope.reason };
    }
    return {
      ok: false,
      error: envelope.reason ?? "unknown helper outcome",
    };
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Sends the draft to the configured staging iMessage handle. The staging
 * Shortcut does the final compose-sheet open from inside Shortcuts.app.
 *
 * The CLDRAFT/1 payload is built here via cldraft-payload.ts so the schema
 * is owned by TypeScript and the shell helper is a thin send-it transport.
 * The draftId returned in the result is the UUIDv4 embedded in the payload;
 * the iCloud fallback writer inside the shell helper reuses the same value
 * so logs and Shortcut state correlate across both transports.
 */
export async function stageIMessageDraft(
  projectRoot: string,
  recipient: string,
  contactLabel: string,
  body: string,
): Promise<StageDraftResult> {
  const script = join(projectRoot, "scripts", "stage-imessage.sh");
  const { payload, draftId } = buildCldraftPayload({
    to: recipient,
    label: contactLabel,
    body,
  });
  const payloadSha256 = sha256Hex(payload);

  const proc = spawn([script, recipient, contactLabel], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: projectRoot,
    env: {
      ...process.env,
      RELAY_CLDRAFT_PAYLOAD_JSON: payload,
      RELAY_CLDRAFT_DRAFT_ID: draftId,
    },
  });

  proc.stdin?.write(body);
  await proc.stdin?.end();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      reject(new Error(`imessage_stage_timeout_${STAGE_HELPER_TIMEOUT_MS}ms`));
    }, STAGE_HELPER_TIMEOUT_MS);
  });

  try {
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeout,
    ]);
    if (timeoutId) clearTimeout(timeoutId);

    let envelope: {
      ok?: boolean;
      mode?: string;
      reason?: string;
      payload_sha256?: string;
    };
    try {
      envelope = JSON.parse(stdout.trim() || "{}");
    } catch {
      // PR3.5 #3 (Codex 2026-05-21): every failure branch must carry draftId
      // and the locally computed payload hash so logs can correlate even when
      // the shell helper exits before emitting a usable JSON envelope.
      return {
        ok: false,
        error: `stage helper stdout was not JSON: ${stdout.slice(0, 120)}`,
        draftId,
        payloadSha256,
      };
    }

    if (code !== 0) {
      return {
        ok: false,
        error: envelope.reason ?? (stderr.trim() || `stage helper exited ${code}`),
        draftId,
        payloadSha256: envelope.payload_sha256 ?? payloadSha256,
      };
    }

    if (envelope.ok && envelope.mode === "staging_imessage") {
      return {
        ok: true,
        mode: "staging_imessage",
        payloadSha256: envelope.payload_sha256 ?? payloadSha256,
        draftId,
      };
    }
    if (envelope.ok && envelope.mode === "dry_run") {
      return {
        ok: true,
        mode: "staging_imessage",
        payloadSha256: envelope.payload_sha256 ?? payloadSha256,
        draftId,
      };
    }
    return {
      ok: false,
      error: envelope.reason ?? "unknown stage helper outcome",
      draftId,
      payloadSha256: envelope.payload_sha256 ?? payloadSha256,
    };
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      draftId,
      payloadSha256,
    };
  }
}
