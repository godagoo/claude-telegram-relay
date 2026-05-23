// short-term.ts
// Per-chat ring buffer of the last N turns, persisted as JSON.

import { chmod, mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";

import type { Turn } from "./query-builder";

const RELAY_DIR = process.env.RELAY_DIR ?? join(homedir(), ".claude-relay");
const STATE_ROOT = process.env.RELAY_STATE_DIR ?? join(RELAY_DIR, "state");
const STATE_DIR = STATE_ROOT.endsWith("/chats") ? STATE_ROOT : join(STATE_ROOT, "chats");
const MAX_TURNS = 10;

function pathFor(chatId: number | string): string {
  return join(STATE_DIR, `${chatId}.json`);
}

export async function loadTurns(chatId: number | string): Promise<Turn[]> {
  try {
    const text = await readFile(pathFor(chatId), "utf8");
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function appendTurn(
  chatId: number | string,
  turn: Turn,
): Promise<Turn[]> {
  const file = pathFor(chatId);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700).catch(() => undefined);
  const turns = await loadTurns(chatId);
  turns.push(turn);
  const trimmed = turns.slice(-MAX_TURNS);
  await writeFile(file, JSON.stringify(trimmed, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(file, 0o600).catch(() => undefined);
  return trimmed;
}

export function renderRecentTurns(turns: Turn[]): string {
  if (turns.length === 0) return "";
  const inner = turns
    .map((t) => `  <turn role="${t.role}" ts="${t.ts}">${escapeXml(t.content)}</turn>`)
    .join("\n");
  return `<recent_turns>\n${inner}\n</recent_turns>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
