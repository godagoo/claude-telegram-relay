// Intent classifier — LLM safety net for the regex extractor.
//
// extractIMessageDraftRequest() in imessage-context.ts is a regex chain that
// has been patched 8+ times for new natural-language phrasings. Every patch
// is correct AND fragile — the next phrasing William invents misses again.
// Root cause: regex for unbounded NLP is the wrong tool.
//
// This module is the safety net. It calls Haiku to classify a message that
// the regex missed. Cheap (~$0.0005/call), fast (~700ms), and trivially
// extensible — any new phrasing the model understands just works, no PR.
//
// USAGE:
//   const regexResult = extractIMessageDraftRequest(text);
//   if (regexResult) return regexResult;             // fast-path hit
//   if (!looksLikeDraftIntent(text)) return null;    // not even close
//   return await classifyIntentLLM(text);            // ambiguous — ask Haiku
//
// The cheap heuristic looksLikeDraftIntent() prevents the LLM from firing
// on obvious chat ("How are you?"), so latency cost is amortized only over
// genuinely ambiguous messages.

import { spawn } from "bun";
import { homedir } from "os";
import { join } from "path";

import type { IMessageDraftRequest } from "./imessage-context.ts";
import { sanitizeSpawnArgs } from "./sanitize-spawn-arg.ts";

const DEFAULT_CLAUDE_PATH = join(homedir(), ".local", "bin", "claude");
const CLAUDE_PATH = process.env.CLAUDE_PATH || DEFAULT_CLAUDE_PATH;
const CLASSIFIER_MODEL =
  process.env.RELAY_INTENT_CLASSIFIER_MODEL || "claude-haiku-4-5-20251001";
// CLI cold-start (hooks, MCP, plugin sync, keychain) can take 5-10s before
// the first API token streams; the API round-trip itself is ~500ms. Budget
// 30s so a slow boot doesn't lose drafts; the heuristic gate keeps these
// calls rare enough that the worst-case latency is bounded.
const CLASSIFIER_TIMEOUT_MS = Number.parseInt(
  process.env.RELAY_INTENT_CLASSIFIER_TIMEOUT_MS || "30000",
  10,
);

const DRAFT_VERB_HEURISTIC =
  /\b(draft|write|compose|send|shoot|text|message|respond|reply|ping|tell|let\s+\w+\s+know)\b/i;
const TELL_ME_REQUEST_RE =
  /^\s*(?:(?:please|pls|can you|could you|would you)\s+)?tell\s+me\b/i;
// True interrogatives only. Polite-request modals (could/would/can/will)
// are deliberately EXCLUDED because they introduce requests ("Could you
// text mom?", "Can you let her know?"), not questions about state. Same
// for "should" — borderline, but more often part of a draft request than
// a state query in practice.
const META_QUESTION_LEAD_RE =
  /^\s*(why|is|are|was|were|did|does|do|have|has|had|where|when|how|what)\b/i;

/**
 * Cheap heuristic — true when the message PLAUSIBLY wants a draft. Designed
 * to be permissive: false-positives only cost an LLM call; false-negatives
 * silently lose drafts (the bug we're trying to kill). Tighten only if LLM
 * cost becomes material.
 */
export function looksLikeDraftIntent(message: string): boolean {
  // "Tell me ..." is a normal assistant request, not a request to text a
  // third party. Keep "tell mom/dad/Jim ..." covered by DRAFT_VERB_HEURISTIC.
  if (TELL_ME_REQUEST_RE.test(message)) return false;
  // No verb that could mean "send a message" → almost certainly chat.
  if (!DRAFT_VERB_HEURISTIC.test(message)) return false;
  // Meta-questions about prior drafts should NOT trigger fallback. The
  // regex's META_PLACEMENT_FAILURE_RE already catches the common ones;
  // this is a coarse "starts with a question word" check so we don't pay
  // an LLM call to be told "no" on every "why didn't you..." or "is the
  // draft done?".
  if (META_QUESTION_LEAD_RE.test(message)) return false;
  return true;
}

interface ClassifierJson {
  is_draft: boolean;
  recipient: string | null;
  body_intent: string | null;
  wants_context: boolean;
  wants_placement: boolean;
}

export type IMessageIntentClassification =
  | { kind: "draft"; request: IMessageDraftRequest }
  | { kind: "not_draft" }
  | { kind: "unresolved"; reason: "classifier_failed" | "missing_recipient" };

const SYSTEM_PROMPT = `You are an intent classifier for William's personal Telegram→iMessage assistant. Decide whether the incoming Telegram message is a request to compose a TEXT MESSAGE to someone. Return ONLY a single JSON object on one line, no prose, no markdown.

Schema:
{"is_draft": bool, "recipient": string|null, "body_intent": string|null, "wants_context": bool, "wants_placement": bool}

Rules:
- is_draft=true when William wants the bot to compose a text/iMessage to a named recipient. Examples that ARE drafts:
  * "Text Mom saying I'll be late"
  * "Please text the following to madison: your memory was correct that ..."
  * "Reply to my dad's last message"
  * "Draft a response to Jacqueline asking what she's up to"
  * "Shoot nater a quick text asking if he wants to fire this weekend"
- is_draft=false for:
  * Meta-questions about prior drafts ("why didn't the draft show up?", "is the draft done?", "where is the draft in the chatbox?")
  * Statements/observations ("I should probably text mom later")
  * General questions or chat ("how are you?", "what time is it?")
  * Requests without a recipient ("just following up", "any updates?")
- recipient: the literal name/phone/email the user said, lowercase preserved. null if not present or is_draft=false.
- body_intent: the user's stated content for the message, if any. null when the user wants the bot to read recent context and craft something (e.g. "respond to mom").
- wants_context: true when drafting requires reading the existing thread (e.g. "respond to", "follow up on", "reply to my dad's last"). false when an explicit body is supplied.
- wants_placement: default true. false ONLY if user explicitly opts out ("just give me the text", "telegram only", "no placement").

Return EXACTLY the JSON object on one line. No backticks. No prose before or after.`;

async function runClassifier(message: string): Promise<ClassifierJson | null> {
  // Mirror the relay's existing buildClaudeCliArgs invocation so we inherit
  // the same auth chain (OAuth via `claude login`) without depending on
  // ANTHROPIC_API_KEY. The only deltas vs the main call: a different model
  // (Haiku for speed/cost) and an empty tool list (classifier needs none).
  try {
    const proc = spawn(
      sanitizeSpawnArgs([
        CLAUDE_PATH,
        "-p",
        message,
        "--append-system-prompt",
        SYSTEM_PROMPT,
        "--no-session-persistence",
        "--tools",
        "",
        "--model",
        CLASSIFIER_MODEL,
        "--output-format",
        "json",
      ]),
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: CLASSIFIER_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      console.error(
        `[intent] classifier exit=${code} stderr=${stderr.trim().slice(0, 200)}`,
      );
      return null;
    }
    // CLI wraps the model response in {"result": "..."} when --output-format=json.
    // Extract .result (or .content / .message — see relay.parseClaudeCliOutput
    // for the same fallback chain), then parse the inner classifier JSON.
    return parseClassifierJson(extractCliPayload(stdout));
  } catch (err) {
    console.error(
      `[intent] classifier failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function extractCliPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    const wrapper = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["result", "content", "message"]) {
      const value = wrapper[key];
      if (typeof value === "string") return value;
    }
  } catch {
    // Not JSON-wrapped — return raw and let parseClassifierJson handle it.
  }
  return trimmed;
}

/**
 * Extract the JSON object from the classifier's stdout. Haiku occasionally
 * wraps responses in markdown fences or adds a single sentence of preamble
 * despite the prompt; this scans for the first balanced `{...}` block.
 */
export function parseClassifierJson(stdout: string): ClassifierJson | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // Try strict parse first — the prompt asks for exactly one line of JSON.
  try {
    return validateShape(JSON.parse(trimmed));
  } catch {
    // Fall through to embedded-JSON extraction.
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return validateShape(JSON.parse(trimmed.slice(start, end + 1)));
  } catch {
    return null;
  }
}

function validateShape(value: unknown): ClassifierJson | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.is_draft !== "boolean") return null;
  const recipient =
    typeof v.recipient === "string" && v.recipient.trim().length > 0
      ? v.recipient.trim()
      : null;
  const body_intent =
    typeof v.body_intent === "string" && v.body_intent.trim().length > 0
      ? v.body_intent.trim()
      : null;
  return {
    is_draft: v.is_draft,
    recipient,
    body_intent,
    wants_context: v.wants_context === true,
    wants_placement: v.wants_placement !== false, // default true on missing/null
  };
}

/**
 * LLM-backed intent classifier. Returns a fully-populated IMessageDraftRequest
 * compatible with the regex extractor's output, or null when the LLM says
 * "not a draft" or when classification fails. New runtime code should prefer
 * classifyIMessageDraftIntent() so it can distinguish "not draft" from
 * "classifier unavailable".
 */
export async function classifyIntentLLM(
  message: string,
): Promise<IMessageDraftRequest | null> {
  const classification = await classifyIMessageDraftIntent(message);
  return classification.kind === "draft" ? classification.request : null;
}

export async function classifyIMessageDraftIntent(
  message: string,
): Promise<IMessageIntentClassification> {
  const result = await runClassifier(message);
  if (!result) return { kind: "unresolved", reason: "classifier_failed" };
  if (!result.is_draft) return { kind: "not_draft" };
  if (!result.recipient) return { kind: "unresolved", reason: "missing_recipient" };
  return {
    kind: "draft",
    request: {
      contact: result.recipient,
      wantsContext: result.wants_context,
      contextLimit: 10,
      wantsPlacement: result.wants_placement,
      ...(result.body_intent ? { directBody: result.body_intent } : {}),
    },
  };
}
