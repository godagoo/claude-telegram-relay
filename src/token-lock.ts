// Host-local, token-keyed singleton lock for the Telegram relay.
//
// The bot token addresses a single Telegram resource: only one long-polling
// consumer can hold getUpdates against it at a time. Previously the relay
// kept a single ~/.claude-relay/bot.lock keyed on the relay directory, which
// could miss a duplicate running with a different RELAY_DIR. This module
// keys the lock on the bot token's sha256 prefix so any second relay using
// the same token sees the same lock file.
//
// The raw token is never written to disk: we store its sha256 hex hash in
// the payload and use the first 16 hex chars in the filename.

import { createHash } from "crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { existsSync, openSync, closeSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const TOKEN_LOCK_SCHEMA_VERSION = 1;
export const TOKEN_LOCK_DEFAULT_HEARTBEAT_MS = 30_000;
export const TOKEN_LOCK_DEFAULT_STALE_AGE_MS = 120_000;

export interface TokenLockPayload {
  schema_version: typeof TOKEN_LOCK_SCHEMA_VERSION;
  token_hash: string;
  host: string;
  pid: number;
  started_at: string;
  heartbeat_at: string;
}

export type AcquireTokenLockResult =
  | { ok: true; path: string; payload: TokenLockPayload }
  | { ok: false; reason: "held_by_live_relay"; holder: TokenLockPayload; path: string }
  | { ok: false; reason: "io_error"; error: string };

function defaultBaseDir(): string {
  return process.env.RELAY_DIR || join(homedir(), ".claude-relay");
}

/**
 * Token locks must live in a host-global directory, independent of
 * RELAY_DIR. Otherwise two relays started with different RELAY_DIR values
 * (e.g. one user, two shell sessions, distinct env) would each see an empty
 * lock root and both acquire — defeating the singleton.
 */
export function defaultLockRoot(): string {
  return process.env.RELAY_LOCK_ROOT || join(homedir(), ".claude-relay", "locks");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenLockPath(token: string, baseDir?: string): string {
  // baseDir is preserved for tests; production callers should not supply it.
  // When baseDir is provided we join it with the legacy "locks" subdir to
  // keep test fixtures stable. Otherwise we use the host-global default,
  // which is now decoupled from RELAY_DIR so two relays with different
  // RELAY_DIR values still collide on the same lock file.
  const prefix = tokenHash(token).slice(0, 16);
  if (baseDir) {
    return join(baseDir, "locks", `token-${prefix}.lock`);
  }
  return join(defaultLockRoot(), `token-${prefix}.lock`);
}

function makePayload(input: {
  token: string;
  host: string;
  pid: number;
  startedAt: Date;
  heartbeatAt: Date;
}): TokenLockPayload {
  return {
    schema_version: TOKEN_LOCK_SCHEMA_VERSION,
    token_hash: tokenHash(input.token),
    host: input.host,
    pid: input.pid,
    started_at: input.startedAt.toISOString(),
    heartbeat_at: input.heartbeatAt.toISOString(),
  };
}

async function writePayloadAtomic(path: string, payload: TokenLockPayload): Promise<void> {
  const dir = join(path, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, path);
}

/**
 * Atomically create the lock file with O_EXCL. Returns true on success,
 * false if EEXIST. Any other error propagates.
 */
function tryAtomicCreate(path: string, payload: TokenLockPayload): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(payload, null, 2) + "\n");
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "EEXIST") return false;
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

async function readPayloadOrNull(path: string): Promise<TokenLockPayload | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as TokenLockPayload;
    if (typeof parsed?.pid !== "number" || typeof parsed?.token_hash !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isLockStaleByAge(
  payload: TokenLockPayload,
  now: Date,
  maxAgeMs: number,
): boolean {
  const heartbeat = Date.parse(payload.heartbeat_at);
  if (!Number.isFinite(heartbeat)) return true;
  return now.getTime() - heartbeat > maxAgeMs;
}

export async function acquireTokenLock(input: {
  token: string;
  host: string;
  pid: number;
  now: Date;
  baseDir?: string;
  isLiveRelay: (pid: number) => boolean | Promise<boolean>;
  maxHeartbeatAgeMs?: number;
}): Promise<AcquireTokenLockResult> {
  const path = tokenLockPath(input.token, input.baseDir);
  const maxAgeMs = input.maxHeartbeatAgeMs ?? TOKEN_LOCK_DEFAULT_STALE_AGE_MS;

  const payload = makePayload({
    token: input.token,
    host: input.host,
    pid: input.pid,
    startedAt: input.now,
    heartbeatAt: input.now,
  });

  // Ensure the lock directory exists before any atomic create attempt.
  try {
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ok: false, reason: "io_error", error: err instanceof Error ? err.message : String(err) };
  }

  // First attempt: atomic exclusive create. Only one process can succeed.
  try {
    if (tryAtomicCreate(path, payload)) {
      await chmod(path, 0o600).catch(() => undefined);
      return { ok: true, path, payload };
    }
  } catch (err) {
    return { ok: false, reason: "io_error", error: err instanceof Error ? err.message : String(err) };
  }

  // Atomic create lost: the lock exists. Decide whether to take it over.
  const existing = await readPayloadOrNull(path);
  if (existing && existing.pid !== input.pid) {
    const live = await Promise.resolve(input.isLiveRelay(existing.pid));
    const fresh = !isLockStaleByAge(existing, input.now, maxAgeMs);
    if (live && fresh) {
      return { ok: false, reason: "held_by_live_relay", holder: existing, path };
    }
  }

  // Stale or unreadable: take over by removing and recreating atomically.
  // If we lose the race a second time, surface that as held_by_live_relay so
  // the caller exits cleanly and launchd retries.
  try {
    await unlink(path).catch(() => undefined);
    if (!tryAtomicCreate(path, payload)) {
      const holder = (await readPayloadOrNull(path)) ?? {
        schema_version: TOKEN_LOCK_SCHEMA_VERSION,
        token_hash: tokenHash(input.token),
        host: input.host,
        pid: -1,
        started_at: input.now.toISOString(),
        heartbeat_at: input.now.toISOString(),
      } satisfies TokenLockPayload;
      return { ok: false, reason: "held_by_live_relay", holder, path };
    }
    await chmod(path, 0o600).catch(() => undefined);
    return { ok: true, path, payload };
  } catch (err) {
    return { ok: false, reason: "io_error", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function releaseTokenLock(input: {
  token: string;
  pid: number;
  baseDir?: string;
  host?: string;
}): Promise<void> {
  const path = tokenLockPath(input.token, input.baseDir);
  const existing = await readPayloadOrNull(path);
  if (!existing) return;
  // Defensive ownership check: only unlink when the file's token_hash, pid,
  // and (when provided) host match the caller. A surprised relay should
  // never delete a sibling's lock just because the path collides.
  if (existing.pid !== input.pid) return;
  if (existing.token_hash !== tokenHash(input.token)) return;
  if (input.host !== undefined && existing.host !== input.host) return;
  await unlink(path).catch(() => undefined);
}

export async function heartbeatTokenLock(input: {
  token: string;
  pid: number;
  now: Date;
  baseDir?: string;
}): Promise<void> {
  const path = tokenLockPath(input.token, input.baseDir);
  const existing = await readPayloadOrNull(path);
  if (!existing || existing.pid !== input.pid) return;
  const next: TokenLockPayload = { ...existing, heartbeat_at: input.now.toISOString() };
  await writePayloadAtomic(path, next);
}

/**
 * Starts a setInterval that periodically rewrites heartbeat_at on the lock
 * file. Returns a stop function that clears the interval. Calling stop()
 * more than once is safe. `now` is injectable for tests.
 */
export function startTokenLockHeartbeat(input: {
  token: string;
  pid: number;
  baseDir?: string;
  intervalMs?: number;
  now?: () => Date;
}): () => void {
  const intervalMs = input.intervalMs ?? TOKEN_LOCK_DEFAULT_HEARTBEAT_MS;
  const nowFn = input.now ?? (() => new Date());
  let stopped = false;
  const handle = setInterval(() => {
    if (stopped) return;
    heartbeatTokenLock({
      token: input.token,
      pid: input.pid,
      baseDir: input.baseDir,
      now: nowFn(),
    }).catch(() => undefined);
  }, intervalMs);
  // Don't keep the event loop alive for the heartbeat alone — let normal
  // shutdown paths drive the process exit.
  if (typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
  };
}

export async function readTokenLock(input: {
  token: string;
  baseDir?: string;
}): Promise<TokenLockPayload | null> {
  return readPayloadOrNull(tokenLockPath(input.token, input.baseDir));
}

/**
 * Returns true if the given PID looks like a live relay process on this host.
 * Combines two signals: kill(pid, 0) (the process exists at all), plus a
 * coarse `ps`-based check that its command line includes "relay.ts". Kept
 * separate from the lock module so tests can inject a deterministic stub.
 */
export async function isLiveRelayPid(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const proc = Bun.spawn(["ps", "-o", "command=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return /relay\.ts/.test(output);
  } catch {
    return true;
  }
}
