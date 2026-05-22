import { describe, expect, test } from "bun:test";
import {
  bunRealpathDriftCheck,
  parseLaunchdPlistJson,
  scanRelayLogForRecentFailures,
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
