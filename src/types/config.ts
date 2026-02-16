/**
 * Configuration types for the Claude Telegram Relay
 */

export interface AppConfig {
  /** Telegram bot token from @BotFather */
  botToken: string;

  /** Telegram user ID allowed to use the bot (empty = any user) */
  allowedUserId: string;

  /** Path to Claude CLI executable */
  claudePath: string;

  /** Claude model ID (e.g. claude-haiku-4-5-20251001). Omit for CLI default. */
  claudeModel?: string;

  /** Base directory for relay data */
  relayDir: string;

  /** Directory for temporary files */
  tempDir: string;

  /** Directory for uploaded files */
  uploadsDir: string;

  /** Path to session file */
  sessionFile: string;

  /** Path to lock file */
  lockFile: string;

  /** Optional: Supabase URL for cloud persistence */
  supabaseUrl?: string;

  /** Optional: Supabase anonymous key */
  supabaseAnonKey?: string;

  /** Memory file path for local persistence */
  memoryFile: string;

  /** Session inactivity timeout in milliseconds */
  sessionTtlMs: number;

  /** Default timeout for Claude CLI invocations in milliseconds */
  cliTimeoutMs: number;

  /** Environment mode */
  nodeEnv: "development" | "production" | "test";

  /** Log level */
  logLevel: "debug" | "info" | "warn" | "error";

  /** SecondBrain configuration (optional, disabled by default) */
  secondbrain?: import("./secondbrain").SecondBrainConfig;

  /** File access configuration (optional, disabled by default) */
  files?: import("./files").FilesConfig;
}

export interface ClaudeCallOptions {
  /** Path to image file to include in prompt */
  imagePath?: string;

  /** Timeout for Claude CLI call in milliseconds */
  timeout?: number;
}
