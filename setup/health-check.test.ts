import { describe, expect, test } from "bun:test";
import {
  buildHealthReport,
  checkRecentErrorLog,
  checkSingletonRelay,
  checkTokenLockHealth,
  findRelayProcesses,
  formatHealthLine,
  isRelayProcessLine,
  resolveRelayErrorLogPath,
} from "./health-check.ts";
import { tokenHash, type TokenLockPayload } from "../src/token-lock.ts";

const SAMPLE_TOKEN = "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SAMPLE_HOST = "test-host";
const SAMPLE_HASH = tokenHash(SAMPLE_TOKEN);

function makeLockPayload(overrides: Partial<TokenLockPayload> = {}): TokenLockPayload {
  return {
    schema_version: 1,
    token_hash: SAMPLE_HASH,
    host: SAMPLE_HOST,
    pid: 12345,
    started_at: "2026-05-19T09:00:00.000Z",
    heartbeat_at: "2026-05-19T09:16:00.000Z",
    ...overrides,
  };
}

describe("isRelayProcessLine", () => {
  test("accepts plain `bun run src/relay.ts`", () => {
    expect(isRelayProcessLine("12345 00:10 bun run src/relay.ts")).toBe(true);
  });
  test("accepts an absolute bun executable path", () => {
    expect(isRelayProcessLine("12345 00:10 /opt/homebrew/bin/bun run src/relay.ts")).toBe(true);
  });
  test("accepts the relay even with trailing args", () => {
    expect(isRelayProcessLine("12345 00:10 /opt/homebrew/bin/bun run src/relay.ts --foo")).toBe(true);
  });
  test("rejects another bun script that is not the relay", () => {
    expect(isRelayProcessLine("12345 00:10 /opt/homebrew/bin/bun run scripts/health-check.ts")).toBe(false);
  });
  test("rejects grep that merely mentions the command string", () => {
    expect(isRelayProcessLine("12345 00:10 grep bun run src/relay.ts")).toBe(false);
  });
  test("rejects ripgrep that merely mentions the command string", () => {
    expect(isRelayProcessLine("12345 00:10 rg bun run src/relay.ts")).toBe(false);
  });
  test("rejects a shell wrapper that echoes the command", () => {
    expect(isRelayProcessLine("12345 00:10 /bin/sh -c echo bun run src/relay.ts")).toBe(false);
  });
  test("rejects a line that names the script under a non-bun executable", () => {
    expect(isRelayProcessLine("12345 00:10 cat src/relay.ts")).toBe(false);
  });
  test("rejects malformed ps output (too few tokens)", () => {
    expect(isRelayProcessLine("12345 00:10 bun")).toBe(false);
  });
  test("rejects when the script slot is something other than src/relay.ts", () => {
    expect(isRelayProcessLine("12345 00:10 bun run ./src/relay.ts")).toBe(false);
  });
});

describe("findRelayProcesses", () => {
  test("extracts pid and line for each relay match", () => {
    const lines = [
      "12345 00:10 bun run src/relay.ts",
      "67890 00:00 ps axww",
      "98765 00:30 /opt/homebrew/bin/bun run src/relay.ts",
    ];
    const found = findRelayProcesses(lines);
    expect(found.length).toBe(2);
    expect(found[0]).toEqual({ line: lines[0], pid: 12345 });
    expect(found[1]).toEqual({ line: lines[2], pid: 98765 });
  });
  test("returns empty for no matches", () => {
    expect(findRelayProcesses(["1 00:00 ps", "2 00:00 bash"])).toEqual([]);
  });
});

describe("checkSingletonRelay", () => {
  test("pass when exactly one relay process is found", () => {
    const lines = checkSingletonRelay({
      relayProcesses: [{ line: "x", pid: 12345 }],
      mode: "standalone",
    });
    expect(lines.length).toBe(1);
    expect(lines[0].severity).toBe("pass");
    expect(lines[0].message).toContain("12345");
  });
  test("fail when two or more relay processes are found (standalone)", () => {
    const lines = checkSingletonRelay({
      relayProcesses: [
        { line: "a", pid: 1 },
        { line: "b", pid: 2 },
      ],
      mode: "standalone",
    });
    expect(lines[0].severity).toBe("fail");
    expect(lines[0].message).toContain("Multiple");
  });
  test("fail when zero relay processes in standalone mode", () => {
    const lines = checkSingletonRelay({ relayProcesses: [], mode: "standalone" });
    expect(lines[0].severity).toBe("fail");
  });
  test("warn when zero relay processes in embedded mode with launchd not loaded", () => {
    const lines = checkSingletonRelay({ relayProcesses: [], mode: "embedded" });
    expect(lines[0].severity).toBe("warn");
  });
  test("fail in embedded mode when launchd reports the relay loaded but no process is running", () => {
    const lines = checkSingletonRelay({
      relayProcesses: [],
      mode: "embedded",
      launchdRelayLoaded: true,
    });
    expect(lines[0].severity).toBe("fail");
    expect(lines[0].message).toMatch(/launchd/i);
  });
  test("standalone is still a fail regardless of launchd state", () => {
    const lines = checkSingletonRelay({
      relayProcesses: [],
      mode: "standalone",
      launchdRelayLoaded: false,
    });
    expect(lines[0].severity).toBe("fail");
  });
});

describe("resolveRelayErrorLogPath", () => {
  const HOME = "/Users/x";

  test("live launchctl print stderr wins over plist StandardErrorPath", () => {
    // Regression: the live launchd job can be bootstrapped from a stale
    // plist that no longer matches the file on disk. Scanning the plist
    // path would false-green real 409/401/NUL evidence written to the
    // live runtime path.
    const result = resolveRelayErrorLogPath({
      launchdLiveStandardErrorPath: "/live/runtime.error.log",
      launchdPlistStandardErrorPath: "/installed/plist.error.log",
      launchdEnvLogDir: "/ignored",
      dotenvLogDir: "/ignored",
      homeDir: HOME,
    });
    expect(result).toBe("/live/runtime.error.log");
  });

  test("plist StandardErrorPath is used when launchctl print did not report a live path", () => {
    const result = resolveRelayErrorLogPath({
      launchdPlistStandardErrorPath: "/var/log/relay-custom.error.log",
      launchdEnvLogDir: "/ignored/launchd-dir",
      dotenvLogDir: "/ignored/dotenv-dir",
      homeDir: HOME,
    });
    expect(result).toBe("/var/log/relay-custom.error.log");
  });

  test("live path is used alone when no plist value is available", () => {
    const result = resolveRelayErrorLogPath({
      launchdLiveStandardErrorPath: "/live/only.error.log",
      homeDir: HOME,
    });
    expect(result).toBe("/live/only.error.log");
  });

  test("falls back to launchd RELAY_LOG_DIR when both stderr paths are absent", () => {
    const result = resolveRelayErrorLogPath({
      launchdEnvLogDir: "/Users/x/.custom-relay/logs",
      dotenvLogDir: "/ignored",
      homeDir: HOME,
    });
    expect(result).toBe("/Users/x/.custom-relay/logs/com.claude.telegram-relay.error.log");
  });

  test("derives logs/ from launchd RELAY_DIR when only RELAY_DIR is set", () => {
    const result = resolveRelayErrorLogPath({
      launchdEnvRelayDir: "/Users/x/.custom-relay",
      homeDir: HOME,
    });
    expect(result).toBe("/Users/x/.custom-relay/logs/com.claude.telegram-relay.error.log");
  });

  test("falls back to dotenv RELAY_LOG_DIR when launchd inputs are absent", () => {
    const result = resolveRelayErrorLogPath({
      dotenvLogDir: "/Users/x/.relay-via-dotenv/logs",
      homeDir: HOME,
    });
    expect(result).toBe("/Users/x/.relay-via-dotenv/logs/com.claude.telegram-relay.error.log");
  });

  test("derives logs/ from dotenv RELAY_DIR when only RELAY_DIR is set", () => {
    const result = resolveRelayErrorLogPath({
      dotenvRelayDir: "/Users/x/.relay-via-dotenv",
      homeDir: HOME,
    });
    expect(result).toBe("/Users/x/.relay-via-dotenv/logs/com.claude.telegram-relay.error.log");
  });

  test("falls back to homeDir default when no inputs are set", () => {
    const result = resolveRelayErrorLogPath({ homeDir: HOME });
    expect(result).toBe("/Users/x/.claude-relay/logs/com.claude.telegram-relay.error.log");
  });

  test("launchd values beat dotenv values at every tier", () => {
    const result = resolveRelayErrorLogPath({
      launchdEnvLogDir: "/launchd-wins",
      dotenvLogDir: "/dotenv-loses",
      homeDir: HOME,
    });
    expect(result).toBe("/launchd-wins/com.claude.telegram-relay.error.log");
  });
});

describe("checkTokenLockHealth", () => {
  const baseInput = {
    lockPath: "/tmp/lock",
    relayIsRunning: true,
    livePids: [12345],
    expectedHost: SAMPLE_HOST,
    expectedTokenHash: SAMPLE_HASH,
    now: new Date("2026-05-19T09:17:00.000Z"),
    maxHeartbeatAgeMs: 120_000,
  };

  test("pass when payload matches host/hash/pid and heartbeat is fresh", () => {
    const result = checkTokenLockHealth({
      ...baseInput,
      tokenLockState: { kind: "payload", payload: makeLockPayload() },
    });
    expect(result.length).toBe(1);
    expect(result[0].severity).toBe("pass");
  });

  test("fail on token-hash mismatch", () => {
    const result = checkTokenLockHealth({
      ...baseInput,
      tokenLockState: {
        kind: "payload",
        payload: makeLockPayload({ token_hash: "deadbeef".repeat(8) }),
      },
    });
    expect(result.some((l) => l.severity === "fail" && /hash/i.test(l.message))).toBe(true);
  });

  test("fail on host mismatch", () => {
    const result = checkTokenLockHealth({
      ...baseInput,
      tokenLockState: { kind: "payload", payload: makeLockPayload({ host: "other-host" }) },
    });
    expect(result.some((l) => l.severity === "fail" && /host/i.test(l.message))).toBe(true);
  });

  test("fail when lock pid is not among live pids", () => {
    const result = checkTokenLockHealth({
      ...baseInput,
      tokenLockState: { kind: "payload", payload: makeLockPayload({ pid: 99999 }) },
    });
    expect(result.some((l) => l.severity === "fail" && /pid/i.test(l.message))).toBe(true);
  });

  test("fail when heartbeat is older than max age", () => {
    const result = checkTokenLockHealth({
      ...baseInput,
      tokenLockState: {
        kind: "payload",
        payload: makeLockPayload({ heartbeat_at: "2026-05-19T09:00:00.000Z" }),
      },
    });
    expect(result.some((l) => l.severity === "fail" && /stale|heartbeat/i.test(l.message))).toBe(true);
  });

  test("fail when relay is running but lock is missing", () => {
    const result = checkTokenLockHealth({
      ...baseInput,
      tokenLockState: { kind: "missing" },
    });
    expect(result[0].severity).toBe("fail");
    expect(result[0].message).toContain("missing");
  });

  test("warn when relay is not running and lock is missing", () => {
    const result = checkTokenLockHealth({
      ...baseInput,
      relayIsRunning: false,
      tokenLockState: { kind: "missing" },
    });
    expect(result[0].severity).toBe("warn");
  });

  test("fail when lock payload is unparseable", () => {
    const result = checkTokenLockHealth({
      ...baseInput,
      tokenLockState: { kind: "unparseable" },
    });
    expect(result[0].severity).toBe("fail");
    expect(result[0].message).toMatch(/parse/i);
  });
});

describe("checkRecentErrorLog", () => {
  test("fail on recent 409 polling-conflict line", () => {
    const log = "2026-05-19T07:00:00 [bot] Telegram getUpdates 409 conflict";
    const r = checkRecentErrorLog({
      errorLog: { kind: "text", text: log },
      errorLogPath: "/tmp/err.log",
      relayIsRunning: true,
    });
    expect(r.some((l) => l.severity === "fail" && /telegram_409/.test(l.message))).toBe(true);
  });
  test("fail on recent 401 unauthorized line", () => {
    const log = "[bot] Telegram getUpdates 401 unauthorized";
    const r = checkRecentErrorLog({
      errorLog: { kind: "text", text: log },
      errorLogPath: "/tmp/err.log",
      relayIsRunning: true,
    });
    expect(r.some((l) => l.severity === "fail" && /telegram_401/.test(l.message))).toBe(true);
  });
  test("fail on recent NUL-crash line", () => {
    const log = "ERR_INVALID_ARG_VALUE: args[4] must be a string without null bytes";
    const r = checkRecentErrorLog({
      errorLog: { kind: "text", text: log },
      errorLogPath: "/tmp/err.log",
      relayIsRunning: true,
    });
    expect(r.some((l) => l.severity === "fail" && /spawn_nul_crash/.test(l.message))).toBe(true);
  });
  test("pass on a clean log tail", () => {
    const r = checkRecentErrorLog({
      errorLog: { kind: "text", text: "ok line one\nok line two\n" },
      errorLogPath: "/tmp/err.log",
      relayIsRunning: true,
    });
    expect(r[0].severity).toBe("pass");
  });
  test("benign 409 token in unrelated text does not false-positive", () => {
    const r = checkRecentErrorLog({
      errorLog: { kind: "text", text: "OS error 409 from unrelated subsystem\n" },
      errorLogPath: "/tmp/err.log",
      relayIsRunning: true,
    });
    expect(r[0].severity).toBe("pass");
  });
  test("warn when log is missing", () => {
    const r = checkRecentErrorLog({
      errorLog: { kind: "missing" },
      errorLogPath: "/tmp/err.log",
      relayIsRunning: true,
    });
    expect(r[0].severity).toBe("warn");
  });
});

describe("buildHealthReport exit codes", () => {
  const base = {
    expectedHost: SAMPLE_HOST,
    expectedTokenHash: SAMPLE_HASH,
    now: new Date("2026-05-19T09:17:00.000Z"),
    maxHeartbeatAgeMs: 120_000,
    errorLog: { kind: "text" as const, text: "ok line\n" },
    errorLogPath: "/tmp/err.log",
    lockPath: "/tmp/lock",
  };

  test("exit 2 when TELEGRAM_BOT_TOKEN is missing (config error)", () => {
    const report = buildHealthReport({
      ...base,
      mode: "standalone",
      tokenConfigured: false,
      processLines: [],
      tokenLockState: { kind: "missing" },
    });
    expect(report.standaloneExitCode).toBe(2);
    expect(
      report.lines.some((l) => l.severity === "fail" && /TELEGRAM_BOT_TOKEN/.test(l.message)),
    ).toBe(true);
  });

  test("exit 0 when one relay process, valid lock, and clean log (standalone)", () => {
    const report = buildHealthReport({
      ...base,
      mode: "standalone",
      tokenConfigured: true,
      processLines: ["12345 00:01 /opt/homebrew/bin/bun run src/relay.ts"],
      tokenLockState: { kind: "payload", payload: makeLockPayload() },
    });
    expect(report.standaloneExitCode).toBe(0);
  });

  test("exit 1 when standalone but no relay process running", () => {
    const report = buildHealthReport({
      ...base,
      mode: "standalone",
      tokenConfigured: true,
      processLines: [],
      tokenLockState: { kind: "missing" },
    });
    expect(report.standaloneExitCode).toBe(1);
  });

  test("exit 0 when embedded with no relay running and launchd not loaded", () => {
    const report = buildHealthReport({
      ...base,
      mode: "embedded",
      tokenConfigured: true,
      processLines: [],
      tokenLockState: { kind: "missing" },
    });
    expect(report.standaloneExitCode).toBe(0);
  });

  test("exit 1 when embedded mode sees launchd loaded but zero relay processes", () => {
    const report = buildHealthReport({
      ...base,
      mode: "embedded",
      launchdRelayLoaded: true,
      tokenConfigured: true,
      processLines: [],
      tokenLockState: { kind: "missing" },
    });
    expect(report.standaloneExitCode).toBe(1);
  });
});

describe("formatHealthLine", () => {
  test("PASS prefix", () => {
    expect(formatHealthLine({ severity: "pass", message: "hi" })).toBe("PASS hi");
  });
  test("WARN prefix", () => {
    expect(formatHealthLine({ severity: "warn", message: "hi" })).toBe("WARN hi");
  });
  test("FAIL prefix", () => {
    expect(formatHealthLine({ severity: "fail", message: "hi" })).toBe("FAIL hi");
  });
});
