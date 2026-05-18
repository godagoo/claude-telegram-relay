// imessage-draft.ts
// Deterministic post-action: take the iMessage draft body Claude emits between
// marker tokens and place it into Messages.app's compose surface via
// scripts/draft-imessage.sh. The helper only pbcopies and opens the thread; it
// never sends.
//
// This mirrors imessage-context.ts (deterministic prefetch). The relay owns
// both side effects so Claude never has to call a Bash tool that the headless
// `claude -p` runtime cannot approve.

import { spawn } from "bun";
import { join } from "path";

export const DRAFT_MARKER_OPEN = "<<<IMESSAGE_DRAFT>>>";
export const DRAFT_MARKER_CLOSE = "<<<END_IMESSAGE_DRAFT>>>";

const DRAFT_BLOCK_RE = /<<<IMESSAGE_DRAFT>>>([\s\S]*?)<<<END_IMESSAGE_DRAFT>>>/;
const ORPHAN_MARKER_RE = /<<<\/?(?:END_)?IMESSAGE_DRAFT>>>/g;
const HELPER_TIMEOUT_MS = 25_000;
const PHONE_HANDOFF_LINE_RE =
  /\n*[ \t]*(?:Phone handoff ready|Open on iPhone)(?:\s+for\s+([^:\n]+))?:\s*(shortcuts:\/\/run-shortcut\?name=[^\s]+)\s*\n*/i;

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
];

/**
 * Strip placement-claim and policy-footer lines from Claude's response.
 * Safety guard: if the strip removes EVERYTHING, return the original text
 * untouched and log a warning. Better to show the boilerplate once than
 * send "I generated an empty response" to Telegram. The caller is then
 * expected to trim — this function never trims so the safety check sees
 * what the caller would see.
 */
export function stripPlacementClaims(text: string): string {
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
  if (text.trim().length > 0 && out.trim().length === 0) {
    console.error(
      `[stripPlacementClaims] strip would empty response (${text.length} chars); returning original`,
    );
    return text;
  }
  return out;
}

export type IMessageDraftStatus =
  | "placed"
  | "phone_handoff_ready"
  | "phone_shortcut_install_pending"
  | "markers_missing"
  | "empty_body"
  | "no_recipient"
  | "helper_failed"
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
    ).trim();
    return stripped.length > 0 ? `${stripped}\n\n${replacement}` : replacement;
  }
  const lead = stripPlacementClaims(response.slice(0, m.index)).trim();
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
 * Pipes the draft body to scripts/draft-imessage.sh with the resolved
 * recipient. Returns whether the placement succeeded plus any helper stderr.
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
      reject(new Error(`imessage_draft_timeout_${HELPER_TIMEOUT_MS}ms`));
    }, HELPER_TIMEOUT_MS);
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
