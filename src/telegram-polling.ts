// Retry interval when another poller holds the bot token.
// Short and fixed: the relay should reclaim the token quickly after the
// competing poller stops instead of waiting through a multi-minute backoff.
export const TELEGRAM_POLLING_CONFLICT_RETRY_DELAY_MS = 1_000;

export type TelegramPollingConflictKind =
  | "competing_poller"
  | "webhook_active"
  | "unknown_getupdates_409";

export interface TelegramPollingConflictDiagnosis {
  kind: TelegramPollingConflictKind;
  method: string | undefined;
  statusCode: number;
  message: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorRecords(error: unknown): Record<string, unknown>[] {
  const root = asRecord(error);
  const nested = root ? [root.error, root.cause].map(asRecord).filter(Boolean) : [];
  return root ? [root, ...nested] : [];
}

function firstStringField(
  records: Record<string, unknown>[],
  keys: string[],
): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return undefined;
}

function firstStatusCode(records: Record<string, unknown>[]): number | undefined {
  for (const record of records) {
    for (const key of ["error_code", "code", "status"]) {
      const value = record[key];
      if (value === 409) return 409;
      if (typeof value === "string" && Number.parseInt(value, 10) === 409) return 409;
    }
  }
  return undefined;
}

function joinedErrorText(error: unknown, records: Record<string, unknown>[]): string {
  const parts = [errorMessage(error)];
  for (const record of records) {
    for (const key of ["message", "description", "error_description"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) parts.push(value);
    }
  }
  return parts.join(" ");
}

function methodAllowsPollingConflict(method: string | undefined): boolean {
  return method === undefined || method === "getUpdates";
}

export function classifyTelegramPollingConflictError(
  error: unknown,
): TelegramPollingConflictDiagnosis | undefined {
  const records = errorRecords(error);
  const statusCode = firstStatusCode(records);
  const text = joinedErrorText(error, records);
  const method = firstStringField(records, ["method"]);
  const has409 = statusCode === 409 || /\b409\b/.test(text);

  if (!has409 || !methodAllowsPollingConflict(method)) return undefined;

  const isGetUpdates = method === "getUpdates" || /getUpdates|long polling/i.test(text);
  if (!isGetUpdates) return undefined;

  if (/webhook/i.test(text) && /active|deleteWebhook|can't use getUpdates/i.test(text)) {
    return { kind: "webhook_active", method, statusCode: 409, message: text };
  }

  if (
    /terminated by other getUpdates|other getUpdates request|only one bot instance|another poller|long polling/i
      .test(text)
  ) {
    return { kind: "competing_poller", method, statusCode: 409, message: text };
  }

  return { kind: "unknown_getupdates_409", method, statusCode: 409, message: text };
}

export function isTelegramPollingConflictError(error: unknown): boolean {
  return classifyTelegramPollingConflictError(error) !== undefined;
}

export function shouldEscalateTelegramPollingConflict(attempt: number): boolean {
  return attempt === 10 || (attempt > 10 && attempt % 60 === 0);
}

export function formatTelegramPollingConflictLog(input: {
  diagnosis: TelegramPollingConflictDiagnosis;
  attempt: number;
  elapsedMs: number;
  pid: number;
  retryDelayMs: number;
  lockFile: string;
  pluginEnvExists: boolean;
}): string {
  const elapsedSeconds = Math.max(0, Math.round(input.elapsedMs / 1000));
  return "[bot] Telegram getUpdates 409 " +
    `kind=${input.diagnosis.kind} ` +
    `pid=${input.pid} ` +
    `attempt=${input.attempt} ` +
    `elapsed_s=${elapsedSeconds} ` +
    `retry_ms=${input.retryDelayMs} ` +
    `plugin_env=${input.pluginEnvExists ? "present" : "absent"} ` +
    `lock=${input.lockFile}`;
}

export function formatTelegramPollingConflictHint(input: {
  diagnosis: TelegramPollingConflictDiagnosis;
  pluginEnvExists: boolean;
}): string {
  if (input.diagnosis.kind === "webhook_active") {
    return "[bot] Telegram webhook is active for this bot token. " +
      "Run setup:verify and delete the webhook before using getUpdates polling.";
  }

  if (input.pluginEnvExists) {
    return "[bot] Local Claude Telegram plugin config is active. " +
      "Disable ~/.claude/channels/telegram/.env or it can keep stealing getUpdates polling.";
  }

  return "[bot] Persistent getUpdates conflict with no local plugin config detected. " +
    "Check another Mac, launchd job, hosted service, or editor plugin using this same bot token.";
}
