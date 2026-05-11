// imessage-context.ts
// Deterministic iMessage context prefetch for draft requests.
//
// The relay cannot rely on Claude choosing to call a Bash helper from a prompt.
// When the user asks for recent iMessage/text-message context before drafting,
// fetch the context before Claude runs and inject it into the prompt.

import { spawn } from "bun";
import { join } from "path";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const HELPER_TIMEOUT_MS = 8_000;

export interface IMessageContextRequest {
  contact: string;
  limit: number;
}

interface IMessageRow {
  id: number;
  sender: "me" | "them";
  ts: string;
  text: string;
}

export interface IMessageContextResult {
  request: IMessageContextRequest;
  status: "found" | "empty" | "fda_denied" | "error" | "timeout";
  messages: IMessageRow[];
  /**
   * The phone/email/chat_identifier the helper landed on for this contact.
   * Always set when status is "found" or "empty"; absent for fda_denied,
   * error, and timeout. The relay reuses this to address Messages.app
   * deterministically when placing a draft.
   */
  resolvedRecipient?: string;
  error?: string;
}

/**
 * Detects whether the user wants the draft *placed* into Messages.app's
 * compose box. Exported for unit tests; the relay reads `wantsPlacement` off
 * `extractIMessageDraftRequest` instead of calling this directly.
 */
export function detectIMessageWriteIntent(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /\b(imessage|message|messages|chat)\s*(box|chatbox)\b/.test(m) ||
    /\bchat\s*box\b/.test(m) ||
    /\bnative\s+compose\b/.test(m) ||
    /\bmessages\s+app\b/.test(m) ||
    /\b(?:drop|put|place)\s+(?:it\s+)?(?:in|into)\s+(?:the\s+)?messages\b/.test(m) ||
    /\bopen\s+messages\b/.test(m) ||
    /\bdirectly\s+in\s+(?:the\s+)?(?:imessage|messages|message)\b/.test(m)
  );
}

/**
 * Detects when the user explicitly does NOT want the draft placed in
 * Messages.app — e.g. "just show me the text", "in Telegram only", "don't
 * open Messages". Used to opt out of the default placement behavior.
 */
function detectPlacementSuppression(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /\b(just|only)\s+(?:give|show|return|send)\s+(?:me\s+)?(?:the\s+)?(?:text|draft|body)\b/.test(m) ||
    /\bin\s+telegram\s+only\b/.test(m) ||
    /\bdon'?t\s+(?:open|use|launch)\s+messages\b/.test(m) ||
    /\bno\s+placement\b/.test(m)
  );
}

const DRAFT_VERB_RE = /\b(draft|write|compose|send|shoot|text|message)\b/;
const MESSAGE_TYPE_RE = /\b(imessage|imessages|text\s+messages?|texts?|sms|message|messages|chat\s+message)\b/;
const CONTEXT_SIGNAL_RE = /\b(last|recent|previous|prior|context|history|go\s+through|look\s+through|read\s+(?:my|our|the))\b/;

function hasDraftVerbAndType(message: string): boolean {
  const m = message.toLowerCase();
  return DRAFT_VERB_RE.test(m) && MESSAGE_TYPE_RE.test(m);
}

function parseLimit(message: string): number {
  const range = message.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/);
  if (range) {
    return Math.min(MAX_LIMIT, Math.max(1, Number(range[2])));
  }

  const single = message.match(/\blast\s+(\d{1,2})\b/i);
  if (single) {
    return Math.min(MAX_LIMIT, Math.max(1, Number(single[1])));
  }

  return DEFAULT_LIMIT;
}

function cleanContact(raw: string): string {
  return raw
    .replace(/[,.!?;:]+$/g, "")
    .replace(/\s+(for|about|letting|saying|telling)\b.*$/i, "")
    .trim();
}

/**
 * Higher-level intent extracted from a user message that asks the bot to
 * draft an iMessage/text/SMS. Captures three independent intents:
 *
 *   - `contact`        — the named recipient (resolved later by the helper).
 *   - `wantsContext`   — does the user want recent thread history fetched
 *                        and injected into the prompt? Signals: "last 5",
 *                        "recent", "context", "go through my messages".
 *   - `wantsPlacement` — should the body land in Messages.app's compose box
 *                        after Claude returns? Defaults to TRUE for any
 *                        explicit message-type draft and only goes false on
 *                        explicit suppression signals ("just give me the
 *                        text", "in Telegram only", "don't open Messages").
 *
 * Decoupling these lets the relay handle the common case ("draft a message
 * to William saying hey wuddup") without requiring the user to repeat the
 * "directly in the iMessage box" phrasing every time.
 */
export interface IMessageDraftRequest {
  contact: string;
  wantsContext: boolean;
  contextLimit: number;
  wantsPlacement: boolean;
}

export function extractIMessageDraftRequest(
  message: string,
): IMessageDraftRequest | null {
  if (!hasDraftVerbAndType(message)) return null;

  const explicit = message.match(
    /\b(?:with|to)\s+([+()\-\d\s]{7,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/i,
  );
  if (!explicit) return null;

  const contact = cleanContact(explicit[1]);
  if (!contact) return null;

  const m = message.toLowerCase();
  const wantsContext = CONTEXT_SIGNAL_RE.test(m);
  const wantsPlacement = !detectPlacementSuppression(message);

  return {
    contact,
    wantsContext,
    contextLimit: parseLimit(message),
    wantsPlacement,
  };
}

export async function fetchIMessageContext(
  projectRoot: string,
  request: IMessageContextRequest,
): Promise<IMessageContextResult> {
  const script = join(projectRoot, "scripts", "imessage-thread.sh");
  const proc = spawn([script, request.contact, String(request.limit)], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: projectRoot,
    env: { ...process.env },
  });

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      reject(new Error(`imessage_context_timeout_${HELPER_TIMEOUT_MS}ms`));
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

    if (code === 77) {
      return {
        request,
        status: "fda_denied",
        messages: [],
        error: stderr.trim() || "Full Disk Access denied",
      };
    }

    if (code !== 0) {
      return {
        request,
        status: "error",
        messages: [],
        error: stderr.trim() || `helper exited ${code}`,
      };
    }

    const parsed = stdout
      ? JSON.parse(stdout)
      : { resolved: "", messages: [] };
    const messages: IMessageRow[] = Array.isArray(parsed?.messages)
      ? parsed.messages
      : [];
    const resolvedRecipient =
      typeof parsed?.resolved === "string" && parsed.resolved.length > 0
        ? parsed.resolved
        : undefined;
    return {
      request,
      status: messages.length > 0 ? "found" : "empty",
      messages,
      resolvedRecipient,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      request,
      status: msg.startsWith("imessage_context_timeout_") ? "timeout" : "error",
      messages: [],
      error: msg,
    };
  }
}

export function renderIMessageContext(result: IMessageContextResult): string {
  const { request } = result;

  if (result.status === "found") {
    const chronological = [...result.messages].reverse();
    const lines = chronological.map((m) =>
      `- ${m.ts} ${m.sender}: ${m.text.replace(/\s+/g, " ").trim()}`
    );
    return [
      `IMESSAGE CONTEXT FOR ${request.contact} (last ${result.messages.length} messages):`,
      ...lines,
      "",
      "Use this real thread context before drafting. Do not claim you lacked iMessage access.",
    ].join("\n");
  }

  if (result.status === "empty") {
    return [
      `IMESSAGE CONTEXT LOOKUP FOR ${request.contact}: no matching messages were found.`,
      "Full Disk Access worked, but the contact name or identifier did not match a Messages thread. Ask the user for the phone number or email if needed.",
    ].join("\n");
  }

  if (result.status === "fda_denied") {
    return [
      `IMESSAGE CONTEXT LOOKUP FOR ${request.contact}: Full Disk Access was denied.`,
      "Draft from the user's description and say the iMessage context could not be read.",
    ].join("\n");
  }

  return [
    `IMESSAGE CONTEXT LOOKUP FOR ${request.contact}: ${result.status}.`,
    result.error ? `Error: ${result.error}` : "",
    "Draft from the user's description and briefly mention that context lookup failed.",
  ].filter(Boolean).join("\n");
}
