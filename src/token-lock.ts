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

import { createHash, randomUUID } from "crypto";
import { chmod, mkdir, readFile, rename, unlink } from "fs/promises";
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

/**
 * Build a placeholder holder payload for held_by_live_relay results when the
 * real holder is unknown — either because the lockfile was unparseable on
 * read, or because a third process replaced an unparseable file between
 * our claim attempts. The pid is -1 so callers can detect "synthetic".
 *
 * The acquire result API requires a non-null `holder` on every
 * `held_by_live_relay` branch; never replace this with a `null` cast.
 */
function makeSyntheticHolder(input: {
  token: string;
  host: string;
  now: Date;
}): TokenLockPayload {
  return {
    schema_version: TOKEN_LOCK_SCHEMA_VERSION,
    token_hash: tokenHash(input.token),
    host: input.host,
    pid: -1,
    started_at: input.now.toISOString(),
    heartbeat_at: input.now.toISOString(),
  };
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

/**
 * No-overwrite restore: if a previous claim grabbed the lockfile, put it
 * back at `path` only if `path` is empty. If a third process has since
 * created a fresh lock at `path`, leave that new lock alone — restoring
 * via blind `rename(claim, path)` would destroy it.
 *
 * Always consumes the claim file: either the restore succeeded, or we
 * keep the third process's fresh lock and discard our claim.
 * Returns true when the original was restored; false otherwise.
 */
async function tryRestoreClaim(
  path: string,
  claimPath: string,
  claimed: TokenLockPayload | null,
): Promise<boolean> {
  let restored = false;
  if (claimed) restored = tryAtomicCreate(path, claimed);
  await unlink(claimPath).catch(() => undefined);
  return restored;
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
  /**
   * Test-only hooks. Production code MUST NOT pass these. They let
   * concurrency tests force a third process to interleave at known
   * points without injecting threads.
   */
  _testHooks?: {
    beforeClaim?: () => Promise<void> | void;
    afterClaim?: () => Promise<void> | void;
  };
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

  // Stale takeover via atomic claim. The previous flow did
  // unlink → tryAtomicCreate, which let two concurrent stale takeovers
  // succeed: process B could unlink process A's freshly-created lock and
  // then create its own. (PLAN4 reproduced 13 double-successes in 500
  // attempts.) Replace with rename-to-unique-claim-path:
  //
  //   1. rename(path, claimPath) is POSIX-atomic. Only one process can
  //      rename the same source file successfully; everyone else gets
  //      ENOENT and bails out as held_by_live_relay.
  //   2. Read the claim file and verify its content matches the stale
  //      payload we observed. A mismatch means a third process replaced
  //      the lock between our observation and our rename; restore it.
  //   3. Create the new lock at the original path with O_EXCL. If a
  //      third process slipped in and created a new lock there, we bail
  //      out as held_by_live_relay (without touching the new lock).
  const claimPath = `${path}.claim-${input.pid}-${randomUUID()}`;

  if (input._testHooks?.beforeClaim) await input._testHooks.beforeClaim();

  try {
    await rename(path, claimPath);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      const holder = existing ?? makeSyntheticHolder(input);
      return { ok: false, reason: "held_by_live_relay", holder, path };
    }
    return { ok: false, reason: "io_error", error: err instanceof Error ? err.message : String(err) };
  }

  if (input._testHooks?.afterClaim) await input._testHooks.afterClaim();

  const claimed = await readPayloadOrNull(claimPath);
  // If the lock was unparseable on initial read (existing === null), we
  // don't have a baseline to verify against; just take over. Otherwise the
  // claimed payload must match what we observed; a mismatch means a third
  // process replaced the lock between read and rename — restore and bail.
  const needsContentVerify = existing !== null;
  if (needsContentVerify) {
    const observedMatches =
      !!claimed &&
      claimed.pid === existing.pid &&
      claimed.token_hash === existing.token_hash &&
      claimed.heartbeat_at === existing.heartbeat_at;
    if (!observedMatches) {
      // PLAN6: never overwrite a third process's new lock during restore.
      // tryRestoreClaim uses O_EXCL — if path is now occupied, the new
      // holder stays and our claim is discarded.
      await tryRestoreClaim(path, claimPath, claimed);
      const holder = (await readPayloadOrNull(path)) ?? claimed ?? existing;
      return { ok: false, reason: "held_by_live_relay", holder, path };
    }
  }

  try {
    if (!tryAtomicCreate(path, payload)) {
      // A third process created a new lock at path between our rename and
      // our create. Their lock is valid; do not disturb it. When their
      // payload is unparseable (or our original `existing` was null because
      // the file was garbage), fall back to a synthetic holder rather than
      // smuggling a null through the API.
      await unlink(claimPath).catch(() => undefined);
      const holder =
        (await readPayloadOrNull(path)) ?? existing ?? makeSyntheticHolder(input);
      return { ok: false, reason: "held_by_live_relay", holder, path };
    }
    await chmod(path, 0o600).catch(() => undefined);
    await unlink(claimPath).catch(() => undefined);
    return { ok: true, path, payload };
  } catch (err) {
    await unlink(claimPath).catch(() => undefined);
    return { ok: false, reason: "io_error", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function releaseTokenLock(input: {
  token: string;
  pid: number;
  baseDir?: string;
  host?: string;
  /** ISO started_at from acquire's payload; defends against PID reuse. */
  startedAt?: string;
  /**
   * Test-only hook. Fires after the atomic rename(path, claim) but before
   * the ownership verification — lets a regression test interpose a fresh
   * holder write at path to verify the release does not delete the new
   * holder.
   */
  _testHookAfterClaim?: () => Promise<void> | void;
}): Promise<void> {
  // PLAN6: release must be atomic, not read-then-unlink. The previous flow
  // had a TOCTOU window: A's release reads existing=A's payload, gets
  // pre-empted, B takes over and writes a new lock at path, A's unlink
  // then deletes B's lock. Switch to the same atomic-claim pattern used
  // by acquire/heartbeat:
  //   1. rename(path, releaseClaimPath) — POSIX-atomic; ENOENT bails.
  //   2. Verify the claim's pid + token_hash + host + (optional) started_at
  //      match the caller. If not, restore via no-overwrite tryAtomicCreate.
  //   3. Unlink the claim — which IS our original lock, now off path.
  const path = tokenLockPath(input.token, input.baseDir);
  const claimPath = `${path}.release-${input.pid}-${randomUUID()}`;
  try {
    await rename(path, claimPath);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return;
    return;
  }

  if (input._testHookAfterClaim) await input._testHookAfterClaim();

  const claimed = await readPayloadOrNull(claimPath);
  const stillOurs =
    !!claimed &&
    claimed.pid === input.pid &&
    claimed.token_hash === tokenHash(input.token) &&
    (input.host === undefined || claimed.host === input.host) &&
    (input.startedAt === undefined || claimed.started_at === input.startedAt);

  if (!stillOurs) {
    // Not our lock anymore. No-overwrite restore so a fresh holder that
    // raced ahead at path stays in place, and our claim is discarded.
    await tryRestoreClaim(path, claimPath, claimed);
    return;
  }

  // Confirmed ours. Unlinking the claim removes our original lock.
  await unlink(claimPath).catch(() => undefined);
}

export async function heartbeatTokenLock(input: {
  token: string;
  pid: number;
  now: Date;
  baseDir?: string;
  host?: string;
  /**
   * Test-only hook. Fires after the read but before the atomic claim;
   * lets a regression test interpose a stale-takeover write to verify
   * the heartbeat does not clobber the new holder.
   */
  _testHookAfterRead?: () => Promise<void> | void;
}): Promise<void> {
  const path = tokenLockPath(input.token, input.baseDir);
  const existing = await readPayloadOrNull(path);
  if (!existing || existing.pid !== input.pid) return;
  if (existing.token_hash !== tokenHash(input.token)) return;
  if (input.host !== undefined && existing.host !== input.host) return;

  if (input._testHookAfterRead) await input._testHookAfterRead();

  // Atomic claim. The previous implementation did
  // readPayloadOrNull → writePayloadAtomic (write tmp, rename tmp → path),
  // which blindly clobbered whatever was at path at rename time. If a
  // takeover wrote a new lock between our read and our rename, the
  // heartbeat's rename overwrote the new holder with our stale payload.
  // PLAN5: replace with rename-to-claim, content-verify, exclusive-create.
  const claimPath = `${path}.heartbeat-${input.pid}-${randomUUID()}`;
  try {
    await rename(path, claimPath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    // ENOENT: lock no longer exists; the relay was already released or
    // taken over. Abandon the heartbeat silently — this is expected.
    if (code === "ENOENT") return;
    // Anything else (EACCES, EIO, EROFS) is unexpected and is a precursor
    // to the stale-by-age threshold letting a peer take over the token.
    // Make it visible so the operator can act before the takeover lands.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[token-lock] heartbeat rename failed: code=${code ?? "?"} ${message}`);
    return;
  }

  const claimed = await readPayloadOrNull(claimPath);
  const stillOurs =
    !!claimed &&
    claimed.pid === input.pid &&
    claimed.token_hash === tokenHash(input.token) &&
    claimed.started_at === existing.started_at;
  if (!stillOurs) {
    // The file at path changed between our read and our claim. PLAN6:
    // restore must be no-overwrite — if a third process already wrote a
    // fresh lock at path, do not disturb it.
    await tryRestoreClaim(path, claimPath, claimed);
    return;
  }

  const next: TokenLockPayload = { ...claimed, heartbeat_at: input.now.toISOString() };
  if (!tryAtomicCreate(path, next)) {
    // A third process created a new lock at path. Their lock is valid;
    // do not disturb it.
    await unlink(claimPath).catch(() => undefined);
    return;
  }
  await chmod(path, 0o600).catch(() => undefined);
  await unlink(claimPath).catch(() => undefined);
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
  /**
   * Optional host string; when supplied, the heartbeat refuses to update
   * a lock whose payload host doesn't match. Mirrors releaseTokenLock's
   * defense-in-depth check.
   */
  host?: string;
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
      host: input.host,
      now: nowFn(),
    }).catch((err) => {
      // heartbeatTokenLock handles ENOENT internally; anything that
      // escapes this catch arm is a programming bug or an unexpected
      // filesystem error (ENOSPC, EROFS, JSON parse). Log so the
      // operator sees it before stale-by-age lets a peer take over.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[token-lock] heartbeat tick failed: ${message}`);
    });
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
