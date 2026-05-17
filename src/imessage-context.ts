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

const DRAFT_VERB_RE = /\b(draft|write|compose|send|shoot|text|message|respond|reply|ping)\b/;
const MESSAGE_TYPE_RE = /\b(imessage|imessages|text\s+messages?|texts?|sms|message|messages|chat\s+message|reply|response)\b/;
const CONTEXT_SIGNAL_RE = /\b(last|recent|previous|prior|context|history|go\s+through|look\s+through|read\s+(?:my|our|the))\b/;
// "Respond to Conor saying hi" and "Reply to Conor" clearly mean iMessage —
// no explicit "message" type keyword is required. We still defer to an email
// keyword to avoid hijacking "respond to John's email".
// Allow only the known "back to" filler so "respond back to" and
// "reply back to" fire the same draft path as "respond to" / "reply to".
// Do not accept arbitrary words here: "reply all to" is an email idiom, not
// an iMessage placement request.
// Live failure 2026-05-14: "Please respond back to my mom" returned null
// because "respond back to" didn't satisfy the bare `\s+to` pattern.
const IMPLICIT_MESSAGE_VERB_RE = /\b(respond|reply|ping)\s+(?:(?:right\s+)?back\s+)?to\b/;
const EMAIL_TYPE_RE = /\b(email|e-mail|gmail|inbox|mailbox)\b/;
const EMAIL_REPLY_ALL_RE = /\breply(?:\s*-\s*|\s+)all(?:\s+(?:right\s+)?back)?\s+to\b/;

// Past-tense / meta references to a prior draft. Live failure 2026-05-13T00:14Z:
// "In your draft to Peggy did not not ready through her previous text messages
// for context?" was treated as a new draft request because "draft" + "messages"
// + "to Peggy" all matched. It's a question ABOUT a past draft, not a new
// request. Shape: <possessive determiner> <draft-noun> <recipient indicator>.
// The trailing (to|for|with|about) is required so "directly in the iMessage
// box" (placement phrasing, no recipient indicator) does not match.
const PAST_DRAFT_REFERENCE_RE =
  /\b(?:your|the|that|this|my|our|his|her|their|last|previous|previously|earlier|prior)\s+(?:draft|message|reply|response|text|imessage|sms|email|note)\s+(?:to|for|with|about)\b/i;
const META_DRAFT_QUESTION_RE =
  /\b(?:did|have|has|had)\s+(?:you|we|i|it|claude|codex|assistant|the\s+(?:bot|relay|assistant))\s+(?:already\s+)?(?:draft|drafted|write|wrote|written|compose|composed|send|sent|shoot|shot|text|texted|message|messaged)\s+(?:(?:a|an|the|that|this|my|your|our|his|her|their|last|previous|earlier|prior)\s+)?(?:draft|message|reply|response|text|imessage|sms|email|note)\s+(?:to|for|with|about)\b/i;

function isPastDraftReference(message: string): boolean {
  return PAST_DRAFT_REFERENCE_RE.test(message) || META_DRAFT_QUESTION_RE.test(message);
}

// Self-recipient: "Reply to myself saying X", "Draft a message to me",
// "Text myself a reminder". The proper-noun regex below requires
// capitalization, so "myself"/"me" never match and the request falls through
// to the generic chat path — which on 2026-05-13 took Claude to a 90s
// timeout because the bot had no draft pathway to follow. Detecting these
// up front routes the request through the normal placement pipeline with
// contact="myself", which the helper short-circuits to RELAY_SELF_RECIPIENT
// (or its fallback) in fetchIMessageContext below.
const SELF_RECIPIENT_RE =
  /\b(?:[Ww]ith|[Tt]o)\s+(?:myself|me)\b|\b(?:[Tt]ext|[Mm]essage|[Pp]ing)\s+(?:myself|me)\b/;
const SELF_DRAFT_INTENT_RE =
  /\b(?:[Rr]eply|[Rr]espond)\s+to\s+(?:myself|me)\b|\b(?:[Tt]ext|[Mm]essage|[Pp]ing)\s+(?:myself|me)\b|\b(?:[Dd]raft|[Ww]rite|[Cc]ompose|[Ss]end|[Ss]hoot)\s+(?:myself|me)\s+(?:a|an)\s+(?:imessage|text|sms|message)\b|\b(?:[Dd]raft|[Ww]rite|[Cc]ompose|[Ss]end|[Ss]hoot)\s+(?:a|an)\s+(?:imessage|text|sms|message)\s+(?:to|for|with)\s+(?:myself|me)\b/;
export const SELF_CONTACT = "myself";
// "to mom", "to my mom", "for my dad", "text my sister", etc.
// The possessive prefix (my/our/the) is made optional so bare "to mom"
// also fires — "my mom" was caught but "to mom" slipped through before.
const RELATIONSHIP_CONTACT_RE =
  /\b(?:[Ww]ith|[Tt]o|[Ff]or)\s+(?:(?:my|our|the)\s+)?(mom|mum|mother|dad|father|wife|husband|son|daughter|brother|sister|parent|parents)\b|\b(?:[Tt]ext|[Mm]essage|[Pp]ing)\s+(?:(?:my|our|the)\s+)?(mom|mum|mother|dad|father|wife|husband|son|daughter|brother|sister|parent|parents)\b/;
const MULTI_RELATIONSHIP_CONTACT_RE =
  /\b(?:[Ww]ith|[Tt]o|[Ff]or|[Tt]ext|[Mm]essage|[Pp]ing)\s+(?:(?:my|our|the)\s+)?(?:mom|mum|mother|dad|father|wife|husband|son|daughter|brother|sister|parent|parents)\s+(?:and|&)\s+(?:(?:my|our|the)\s+)?(?:mom|mum|mother|dad|father|wife|husband|son|daughter|brother|sister|parent|parents)\b/;
const COMMAND_POSITION_CONTACT_RE =
  /^\s*(?:(?:[Oo]k(?:ay)?|[Aa]lright|[Ss]ure)[,.\s]+)?(?:(?:[Pp]lease|[Pp]ls|[Cc]an you|[Cc]ould you|[Ww]ould you)\s+)?(?:[Tt]ext|[Mm]essage|[Pp]ing)\s+([+()\-\d][+()\-\d\s]{6,}|[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}|[a-z][a-z'\-]{1,30}(?:\s+[a-z][a-z'\-]{1,30}){0,2})(?=\s*(?:$|[,.;:!?]|\b(?:saying|say|with|about|letting|telling)\b))/;

function hasDraftVerbAndType(message: string): boolean {
  const m = message.toLowerCase();
  if (EMAIL_TYPE_RE.test(m)) return false;
  if (EMAIL_REPLY_ALL_RE.test(m)) return false;
  // Suppress when the message references a prior draft — meta-question, not
  // a new draft request. Critical: this runs BEFORE the implicit-verb path
  // so "in your reply to Peggy did you..." doesn't get hijacked by the
  // `reply to` heuristic.
  if (isPastDraftReference(message)) return false;
  if (SELF_DRAFT_INTENT_RE.test(message)) return true;
  if (IMPLICIT_MESSAGE_VERB_RE.test(m)) return true;
  if (COMMAND_POSITION_CONTACT_RE.test(message)) return true;
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

function normalizeRelationshipContact(raw: string): string {
  const contact = raw.toLowerCase();
  if (contact === "mum" || contact === "mother") return "mom";
  if (contact === "father") return "dad";
  return contact;
}

function cleanDirectDraftBody(raw: string): string | undefined {
  const body = raw
    // Remove placement instructions that are not part of the body.
    .replace(
      /\s+(?:directly\s+)?(?:in|into)\s+(?:the\s+)?(?:imessage|messages?|message|chat)\s*(?:box|app|compose(?:\s+box)?)?\b.*$/i,
      "",
    )
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
  return body.length > 0 ? body : undefined;
}

/**
 * Extracts an exact draft body when the user supplies one in the same turn:
 * "Reply to myself saying testing", "Text me with hello", or
 * "Draft an iMessage to Peggy: thanks". This is intentionally conservative:
 * descriptive asks like "letting her know that..." still go through Claude so
 * it can turn the instruction into polished prose.
 */
function sameText(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalize(a) === normalize(b);
}

function extractDirectDraftBody(
  message: string,
  contact?: string,
): string | undefined {
  const saying = message.match(/\b(?:saying|say)\s+([\s\S]+)$/i);
  if (saying) return cleanDirectDraftBody(saying[1]);

  const withBody = message.match(/.*\bwith\s+([\s\S]+)$/i);
  if (withBody) {
    const body = cleanDirectDraftBody(withBody[1]);
    return sameText(body, contact) ? undefined : body;
  }

  const colon = message.match(/\b(?:imessage|text|sms|message)\s+(?:to|for|with)\s+[^:]{1,80}:\s+([\s\S]+)$/i);
  if (colon) return cleanDirectDraftBody(colon[1]);

  return undefined;
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
  /**
   * Body instruction supplied by the user in this turn. For named contacts,
   * the relay treats this as the core meaning and still lets Claude apply
   * thread context plus writing-style rules. For direct phone/email targets
   * where no local thread can be read, the relay may place this body directly.
   */
  directBody?: string;
}

export function extractIMessageDraftRequest(
  message: string,
): IMessageDraftRequest | null {
  if (!hasDraftVerbAndType(message)) return null;
  if (MULTI_RELATIONSHIP_CONTACT_RE.test(message)) return null;

  // Self-recipient first: "Reply to myself saying X" must not require a
  // proper-noun match to count. See SELF_RECIPIENT_RE comment above.
  if (SELF_DRAFT_INTENT_RE.test(message) || SELF_RECIPIENT_RE.test(message)) {
    const directBody = extractDirectDraftBody(message, SELF_CONTACT);
    return {
      contact: SELF_CONTACT,
      wantsContext: false,
      contextLimit: parseLimit(message),
      wantsPlacement: !detectPlacementSuppression(message),
      ...(directBody ? { directBody } : {}),
    };
  }

  // Prefix keyword is case-insensitive ([Ww]ith / [Tt]o), but the proper-noun
  // branch must require real capitalization. A global /i flag caused
  // "Nono it needs to be in my iMessages compose box" to capture "be in my"
  // as a three-word "proper noun" — case-insensitive [A-Z] matches lowercase.
  // The email branch stays case-insensitive via explicit [A-Za-z].
  const relationship = message.match(RELATIONSHIP_CONTACT_RE);
  const commandPosition = relationship ? null : message.match(COMMAND_POSITION_CONTACT_RE);
  const explicit = relationship || commandPosition ? null : message.match(
    /\b(?:[Ww]ith|[Tt]o)\s+([+()\-\d\s]{7,}|[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/,
  );
  if (!explicit && !relationship && !commandPosition) return null;

  const contact = explicit
    ? cleanContact(explicit[1])
    : commandPosition
      ? cleanContact(commandPosition[1])
      : normalizeRelationshipContact(relationship![1] || relationship![2]);
  if (!contact) return null;

  const m = message.toLowerCase();
  const wantsContext = CONTEXT_SIGNAL_RE.test(m);
  const wantsPlacement = !detectPlacementSuppression(message);
  const directBody = wantsContext ? undefined : extractDirectDraftBody(message, contact);

  return {
    contact,
    wantsContext,
    contextLimit: parseLimit(message),
    wantsPlacement,
    ...(directBody ? { directBody } : {}),
  };
}

/**
 * Recipient the relay uses when the user says "myself" / "me". Override via
 * `RELAY_SELF_RECIPIENT` env var (phone or email). Fallback is William's
 * Apple-ID email so a missing env var still produces a valid handoff. We
 * short-circuit the helper for this case because (a) imessage-thread.sh
 * returns empty for "myself" anyway, and (b) drafting to yourself doesn't
 * need prior thread context.
 */
function resolveSelfRecipient(): string {
  return process.env.RELAY_SELF_RECIPIENT?.trim() || "wregan599@gmail.com";
}

export async function fetchIMessageContext(
  projectRoot: string,
  request: IMessageContextRequest,
): Promise<IMessageContextResult> {
  if (request.contact === SELF_CONTACT) {
    return {
      request,
      status: "empty",
      messages: [],
      resolvedRecipient: resolveSelfRecipient(),
    };
  }

  const script = join(projectRoot, "scripts", "imessage-thread.sh");
  const proc = spawn([script, request.contact, String(request.limit)], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: projectRoot,
    env: { ...process.env },
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
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
    if (timeoutId) clearTimeout(timeoutId);

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
    if (timeoutId) clearTimeout(timeoutId);
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
      "Full Disk Access worked but the contact name did not match a Messages thread. Draft from the user's description without asking clarifying questions.",
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
