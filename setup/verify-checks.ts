// Pure, testable verification helpers used by setup/verify.ts. Keeping them
// here lets us unit-test the parsers and matchers without spinning up real
// launchd jobs or seeding chat.db on the test host.

export type FailureKind =
  | "telegram_409"
  | "telegram_401"
  | "spawn_nul_crash"
  | "imessage_stage_timeout"
  | "imessage_stage_failed"
  | "imessage_markers_missing";

export interface RelayLogScanHit {
  kind: FailureKind;
  line: string;
}

export interface RelayLogScanResult {
  hits: RelayLogScanHit[];
}

// Order matters: first match wins. Put the most specific pattern first so a
// "staging helper failed ... imessage_stage_timeout_25000ms" line classifies
// as a timeout, not the generic stage_failed.
const FAILURE_PATTERNS: { kind: FailureKind; regex: RegExp }[] = [
  // Match the relay's own 409 log line shape; do not match arbitrary "409"
  // tokens that show up in unrelated subsystems.
  { kind: "telegram_409", regex: /Telegram\s+getUpdates\s+409/i },
  { kind: "telegram_401", regex: /Telegram[^\n]*\b401\b|getMe\b[^\n]*401|Unauthorized:\s*invalid token/i },
  { kind: "spawn_nul_crash", regex: /ERR_INVALID_ARG_VALUE.*null bytes/i },
  // iMessage staging timeout. Scope to the relay's real log prefix so stale
  // notes or docs mentioning these tokens do not fail verification.
  {
    kind: "imessage_stage_timeout",
    regex: /\[imessage-draft\]\s+staging\s+helper\s+failed\b.*\b(?:imessage_stage_timeout_\d+ms|osascript_timeout)\b/i,
  },
  // Generic staging helper failure (osascript error, empty body, payload hash
  // mismatch, etc.) emitted from src/imessage-draft.ts. Scoped to the
  // [imessage-draft] prefix so unrelated "staging" mentions don't false-fire.
  { kind: "imessage_stage_failed", regex: /\[imessage-draft\]\s+staging\s+helper\s+failed/i },
  // Claude returned a response without the <<<IMESSAGE_DRAFT>>> marker block,
  // so the relay had nothing to stage. Usually a prompt regression.
  { kind: "imessage_markers_missing", regex: /\[imessage-draft\]\s+markers_missing\s+for/i },
];

export function scanRelayLogForRecentFailures(
  logText: string,
  options: { lineLimit: number },
): RelayLogScanResult {
  const allLines = logText.split(/\r?\n/);
  const lines = allLines.slice(Math.max(0, allLines.length - options.lineLimit));
  const hits: RelayLogScanHit[] = [];
  for (const line of lines) {
    for (const pattern of FAILURE_PATTERNS) {
      if (pattern.regex.test(line)) {
        hits.push({ kind: pattern.kind, line });
        break;
      }
    }
  }
  return { hits };
}

export type ResolverPythonSource = "launchd_plist" | "env" | "path";

export interface ResolverPythonSelection {
  command: string;
  source: ResolverPythonSource;
  pinned: boolean;
  label: string;
}

export function selectResolverPython(input: {
  launchdPython?: string;
  envPython?: string;
}): ResolverPythonSelection {
  const launchdPython = input.launchdPython?.trim();
  if (launchdPython) {
    return {
      command: launchdPython,
      source: "launchd_plist",
      pinned: true,
      label: "launchd RELAY_PYTHON",
    };
  }

  const envPython = input.envPython?.trim();
  if (envPython) {
    return {
      command: envPython,
      source: "env",
      pinned: true,
      label: ".env RELAY_PYTHON",
    };
  }

  return {
    command: "python3",
    source: "path",
    pinned: false,
    label: "launchd PATH",
  };
}

export interface LaunchdPolicy {
  environment: Record<string, string>;
  throttleInterval: number | undefined;
  exitTimeOut: number | undefined;
  keepAlive: true | false | Record<string, unknown>;
  standardOutPath: string | undefined;
  standardErrorPath: string | undefined;
}

export function parseLaunchdPlistJson(input: string): LaunchdPolicy | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const env = root.EnvironmentVariables;
  const environment: Record<string, string> = {};
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value === "string") environment[key] = value;
    }
  }
  const keepAliveRaw = root.KeepAlive;
  const keepAlive: LaunchdPolicy["keepAlive"] =
    typeof keepAliveRaw === "boolean"
      ? keepAliveRaw
      : keepAliveRaw && typeof keepAliveRaw === "object" && !Array.isArray(keepAliveRaw)
        ? (keepAliveRaw as Record<string, unknown>)
        : false;
  return {
    environment,
    throttleInterval: typeof root.ThrottleInterval === "number" ? root.ThrottleInterval : undefined,
    exitTimeOut: typeof root.ExitTimeOut === "number" ? root.ExitTimeOut : undefined,
    keepAlive,
    standardOutPath: typeof root.StandardOutPath === "string" ? root.StandardOutPath : undefined,
    standardErrorPath: typeof root.StandardErrorPath === "string" ? root.StandardErrorPath : undefined,
  };
}

export interface BunRealpathDriftResult {
  ok: boolean;
  drifted: boolean;
}

export function bunRealpathDriftCheck(
  currentRealpath: string,
  previousRealpath: string | null,
): BunRealpathDriftResult {
  if (previousRealpath === null) return { ok: true, drifted: false };
  if (currentRealpath === previousRealpath) return { ok: true, drifted: false };
  return { ok: false, drifted: true };
}
