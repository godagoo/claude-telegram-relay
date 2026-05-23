import { describe, expect, test } from "bun:test";
import {
  bunRealpathDriftCheck,
  launchdPathDriftCheck,
  parseLaunchdPlistJson,
  scanRelayLogForRecentFailures,
  selectResolverPython,
  type LaunchdPolicy,
} from "./verify-checks.ts";

describe("scanRelayLogForRecentFailures", () => {
  const log = [
    "2026-05-17T07:00:00 [bot] Telegram getUpdates 409 kind=competing_poller pid=99 attempt=1",
    "2026-05-17T07:00:01 [imessage-draft] icloud_drive_file for Bro path=/tmp/x sha256=abc",
    "2026-05-17T07:00:05 [bot] Telegram getUpdates 401 unauthorized: invalid token",
    "2026-05-17T07:00:10 ERR_INVALID_ARG_VALUE: args[4] must be a string without null bytes",
    "2026-05-17T07:00:11 plain text line",
  ].join("\n");

  test("flags 409 polling conflicts", () => {
    const result = scanRelayLogForRecentFailures(log, { lineLimit: 100 });
    expect(result.hits.find((h) => h.kind === "telegram_409")).toBeDefined();
  });

  test("flags 401 unauthorized errors", () => {
    const result = scanRelayLogForRecentFailures(log, { lineLimit: 100 });
    expect(result.hits.find((h) => h.kind === "telegram_401")).toBeDefined();
  });

  test("flags ERR_INVALID_ARG_VALUE NUL crashes", () => {
    const result = scanRelayLogForRecentFailures(log, { lineLimit: 100 });
    expect(result.hits.find((h) => h.kind === "spawn_nul_crash")).toBeDefined();
  });

  test("returns empty hits for a clean log", () => {
    const result = scanRelayLogForRecentFailures(
      "ok line 1\nok line 2\n",
      { lineLimit: 100 },
    );
    expect(result.hits).toEqual([]);
  });

  test("only inspects the last lineLimit lines", () => {
    const tail = ["[bot] Telegram getUpdates 409 attempt=1"];
    const head: string[] = [];
    for (let i = 0; i < 1000; i++) head.push(`safe line ${i}`);
    const result = scanRelayLogForRecentFailures(
      [...head, ...tail].join("\n"),
      { lineLimit: 5 },
    );
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].kind).toBe("telegram_409");
  });

  test("does not flag the standalone token telegram_409 inside benign text", () => {
    const result = scanRelayLogForRecentFailures(
      "OS error 409 from unrelated subsystem\n",
      { lineLimit: 100 },
    );
    expect(result.hits.find((h) => h.kind === "telegram_409")).toBeUndefined();
  });

  test("flags imessage staging timeout (TS-side timeout fired)", () => {
    const result = scanRelayLogForRecentFailures(
      "[imessage-draft] staging helper failed for Madison: imessage_stage_timeout_25000ms",
      { lineLimit: 100 },
    );
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].kind).toBe("imessage_stage_timeout");
  });

  test("flags osascript_timeout as an imessage staging timeout", () => {
    const result = scanRelayLogForRecentFailures(
      "[imessage-draft] staging helper failed for Conor: osascript_timeout",
      { lineLimit: 100 },
    );
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].kind).toBe("imessage_stage_timeout");
  });

  test("does not flag a bare imessage stage timeout token without relay log prefix", () => {
    const result = scanRelayLogForRecentFailures(
      "operator note: imessage_stage_timeout_25000ms happened yesterday",
      { lineLimit: 100 },
    );
    expect(result.hits).toEqual([]);
  });

  test("flags markers_missing when Claude emits no draft marker block", () => {
    const result = scanRelayLogForRecentFailures(
      "[imessage-draft] markers_missing for Nater; resp_chars=97",
      { lineLimit: 100 },
    );
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].kind).toBe("imessage_markers_missing");
  });

  test("does not double-count when both timeout and stage_failed match the same line", () => {
    const result = scanRelayLogForRecentFailures(
      "[imessage-draft] staging helper failed for Madison: imessage_stage_timeout_25000ms",
      { lineLimit: 100 },
    );
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].kind).toBe("imessage_stage_timeout");
  });

  test("classifies bare osascript_timeout token without [imessage-draft] prefix as benign", () => {
    const result = scanRelayLogForRecentFailures(
      "internal note: osascript_timeout reasoning in helper README\n",
      { lineLimit: 100 },
    );
    expect(result.hits).toEqual([]);
  });
});

describe("parseLaunchdPlistJson", () => {
  const samplePlist = JSON.stringify({
    Label: "com.claude.telegram-relay",
    ProgramArguments: ["/opt/homebrew/bin/bun", "run", "src/relay.ts"],
    EnvironmentVariables: {
      PATH: "/usr/bin",
      HOME: "/Users/x",
      RELAY_DIR: "/Users/x/.claude-relay",
      RELAY_LOG_DIR: "/Users/x/.claude-relay/logs",
      RELAY_PYTHON: "/usr/local/bin/python3",
    },
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false, Crashed: true },
    ThrottleInterval: 30,
    ExitTimeOut: 20,
    StandardOutPath: "/Users/x/.claude-relay/logs/relay.log",
    StandardErrorPath: "/Users/x/.claude-relay/logs/relay.error.log",
  });

  test("extracts environment, throttle, keepalive, exit timeout", () => {
    const parsed = parseLaunchdPlistJson(samplePlist) as LaunchdPolicy;
    expect(parsed.environment.PATH).toBe("/usr/bin");
    expect(parsed.environment.RELAY_DIR).toBe("/Users/x/.claude-relay");
    expect(parsed.environment.RELAY_PYTHON).toBe("/usr/local/bin/python3");
    expect(parsed.throttleInterval).toBe(30);
    expect(parsed.exitTimeOut).toBe(20);
    expect(parsed.keepAlive).toEqual({ SuccessfulExit: false, Crashed: true });
    expect(parsed.standardOutPath).toBe("/Users/x/.claude-relay/logs/relay.log");
  });

  test("returns null when JSON is malformed", () => {
    expect(parseLaunchdPlistJson("not json")).toBeNull();
  });

  test("returns null when top-level is not an object", () => {
    expect(parseLaunchdPlistJson("[]")).toBeNull();
  });

  test("treats KeepAlive=true as the legacy boolean shape", () => {
    const parsed = parseLaunchdPlistJson(
      JSON.stringify({ KeepAlive: true }),
    ) as LaunchdPolicy;
    expect(parsed.keepAlive).toBe(true);
  });
});

describe("selectResolverPython", () => {
  test("uses launchd RELAY_PYTHON before .env", () => {
    expect(selectResolverPython({
      launchdPython: "/opt/homebrew/bin/python3",
      envPython: "/usr/local/bin/python3",
    })).toEqual({
      command: "/opt/homebrew/bin/python3",
      source: "launchd_plist",
      pinned: true,
      label: "launchd RELAY_PYTHON",
    });
  });

  test("uses .env RELAY_PYTHON when launchd has no pin", () => {
    expect(selectResolverPython({
      envPython: "/usr/local/bin/python3",
    })).toEqual({
      command: "/usr/local/bin/python3",
      source: "env",
      pinned: true,
      label: ".env RELAY_PYTHON",
    });
  });

  test("falls back to launchd PATH when no pin exists", () => {
    expect(selectResolverPython({
      launchdPython: " ",
      envPython: "",
    })).toEqual({
      command: "python3",
      source: "path",
      pinned: false,
      label: "launchd PATH",
    });
  });
});

describe("bunRealpathDriftCheck", () => {
  test("returns ok when current matches previous", () => {
    expect(bunRealpathDriftCheck("/opt/homebrew/Cellar/bun/1.3.13/bin/bun", "/opt/homebrew/Cellar/bun/1.3.13/bin/bun"))
      .toEqual({ ok: true, drifted: false });
  });

  test("flags drift when realpath has changed", () => {
    expect(bunRealpathDriftCheck("/opt/homebrew/Cellar/bun/1.3.14/bin/bun", "/opt/homebrew/Cellar/bun/1.3.13/bin/bun"))
      .toEqual({ ok: false, drifted: true });
  });

  test("returns ok with no previous when no record exists yet (first run)", () => {
    expect(bunRealpathDriftCheck("/opt/homebrew/Cellar/bun/1.3.13/bin/bun", null))
      .toEqual({ ok: true, drifted: false });
  });
});

describe("launchdPathDriftCheck", () => {
  const expected = "/Users/x/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";

  test("passes when plist PATH matches the helper output", () => {
    expect(launchdPathDriftCheck(expected, expected)).toEqual({ ok: true });
  });

  test("fails when plist PATH is missing", () => {
    expect(launchdPathDriftCheck(undefined, expected)).toEqual({
      ok: false,
      reason: "missing",
      expected,
    });
  });

  test("fails when plist PATH is stale", () => {
    expect(launchdPathDriftCheck("/Users/x/.bun/bin:/usr/local/bin:/usr/bin:/bin", expected)).toEqual({
      ok: false,
      reason: "drift",
      actual: "/Users/x/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      expected,
    });
  });
});
