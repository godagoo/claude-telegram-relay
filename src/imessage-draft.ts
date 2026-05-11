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

export type IMessageDraftStatus =
  | "placed"
  | "markers_missing"
  | "empty_body"
  | "no_recipient"
  | "helper_failed"
  | "no_intent";

export interface PlaceDraftResult {
  ok: boolean;
  /**
   * "pasted" → body is in the Messages compose field via the native
   * sms:&body= URL path.
   * "clipboard_only" → body is on the clipboard and Messages is open on the
   * thread, but URL body prefill failed. Both are usable; the relay tells the
   * user which one happened so it never claims compose-box
   * placement that didn't occur.
   */
  mode?: "pasted" | "clipboard_only";
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
