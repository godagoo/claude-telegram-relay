// draft-router.ts
// Single outbound chokepoint for the relay. Enforces:
//   (1) em-dash gate — never send a response containing — or –
//   (2) Telegram 4096-char split (paragraph → sentence → hard split)
//   (3) 60-second "still thinking" feedback hook
//   (4) iMessage recipient allowlist gate (fail-closed on missing/malformed file)
//
// Email / iMessage / WhatsApp routing helpers live in their own modules
// (PR #3). This router exposes gates that those helpers call before any
// IO; the chokepoint guarantees a single em-dash policy and a single
// recipient-trust source.

import { readFile, stat } from "fs/promises";
import { join } from "path";

const TELEGRAM_SOFT_LIMIT = 4000; // margin under 4096 for HTML entities
const STILL_THINKING_MS = 60_000;

// ---------- em-dash gate ----------

export function containsEmDash(text: string): boolean {
  return /[—–]/.test(text);
}

export interface Gate { ok: true }
export interface GateFailure { ok: false; reason: string }

export function gateForEmDash(text: string): Gate | GateFailure {
  if (containsEmDash(text)) return { ok: false, reason: "em_dash_in_outbound" };
  return { ok: true };
}

// ---------- iMessage allowlist gate ----------

function allowlistPath(): string {
  return process.env.IMESSAGE_ALLOWLIST_PATH
    || join(process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay"), "imessage-allowlist.json");
}

// In-memory cache keyed by path+mtime so we re-read on file changes without
// hammering disk on every call. Tests reset via resetAllowlistCache().
let cache: { path: string; mtimeMs: number; entries: Set<string> } | null = null;

export function resetAllowlistCache(): void {
  cache = null;
}

async function loadAllowlist(): Promise<Set<string> | null> {
  const path = allowlistPath();
  try {
    const s = await stat(path);
    if (cache && cache.path === path && cache.mtimeMs === s.mtimeMs) {
      return cache.entries;
    }
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const entries = new Set<string>();
    for (const e of parsed) {
      if (typeof e === "string") entries.add(e);
    }
    cache = { path, mtimeMs: s.mtimeMs, entries };
    return entries;
  } catch {
    return null;
  }
}

export async function gateForIMessageRecipient(
  recipient: string,
): Promise<Gate | GateFailure> {
  const allow = await loadAllowlist();
  if (!allow) {
    console.error(
      `[draft-router] iMessage allowlist missing or invalid at ${allowlistPath()}; refusing recipient`,
    );
    return { ok: false, reason: "recipient_not_allowlisted" };
  }
  if (!allow.has(recipient)) {
    return { ok: false, reason: "recipient_not_allowlisted" };
  }
  return { ok: true };
}

// ---------- Telegram split ----------

export function splitForTelegram(text: string, limit = TELEGRAM_SOFT_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let buf = "";
  for (const para of paragraphs) {
    if (para.length > limit) {
      if (buf) { chunks.push(buf); buf = ""; }
      const sentences = para.split(/(?<=[.!?])\s+/);
      let sentBuf = "";
      for (const s of sentences) {
        if (s.length > limit) {
          if (sentBuf) { chunks.push(sentBuf); sentBuf = ""; }
          for (let i = 0; i < s.length; i += limit) {
            chunks.push(s.slice(i, i + limit));
          }
        } else if ((sentBuf + " " + s).trim().length > limit) {
          chunks.push(sentBuf.trim());
          sentBuf = s;
        } else {
          sentBuf = sentBuf ? `${sentBuf} ${s}` : s;
        }
      }
      if (sentBuf) chunks.push(sentBuf.trim());
    } else if ((buf + "\n\n" + para).trim().length > limit) {
      chunks.push(buf.trim());
      buf = para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

// ---------- 60-second "still thinking" ----------

export function scheduleStillThinking(send: () => void, ms = STILL_THINKING_MS): () => void {
  const t = setTimeout(send, ms);
  return () => clearTimeout(t);
}
