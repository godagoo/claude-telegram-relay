// session.ts
// Persistent Claude session id for `--resume`. The shape and on-disk format
// match the inline implementation that already lives in src/relay.ts; this
// module exists so a future PR can gradually swap relay.ts onto it without
// changing runtime semantics. Until that swap lands, this module is dormant
// infrastructure — relay.ts continues to use its inline copies.
//
// Differences from a naive parse-and-trust loader:
//   - Field-level type narrowing on load: a malformed file never returns a
//     partial SessionState; it falls back to a fresh default.
//   - saveSession ensures the parent directory exists at 0700 before writing.
//   - rotateSession deletes the persisted id and returns a fresh in-memory
//     state so future relay integration can assign it without reusing a stale
//     `--resume` id.

import { chmod, mkdir, readFile, unlink, writeFile } from "fs/promises";
import { join } from "path";

export interface SessionState {
  sessionId: string | null;
  createdAt?: string;
  lastActivity: string;
}

function relayDir(): string {
  return process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
}

export function sessionFilePath(): string {
  return join(relayDir(), "session.json");
}

async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

export async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(sessionFilePath(), "utf-8");
    const parsed = JSON.parse(content) as Partial<SessionState>;
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : null;
    const lastActivity =
      typeof parsed.lastActivity === "string"
        ? parsed.lastActivity
        : new Date().toISOString();
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : undefined;
    return createdAt ? { sessionId, createdAt, lastActivity } : { sessionId, lastActivity };
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

export async function saveSession(state: SessionState): Promise<void> {
  await ensurePrivateDir(relayDir());
  const path = sessionFilePath();
  await writeFile(path, JSON.stringify(state, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await chmod(path, 0o600).catch(() => undefined);
}

export async function rotateSession(reason: string): Promise<SessionState> {
  console.log(`[session] rotate: ${reason}`);
  await unlink(sessionFilePath()).catch(() => undefined);
  return { sessionId: null, lastActivity: new Date().toISOString() };
}
