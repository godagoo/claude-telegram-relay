import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  acquireTokenLock,
  heartbeatTokenLock,
  isLockStaleByAge,
  readTokenLock,
  releaseTokenLock,
  startTokenLockHeartbeat,
  TOKEN_LOCK_DEFAULT_HEARTBEAT_MS,
  TOKEN_LOCK_DEFAULT_STALE_AGE_MS,
  tokenHash,
  tokenLockPath,
  type TokenLockPayload,
} from "./token-lock.ts";

const FAKE_TOKEN = "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FAKE_HOST = "test-host";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "relay-token-lock-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("tokenHash", () => {
  test("returns 64-char lowercase hex sha256 of the token", () => {
    const hash = tokenHash(FAKE_TOKEN);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("is stable for the same input", () => {
    expect(tokenHash(FAKE_TOKEN)).toBe(tokenHash(FAKE_TOKEN));
  });

  test("does not contain the original token text", () => {
    const hash = tokenHash(FAKE_TOKEN);
    expect(hash).not.toContain(FAKE_TOKEN);
    expect(hash).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });
});

describe("tokenLockPath", () => {
  test("locks live under <baseDir>/locks/token-<sha256-prefix>.lock", () => {
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    expect(path).toBe(join(tempDir, "locks", `token-${tokenHash(FAKE_TOKEN).slice(0, 16)}.lock`));
  });

  test("uses 16-char hex prefix from the token sha256", () => {
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    expect(path).toMatch(/locks\/token-[a-f0-9]{16}\.lock$/);
  });

  test("never embeds the raw token in the path", () => {
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    expect(path).not.toContain(FAKE_TOKEN);
    expect(path).not.toContain("AAAAAA");
  });
});

describe("acquireTokenLock", () => {
  test("acquires when no lock exists", async () => {
    const result = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 12345,
      now: new Date("2026-05-18T10:00:00Z"),
      baseDir: tempDir,
      isLiveRelay: () => false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(existsSync(result.path)).toBe(true);
    }
  });

  test("writes payload with token_hash, host, pid, started_at, heartbeat_at", async () => {
    const result = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 12345,
      now: new Date("2026-05-18T10:00:00Z"),
      baseDir: tempDir,
      isLiveRelay: () => false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.parse(readFileSync(result.path, "utf8")) as TokenLockPayload;
    expect(payload.schema_version).toBe(1);
    expect(payload.token_hash).toBe(tokenHash(FAKE_TOKEN));
    expect(payload.host).toBe(FAKE_HOST);
    expect(payload.pid).toBe(12345);
    expect(payload.started_at).toBe("2026-05-18T10:00:00.000Z");
    expect(payload.heartbeat_at).toBe("2026-05-18T10:00:00.000Z");
  });

  test("never writes the raw token in the payload", async () => {
    const result = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 12345,
      now: new Date("2026-05-18T10:00:00Z"),
      baseDir: tempDir,
      isLiveRelay: () => false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = readFileSync(result.path, "utf8");
    expect(raw).not.toContain(FAKE_TOKEN);
    expect(raw).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  test("refuses to acquire when the existing holder PID is a live relay with a fresh heartbeat", async () => {
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    mkdirSync(join(tempDir, "locks"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        token_hash: tokenHash(FAKE_TOKEN),
        host: FAKE_HOST,
        pid: 99999,
        started_at: "2026-05-18T09:00:00.000Z",
        heartbeat_at: "2026-05-18T09:59:55.000Z",
      } satisfies TokenLockPayload),
    );

    const result = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 11111,
      now: new Date("2026-05-18T10:00:00Z"),
      baseDir: tempDir,
      isLiveRelay: (pid) => pid === 99999,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("held_by_live_relay");
    if (result.reason !== "held_by_live_relay") return;
    expect(result.holder.pid).toBe(99999);
  });

  test("takes over a stale lock whose PID is not a live relay", async () => {
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    mkdirSync(join(tempDir, "locks"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        token_hash: tokenHash(FAKE_TOKEN),
        host: FAKE_HOST,
        pid: 99999,
        started_at: "2026-05-18T09:00:00.000Z",
        heartbeat_at: "2026-05-18T09:00:00.000Z",
      } satisfies TokenLockPayload),
    );

    const result = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 11111,
      now: new Date("2026-05-18T10:00:00Z"),
      baseDir: tempDir,
      isLiveRelay: () => false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.parse(readFileSync(result.path, "utf8")) as TokenLockPayload;
    expect(payload.pid).toBe(11111);
  });

  test("treats invalid JSON in the lockfile as stale (overwrites)", async () => {
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    mkdirSync(join(tempDir, "locks"), { recursive: true });
    writeFileSync(path, "not json at all");

    const result = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 11111,
      now: new Date("2026-05-18T10:00:00Z"),
      baseDir: tempDir,
      isLiveRelay: () => true,
    });
    expect(result.ok).toBe(true);
  });

  test("creates the locks/ subdirectory if it does not exist", async () => {
    const result = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 12345,
      now: new Date(),
      baseDir: tempDir,
      isLiveRelay: () => false,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(tempDir, "locks"))).toBe(true);
  });
});

describe("releaseTokenLock", () => {
  test("removes the lock when its pid matches", async () => {
    const acquired = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 12345,
      now: new Date(),
      baseDir: tempDir,
      isLiveRelay: () => false,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    await releaseTokenLock({ token: FAKE_TOKEN, pid: 12345, baseDir: tempDir });
    expect(existsSync(acquired.path)).toBe(false);
  });

  test("does not remove the lock when a different pid holds it", async () => {
    const acquired = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 12345,
      now: new Date(),
      baseDir: tempDir,
      isLiveRelay: () => false,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    await releaseTokenLock({ token: FAKE_TOKEN, pid: 99999, baseDir: tempDir });
    expect(existsSync(acquired.path)).toBe(true);
  });

  test("is a no-op if the lock file is missing", async () => {
    await expect(
      releaseTokenLock({ token: FAKE_TOKEN, pid: 12345, baseDir: tempDir }),
    ).resolves.toBeUndefined();
  });
});

describe("heartbeatTokenLock", () => {
  test("updates heartbeat_at when the lock pid matches", async () => {
    const t0 = new Date("2026-05-18T10:00:00Z");
    const t1 = new Date("2026-05-18T10:00:30Z");
    const acquired = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 12345,
      now: t0,
      baseDir: tempDir,
      isLiveRelay: () => false,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    await heartbeatTokenLock({ token: FAKE_TOKEN, pid: 12345, now: t1, baseDir: tempDir });
    const payload = JSON.parse(readFileSync(acquired.path, "utf8")) as TokenLockPayload;
    expect(payload.started_at).toBe(t0.toISOString());
    expect(payload.heartbeat_at).toBe(t1.toISOString());
  });

  test("is a no-op when the lock pid does not match", async () => {
    const t0 = new Date("2026-05-18T10:00:00Z");
    const acquired = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 12345,
      now: t0,
      baseDir: tempDir,
      isLiveRelay: () => false,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    await heartbeatTokenLock({
      token: FAKE_TOKEN,
      pid: 99999,
      now: new Date("2026-05-18T10:00:30Z"),
      baseDir: tempDir,
    });
    const payload = JSON.parse(readFileSync(acquired.path, "utf8")) as TokenLockPayload;
    expect(payload.heartbeat_at).toBe(t0.toISOString());
  });
});

describe("readTokenLock", () => {
  test("returns null when no lock file exists", async () => {
    const payload = await readTokenLock({ token: FAKE_TOKEN, baseDir: tempDir });
    expect(payload).toBeNull();
  });

  test("returns the parsed payload when the lock file exists", async () => {
    const acquired = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 12345,
      now: new Date("2026-05-18T10:00:00Z"),
      baseDir: tempDir,
      isLiveRelay: () => false,
    });
    expect(acquired.ok).toBe(true);

    const payload = await readTokenLock({ token: FAKE_TOKEN, baseDir: tempDir });
    expect(payload?.pid).toBe(12345);
    expect(payload?.host).toBe(FAKE_HOST);
  });

  test("returns null on malformed JSON instead of throwing", async () => {
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    mkdirSync(join(tempDir, "locks"), { recursive: true });
    writeFileSync(path, "garbage");
    const payload = await readTokenLock({ token: FAKE_TOKEN, baseDir: tempDir });
    expect(payload).toBeNull();
  });
});

describe("isLockStaleByAge", () => {
  const sample: TokenLockPayload = {
    schema_version: 1,
    token_hash: tokenHash(FAKE_TOKEN),
    host: FAKE_HOST,
    pid: 100,
    started_at: "2026-05-18T10:00:00.000Z",
    heartbeat_at: "2026-05-18T10:00:00.000Z",
  };

  test("returns false when heartbeat is fresher than the threshold", () => {
    expect(
      isLockStaleByAge(sample, new Date("2026-05-18T10:00:30Z"), 120_000),
    ).toBe(false);
  });

  test("returns true when heartbeat is older than the threshold", () => {
    expect(
      isLockStaleByAge(sample, new Date("2026-05-18T10:05:00Z"), 120_000),
    ).toBe(true);
  });

  test("treats an unparseable heartbeat_at as stale", () => {
    const bad = { ...sample, heartbeat_at: "not a date" };
    expect(isLockStaleByAge(bad, new Date(), 120_000)).toBe(true);
  });

  test("default constants are sensible: heartbeat < stale age", () => {
    expect(TOKEN_LOCK_DEFAULT_HEARTBEAT_MS).toBeGreaterThan(0);
    expect(TOKEN_LOCK_DEFAULT_STALE_AGE_MS).toBeGreaterThan(
      TOKEN_LOCK_DEFAULT_HEARTBEAT_MS,
    );
  });
});

describe("acquireTokenLock with stale-by-age", () => {
  test("takes over when heartbeat is stale even if PID is alive", async () => {
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    mkdirSync(join(tempDir, "locks"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        token_hash: tokenHash(FAKE_TOKEN),
        host: FAKE_HOST,
        pid: 99999,
        started_at: "2026-05-18T09:00:00.000Z",
        heartbeat_at: "2026-05-18T09:00:00.000Z",
      } satisfies TokenLockPayload),
    );

    const result = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 11111,
      now: new Date("2026-05-18T10:00:00Z"),
      baseDir: tempDir,
      isLiveRelay: () => true,
      maxHeartbeatAgeMs: 60_000,
    });
    expect(result.ok).toBe(true);
  });

  test("refuses when heartbeat is fresh and PID is alive", async () => {
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    mkdirSync(join(tempDir, "locks"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        token_hash: tokenHash(FAKE_TOKEN),
        host: FAKE_HOST,
        pid: 99999,
        started_at: "2026-05-18T09:00:00.000Z",
        heartbeat_at: "2026-05-18T09:59:55.000Z",
      } satisfies TokenLockPayload),
    );

    const result = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 11111,
      now: new Date("2026-05-18T10:00:00Z"),
      baseDir: tempDir,
      isLiveRelay: () => true,
      maxHeartbeatAgeMs: 60_000,
    });
    expect(result.ok).toBe(false);
  });
});

describe("startTokenLockHeartbeat", () => {
  test("updates heartbeat_at on every interval tick", async () => {
    const t0 = new Date("2026-05-18T10:00:00Z");
    const acquired = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 12345,
      now: t0,
      baseDir: tempDir,
      isLiveRelay: () => false,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    let now = t0;
    const stop = startTokenLockHeartbeat({
      token: FAKE_TOKEN,
      pid: 12345,
      baseDir: tempDir,
      intervalMs: 10,
      now: () => now,
    });

    // Advance simulated time and let the interval fire a few times.
    await new Promise((r) => setTimeout(r, 30));
    now = new Date("2026-05-18T10:00:00.030Z");
    await new Promise((r) => setTimeout(r, 30));

    stop();

    const payload = JSON.parse(readFileSync(acquired.path, "utf8")) as TokenLockPayload;
    expect(payload.heartbeat_at).not.toBe(t0.toISOString());
  });

  test("stop function makes the heartbeat idempotent (safe to call twice)", () => {
    const stop = startTokenLockHeartbeat({
      token: FAKE_TOKEN,
      pid: 12345,
      baseDir: tempDir,
      intervalMs: 1_000,
    });
    stop();
    expect(() => stop()).not.toThrow();
  });
});
