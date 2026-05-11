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
  error?: string;
}

function isIMessageDraftRequest(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /\b(imessage|text messages?|texts?|sms)\b/.test(m) &&
    /\b(draft|write|compose)\b/.test(m) &&
    /\b(last|recent|previous|prior|context|go through|look through|read)\b/.test(m)
  );
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

export function extractIMessageContextRequest(
  message: string,
): IMessageContextRequest | null {
  if (!isIMessageDraftRequest(message)) return null;

  const explicit = message.match(
    /\b(?:with|to)\s+([+()\-\d\s]{7,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/i,
  );
  if (!explicit) return null;

  const contact = cleanContact(explicit[1]);
  if (!contact) return null;

  return {
    contact,
    limit: parseLimit(message),
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

    const parsed = JSON.parse(stdout || "[]");
    const messages = Array.isArray(parsed) ? parsed as IMessageRow[] : [];
    return {
      request,
      status: messages.length > 0 ? "found" : "empty",
      messages,
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
