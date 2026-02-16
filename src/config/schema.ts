/**
 * Configuration schema validation with Zod
 */

import { join } from "path";
import { z } from "zod";

const homeDir = process.env["HOME"] || "~";
const defaultRelayDir = join(homeDir, ".claude-relay");

export const configSchema = z.object({
  // Required
  botToken: z
    .string()
    .min(1, "TELEGRAM_BOT_TOKEN is required")
    .describe("Telegram bot token from @BotFather"),

  // Optional with defaults
  allowedUserId: z.string().default("").describe("Telegram user ID allowed to use the bot"),

  claudePath: z.string().default("claude").describe("Path to Claude CLI executable"),

  claudeModel: z
    .string()
    .optional()
    .describe("Claude model ID to use (e.g. claude-haiku-4-5-20251001)"),

  relayDir: z.string().default(defaultRelayDir).describe("Base directory for relay data"),

  nodeEnv: z
    .enum(["development", "production", "test"])
    .default("development")
    .describe("Environment mode"),

  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info").describe("Log level"),

  // Optional cloud persistence
  supabaseUrl: z.string().url().optional().describe("Supabase URL for cloud persistence"),

  supabaseAnonKey: z.string().optional().describe("Supabase anonymous key"),

  memoryFile: z.string().default("").describe("Path to local memory JSON file"),

  sessionTtlMs: z
    .number()
    .int()
    .positive()
    .default(86400000)
    .describe("Session inactivity timeout in milliseconds (default 24h)"),

  cliTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(120000)
    .describe("Default timeout for Claude CLI invocations in milliseconds (default 2min)"),

  // File access (optional, disabled by default)
  files: z
    .object({
      shareRoot: z.string().optional().describe("Absolute path to mounted Windows share"),
      brainRoot: z.string().optional().describe("Absolute path to SecondBrain data directory"),
      maxReadBytes: z
        .number()
        .int()
        .positive()
        .default(51200)
        .describe("Max bytes injectable by /read (default 50 KB)"),
      sharePollIntervalMs: z
        .number()
        .int()
        .positive()
        .default(10000)
        .describe("Share watcher poll interval in ms (default 10s)"),
      brainDebounceMs: z
        .number()
        .int()
        .positive()
        .default(2000)
        .describe("Brain watcher debounce delay in ms (default 2s)"),
    })
    .optional(),

  // SecondBrain (optional, disabled by default)
  secondbrain: z
    .object({
      enabled: z.boolean().default(false),
      dataDir: z.string().default(join(defaultRelayDir, "secondbrain")),
      confidenceThreshold: z.number().min(0).max(1).default(0.6),
      chatId: z.string().default(""),
      gitEnabled: z.boolean().default(false),
      gitAutoCommit: z.boolean().default(false),
      digest: z
        .object({
          daily: z
            .object({
              enabled: z.boolean().default(true),
              time: z.string().default("07:00"),
              timezone: z.string().default("America/Chicago"),
              limit: z.number().int().positive().default(3),
            })
            .default({}),
          weekly: z
            .object({
              enabled: z.boolean().default(true),
              day: z.string().default("sunday"),
              time: z.string().default("16:00"),
              timezone: z.string().default("America/Chicago"),
            })
            .default({}),
        })
        .default({}),
    })
    .optional(),
});

export type ConfigInput = z.input<typeof configSchema>;
export type ConfigOutput = z.output<typeof configSchema>;

/**
 * Parse SecondBrain-specific env vars into config input.
 */
function parseSecondBrainEnvVars(): ConfigInput["secondbrain"] {
  if (process.env["SECONDBRAIN_ENABLED"] !== "true") return undefined;

  return {
    enabled: true,
    dataDir: process.env["SECONDBRAIN_DATA_DIR"] || join(homeDir, ".claude-relay", "secondbrain"),
    confidenceThreshold: process.env["SECONDBRAIN_CONFIDENCE_THRESHOLD"]
      ? Number.parseFloat(process.env["SECONDBRAIN_CONFIDENCE_THRESHOLD"])
      : 0.6,
    chatId: process.env["TELEGRAM_USER_ID"] || "",
    gitEnabled: process.env["SECONDBRAIN_GIT_ENABLED"] === "true",
    gitAutoCommit: process.env["SECONDBRAIN_GIT_AUTOCOMMIT"] === "true",
    digest: {
      daily: {
        enabled: process.env["SECONDBRAIN_DIGEST_DAILY_ENABLED"] !== "false",
        time: process.env["SECONDBRAIN_DIGEST_DAILY_TIME"] || "07:00",
        timezone: process.env["SECONDBRAIN_DIGEST_DAILY_TIMEZONE"] || "America/Chicago",
        limit: process.env["SECONDBRAIN_DIGEST_DAILY_LIMIT"]
          ? Number.parseInt(process.env["SECONDBRAIN_DIGEST_DAILY_LIMIT"], 10)
          : 3,
      },
      weekly: {
        enabled: process.env["SECONDBRAIN_DIGEST_WEEKLY_ENABLED"] !== "false",
        day: process.env["SECONDBRAIN_DIGEST_WEEKLY_DAY"] || "sunday",
        time: process.env["SECONDBRAIN_DIGEST_WEEKLY_TIME"] || "16:00",
        timezone: process.env["SECONDBRAIN_DIGEST_WEEKLY_TIMEZONE"] || "America/Chicago",
      },
    },
  };
}

/**
 * Parse environment variables into config input
 */
export function parseEnvVars(): ConfigInput {
  return {
    botToken: process.env["TELEGRAM_BOT_TOKEN"] || "",
    allowedUserId: process.env["TELEGRAM_USER_ID"] || "",
    claudePath: process.env["CLAUDE_PATH"] || "claude",
    claudeModel: process.env["CLAUDE_MODEL"] || undefined,
    relayDir: process.env["RELAY_DIR"] || join(homeDir, ".claude-relay"),
    nodeEnv: (process.env["NODE_ENV"] as ConfigOutput["nodeEnv"]) || "development",
    logLevel: (process.env["LOG_LEVEL"] as ConfigOutput["logLevel"]) || "info",
    supabaseUrl: process.env["SUPABASE_URL"],
    supabaseAnonKey: process.env["SUPABASE_ANON_KEY"],
    memoryFile: process.env["MEMORY_FILE"] || "",
    sessionTtlMs: process.env["SESSION_TTL_MS"]
      ? Number.parseInt(process.env["SESSION_TTL_MS"], 10)
      : undefined,
    cliTimeoutMs: process.env["CLI_TIMEOUT_MS"]
      ? Number.parseInt(process.env["CLI_TIMEOUT_MS"], 10)
      : undefined,
    secondbrain: parseSecondBrainEnvVars(),
    files: parseFilesEnvVars(),
  };
}

/**
 * Parse file access env vars into config input.
 */
function parseFilesEnvVars(): ConfigInput["files"] {
  const shareRoot = process.env["FILES_SHARE_ROOT"];
  const brainRoot = process.env["FILES_BRAIN_ROOT"];

  // Fall back to secondbrain.dataDir for brainRoot when not explicitly set
  const resolvedBrainRoot = brainRoot ?? process.env["SECONDBRAIN_DATA_DIR"] ?? undefined;

  if (!shareRoot && !resolvedBrainRoot) return undefined;

  return {
    shareRoot,
    brainRoot: resolvedBrainRoot,
    maxReadBytes: process.env["FILES_MAX_READ_BYTES"]
      ? Number.parseInt(process.env["FILES_MAX_READ_BYTES"], 10)
      : undefined,
    sharePollIntervalMs: process.env["FILES_SHARE_POLL_INTERVAL_MS"]
      ? Number.parseInt(process.env["FILES_SHARE_POLL_INTERVAL_MS"], 10)
      : undefined,
    brainDebounceMs: process.env["FILES_BRAIN_DEBOUNCE_MS"]
      ? Number.parseInt(process.env["FILES_BRAIN_DEBOUNCE_MS"], 10)
      : undefined,
  };
}
