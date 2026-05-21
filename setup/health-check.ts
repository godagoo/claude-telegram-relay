// Read-only health monitor for the Claude Telegram relay.
//
// The module is structured in two layers:
//
//   1. Pure helpers (isRelayProcessLine, findRelayProcesses,
//      checkSingletonRelay, checkTokenLockHealth, checkRecentErrorLog,
//      buildHealthReport). These take fully injected inputs — process
//      lines, env, current time, log text, token-lock payload — so they
//      can be unit-tested without touching launchd, the live filesystem,
//      or the running process table.
//
//   2. I/O wrappers (runHealthCheck, defaultErrorLogPath, plus the .env
//      reader). These exist to be called from scripts/health-check.ts and
//      from setup/verify.ts when it detects a running relay.
//
// The CLI standalone exit codes are: 0 (no failures), 1 (runtime health
// failure), 2 (configuration error such as a missing TELEGRAM_BOT_TOKEN).
//
// Nothing in this module mutates relay state: no log deletion, no lock
// rewrites, no launchctl bootstrap/bootout/kickstart, no .env writes.

import { existsSync, readFileSync } from "fs";
import { homedir, hostname } from "os";
import { dirname, join } from "path";
import {
  TOKEN_LOCK_DEFAULT_STALE_AGE_MS,
  tokenHash,
  tokenLockPath,
  type TokenLockPayload,
} from "../src/token-lock.ts";
import { runCommandWithTimeout } from "./process-timeout.ts";
import { scanRelayLogForRecentFailures } from "./verify-checks.ts";

export type HealthSeverity = "pass" | "warn" | "fail";

export interface HealthLine {
  severity: HealthSeverity;
  message: string;
}

export interface HealthReport {
  lines: HealthLine[];
  /**
   * Standalone-CLI exit code. 2 for configuration errors (missing
   * TELEGRAM_BOT_TOKEN); 1 if any other failure is present; 0 otherwise.
   * setup/verify.ts may map fails to its own exit code without using
   * this field.
   */
  standaloneExitCode: 0 | 1 | 2;
}

export interface RelayProcess {
  line: string;
  pid: number;
}

export type TokenLockState =
  | { kind: "missing" }
  | { kind: "unparseable" }
  | { kind: "payload"; payload: TokenLockPayload };

export type ErrorLogState =
  | { kind: "text"; text: string }
  | { kind: "missing" };

export type HealthCheckMode = "standalone" | "embedded";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isRelayProcessLine(line: string): boolean {
  // ps axww -o pid=,etime=,command= produces "<pid> <etime> <cmd...>".
  // Parse strictly so we don't accept lines that only mention the relay
  // command in their args (grep / rg / sh -c echo all leak the literal
  // string into the command column). The relay's real argv is exactly
  // `<bun-exe> run src/relay.ts [...args]`.
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const exe = parts[2];
  if (exe !== "bun" && !exe.endsWith("/bun")) return false;
  if (parts[3] !== "run") return false;
  if (parts[4] !== "src/relay.ts") return false;
  return true;
}

export function pidFromProcessLine(line: string): number | undefined {
  const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function findRelayProcesses(processLines: string[]): RelayProcess[] {
  const out: RelayProcess[] = [];
  for (const line of processLines) {
    if (!isRelayProcessLine(line)) continue;
    const pid = pidFromProcessLine(line);
    if (pid !== undefined) out.push({ line, pid });
  }
  return out;
}

export function checkSingletonRelay(input: {
  relayProcesses: RelayProcess[];
  mode: HealthCheckMode;
  /**
   * Optional context: when launchd reports the relay job as loaded but
   * the process list shows none running, zero relays graduates from a
   * warning to a hard fail even in embedded mode. Standalone mode
   * always fails on zero relays.
   */
  launchdRelayLoaded?: boolean;
}): HealthLine[] {
  const { relayProcesses, mode, launchdRelayLoaded } = input;
  if (relayProcesses.length > 1) {
    return [
      {
        severity: "fail",
        message: `Multiple relay processes found (n=${relayProcesses.length}); pids=${relayProcesses
          .map((p) => p.pid)
          .join(",")}`,
      },
    ];
  }
  if (relayProcesses.length === 0) {
    if (mode === "standalone") {
      return [{ severity: "fail", message: "No local relay process found" }];
    }
    if (launchdRelayLoaded) {
      return [
        {
          severity: "fail",
          message:
            "Relay launchd service is loaded but no relay process is running",
        },
      ];
    }
    return [{ severity: "warn", message: "No local relay process found" }];
  }
  return [
    {
      severity: "pass",
      message: `Exactly one relay process found (pid=${relayProcesses[0].pid})`,
    },
  ];
}

export function checkTokenLockHealth(input: {
  tokenLockState: TokenLockState;
  lockPath: string;
  relayIsRunning: boolean;
  livePids: number[];
  expectedHost: string;
  expectedTokenHash: string;
  now: Date;
  maxHeartbeatAgeMs: number;
}): HealthLine[] {
  const {
    tokenLockState,
    lockPath,
    relayIsRunning,
    livePids,
    expectedHost,
    expectedTokenHash,
    now,
    maxHeartbeatAgeMs,
  } = input;

  if (tokenLockState.kind === "missing") {
    if (relayIsRunning) {
      return [
        {
          severity: "fail",
          message: `Token lock missing at ${lockPath} but a relay process is running`,
        },
      ];
    }
    return [
      {
        severity: "warn",
        message: `Token lock not found at ${lockPath}; relay may not be running`,
      },
    ];
  }

  if (tokenLockState.kind === "unparseable") {
    return [
      {
        severity: "fail",
        message: `Token lock at ${lockPath} did not parse as a valid payload`,
      },
    ];
  }

  const payload = tokenLockState.payload;
  const lines: HealthLine[] = [];

  if (payload.token_hash !== expectedTokenHash) {
    lines.push({
      severity: "fail",
      message:
        `Token lock hash does not match configured TELEGRAM_BOT_TOKEN ` +
        `(lock=${payload.token_hash.slice(0, 16)} expected=${expectedTokenHash.slice(0, 16)})`,
    });
  }

  if (payload.host !== expectedHost) {
    lines.push({
      severity: "fail",
      message: `Token lock host=${payload.host} differs from this host=${expectedHost}`,
    });
  }

  if (livePids.length > 0 && !livePids.includes(payload.pid)) {
    lines.push({
      severity: "fail",
      message: `Token lock pid=${payload.pid} does not match live relay pid(s) [${livePids.join(",")}]`,
    });
  }

  const heartbeatMs = Date.parse(payload.heartbeat_at);
  if (!Number.isFinite(heartbeatMs)) {
    lines.push({
      severity: "fail",
      message: `Token lock heartbeat_at=${payload.heartbeat_at} is not a valid timestamp`,
    });
  } else {
    const ageMs = now.getTime() - heartbeatMs;
    if (ageMs > maxHeartbeatAgeMs) {
      lines.push({
        severity: "fail",
        message: `Token lock heartbeat stale: age_ms=${ageMs} > max=${maxHeartbeatAgeMs}`,
      });
    }
  }

  if (lines.length === 0) {
    lines.push({
      severity: "pass",
      message: `Token lock at ${lockPath} is consistent (pid=${payload.pid}, host=${payload.host})`,
    });
  }
  return lines;
}

export function checkRecentErrorLog(input: {
  errorLog: ErrorLogState;
  errorLogPath: string;
  relayIsRunning: boolean;
  lineLimit?: number;
}): HealthLine[] {
  const lineLimit = input.lineLimit ?? 200;
  if (input.errorLog.kind === "missing") {
    return [
      {
        severity: "warn",
        message: input.relayIsRunning
          ? `Relay error log missing at ${input.errorLogPath} despite a running relay`
          : `Relay error log missing at ${input.errorLogPath} (relay may not have run yet)`,
      },
    ];
  }
  const scan = scanRelayLogForRecentFailures(input.errorLog.text, { lineLimit });
  if (scan.hits.length === 0) {
    return [
      {
        severity: "pass",
        message: `Recent relay error log clean (no 409/401/NUL crash) - ${input.errorLogPath}`,
      },
    ];
  }
  const summary = scan.hits.reduce<Record<string, number>>((acc, h) => {
    acc[h.kind] = (acc[h.kind] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(summary).map(([kind, count]) => ({
    severity: "fail" as const,
    message: `Recent relay error log has ${count} ${kind} hits`,
  }));
}

export interface BuildHealthReportInput {
  mode: HealthCheckMode;
  tokenConfigured: boolean;
  processLines: string[];
  tokenLockState: TokenLockState;
  lockPath: string;
  expectedHost: string;
  expectedTokenHash: string;
  now: Date;
  maxHeartbeatAgeMs?: number;
  errorLog: ErrorLogState;
  errorLogPath: string;
  /**
   * When the caller (typically setup/verify) knows the launchd job is
   * loaded, pass this through so a zero-relay state graduates from warn
   * to fail in embedded mode. The standalone CLI cannot tell whether
   * launchd is loaded and leaves this undefined.
   */
  launchdRelayLoaded?: boolean;
}

export function buildHealthReport(input: BuildHealthReportInput): HealthReport {
  const lines: HealthLine[] = [];

  if (!input.tokenConfigured) {
    lines.push({
      severity: "fail",
      message: "TELEGRAM_BOT_TOKEN is not set in .env",
    });
    return { lines, standaloneExitCode: 2 };
  }

  const relayProcesses = findRelayProcesses(input.processLines);
  lines.push(
    ...checkSingletonRelay({
      relayProcesses,
      mode: input.mode,
      launchdRelayLoaded: input.launchdRelayLoaded,
    }),
  );

  lines.push(
    ...checkTokenLockHealth({
      tokenLockState: input.tokenLockState,
      lockPath: input.lockPath,
      relayIsRunning: relayProcesses.length >= 1,
      livePids: relayProcesses.map((p) => p.pid),
      expectedHost: input.expectedHost,
      expectedTokenHash: input.expectedTokenHash,
      now: input.now,
      maxHeartbeatAgeMs:
        input.maxHeartbeatAgeMs ?? TOKEN_LOCK_DEFAULT_STALE_AGE_MS,
    }),
  );

  lines.push(
    ...checkRecentErrorLog({
      errorLog: input.errorLog,
      errorLogPath: input.errorLogPath,
      relayIsRunning: relayProcesses.length >= 1,
    }),
  );

  const fails = lines.filter((l) => l.severity === "fail").length;
  return {
    lines,
    standaloneExitCode: fails > 0 ? 1 : 0,
  };
}

export function formatHealthLine(line: HealthLine): string {
  const prefix =
    line.severity === "pass" ? "PASS" : line.severity === "warn" ? "WARN" : "FAIL";
  return `${prefix} ${line.message}`;
}

// ---------------------------------------------------------------------------
// I/O wrappers
// ---------------------------------------------------------------------------

const RELAY_ERROR_LOG_BASENAME = "com.claude.telegram-relay.error.log";

/**
 * Resolve the file path the running relay's stderr is actually written
 * to. Precedence (most authoritative first):
 *
 *   1. Live launchctl print "stderr path = ..." — what the bootstrapped
 *      job is currently writing to. This wins because the installed
 *      plist on disk can drift away from the loaded job.
 *   2. Installed plist StandardErrorPath — the file launchd would use
 *      if it re-bootstrapped from the plist now.
 *   3. Launchd EnvironmentVariables.RELAY_LOG_DIR + basename.
 *   4. Launchd EnvironmentVariables.RELAY_DIR + "logs" + basename.
 *   5. .env RELAY_LOG_DIR + basename.
 *   6. .env RELAY_DIR + "logs" + basename.
 *   7. Default: <homeDir>/.claude-relay/logs + basename.
 *
 * setup/verify.ts knows about launchd; the standalone health CLI does
 * not and only passes the .env tier.
 */
export function resolveRelayErrorLogPath(input: {
  launchdLiveStandardErrorPath?: string;
  launchdPlistStandardErrorPath?: string;
  launchdEnvLogDir?: string;
  launchdEnvRelayDir?: string;
  dotenvLogDir?: string;
  dotenvRelayDir?: string;
  homeDir: string;
}): string {
  if (input.launchdLiveStandardErrorPath) return input.launchdLiveStandardErrorPath;
  if (input.launchdPlistStandardErrorPath) return input.launchdPlistStandardErrorPath;
  const launchdLogDir =
    input.launchdEnvLogDir
    || (input.launchdEnvRelayDir ? join(input.launchdEnvRelayDir, "logs") : undefined);
  const dotenvLogDir =
    input.dotenvLogDir
    || (input.dotenvRelayDir ? join(input.dotenvRelayDir, "logs") : undefined);
  const logDir =
    launchdLogDir
    || dotenvLogDir
    || join(input.homeDir, ".claude-relay", "logs");
  return join(logDir, RELAY_ERROR_LOG_BASENAME);
}

/**
 * Convenience wrapper for callers that have only .env / process.env at
 * hand (e.g. the standalone scripts/health-check.ts CLI). Real
 * launchd-aware callers should use resolveRelayErrorLogPath directly so
 * they can pass the plist tier.
 */
export function defaultErrorLogPath(env: Record<string, string | undefined> = process.env): string {
  return resolveRelayErrorLogPath({
    dotenvLogDir: env.RELAY_LOG_DIR,
    dotenvRelayDir: env.RELAY_DIR,
    homeDir: homedir(),
  });
}

function parseDotEnv(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

async function loadDotEnv(envPath: string): Promise<Record<string, string>> {
  try {
    const content = await Bun.file(envPath).text();
    return parseDotEnv(content);
  } catch {
    return {};
  }
}

export async function readProcessLines(): Promise<string[]> {
  const result = await runCommandWithTimeout(
    ["/bin/ps", "axww", "-o", "pid=,etime=,command="],
    { timeoutMs: 5_000 },
  );
  if (result.timedOut) {
    throw new Error("process list timed out after 5000ms");
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `ps exited ${result.code}`);
  }
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function loadTokenLockState(lockPath: string): TokenLockState {
  if (!existsSync(lockPath)) return { kind: "missing" };
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as TokenLockPayload;
    if (typeof parsed?.pid !== "number" || typeof parsed?.token_hash !== "string") {
      return { kind: "unparseable" };
    }
    return { kind: "payload", payload: parsed };
  } catch {
    return { kind: "unparseable" };
  }
}

export function loadErrorLogState(path: string): ErrorLogState {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch {
    return { kind: "missing" };
  }
}

export interface RunHealthCheckInput {
  mode: HealthCheckMode;
  /** Path to .env. Defaults to {projectRoot}/.env (caller resolves). */
  envPath?: string;
  now?: Date;
  /** Test hook: inject process lines instead of spawning ps. */
  processLines?: string[];
}

function defaultEnvPath(): string {
  // setup/ is one level below project root.
  return join(dirname(dirname(import.meta.path ?? "")), ".env");
}

export async function runHealthCheck(input: RunHealthCheckInput): Promise<HealthReport> {
  const envPath = input.envPath ?? defaultEnvPath();
  const env = await loadDotEnv(envPath);
  const token = env.TELEGRAM_BOT_TOKEN || "";
  const tokenConfigured = !!token && !token.includes("your_");
  const now = input.now ?? new Date();
  const errorLogPath = defaultErrorLogPath(env);

  if (!tokenConfigured) {
    return buildHealthReport({
      mode: input.mode,
      tokenConfigured: false,
      processLines: [],
      tokenLockState: { kind: "missing" },
      lockPath: "",
      expectedHost: hostname(),
      expectedTokenHash: "",
      now,
      errorLog: { kind: "missing" },
      errorLogPath,
    });
  }

  const lockPath = tokenLockPath(token);
  const tokenLockState = loadTokenLockState(lockPath);
  const errorLog = loadErrorLogState(errorLogPath);
  const processLines = input.processLines ?? (await readProcessLines());

  return buildHealthReport({
    mode: input.mode,
    tokenConfigured: true,
    processLines,
    tokenLockState,
    lockPath,
    expectedHost: hostname(),
    expectedTokenHash: tokenHash(token),
    now,
    errorLog,
    errorLogPath,
  });
}
