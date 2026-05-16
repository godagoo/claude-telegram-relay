import { expect, test } from "bun:test";
import {
  TELEGRAM_POLLING_CONFLICT_RETRY_DELAY_MS,
  classifyTelegramPollingConflictError,
  formatTelegramPollingConflictHint,
  formatTelegramPollingConflictLog,
  isTelegramPollingConflictError,
  shouldEscalateTelegramPollingConflict,
} from "./telegram-polling";

test("detects Telegram getUpdates 409 conflict objects", () => {
  expect(
    isTelegramPollingConflictError({
      method: "getUpdates",
      error_code: 409,
      description: "Conflict: terminated by other getUpdates request",
    }),
  ).toBe(true);
});

test("classifies competing long polling conflicts", () => {
  const diagnosis = classifyTelegramPollingConflictError({
    method: "getUpdates",
    error: {
      error_code: 409,
      description: "Conflict: terminated by other getUpdates request",
    },
  });

  expect(diagnosis?.kind).toBe("competing_poller");
  expect(diagnosis?.method).toBe("getUpdates");
});

test("classifies active webhook conflicts separately", () => {
  const diagnosis = classifyTelegramPollingConflictError(
    new Error("Call to 'getUpdates' failed! (409: Conflict: can't use getUpdates method while webhook is active)"),
  );

  expect(diagnosis?.kind).toBe("webhook_active");
});

test("detects Telegram getUpdates 409 conflict messages", () => {
  expect(
    isTelegramPollingConflictError(
      new Error("Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates request)"),
    ),
  ).toBe(true);
});

test("does not classify unrelated Telegram errors as polling conflicts", () => {
  expect(
    isTelegramPollingConflictError({
      method: "sendMessage",
      error_code: 400,
      description: "Bad Request",
    }),
  ).toBe(false);
});

test("does not classify non-polling Telegram 409 objects as polling conflicts", () => {
  expect(
    isTelegramPollingConflictError({
      method: "sendMessage",
      error_code: 409,
      description: "Conflict in another Telegram method",
    }),
  ).toBe(false);
});

test("polling conflict retry delay is short and fixed", () => {
  expect(TELEGRAM_POLLING_CONFLICT_RETRY_DELAY_MS).toBe(1_000);
});

test("escalates persistent polling conflict diagnostics on bounded intervals", () => {
  expect(shouldEscalateTelegramPollingConflict(1)).toBe(false);
  expect(shouldEscalateTelegramPollingConflict(10)).toBe(true);
  expect(shouldEscalateTelegramPollingConflict(11)).toBe(false);
  expect(shouldEscalateTelegramPollingConflict(60)).toBe(true);
});

test("formats token-safe conflict diagnostics", () => {
  const diagnosis = classifyTelegramPollingConflictError({
    method: "getUpdates",
    error_code: 409,
    description: "Conflict: terminated by other getUpdates request",
  });
  expect(diagnosis).toBeDefined();

  const line = formatTelegramPollingConflictLog({
    diagnosis: diagnosis!,
    attempt: 10,
    elapsedMs: 12_200,
    pid: 123,
    retryDelayMs: TELEGRAM_POLLING_CONFLICT_RETRY_DELAY_MS,
    lockFile: "/Users/williamregan/.claude-relay/bot.lock",
    pluginEnvExists: false,
  });

  expect(line).toContain("kind=competing_poller");
  expect(line).toContain("attempt=10");
  expect(line).not.toContain("TELEGRAM_BOT_TOKEN");
  expect(line).not.toContain("bot123");
});

test("formats actionable persistent conflict hints", () => {
  const diagnosis = classifyTelegramPollingConflictError({
    method: "getUpdates",
    error_code: 409,
    description: "Conflict: terminated by other getUpdates request",
  });
  expect(diagnosis).toBeDefined();

  expect(formatTelegramPollingConflictHint({
    diagnosis: diagnosis!,
    pluginEnvExists: false,
  })).toContain("another Mac");
});
