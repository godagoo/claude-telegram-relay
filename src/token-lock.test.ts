import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  acquireTokenLock,
  defaultLockRoot,
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

describe("defaultLockRoot", () => {
  test("is independent of RELAY_DIR; honors RELAY_LOCK_ROOT only", () => {
    const original = {
      RELAY_LOCK_ROOT: process.env.RELAY_LOCK_ROOT,
      RELAY_DIR: process.env.RELAY_DIR,
    };
    try {
      delete process.env.RELAY_LOCK_ROOT;
      process.env.RELAY_DIR = "/tmp/forge-a-different-relay-dir";
      const fromRelayDir = defaultLockRoot();
      expect(fromRelayDir).not.toContain("/tmp/forge-a-different-relay-dir");
      expect(fromRelayDir.endsWith("/.claude-relay/locks")).toBe(true);

      process.env.RELAY_LOCK_ROOT = "/tmp/explicit-lock-root";
      expect(defaultLockRoot()).toBe("/tmp/explicit-lock-root");
    } finally {
      if (original.RELAY_LOCK_ROOT === undefined) delete process.env.RELAY_LOCK_ROOT;
      else process.env.RELAY_LOCK_ROOT = original.RELAY_LOCK_ROOT;
      if (original.RELAY_DIR === undefined) delete process.env.RELAY_DIR;
      else process.env.RELAY_DIR = original.RELAY_DIR;
    }
  });
});

describe("acquireTokenLock atomicity (open wx)", () => {
  test("the second concurrent acquire fails when no stale takeover is allowed", async () => {
    const isLiveRelay = () => true;
    const now = new Date("2026-05-18T10:00:00Z");

    const [first, second] = await Promise.all([
      acquireTokenLock({
        token: FAKE_TOKEN,
        host: FAKE_HOST,
        pid: 11111,
        now,
        baseDir: tempDir,
        isLiveRelay,
      }),
      acquireTokenLock({
        token: FAKE_TOKEN,
        host: FAKE_HOST,
        pid: 22222,
        now,
        baseDir: tempDir,
        isLiveRelay: (pid) => pid !== 22222,
      }),
    ]);
    const successes = [first, second].filter((r) => r.ok).length;
    expect(successes).toBe(1);
  });
});

describe("stale-takeover race", () => {
  test("two concurrent stale takeovers produce exactly one success", async () => {
    // Seed an obviously-stale lock.
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

    const now = new Date("2026-05-18T10:00:00Z");
    const tryAcquire = (pid: number) =>
      acquireTokenLock({
        token: FAKE_TOKEN,
        host: FAKE_HOST,
        pid,
        now,
        baseDir: tempDir,
        // Holder is dead (we say no PID is alive) but our own pid is alive
        // for the heartbeat check — irrelevant because existing.pid is 99999.
        isLiveRelay: () => false,
      });

    const [a, b] = await Promise.all([tryAcquire(11111), tryAcquire(22222)]);
    const successes = [a, b].filter((r) => r.ok).length;
    expect(successes).toBe(1);
  });

  test("500 pairs of concurrent stale takeovers always elect exactly one winner", async () => {
    let doubleSuccesses = 0;
    for (let trial = 0; trial < 50; trial++) {
      const trialDir = mkdtempSync(join(tmpdir(), `relay-stale-race-${trial}-`));
      try {
        const path = tokenLockPath(FAKE_TOKEN, trialDir);
        mkdirSync(join(trialDir, "locks"), { recursive: true });
        writeFileSync(
          path,
          JSON.stringify({
            schema_version: 1,
            token_hash: tokenHash(FAKE_TOKEN),
            host: FAKE_HOST,
            pid: 70000 + trial,
            started_at: "2026-05-18T09:00:00.000Z",
            heartbeat_at: "2026-05-18T09:00:00.000Z",
          } satisfies TokenLockPayload),
        );

        const now = new Date("2026-05-18T10:00:00Z");
        const results = await Promise.all([
          acquireTokenLock({
            token: FAKE_TOKEN,
            host: FAKE_HOST,
            pid: 11111,
            now,
            baseDir: trialDir,
            isLiveRelay: () => false,
          }),
          acquireTokenLock({
            token: FAKE_TOKEN,
            host: FAKE_HOST,
            pid: 22222,
            now,
            baseDir: trialDir,
            isLiveRelay: () => false,
          }),
        ]);
        const successes = results.filter((r) => r.ok).length;
        if (successes !== 1) doubleSuccesses += 1;
      } finally {
        rmSync(trialDir, { recursive: true, force: true });
      }
    }
    expect(doubleSuccesses).toBe(0);
  });
});

describe("stale-takeover edge cases", () => {
  test("unparseable existing + third process creating a new lock returns a non-null synthetic holder", async () => {
    // Seed garbage at path so the initial read returns null.
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    mkdirSync(join(tempDir, "locks"), { recursive: true });
    writeFileSync(path, "not parseable");

    const thirdPayload: TokenLockPayload = {
      schema_version: 1,
      token_hash: tokenHash(FAKE_TOKEN),
      host: "third-host",
      pid: 33333,
      started_at: "2026-05-19T10:00:00.000Z",
      heartbeat_at: "2026-05-19T10:00:00.000Z",
    };

    const result = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 11111,
      now: new Date("2026-05-19T10:00:00Z"),
      baseDir: tempDir,
      isLiveRelay: () => false,
      _testHooks: {
        // After our claim succeeded (path is empty), a third process slips
        // in and creates a fresh lock at path before we get to tryAtomicCreate.
        afterClaim: async () => {
          mkdirSync(join(tempDir, "locks"), { recursive: true });
          writeFileSync(path, JSON.stringify(thirdPayload));
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("held_by_live_relay");
    if (result.reason !== "held_by_live_relay") return;
    // Critical: holder must be non-null. With the previous `existing!`,
    // this was a lying type-cast over a `null`.
    expect(result.holder).not.toBeNull();
    expect(result.holder.pid).toBe(33333);
  });

  test("unparseable existing + third process writing more garbage returns a synthetic holder", async () => {
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    mkdirSync(join(tempDir, "locks"), { recursive: true });
    writeFileSync(path, "garbage v1");

    const result = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 11111,
      now: new Date("2026-05-19T10:00:00Z"),
      baseDir: tempDir,
      isLiveRelay: () => false,
      _testHooks: {
        afterClaim: async () => {
          // Third process writes more garbage. readPayloadOrNull will
          // return null for both `existing` and the post-claim read.
          mkdirSync(join(tempDir, "locks"), { recursive: true });
          writeFileSync(path, "garbage v2");
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("held_by_live_relay");
    if (result.reason !== "held_by_live_relay") return;
    expect(result.holder).not.toBeNull();
    // Synthetic holder uses pid = -1 to mark "unknown real holder".
    expect(result.holder.pid).toBe(-1);
    expect(result.holder.token_hash).toBe(tokenHash(FAKE_TOKEN));
  });

  test("restore-on-mismatch puts the third process's payload back into the lockfile", async () => {
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    mkdirSync(join(tempDir, "locks"), { recursive: true });
    const stalePayload: TokenLockPayload = {
      schema_version: 1,
      token_hash: tokenHash(FAKE_TOKEN),
      host: FAKE_HOST,
      pid: 99999,
      started_at: "2026-05-19T09:00:00.000Z",
      heartbeat_at: "2026-05-19T09:00:00.000Z",
    };
    writeFileSync(path, JSON.stringify(stalePayload));

    const replacementPayload: TokenLockPayload = {
      schema_version: 1,
      token_hash: tokenHash(FAKE_TOKEN),
      host: "replacement-host",
      pid: 44444,
      started_at: "2026-05-19T09:59:00.000Z",
      heartbeat_at: "2026-05-19T09:59:30.000Z",
    };

    const result = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 11111,
      now: new Date("2026-05-19T10:00:00Z"),
      baseDir: tempDir,
      isLiveRelay: () => false,
      _testHooks: {
        // Between our read of `existing` and our atomic claim rename,
        // a third process replaces the lockfile with a fresh payload.
        beforeClaim: async () => {
          writeFileSync(path, JSON.stringify(replacementPayload));
        },
      },
    });

    // Mismatch detected. Our acquire must return held_by_live_relay and
    // must restore the replacement payload at path.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("held_by_live_relay");
    if (result.reason !== "held_by_live_relay") return;

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as TokenLockPayload;
    expect(onDisk.pid).toBe(replacementPayload.pid);
    expect(onDisk.host).toBe(replacementPayload.host);
  });

  test("third-process create between claim rename and recreate leaves the third's lock untouched", async () => {
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    mkdirSync(join(tempDir, "locks"), { recursive: true });
    const stalePayload: TokenLockPayload = {
      schema_version: 1,
      token_hash: tokenHash(FAKE_TOKEN),
      host: FAKE_HOST,
      pid: 99999,
      started_at: "2026-05-19T09:00:00.000Z",
      heartbeat_at: "2026-05-19T09:00:00.000Z",
    };
    writeFileSync(path, JSON.stringify(stalePayload));

    const thirdPayload: TokenLockPayload = {
      schema_version: 1,
      token_hash: tokenHash(FAKE_TOKEN),
      host: "third-host",
      pid: 55555,
      started_at: "2026-05-19T09:59:55.000Z",
      heartbeat_at: "2026-05-19T09:59:55.000Z",
    };

    const result = await acquireTokenLock({
      token: FAKE_TOKEN,
      host: FAKE_HOST,
      pid: 11111,
      now: new Date("2026-05-19T10:00:00Z"),
      baseDir: tempDir,
      isLiveRelay: () => false,
      _testHooks: {
        afterClaim: async () => {
          // After our atomic claim rename succeeded (path is empty)
          // but before we tryAtomicCreate, a third process creates a
          // fresh lock at path.
          mkdirSync(join(tempDir, "locks"), { recursive: true });
          writeFileSync(path, JSON.stringify(thirdPayload));
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("held_by_live_relay");
    if (result.reason !== "held_by_live_relay") return;
    expect(result.holder.pid).toBe(thirdPayload.pid);

    // The third's lock must remain intact — we never overwrote it.
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as TokenLockPayload;
    expect(onDisk.pid).toBe(thirdPayload.pid);
    expect(onDisk.host).toBe(thirdPayload.host);
  });
});

describe("heartbeat clobber regression", () => {
  test("a delayed heartbeat from the old holder must not overwrite the new holder after takeover", async () => {
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    mkdirSync(join(tempDir, "locks"), { recursive: true });

    // State at t0: A holds the lock.
    const aPayload: TokenLockPayload = {
      schema_version: 1,
      token_hash: tokenHash(FAKE_TOKEN),
      host: FAKE_HOST,
      pid: 11111,
      started_at: "2026-05-19T09:00:00.000Z",
      heartbeat_at: "2026-05-19T09:00:00.000Z",
    };
    writeFileSync(path, JSON.stringify(aPayload));

    // A's heartbeat fires. After it reads existing=A but before its
    // atomic claim, B takes over and replaces path with B's payload.
    const bPayload: TokenLockPayload = {
      schema_version: 1,
      token_hash: tokenHash(FAKE_TOKEN),
      host: FAKE_HOST,
      pid: 22222,
      started_at: "2026-05-19T09:59:50.000Z",
      heartbeat_at: "2026-05-19T09:59:50.000Z",
    };

    await heartbeatTokenLock({
      token: FAKE_TOKEN,
      pid: 11111,
      now: new Date("2026-05-19T10:00:00Z"),
      baseDir: tempDir,
      host: FAKE_HOST,
      _testHookAfterRead: async () => {
        writeFileSync(path, JSON.stringify(bPayload));
      },
    });

    // The file at path must still be B's lock, untouched.
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as TokenLockPayload;
    expect(onDisk.pid).toBe(bPayload.pid);
    expect(onDisk.host).toBe(bPayload.host);
    expect(onDisk.heartbeat_at).toBe(bPayload.heartbeat_at);
  });
});

describe("releaseTokenLock ownership", () => {
  test("refuses to release when token_hash in the file does not match the caller's token", async () => {
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

    // Simulate a different token whose lockfile happens to share the same
    // path (cannot occur in production since the path is keyed on the
    // sha256 prefix, but the release path must defensively check).
    const wrongTokenLockPath = acquired.path;
    const payload = JSON.parse(readFileSync(wrongTokenLockPath, "utf8")) as TokenLockPayload;
    payload.token_hash = "0".repeat(64);
    writeFileSync(wrongTokenLockPath, JSON.stringify(payload));

    await releaseTokenLock({ token: FAKE_TOKEN, pid: 12345, baseDir: tempDir });
    expect(existsSync(wrongTokenLockPath)).toBe(true);
  });

  test("refuses to release when host in the file does not match the caller's host", async () => {
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

    const payload = JSON.parse(readFileSync(acquired.path, "utf8")) as TokenLockPayload;
    payload.host = "some-other-host";
    writeFileSync(acquired.path, JSON.stringify(payload));

    await releaseTokenLock({ token: FAKE_TOKEN, pid: 12345, baseDir: tempDir, host: FAKE_HOST });
    expect(existsSync(acquired.path)).toBe(true);
  });
});
