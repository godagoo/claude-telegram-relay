/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot } from "grammy";
import { spawn } from "bun";
import { constants, existsSync } from "fs";
import { writeFile, mkdir, readFile, unlink, access, open, chmod, rm } from "fs/promises";
import { join, dirname, basename, extname } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { splitPromptForClaudeCli } from "./prompt-split.ts";
import { transcribe } from "./transcribe.ts";
import {
  ANESTHESIA_CORPUS_INSTRUCTIONS,
  isAnesthesiaCorpusQuery,
} from "./anesthesia-corpus.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";
import { search as ftsSearch, renderContext as renderFtsContext, preflight as retrievalPreflight } from "./retrieval.ts";
import {
  findAnchoredProjects,
  retrieveAnchoredContext,
  renderAnchoredContext,
} from "./project-anchors.ts";
import { isReferential } from "./trigger.ts";
import {
  buildSearchQuery,
  countContentTokens,
  ENGLISH_ONLY_DIRECTIVE,
  type Turn,
} from "./query-builder.ts";
import { loadTurns, appendTurn } from "./short-term.ts";
import { buildCatalogResponse, buildSkippedTextbookResponse } from "./textbook-response.ts";
import { sanitizeClaudeResponse } from "./response-sanitize.ts";
import {
  extractIMessageDraftRequest,
  fetchIMessageContext,
  renderIMessageContext,
  type IMessageContextResult,
} from "./imessage-context.ts";
import {
  DRAFT_MARKER_CLOSE,
  DRAFT_MARKER_OPEN,
  NEW_COMPOSE_SENTINEL,
  extractDraftBody,
  placeIMessageDraft,
  rebuildAroundDraftBlock,
  replaceDraftBlock,
  stripPlacementClaims,
  type IMessageDraftStatus,
} from "./imessage-draft.ts";
import {
  clearUpdateMarker,
  loadSeenUpdateIds,
  logDecision,
  markUpdateStarted,
  markUpdateSent,
  sweepOldDecisionLogs,
  type DecisionRecord,
} from "./decision-log.ts";
import {
  clearICloudDriveDraft,
  shortcutInstallPath,
  writeICloudDriveDraft,
} from "./icloud-drive-draft.ts";
import {
  placeIPhoneMirrorDraft,
  shouldUseIPhoneMirrorPlacement,
} from "./iphone-mirror-draft.ts";
import {
  classifyMemoryCandidate,
  writeMemoryCandidate,
} from "./memory-capture.ts";
import {
  prepareTelegramResponseText,
  sendTelegramResponse,
} from "./telegram-response.ts";
import {
  TELEGRAM_POLLING_CONFLICT_RETRY_DELAY_MS,
  classifyTelegramPollingConflictError,
  formatTelegramPollingConflictHint,
  formatTelegramPollingConflictLog,
  shouldEscalateTelegramPollingConflict,
} from "./telegram-polling.ts";
import { getSupabaseFeatureConfig } from "./supabase-config.ts";
import { checkRelayBinaries, archLabel } from "./arch-check.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const DEFAULT_CLAUDE_PATH = join(homedir(), ".local", "bin", "claude");
const CLAUDE_PATH = process.env.CLAUDE_PATH || DEFAULT_CLAUDE_PATH;
const PROJECT_DIR = process.env.PROJECT_DIR || "";
// Pin the cwd for every `claude` spawn so future --resume work (Phase 1.1)
// can locate session JSONLs in a stable project bucket. Per
// platform.claude.com/docs/en/agent-sdk/sessions, sessions are stored under
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl with non-alphanumerics
// replaced by '-'. Inheriting launchd's cwd ('/') would scatter sessions.
const RELAY_CWD = process.env.PROJECT_DIR || process.env.RELAY_CWD || PROJECT_ROOT;
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const CLAUDE_TIMEOUT_MS = positiveIntEnv("CLAUDE_TIMEOUT_MS", 90_000);
const SESSION_TIMEOUT_ROTATE = process.env.SESSION_TIMEOUT_ROTATE !== "0";
const MAX_PROMPT_CHARS = 120_000;
const MAX_RECENT_TURNS_RENDERED = 6;
const CLAUDE_RESUME_ENABLED = process.env.CLAUDE_RESUME === "1";

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");
const MAX_VOICE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  createdAt?: string;
  lastActivity: string;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isUnsetPlaceholder(value: string): boolean {
  return !value.trim() || /^your_/i.test(value.trim());
}

function isDirectMessageIdentifier(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(trimmed) ||
    /^\+?[()\-\d\s]{7,}$/.test(trimmed);
}

async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

function declaredSizeTooLarge(size: number | undefined, maxBytes: number): boolean {
  return typeof size === "number" && Number.isFinite(size) && size > maxBytes;
}

function formatBytes(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await ensurePrivateDir(RELAY_DIR);
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(SESSION_FILE, 0o600).catch(() => undefined);
}

let session = await loadSession();

async function resetClaudeSession(reason: string): Promise<void> {
  console.log(`[session] reset Claude session: ${reason}`);
  session = { sessionId: null, lastActivity: new Date().toISOString() };
  await unlink(SESSION_FILE).catch(() => undefined);
}

async function rotateClaudeSessionAfterTimeout(): Promise<void> {
  if (!SESSION_TIMEOUT_ROTATE) return;
  await resetClaudeSession("claude_timeout");
}

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(): Promise<boolean> {
  try {
    await ensurePrivateDir(RELAY_DIR);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(LOCK_FILE, "wx", 0o600);
        await handle.writeFile(process.pid.toString(), "utf8");
        await handle.close();
        await chmod(LOCK_FILE, 0o600).catch(() => undefined);
        return true;
      } catch (err) {
        if ((err as { code?: string }).code !== "EEXIST") throw err;

        const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => "");
        const pid = Number.parseInt(existingLock, 10);
        if (isProcessAlive(pid)) {
          console.log(`Another instance running (PID: ${pid})`);
          return false;
        }

        console.log("Stale lock found, taking over...");
        await unlink(LOCK_FILE).catch(() => undefined);
      }
    }

    return false;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => "");
  if (Number.parseInt(existingLock, 10) === process.pid) {
    await unlink(LOCK_FILE).catch(() => {});
  }
}

// Cleanup on exit
process.on("exit", () => {
  try {
    const fs = require("fs");
    const existingLock = fs.readFileSync(LOCK_FILE, "utf8");
    if (Number.parseInt(existingLock, 10) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

if (isUnsetPlaceholder(ALLOWED_USER_ID) || !/^\d+$/.test(ALLOWED_USER_ID.trim())) {
  console.error("TELEGRAM_USER_ID must be set to your numeric Telegram user ID.");
  console.log("\nThis relay can spawn a local Claude Code process, so it refuses to run without an explicit Telegram allowlist.");
  console.log("Get your ID from @userinfobot and set TELEGRAM_USER_ID in .env.");
  process.exit(1);
}

try {
  await access(RELAY_CWD, constants.R_OK);
} catch {
  console.error(`RELAY_CWD is not readable: ${RELAY_CWD}`);
  console.log("Set PROJECT_DIR or RELAY_CWD to the relay workspace path.");
  process.exit(1);
}

// Create directories
await ensurePrivateDir(RELAY_DIR);
await ensurePrivateDir(TEMP_DIR);
await ensurePrivateDir(UPLOADS_DIR);

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;
const supabaseFeatures = getSupabaseFeatureConfig(process.env);

if (supabase) {
  console.log(
    `[supabase] configured history=${supabaseFeatures.messageHistory} relevant_context=${supabaseFeatures.relevantContext} durable_memory=${supabaseFeatures.durableMemory} memory_authority=${supabaseFeatures.memoryAuthority}`,
  );
}

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase || !supabaseFeatures.messageHistory) return;
  try {
    const { error } = await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      metadata: metadata || {},
    });
    if (error) {
      console.error(
        `[supabase] message insert failed role=${role}: ${error.message}`,
      );
    }
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

const seenUpdates: Set<number> = await loadSeenUpdateIds();
const sentUpdates = new Set<number>();
let retrievalAvailable = false;
let retrievalStartupError: string | undefined;

async function markUpdateSentAndRemember(updateId: number): Promise<void> {
  await markUpdateSent(updateId);
  sentUpdates.add(updateId);
}

bot.use(async (ctx, next) => {
  const updateId = ctx.update.update_id;
  if (seenUpdates.has(updateId)) {
    return;
  }

  seenUpdates.add(updateId);
  await markUpdateStarted(updateId);

  try {
    await next();
    await clearUpdateMarker(updateId);
    sentUpdates.delete(updateId);
  } catch (err) {
    await logDecision({
      ts: new Date().toISOString(),
      update_id: updateId,
      chat_id: ctx.chat?.id ?? 0,
      message: ctx.message && "text" in ctx.message ? ctx.message.text ?? "" : "",
      trigger_fired: false,
      hit_count: 0,
      hits_summary: [],
      injected_count: 0,
      total_ms: 0,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    if (!sentUpdates.has(updateId)) {
      seenUpdates.delete(updateId);
      await clearUpdateMarker(updateId);
    }
    throw err;
  }
});

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    await markUpdateSentAndRemember(ctx.update.update_id);
    return;
  }

  await next();
});

// Per-chat FIFO for every update type. The text handler already calls
// enqueue(); enqueue is re-entrant so nested calls from inside this middleware
// run directly instead of deadlocking on their own queue slot.
bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    await next();
    return;
  }

  await enqueue(String(chatId), ctx.update.update_id, next);
});

// ============================================================
// CORE: Call Claude CLI
// ============================================================

function buildClaudeEnv(): Record<string, string> {
  const names = [
    "HOME",
    "PATH",
    "SHELL",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CONFIG_DIR",
  ];
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function sanitizeStderr(stderr: string): string {
  return stderr
    .replace(/(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|TELEGRAM_BOT_TOKEN)=\S+/g, "$1=[redacted]")
    .slice(0, 4000);
}

function parseClaudeCliOutput(output: string): { text: string; sessionId?: string } {
  const trimmed = output.trim();
  if (!trimmed) return { text: "" };

  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    const sessionId =
      typeof data.session_id === "string"
        ? data.session_id
        : typeof data.sessionId === "string"
          ? data.sessionId
          : undefined;
    const text =
      typeof data.result === "string"
        ? data.result
        : typeof data.content === "string"
          ? data.content
          : typeof data.message === "string"
            ? data.message
            : trimmed;
    return { text: text.trim(), sessionId };
  } catch {
    return { text: trimmed };
  }
}

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; allowedTools?: string[]; addDirs?: string[]; cwd?: string }
): Promise<string> {
  const { systemPrompt, userPrompt } = splitPromptForClaudeCli(prompt);
  const args = [CLAUDE_PATH, "-p", userPrompt];

  if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }

  // Resume previous session if available and requested
  if (CLAUDE_RESUME_ENABLED && options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  if (!CLAUDE_RESUME_ENABLED) {
    args.push("--no-session-persistence");
  }
  args.push("--tools", (options?.allowedTools ?? []).join(","));
  for (const dir of options?.addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  args.push("--output-format", "json");

  console.log(`Calling Claude: ${userPrompt.substring(0, 80)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: options?.cwd ?? RELAY_CWD,
      env: buildClaudeEnv(),
      timeout: CLAUDE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });

    const [output, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const signalCode = (proc as { signalCode?: string | null }).signalCode;
    if (signalCode === "SIGKILL") {
      await rotateClaudeSessionAfterTimeout();
      throw new Error(`claude_timeout_${CLAUDE_TIMEOUT_MS}ms`);
    }

    if (exitCode !== 0) {
      const sanitized = sanitizeStderr(stderr || `exit_code=${exitCode}`);
      console.error("Claude error:", sanitized);
      throw new Error(`claude_exit_${exitCode}: ${sanitized}`);
    }

    const parsed = parseClaudeCliOutput(output);
    if (CLAUDE_RESUME_ENABLED && parsed.sessionId) {
      if (!session.createdAt || session.sessionId !== parsed.sessionId) {
        session.createdAt = new Date().toISOString();
      }
      session.sessionId = parsed.sessionId;
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return parsed.text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("claude_timeout_")) {
      throw new Error(`claude_timeout_${CLAUDE_TIMEOUT_MS}ms`);
    }
    if (message.startsWith("claude_exit_")) {
      throw new Error(message);
    }
    console.error("Spawn error:", error);
    throw new Error(`claude_spawn_failed: ${message}`);
  }
}

// ============================================================
// HARDENING HELPERS (Phase 1 v1)
// ============================================================

// Per-chat FIFO queue. Two messages from the same chat process in order;
// different chats are independent. Prevents state.json races.
const chatQueues = new Map<string, Promise<unknown>>();
const queueContext = new AsyncLocalStorage<string>();

function enqueue<T>(chatId: string, updateId: number, fn: () => Promise<T>): Promise<T> {
  if (queueContext.getStore() === chatId) return fn();

  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => queueContext.run(chatId, fn));
  const logged = next.catch(async (err) => {
    await logDecision({
      ts: new Date().toISOString(),
      update_id: updateId,
      chat_id: chatId,
      message: "",
      trigger_fired: false,
      hit_count: 0,
      hits_summary: [],
      injected_count: 0,
      total_ms: 0,
      error: `enqueue_caught: ${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  });
  chatQueues.set(chatId, logged.catch(() => undefined));
  return logged;
}

// stripMemoryTags / stripWrapperTags moved to ./response-sanitize.ts so they
// can be unit-tested without importing the relay module's startup side effects
// (lock acquisition, bot construction). Layer 1 of the memory-tag leak fix
// (gating the prompt instruction on `supabase`) is in buildPrompt.

// Plain-text recent-turns renderer (locked v1 decision: no XML in prompts).
// short-term.ts also exports renderRecentTurns which emits XML; we use this
// plain-text variant instead.
function isStaleIMessageAccessFailure(turn: Turn): boolean {
  return (
    turn.role === "assistant" &&
    /cannot read your iMessage history|Full Disk Access for the relay's bun binary|drafting from your description, not from actual prior messages/i.test(turn.content)
  );
}

function renderRecentTurnsPlain(
  turns: Turn[],
  cap = MAX_RECENT_TURNS_RENDERED,
  opts?: { suppressStaleIMessageFailures?: boolean },
): string {
  if (turns.length === 0) return "";
  const source = opts?.suppressStaleIMessageFailures
    ? turns.filter((turn) => !isStaleIMessageAccessFailure(turn))
    : turns;
  const trimmed = source.slice(-cap);
  if (trimmed.length === 0) return "";
  const lines = trimmed.map((t) => `${t.role}: ${t.content}`);
  return `RECENT CONVERSATION:\n${lines.join("\n")}`;
}

function capPrompt(prompt: string, userMessage?: string): string {
  if (prompt.length <= MAX_PROMPT_CHARS) return prompt;
  const note =
    `\n\n[TRUNCATED: prompt exceeded relay safety limit of ${MAX_PROMPT_CHARS} chars]`;
  const userBlock = userMessage === undefined ? "" : `\nUser: ${userMessage}`;

  if (
    userBlock &&
    prompt.endsWith(userBlock) &&
    userBlock.length + note.length + 1000 < MAX_PROMPT_CHARS
  ) {
    const headBudget = MAX_PROMPT_CHARS - userBlock.length - note.length;
    return prompt.slice(0, headBudget) + note + userBlock;
  }

  return prompt.slice(0, Math.max(0, MAX_PROMPT_CHARS - note.length)) + note;
}

function ensureSendableResponse(text: string, fallback: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function safeUploadExtension(fileName?: string): string {
  const ext = extname(basename(fileName ?? "")).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : "";
}

async function createUploadWorkDir(updateId: number): Promise<string> {
  const dir = join(UPLOADS_DIR, `${updateId}-${Date.now()}-${randomUUID()}`);
  await mkdir(dir, { recursive: false, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  return dir;
}

async function downloadTelegramFile(
  args: {
    filePath?: string;
    fileId: string;
    declaredSize?: number;
    maxBytes: number;
    kind: "voice" | "image" | "document";
  },
): Promise<Buffer> {
  if (!args.filePath) {
    throw new Error(`telegram_${args.kind}_missing_file_path`);
  }
  if (declaredSizeTooLarge(args.declaredSize, args.maxBytes)) {
    throw new Error(
      `telegram_${args.kind}_too_large_declared_${args.declaredSize}_max_${args.maxBytes}`,
    );
  }

  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${args.filePath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`telegram_${args.kind}_download_http_${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > args.maxBytes) {
    throw new Error(
      `telegram_${args.kind}_too_large_content_length_${contentLength}_max_${args.maxBytes}`,
    );
  }
  if (!response.body) {
    throw new Error(`telegram_${args.kind}_download_missing_body`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > args.maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Ignore stream cleanup failure.
      }
      throw new Error(
        `telegram_${args.kind}_too_large_stream_${received}_max_${args.maxBytes}`,
      );
    }
    chunks.push(value);
  }

  console.log(
    `[telegram-file] kind=${args.kind} file_id=${args.fileId} declared_bytes=${args.declaredSize ?? "n/a"} downloaded_bytes=${received} max=${formatBytes(args.maxBytes)} content_type=${response.headers.get("content-type") ?? "n/a"}`,
  );
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

// Concrete reframes for the 90s timeout. "Try a narrower request" was flagged
// as unactionable (see feedback_timeout_message_unhelpful.md). Pick suggestions
// that match the shape of the user's question so the next attempt has a path.
function buildTimeoutFallback(_userMessage: string): string {
  const sec = Math.round(CLAUDE_TIMEOUT_MS / 1000);
  return `Claude timed out at ${sec}s. Started a fresh session. Please re-send your request.`;
}

function shouldAcknowledgeFeedbackWithoutClaude(userMessage: string): boolean {
  return (
    /\b(?:please\s+)?log\s+this\b[\s\S]{0,120}\b(?:un+acceptable|wrong|bad|poor)\s+response\b/i.test(userMessage) ||
    /\bthis\s+response\s+(?:is|was)\s+(?:un+acceptable|wrong|bad|poor)\b/i.test(userMessage)
  );
}

function shouldDeclineAlreadyAnsweredLastMessageDraft(
  text: string,
  imessageContextResult: IMessageContextResult | null,
  draftRequest: ReturnType<typeof extractIMessageDraftRequest>,
): boolean {
  if (!draftRequest?.wantsPlacement || draftRequest.directBody) return false;
  if (imessageContextResult?.status !== "found") return false;
  if (imessageContextResult.messages[0]?.sender !== "me") return false;

  const asksForLastMessageReply =
    /\b(?:reply|respond)\b[\s\S]{0,80}\blast\s+(?:message|text|imessage|sms|one)\b/i.test(text) ||
    /\blast\s+(?:message|text|imessage|sms|one)\b[\s\S]{0,80}\b(?:reply|respond)\b/i.test(text);

  return asksForLastMessageReply;
}

interface PostClaudeResult {
  text: string;
  memoryTagsStripped: number;
  wrapperTagsStripped: number;
  scaffoldingTagsStripped: number;
  turnMarkersStripped: number;
  proseDashesStripped: number;
}

async function postProcessClaudeResponse(
  raw: string,
  fallback: string,
): Promise<PostClaudeResult> {
  const intentResult = supabase && supabaseFeatures.durableMemory
    ? await processMemoryIntents(supabase, raw)
    : raw;
  const cleanResult = sanitizeClaudeResponse(intentResult);

  if (cleanResult.wrapperTagsStripped > 0) {
    console.log(
      `[wrapper-tag-strip] removed ${cleanResult.wrapperTagsStripped} bare wrapper tag(s)`,
    );
    if (CLAUDE_RESUME_ENABLED) {
      await resetClaudeSession("wrapper tag emitted");
    }
  }

  if (cleanResult.scaffoldingTagsStripped > 0) {
    console.error(
      `[scaffolding-leak] removed ${cleanResult.scaffoldingTagsStripped} internal scaffolding tag(s) (system-reminder/command-*)`,
    );
    if (CLAUDE_RESUME_ENABLED) {
      await resetClaudeSession("scaffolding tag emitted");
    }
  }

  if (cleanResult.turnMarkersStripped > 0) {
    console.log(
      `[turn-marker-strip] removed leaked User:/Assistant: turn marker from response`,
    );
  }

  const strippedTotal =
    cleanResult.memoryTagsStripped +
    cleanResult.wrapperTagsStripped +
    cleanResult.scaffoldingTagsStripped +
    cleanResult.turnMarkersStripped +
    cleanResult.proseDashesStripped;
  if (strippedTotal > 0) {
    console.log(
      `[response-sanitize] memory=${cleanResult.memoryTagsStripped} wrapper=${cleanResult.wrapperTagsStripped} scaffolding=${cleanResult.scaffoldingTagsStripped} turn=${cleanResult.turnMarkersStripped} prose_dashes=${cleanResult.proseDashesStripped}`,
    );
  }

  return {
    text: ensureSendableResponse(cleanResult.clean, fallback),
    memoryTagsStripped: cleanResult.memoryTagsStripped,
    wrapperTagsStripped: cleanResult.wrapperTagsStripped,
    scaffoldingTagsStripped: cleanResult.scaffoldingTagsStripped,
    turnMarkersStripped: cleanResult.turnMarkersStripped,
    proseDashesStripped: cleanResult.proseDashesStripped,
  };
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages (Phase 1 v1: trigger-gated FTS, short-term ring buffer,
// per-chat FIFO queue, decision JSONL, two-layer memory-tag leak fix.)
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const chatId = String(ctx.chat.id);
  const updateId = ctx.update.update_id;

  await enqueue(chatId, updateId, async () => {
    const t0 = Date.now();
    const ts = new Date().toISOString();
    console.log(`Message: ${text.substring(0, 50)}...`);

    await ctx.replyWithChatAction("typing");
    await saveMessage("user", text);

    // Load recent turns for query builder + prompt block; append the user
    // turn before retrieval so it's persisted even on later failure.
    const recentTurns = await loadTurns(chatId);
    const turnBufferSizeBefore = recentTurns.length;
    await appendTurn(chatId, { role: "user", content: text, ts });

    // Trigger gating: run FTS for referential/project-memory messages and for
    // anesthesia-domain questions that should consult the textbook corpus.
    const referential = isReferential(text);
    const corpusQuery = referential || isAnesthesiaCorpusQuery(text);
    const queryContentTokens = countContentTokens(text);
    const searchQuery = corpusQuery && retrievalAvailable
      ? buildSearchQuery(text, recentTurns)
      : "";
    const tRetrieval0 = Date.now();
    let retrievalMs: number | undefined;
    let timeoutKind: "fts" | "claude" | undefined;
    let retrievalError: string | undefined = corpusQuery && !retrievalAvailable
      ? `retrieval_unavailable${retrievalStartupError ? `: ${retrievalStartupError}` : ""}`
      : undefined;
    let ftsHits: Awaited<ReturnType<typeof ftsSearch>> = [];
    if (corpusQuery && searchQuery) {
      try {
        ftsHits = await ftsSearch(searchQuery, 8);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        retrievalError = msg;
        if (msg.startsWith("fts_timeout_")) timeoutKind = "fts";
        console.error("[retrieval] search failed:", msg);
      } finally {
        retrievalMs = Date.now() - tRetrieval0;
      }
    }

    // Compose relevant-context block: recent conversation + indexed content
    // + supabase fallback (inert when Supabase is null).
    const indexedContent = renderFtsContext(ftsHits);
    // Higher-level intent: contact + whether the user wants prior thread
    // context fetched + whether the draft should be placed in Messages.app.
    // Placement defaults to TRUE for any iMessage/text/SMS draft so the user
    // doesn't have to repeat "directly in the iMessage box" each time.
    const draftRequest = extractIMessageDraftRequest(text);
    const directResolvedRecipient =
      draftRequest?.directBody &&
      !draftRequest.wantsContext &&
      isDirectMessageIdentifier(draftRequest.contact)
        ? draftRequest.contact
        : undefined;
    const imessageContextResult: IMessageContextResult | null = directResolvedRecipient
      ? {
          request: {
            contact: draftRequest!.contact,
            limit: draftRequest!.contextLimit,
          },
          status: "empty",
          messages: [],
          resolvedRecipient: directResolvedRecipient,
        }
      : draftRequest
        ? await fetchIMessageContext(PROJECT_ROOT, {
          contact: draftRequest.contact,
          limit: draftRequest.contextLimit,
        })
        : null;
    const wantsIMessagePlacement = draftRequest?.wantsPlacement ?? false;
    // Inject thread context for named iMessage drafts, including direct-body
    // requests like "Text Jacqueline saying ...". The supplied body is the
    // user's core meaning, not proof we should skip the user's writing rules or
    // the last 5-10 messages from the actual thread. Direct phone/email targets
    // still bypass context because there is no safe local thread name to read.
    //
    // Previously this was gated away whenever `directBody` existed, which made
    // the relay place literal text and skip Claude entirely. Live failure
    // 2026-05-17: "Text jacqueline saying where you at?" wrote exactly that
    // phrase even though the thread context was available.
    const hasThreadContextForDrafting =
      Boolean(imessageContextResult) &&
      !directResolvedRecipient &&
      (imessageContextResult!.status === "found" ||
        imessageContextResult!.status === "empty");
    const shouldInjectContext =
      Boolean(imessageContextResult) &&
      !directResolvedRecipient &&
      (!draftRequest?.directBody || hasThreadContextForDrafting);
    const imessageContext = shouldInjectContext
      ? renderIMessageContext(imessageContextResult!)
      : "";
    if (imessageContextResult && draftRequest) {
      console.log(
        `[imessage-context] contact=${imessageContextResult.request.contact} status=${imessageContextResult.status} messages=${imessageContextResult.messages.length} render_context=${shouldInjectContext} placement=${wantsIMessagePlacement}`,
      );
    }
    if (wantsIMessagePlacement) {
      const clearDraft = await clearICloudDriveDraft();
      if (clearDraft.ok) {
        console.log(
          `[imessage-draft] cleared stale iCloud handoff before new placement request path=${clearDraft.path ?? "unknown"}`,
        );
      } else {
        console.error(
          `[imessage-draft] failed to clear stale iCloud handoff before new placement request: ${clearDraft.error ?? "unknown error"}`,
        );
      }
    }
    const recentBlock = renderRecentTurnsPlain(recentTurns, MAX_RECENT_TURNS_RENDERED, {
      suppressStaleIMessageFailures: Boolean(imessageContextResult),
    });
    // Project-anchor retrieval: deterministic. If the user message contains
    // anchors for a known project (e.g. "lawyers / Saint Amman / MIET" →
    // Medicolegal-Case), pull the top hits from that project's paths and
    // inject them so Claude has context Saint-Amman-the-supervisor is real,
    // not invented. See config/project-anchors.json.
    let projectAnchorBlock = "";
    let anchoredProjectNames: string[] = [];
    try {
      const matches = await findAnchoredProjects(text);
      anchoredProjectNames = matches.map((m) => m.project.name);
      if (matches.length > 0) {
        const anchored = await retrieveAnchoredContext(matches);
        projectAnchorBlock = renderAnchoredContext(anchored);
        if (projectAnchorBlock) {
          console.log(
            `[project-anchors] injected ${anchored.reduce((n, h) => n + h.chunks.length, 0)} chunk(s) across ${anchored.length} project(s)`,
          );
        }
      }
    } catch (err) {
      console.error("[project-anchors] failed:", err instanceof Error ? err.message : err);
    }
    const [supabaseContext, memoryContext] = supabase
      ? await Promise.all([
          supabaseFeatures.relevantContext
            ? getRelevantContext(supabase, text)
            : Promise.resolve(""),
          supabaseFeatures.durableMemory
            ? getMemoryContext(supabase)
            : Promise.resolve(""),
        ])
      : ["", ""];
    const combinedRelevant = [imessageContext, recentBlock, projectAnchorBlock, indexedContent, supabaseContext]
      .filter(Boolean)
      .join("\n\n");
    const directIMessageBody =
      wantsIMessagePlacement &&
      draftRequest?.directBody &&
      !draftRequest.wantsContext &&
      !hasThreadContextForDrafting
        ? draftRequest.directBody
        : undefined;
    const alreadyAnsweredLastMessageDraft =
      shouldDeclineAlreadyAnsweredLastMessageDraft(
        text,
        imessageContextResult,
        draftRequest,
      );
    const shouldClarifyMissingIMessageBody =
      wantsIMessagePlacement &&
      Boolean(draftRequest) &&
      !directIMessageBody &&
      !alreadyAnsweredLastMessageDraft &&
      !draftRequest?.wantsContext &&
      imessageContextResult?.status !== "found" &&
      !imessageContextResult?.resolvedRecipient;

    const enrichedPrompt = capPrompt(
      buildPrompt(text, combinedRelevant, memoryContext, {
        iMessageDraftContact: wantsIMessagePlacement
          ? draftRequest?.contact
          : undefined,
      }),
      text,
    );

    const tClaude0 = Date.now();
    let assistantText = "";
    let memoryTagsStripped = 0;
    let wrapperTagsStripped = 0;
    let scaffoldingTagsStripped = 0;
    let turnMarkersStripped = 0;
    let proseDashesStripped = 0;
    let errorMsg: string | undefined;
    const deterministicTextbookResponse = buildSkippedTextbookResponse(text, ftsHits, {
      referentialFired: referential,
      contentTokenCount: queryContentTokens,
    });
    const deterministicCatalogResponse = buildCatalogResponse(ftsHits);
    if (deterministicTextbookResponse) {
      assistantText = deterministicTextbookResponse;
    } else if (deterministicCatalogResponse) {
      assistantText = deterministicCatalogResponse;
    } else if (directIMessageBody) {
      assistantText = `${DRAFT_MARKER_OPEN}\n${directIMessageBody}\n${DRAFT_MARKER_CLOSE}`;
    } else if (alreadyAnsweredLastMessageDraft) {
      const contactLabel = draftRequest?.contact ?? "that contact";
      const latestText = imessageContextResult?.messages[0]?.text
        ?.replace(/\s+/g, " ")
        .trim();
      const clearDraft = await clearICloudDriveDraft();
      if (clearDraft.ok) {
        console.log(
          `[imessage-draft] cleared stale iCloud handoff after already-answered last-message request path=${clearDraft.path ?? "unknown"}`,
        );
      } else {
        console.error(
          `[imessage-draft] failed to clear stale iCloud handoff after already-answered request: ${clearDraft.error ?? "unknown error"}`,
        );
      }
      assistantText = latestText
        ? `The latest message I can see in ${contactLabel}'s thread is already from you: "${latestText}". I did not open a new draft. Tell me what you want to add if you still want a follow up.`
        : `The latest message I can see in ${contactLabel}'s thread is already from you. I did not open a new draft. Tell me what you want to add if you still want a follow up.`;
    } else if (shouldClarifyMissingIMessageBody) {
      const contactLabel = draftRequest?.contact ?? "that contact";
      assistantText = `I couldn't find a Messages thread for ${contactLabel}, and I don't have the message body yet. Send me the phone/email plus what you want it to say.`;
    } else if (shouldAcknowledgeFeedbackWithoutClaude(text)) {
      assistantText = "Logged.";
    } else {
      try {
        const raw = await callClaude(enrichedPrompt, { resume: true });
        const processed = await postProcessClaudeResponse(
          raw,
          "Hmm, I didn't generate a useful reply this time. Could you rephrase or ask a more specific question?",
        );
        assistantText = processed.text;
        memoryTagsStripped = processed.memoryTagsStripped;
        wrapperTagsStripped = processed.wrapperTagsStripped;
        scaffoldingTagsStripped = processed.scaffoldingTagsStripped;
        turnMarkersStripped = processed.turnMarkersStripped;
        proseDashesStripped = processed.proseDashesStripped;
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
        if (errorMsg.startsWith("claude_timeout_")) {
          timeoutKind = "claude";
          assistantText = buildTimeoutFallback(text);
        } else {
          assistantText = "Sorry, something went wrong on my end. Try again.";
        }
      }
    }
    // Strip "Draft above, review and send manually" and similar boilerplate
    // footers Claude likes to append. Hard-banned by 2026-05-11 feedback.
    // Applied here (before placement logic) so it works for placement AND
    // non-placement drafts alike. For placement requests, rebuildAroundDraftBlock
    // already strips claims from the lead and discards anything after the
    // marker block — this catches the plain-text case where there are no
    // markers and Claude just appends the boilerplate.
    const hasDraftMarkerBlock =
      assistantText.includes(DRAFT_MARKER_OPEN) &&
      assistantText.includes(DRAFT_MARKER_CLOSE);
    if (!(wantsIMessagePlacement && hasDraftMarkerBlock)) {
      assistantText = stripPlacementClaims(assistantText).trim();
    }
    const claudeMs = Date.now() - tClaude0;

    let imessageDraftStatus: IMessageDraftStatus | undefined;
    let imessageDraftMode:
      | "pasted"
      | "new_compose"
      | "clipboard_only"
      | "icloud_drive_file"
      | "iphone_mirror_typed"
      | undefined;
    let imessageDraftHandoffPath: string | undefined;
    let imessageDraftBodySha256: string | undefined;
    let imessageDraftShortcutUrl: string | undefined;
    if (shouldClarifyMissingIMessageBody) {
      imessageDraftStatus = "no_recipient";
    }
    if (
      wantsIMessagePlacement &&
      !shouldClarifyMissingIMessageBody &&
      !alreadyAnsweredLastMessageDraft
    ) {
      const body = extractDraftBody(assistantText);
      const resolved = imessageContextResult?.resolvedRecipient;
      const contactLabel =
        draftRequest?.contact ?? resolved ?? "this contact";

      if (!body) {
        imessageDraftStatus = "markers_missing";
        // No marker block means Claude ignored the placement instruction. Strip
        // any orphan markers AND any hallucinated "Draft is placed" lines so
        // the relay's "couldn't place" message isn't contradicted.
        const stripped = stripPlacementClaims(
          replaceDraftBlock(assistantText, ""),
        ).trim();
        assistantText = stripped.length > 0
          ? `${stripped}\n\n(I couldn't place this in Messages this time.)`
          : "(I couldn't place this in Messages this time.)";
        console.error(
          `[imessage-draft] markers_missing for ${contactLabel}; resp_chars=${assistantText.length}`,
        );
      } else {
        // Three real placement paths:
        //   - resolved → write latest draft to the iCloud Drive container
        //     for the iPhone Shortcut handoff.
        //   - resolved + handoff unavailable → place into that contact's
        //     existing Mac thread.
        //   - genuinely unresolved contact -> open a fresh New Message compose
        //     on the Mac with the body prefilled and the To: field blank.
        // Context lookup failures are setup/runtime problems, not a safe reason
        // to open a blank-recipient compose.
        const contextStatus = imessageContextResult?.status;
        if (
          !resolved &&
          (contextStatus === "fda_denied" ||
            contextStatus === "error" ||
            contextStatus === "timeout")
        ) {
          imessageDraftStatus = "no_recipient";
          const hint = contextStatus === "fda_denied"
            ? "Couldn't open Messages on your Mac - Full Disk Access is missing. See docs/IMESSAGE-SETUP.md."
            : "Couldn't place this in Messages because contact resolution failed. Run `bun run setup:verify` on the Mac and check the relay logs.";
          assistantText = rebuildAroundDraftBlock(
            assistantText,
            `${body}\n\n${hint}`,
          );
          console.error(
            `[imessage-draft] no_recipient for ${contactLabel} (context_status=${contextStatus}${imessageContextResult?.error ? ` error=${JSON.stringify(imessageContextResult.error)}` : ""})`,
          );
        } else {
          // Phone handoff:
          //   1. Always write the CloudDocs handoff for the ClaudeDraft Shortcut.
          //   2. iPhone Mirroring typed placement is diagnostic-only, opt-in,
          //      and useful only when the phone is physically mirrored to this
          //      Mac. It is not a production path for remote relay use.
          //   3. Only use Mac Messages as a fallback when phone handoff is not
          //      available. Mac placement is not proof of iPhone delivery.
          const target = resolved ?? NEW_COMPOSE_SENTINEL;
          const useIPhoneMirror =
            Boolean(resolved) && shouldUseIPhoneMirrorPlacement();
          const [handoff, iPhoneMirror] = await Promise.all([
            resolved
              ? writeICloudDriveDraft({ recipient: resolved, recipientLabel: contactLabel, body })
              : Promise.resolve(null),
            resolved
              ? useIPhoneMirror
                ? placeIPhoneMirrorDraft(resolved, body)
                : Promise.resolve(null)
              : Promise.resolve(null),
          ]);
          let placement:
            | Awaited<ReturnType<typeof placeIMessageDraft>>
            | undefined;

          if (handoff && handoff.ok) {
            imessageDraftHandoffPath = handoff.path;
            imessageDraftBodySha256 = handoff.bodySha256;
            imessageDraftShortcutUrl = handoff.shortcutUrl;
            console.log(
              `[imessage-draft] icloud_drive_file for ${contactLabel} (${resolved}) path=${handoff.path} sha256=${handoff.bodySha256}`,
            );
          } else if (handoff && !handoff.ok) {
            console.error(
              `[imessage-draft] iCloud Drive handoff failed for ${contactLabel}: ${handoff.error ?? "unknown error"}`,
            );
          }

          if (iPhoneMirror?.ok) {
            imessageDraftStatus = "phone_handoff_ready";
            imessageDraftMode = "iphone_mirror_typed";
            assistantText = rebuildAroundDraftBlock(
              assistantText,
              `${body}\n\nDraft is in the iPhone Messages compose field for ${contactLabel}.`,
            );
            console.log(
              `[imessage-draft] iphone_mirror_typed for ${contactLabel} (${resolved})`,
            );
          } else if (handoff?.ok) {
            if (iPhoneMirror && !iPhoneMirror.ok) {
              console.error(
                `[imessage-draft] iPhone mirror placement failed for ${contactLabel}: ${iPhoneMirror.error ?? "unknown error"}`,
              );
            }
            // iCloud Drive succeeded, but that only prepares the Shortcut input.
            // It is not proof the iPhone compose box is populated.
            const shortcutInstallPending = existsSync(shortcutInstallPath());
            imessageDraftStatus = shortcutInstallPending
              ? "phone_shortcut_install_pending"
              : "phone_handoff_ready";
            imessageDraftMode = "icloud_drive_file";
            assistantText = rebuildAroundDraftBlock(
              assistantText,
              shortcutInstallPending
                ? `${body}\n\nClaudeDraft is not installed on your iPhone yet. Open Files > iCloud Drive > ClaudeDraft.shortcut, tap Replace or Add Shortcut, then run ClaudeDraft. Draft target: ${contactLabel} (${resolved}).`
                : `${body}\n\nPhone handoff ready for ${contactLabel} (${resolved}): ${handoff.shortcutUrl}`,
            );
          } else {
            placement = await placeIMessageDraft(PROJECT_ROOT, target, body);
          }

          if (placement !== undefined) {
            if (!handoff?.ok && placement.ok && placement.mode === "pasted") {
              // iCloud Drive failed; Mac paste is the fallback.
              imessageDraftStatus = "placed";
              imessageDraftMode = "pasted";
              assistantText = rebuildAroundDraftBlock(
                assistantText,
                `${body}\n\nDraft is in the Messages compose box on your Mac for ${contactLabel}.`,
              );
              console.log(
                `[imessage-draft] pasted into compose for ${contactLabel} (${resolved}) — iCloud Drive fallback`,
              );
            } else if (!handoff?.ok && placement.ok && placement.mode === "new_compose") {
              imessageDraftStatus = "placed";
              imessageDraftMode = "new_compose";
              assistantText = rebuildAroundDraftBlock(
                assistantText,
                `${body}\n\nI couldn't find a thread for ${contactLabel}, so I opened a new Messages compose on your Mac with the body prefilled. Pick the contact in the To field.`,
              );
              console.log(
                `[imessage-draft] new_compose for ${contactLabel} (context_status=${imessageContextResult?.status})`,
              );
            } else if (!handoff?.ok && placement.ok) {
              imessageDraftStatus = "placed";
              imessageDraftMode = "clipboard_only";
              const where = resolved
                ? `Messages on your Mac is open to the ${contactLabel} thread`
                : placement.reason === "sms_body_url_opened_unverified_new_compose"
                  ? `Messages on your Mac opened a new compose window for ${contactLabel}`
                : `Messages on your Mac is open — press Cmd+N for a new message, pick ${contactLabel}`;
              assistantText = rebuildAroundDraftBlock(
                assistantText,
                `${body}\n\nDraft is on your clipboard and ${where}. Paste with Cmd+V.`,
              );
              console.log(
                `[imessage-draft] clipboard_only fallback for ${contactLabel}: ${placement.reason ?? "no reason"}`,
              );
            } else {
              imessageDraftStatus = "helper_failed";
              assistantText = rebuildAroundDraftBlock(
                assistantText,
                `${body}\n\n(Couldn't place this in Messages: ${placement.error ?? "unknown error"}.)`,
              );
              console.error(`[imessage-draft] helper failed: ${placement.error}`);
            }
          }
        }
      }
    }

    // Defensive: ensure no raw iMessage-draft markers reach Telegram even if
    // Claude emitted them outside a placement request or left a second pair.
    if (
      assistantText.includes(DRAFT_MARKER_OPEN) ||
      assistantText.includes(DRAFT_MARKER_CLOSE)
    ) {
      assistantText = replaceDraftBlock(assistantText, "").trim();
    }

    // Compute the actually-sendable text ONCE so Telegram, the short-term
    // turn buffer, and Supabase all agree. 2026-05-11 the Conor turn
    // persisted an empty string here while sendResponse substituted the
    // "I generated an empty response" apology. 2026-05-14 the iPhone Shortcut
    // handoff path had the same class of bug: Telegram saw "Open on iPhone",
    // but short-term state saved the internal "Phone handoff ready" line.
    const sendableText = prepareTelegramResponseText(assistantText);
    const sendResult = await sendTelegramResponse(ctx, sendableText);
    if (sendResult.partialFailure) {
      errorMsg = [errorMsg, sendResult.partialFailure].filter(Boolean).join("; ");
    }
    await markUpdateSentAndRemember(updateId);
    await saveMessage("assistant", sendableText);
    await appendTurn(chatId, { role: "assistant", content: sendableText, ts: new Date().toISOString() });

    // Background memory capture. Synchronous classification (regex match) so
    // the decision record can include the reason; the actual file write is
    // fire-and-forget — never blocks the reply, never throws into the queue.
    const memoryCandidate = classifyMemoryCandidate({
      userText: text,
      assistantText: sendableText,
      anchoredProjects: anchoredProjectNames,
      retrievalUsed: corpusQuery,
      retrievalHitCount: ftsHits.length,
    });
    if (memoryCandidate) {
      void writeMemoryCandidate(memoryCandidate)
        .then((r) => {
          console.log(
            `[memory-capture] ${r.reason} kind=${memoryCandidate.kind} dest=${memoryCandidate.destination} path=${r.path ?? "n/a"}`,
          );
        })
        .catch((err) => {
          console.error(
            "[memory-capture] write failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
    }

    const rec: DecisionRecord = {
      ts,
      update_id: updateId,
      chat_id: chatId,
      message: text,
      trigger_fired: corpusQuery,
      hit_count: ftsHits.length,
      hits_summary: ftsHits.slice(0, 5).map((h) => ({
        path: h.file_path,
        sim: Number(h.display_score.toFixed(3)),
      })),
      injected_count: corpusQuery ? Math.min(ftsHits.length, 3) : 0,
      claude_ms: claudeMs,
      total_ms: Date.now() - t0,
      error: errorMsg ?? retrievalError,
      query_content_tokens: queryContentTokens,
      fts_query: searchQuery,
      retrieval_ms: retrievalMs,
      top_rank_score: ftsHits[0]?.rank_score,
      second_rank_score: ftsHits[1]?.rank_score,
      prompt_chars: enrichedPrompt.length,
      turn_buffer_size_before: turnBufferSizeBefore,
      timeout_kind: timeoutKind,
      imessage_context_status: imessageContextResult?.status,
      imessage_context_count: imessageContextResult?.messages.length,
      imessage_context_contact: imessageContextResult?.request.contact,
      imessage_draft_status: imessageDraftStatus,
      imessage_draft_mode: imessageDraftMode,
      imessage_draft_handoff_path: imessageDraftHandoffPath,
      imessage_draft_body_sha256: imessageDraftBodySha256,
      imessage_draft_shortcut_url: imessageDraftShortcutUrl,
      memory_tags_stripped: memoryTagsStripped,
      wrapper_tags_stripped: wrapperTagsStripped,
      scaffolding_tags_stripped: scaffoldingTagsStripped,
      turn_markers_stripped: turnMarkersStripped,
      prose_dashes_stripped: proseDashesStripped,
      response_chars: sendableText.length,
      catalog_response_used: Boolean(deterministicCatalogResponse),
      skipped_textbook_response_used: Boolean(deterministicTextbookResponse),
      memory_capture_attempted: Boolean(memoryCandidate),
      memory_capture_reason: memoryCandidate?.reason,
      memory_capture_confidence: memoryCandidate?.confidence,
      memory_capture_kind: memoryCandidate?.kind,
      memory_capture_destination: memoryCandidate?.destination,
      memory_capture_project: memoryCandidate?.project ?? undefined,
    };
    await logDecision(rec);
  });
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  const updateId = ctx.update.update_id;
  const chatId = String(ctx.chat.id);
  const t0 = Date.now();
  const ts = new Date().toISOString();
  console.log(`Voice message: ${voice.duration}s`);

  let errorMsg: string | undefined;
  let assistantText = "";
  let memoryTagsStripped = 0;
  let wrapperTagsStripped = 0;
  let scaffoldingTagsStripped = 0;
  let turnMarkersStripped = 0;
  let proseDashesStripped = 0;
  try {
    await ctx.replyWithChatAction("typing");

    if (!process.env.VOICE_PROVIDER) {
      await ctx.reply(
        "Voice transcription is not set up yet. " +
          "Run the setup again and choose a voice provider (Groq or local Whisper)."
      );
      await markUpdateSentAndRemember(updateId);
      return;
    }

    const file = await ctx.getFile();
    const buffer = await downloadTelegramFile({
      filePath: file.file_path,
      fileId: voice.file_id,
      declaredSize: voice.file_size ?? file.file_size,
      maxBytes: MAX_VOICE_BYTES,
      kind: "voice",
    });

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply("Could not transcribe voice message.");
      await markUpdateSentAndRemember(updateId);
      return;
    }

    const userTurn = `[Voice ${voice.duration}s]: ${transcription}`;
    await saveMessage("user", userTurn);
    await appendTurn(chatId, { role: "user", content: userTurn, ts });

    const [relevantContext, memoryContext] = supabase
      ? await Promise.all([
          supabaseFeatures.relevantContext
            ? getRelevantContext(supabase, transcription)
            : Promise.resolve(""),
          supabaseFeatures.durableMemory
            ? getMemoryContext(supabase)
            : Promise.resolve(""),
        ])
      : ["", ""];

    const voiceUserMessage = `[Voice message transcribed]: ${transcription}`;
    const enrichedPrompt = capPrompt(buildPrompt(
      voiceUserMessage,
      relevantContext,
      memoryContext
    ), voiceUserMessage);
    const rawResponse = await callClaude(enrichedPrompt, { resume: true });
    const processed = await postProcessClaudeResponse(
      rawResponse,
      "I transcribed the voice message, but I didn't generate a useful reply. Could you ask again more specifically?",
    );
    assistantText = processed.text;
    memoryTagsStripped = processed.memoryTagsStripped;
    wrapperTagsStripped = processed.wrapperTagsStripped;
    scaffoldingTagsStripped = processed.scaffoldingTagsStripped;
    turnMarkersStripped = processed.turnMarkersStripped;
    proseDashesStripped = processed.proseDashesStripped;

    assistantText = prepareTelegramResponseText(assistantText);
    const sendResult = await sendTelegramResponse(ctx, assistantText);
    if (sendResult.partialFailure) {
      errorMsg = [errorMsg, sendResult.partialFailure].filter(Boolean).join("; ");
    }
    await markUpdateSentAndRemember(updateId);
    await saveMessage("assistant", assistantText);
    await appendTurn(chatId, { role: "assistant", content: assistantText, ts: new Date().toISOString() });
  } catch (error) {
    errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Voice error:", error);
    try {
      await ctx.reply("Could not process voice message. Check logs for details.");
      await markUpdateSentAndRemember(updateId);
    } catch {
      // Telegram send failure remains visible in stderr via the original error.
    }
  } finally {
    // Persist update_id so loadSeenUpdateIds() blocks Telegram redelivery on
    // restart. Without this, voice updates are only tracked via the in-memory
    // seen-set and short-lived marker file, both lost on relay restart.
    await logDecision({
      ts,
      update_id: updateId,
      chat_id: chatId,
      message: `[voice ${voice.duration}s]`,
      trigger_fired: false,
      hit_count: 0,
      hits_summary: [],
      injected_count: 0,
      total_ms: Date.now() - t0,
      error: errorMsg,
      memory_tags_stripped: memoryTagsStripped,
      wrapper_tags_stripped: wrapperTagsStripped,
      scaffolding_tags_stripped: scaffoldingTagsStripped,
      turn_markers_stripped: turnMarkersStripped,
      prose_dashes_stripped: proseDashesStripped,
      response_chars: assistantText.length,
    }).catch(() => undefined);
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  const updateId = ctx.update.update_id;
  const chatId = String(ctx.chat.id);
  const t0 = Date.now();
  const ts = new Date().toISOString();
  console.log("Image received");

  let errorMsg: string | undefined;
  let assistantText = "";
  let memoryTagsStripped = 0;
  let wrapperTagsStripped = 0;
  let scaffoldingTagsStripped = 0;
  let turnMarkersStripped = 0;
  let proseDashesStripped = 0;
  let uploadDir: string | undefined;
  let filePath: string | undefined;
  try {
    await ctx.replyWithChatAction("typing");

    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image into a per-update private directory. Claude receives
    // Read access to this directory only, never the shared uploads root.
    const timestamp = Date.now();
    uploadDir = await createUploadWorkDir(updateId);
    filePath = join(uploadDir, `image_${timestamp}.jpg`);

    const buffer = await downloadTelegramFile({
      filePath: file.file_path,
      fileId: photo.file_id,
      declaredSize: photo.file_size ?? file.file_size,
      maxBytes: MAX_IMAGE_BYTES,
      kind: "image",
    });
    await writeFile(filePath, buffer);

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = capPrompt(`[Image: ${filePath}]\n\n${caption}`);

    const userTurn = `[Image]: ${caption}`;
    await saveMessage("user", userTurn);
    await appendTurn(chatId, { role: "user", content: userTurn, ts });

    const claudeResponse = await callClaude(prompt, {
      resume: true,
      allowedTools: ["Read"],
      addDirs: [uploadDir],
      cwd: uploadDir,
    });

    const processed = await postProcessClaudeResponse(
      claudeResponse,
      "I looked at the image, but I didn't generate a useful reply. Could you ask again more specifically?",
    );
    assistantText = processed.text;
    memoryTagsStripped = processed.memoryTagsStripped;
    wrapperTagsStripped = processed.wrapperTagsStripped;
    scaffoldingTagsStripped = processed.scaffoldingTagsStripped;
    turnMarkersStripped = processed.turnMarkersStripped;
    proseDashesStripped = processed.proseDashesStripped;
    assistantText = prepareTelegramResponseText(assistantText);
    const sendResult = await sendTelegramResponse(ctx, assistantText);
    if (sendResult.partialFailure) {
      errorMsg = [errorMsg, sendResult.partialFailure].filter(Boolean).join("; ");
    }
    await markUpdateSentAndRemember(updateId);
    await saveMessage("assistant", assistantText);
    await appendTurn(chatId, { role: "assistant", content: assistantText, ts: new Date().toISOString() });
  } catch (error) {
    errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Image error:", error);
    try {
      await ctx.reply("Could not process image.");
      await markUpdateSentAndRemember(updateId);
    } catch {
      // Telegram send failure remains visible in stderr via the original error.
    }
  } finally {
    if (uploadDir) {
      await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
    } else if (filePath) {
      await unlink(filePath).catch(() => {});
    }
    await logDecision({
      ts,
      update_id: updateId,
      chat_id: chatId,
      message: "[photo]",
      trigger_fired: false,
      hit_count: 0,
      hits_summary: [],
      injected_count: 0,
      total_ms: Date.now() - t0,
      error: errorMsg,
      memory_tags_stripped: memoryTagsStripped,
      wrapper_tags_stripped: wrapperTagsStripped,
      scaffolding_tags_stripped: scaffoldingTagsStripped,
      turn_markers_stripped: turnMarkersStripped,
      prose_dashes_stripped: proseDashesStripped,
      response_chars: assistantText.length,
    }).catch(() => undefined);
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const updateId = ctx.update.update_id;
  const chatId = String(ctx.chat.id);
  const t0 = Date.now();
  const ts = new Date().toISOString();
  console.log(`Document: ${doc.file_name}`);

  let errorMsg: string | undefined;
  let assistantText = "";
  let memoryTagsStripped = 0;
  let wrapperTagsStripped = 0;
  let scaffoldingTagsStripped = 0;
  let turnMarkersStripped = 0;
  let proseDashesStripped = 0;
  let uploadDir: string | undefined;
  let filePath: string | undefined;
  try {
    await ctx.replyWithChatAction("typing");

    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    uploadDir = await createUploadWorkDir(updateId);
    filePath = join(uploadDir, `document_${timestamp}${safeUploadExtension(fileName)}`);

    const buffer = await downloadTelegramFile({
      filePath: file.file_path,
      fileId: doc.file_id,
      declaredSize: doc.file_size ?? file.file_size,
      maxBytes: MAX_DOCUMENT_BYTES,
      kind: "document",
    });
    await writeFile(filePath, buffer);

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = capPrompt(`[File: ${filePath}]\nOriginal filename: ${basename(fileName)}\n\n${caption}`);

    const userTurn = `[Document: ${doc.file_name}]: ${caption}`;
    await saveMessage("user", userTurn);
    await appendTurn(chatId, { role: "user", content: userTurn, ts });

    const claudeResponse = await callClaude(prompt, {
      resume: true,
      allowedTools: ["Read"],
      addDirs: [uploadDir],
      cwd: uploadDir,
    });

    const processed = await postProcessClaudeResponse(
      claudeResponse,
      "I looked at the document, but I didn't generate a useful reply. Could you ask again more specifically?",
    );
    assistantText = processed.text;
    memoryTagsStripped = processed.memoryTagsStripped;
    wrapperTagsStripped = processed.wrapperTagsStripped;
    scaffoldingTagsStripped = processed.scaffoldingTagsStripped;
    turnMarkersStripped = processed.turnMarkersStripped;
    proseDashesStripped = processed.proseDashesStripped;
    assistantText = prepareTelegramResponseText(assistantText);
    const sendResult = await sendTelegramResponse(ctx, assistantText);
    if (sendResult.partialFailure) {
      errorMsg = [errorMsg, sendResult.partialFailure].filter(Boolean).join("; ");
    }
    await markUpdateSentAndRemember(updateId);
    await saveMessage("assistant", assistantText);
    await appendTurn(chatId, { role: "assistant", content: assistantText, ts: new Date().toISOString() });
  } catch (error) {
    errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Document error:", error);
    try {
      await ctx.reply("Could not process document.");
      await markUpdateSentAndRemember(updateId);
    } catch {
      // Telegram send failure remains visible in stderr via the original error.
    }
  } finally {
    if (uploadDir) {
      await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
    } else if (filePath) {
      await unlink(filePath).catch(() => {});
    }
    await logDecision({
      ts,
      update_id: updateId,
      chat_id: chatId,
      message: `[document: ${doc.file_name ?? "unnamed"}]`,
      trigger_fired: false,
      hit_count: 0,
      hits_summary: [],
      injected_count: 0,
      total_ms: Date.now() - t0,
      error: errorMsg,
      memory_tags_stripped: memoryTagsStripped,
      wrapper_tags_stripped: wrapperTagsStripped,
      scaffolding_tags_stripped: scaffoldingTagsStripped,
      turn_markers_stripped: turnMarkersStripped,
      prose_dashes_stripped: proseDashesStripped,
      response_chars: assistantText.length,
    }).catch(() => undefined);
  }
});

// ============================================================
// HELPERS
// ============================================================

// Load profile once at startup
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string,
  opts?: { iMessageDraftContact?: string },
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = [
    "You are a personal AI assistant responding via Telegram.",
    ENGLISH_ONLY_DIRECTIVE,
    "Default to concise, scannable replies: lead with the answer, prefer short bullets for multi-part technical or factual responses, and avoid long paragraphs unless the user explicitly asks for depth or nuance. Match the user's tone; this is a conversational chat, not a report.",
    "Reply in plain text. Never wrap your response in XML or HTML tags such as <response>, </response>, <answer>, or <reply>. If you have nothing useful to say, ask a clarifying question instead of returning an empty or tag-only reply.",
    ANESTHESIA_CORPUS_INSTRUCTIONS,
    // Runtime context so the bot stops giving wrong macOS FDA advice. The
    // relay does not run from a terminal, and iMessage context prefetch no
    // longer routes through Claude. The protected-file reader is bun.
    "Runtime context: you run as a macOS launchd service named com.claude.telegram-relay. You are NOT running inside Terminal, iTerm, Warp, or any GUI shell, and there is no Claude Code session attached. The relay process is bun, and it deterministically reads iMessage context before Claude runs by spawning scripts/imessage-thread.sh. If macOS denies access to ~/Library/Messages/chat.db, the relevant Full Disk Access entry is the resolved bun Cellar binary from `readlink -f \"$(which bun)\"`, not Terminal and not the Claude CLI. Do not tell the user to grant FDA to a terminal application or to ~/.local/share/claude/versions/<latest>; that will not fix this relay path.",
    // Hard rule logged 2026-05-11 after the user asked for an iMessage and
    // an email draft. The bot must NEVER send; only draft. Full policy in
    // ~/.claude/projects/.../memory/feedback_drafts_never_send.md.
    "Drafting policy (hard rule): when the user asks you to write an email, iMessage, SMS, or any outbound message, produce a draft only. NEVER send the message yourself. NEVER call a tool that would send it. NEVER claim to have sent it. Return the draft body as the body of your reply — no policy footer, no \"Draft above\", no \"send manually\", no \"review and send\", no \"I can't send for you\". The relay tells the user where the draft is; you do not need to remind them. If the user later says \"just send it\" or \"you send it\", refuse politely in one sentence and stop.",
    // Helper scripts the bot can invoke via its Bash tool. Documented in
    // docs/IMESSAGE-SETUP.md. The two draft helpers do NOT require Full Disk
    // Access; they drop the draft into the native compose surface and the
    // user reviews/sends. The read helper DOES require FDA on the Claude
    // binary and will return an error message if FDA is not granted.
    // Hard rule logged 2026-05-11 after the user asked for context-aware
    // drafts. Always read 5 to 10 prior messages before drafting a reply.
    // See feedback_context_before_drafting.md for the durable policy.
    "Context-before-drafting rule (hard): whenever the user asks you to draft an iMessage, text, SMS, or email to someone, work from the injected context. For iMessage/text/SMS, the relay always attempts to fetch the last 5 to 10 messages from the relevant thread before you run. The result appears as an 'IMESSAGE CONTEXT FOR <name>' block above. If the block says messages were found, use them to match the relationship, cadence, and level of warmth while preserving the user's exact intended meaning. If the block says the thread was not found or context could not be read, draft from the user's description as best you can. Do NOT ask the user for a phone number, prior messages, or any other clarifying information. Do not claim you lack iMessage access; the relay owns that lookup. For email replies, ask the user to paste the most recent thread only if no context was supplied at all.",
    "Context cleanup rule (hard): never save the fetched context to a local file. The read helper streams JSON to stdout; consume it in your working memory only. Do NOT write context to ~/Projects/claude-telegram-relay/data/ or anywhere else on disk. If you find an existing cached context file from a prior session (e.g. data/mom-imessages.json), delete it after use rather than reusing it. The user's machine is the source of truth; re-read fresh from chat.db each time rather than caching.",
    "iMessage handling is deterministic in this runtime. The relay reads thread context before you run and places drafts after you run (using the marker pattern described below when relevant). Do NOT attempt to call scripts/imessage-thread.sh or scripts/draft-imessage.sh yourself; in headless mode you have no Bash approval surface and the call will surface as a confusing 'blocked for approval' message to the user. Just respond in text and use the markers when asked to place a draft.",
    "For email drafts in this runtime, produce the draft text only. Do NOT call scripts/draft-email.sh or any mail client helper; ordinary Telegram turns do not expose Bash tools.",
    // Durable writing-style rules for any outgoing draft the user will send
    // under his own name. Source of truth (verbatim) lives at
    //   ~/ObsidianVault/02-Cross-Project/writing_style_for_william.md
    //   ~/.claude/projects/-Users-williamregan-ObsidianVault/memory/feedback_writing_style.md
    // Applied automatically; do not require the user to invoke them.
    "When drafting outgoing text on the user's behalf (emails, iMessages, letters, notes, anything that will go out under his name), follow these rules verbatim:",
    "Remember to always follow the following:",
    "You must act as an expert human-writing editor and rewrite your output so it reads as entirely organic, authentic, and written by a confident, experienced human.",
    "Please apply the following guidelines:",
    "- Tone & Voice: Make it sound conversational, warm, and engaging, like a knowledgeable expert explaining something casually but professionally. Add subtle human emotion and natural emphasis to make the writing feel alive.",
    "- Rhythm & Flow: Master the pacing. Actively vary sentence lengths, improve transitions, and ensure a smooth, natural rhythm that carries the reader effortlessly.",
    "- What to Eliminate: Strip out any robotic phrasing, stiff structures, monotone patterns, and overly formal jargon. Remove repetitive, predictable AI-like word choices and avoid adding unnecessary fluff.",
    "- The Golden Rule: Preserve the original meaning and core message completely intact while making the text completely undetectable as AI. Ensure absolutely no \"-\" \"em dashes\" in your final output.",
  ];

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  if (opts?.iMessageDraftContact) {
    const contact = opts.iMessageDraftContact;
    parts.push(
      `\niMessage handoff (this message): the user wants a draft for ${contact}. The relay will handle placement after you respond — usually by writing the draft for the iPhone Shortcut handoff, with the Mac Messages compose path as a fallback. Output the iMessage body — and only the body — between the literal marker lines below, each on its own line:`,
      DRAFT_MARKER_OPEN,
      "(the iMessage body)",
      DRAFT_MARKER_CLOSE,
      `Treat any phrase after "saying", "say", or "with" in the user's message as the core meaning to preserve, not necessarily as verbatim wording. Use the injected iMessage context when present, then rewrite the body so it sounds organic, confident, warm, and human. Keep it concise enough for a real text message unless the user asks for length. Do not use hyphen, en dash, or em dash characters in the draft body. You may add one short lead sentence BEFORE the opening marker (e.g. "Here's the draft for ${contact}:"). Write NOTHING after the closing marker. The relay appends its own handoff status line based on what actually happened (iPhone Shortcut handoff, Mac compose fallback, clipboard fallback, or failure), and any line you add will either be discarded or contradict the truth. In particular: do NOT write "Draft is in the Messages compose box", "Draft is placed", "Ready to send", "I've opened Messages", or any variation — the relay owns that status. Do NOT call any tool, do NOT mention scripts, and NEVER say the placement was blocked for approval — there is no approval surface in this runtime.`,
    );
  }

  // Layer 1 of memory-tag leak fix: only ask Claude to emit tags when Supabase
  // is explicitly the durable memory authority. In the default Obsidian-first
  // mode, Supabase may still store/search Telegram history, but it must not
  // compete with vault Markdown memories.
  if (supabase && supabaseFeatures.durableMemory) {
    parts.push(
      "\nMEMORY MANAGEMENT:" +
        "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
        "include these tags in your response (they are processed automatically and hidden from the user):" +
        "\n[REMEMBER: fact to store]" +
        "\n[GOAL: goal text | DEADLINE: optional date]" +
        "\n[DONE: search text for completed goal]"
    );
  }

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function verifyClaudeExecutable(): Promise<void> {
  if (CLAUDE_PATH.includes("/")) {
    try {
      await access(CLAUDE_PATH, constants.X_OK);
    } catch {
      throw new Error(
        `preflight: CLAUDE_PATH is not executable: ${CLAUDE_PATH}`,
      );
    }
    console.log(`[preflight] Claude CLI: ${CLAUDE_PATH}`);
    return;
  }

  const result = Bun.spawnSync({
    cmd: ["/bin/sh", "-lc", `command -v ${shellQuote(CLAUDE_PATH)}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `preflight: Claude CLI '${CLAUDE_PATH}' not found on PATH; set CLAUDE_PATH`,
    );
  }
  console.log(
    `[preflight] Claude CLI: ${new TextDecoder().decode(result.stdout).trim()}`,
  );
}

// ============================================================
// START
// ============================================================

async function runStartupPreflight(): Promise<void> {
  console.log("Starting Claude Telegram Relay...");
  console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
  console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);
  console.log("[relay] RELAY_CWD:", RELAY_CWD);
  console.log(`[relay] Claude resume: ${CLAUDE_RESUME_ENABLED ? "enabled" : "disabled"}`);
  console.log(`[relay] Claude timeout: ${CLAUDE_TIMEOUT_MS}ms`);

  await verifyClaudeExecutable();

  // Architecture check — warns if bun or claude are Intel-only (will break in macOS 28).
  try {
    const archReport = checkRelayBinaries(CLAUDE_PATH);
    console.log(`[preflight] bun arch: ${archLabel(archReport.bun.arch)} (${archReport.bun.path})`);
    console.log(`[preflight] claude arch: ${archLabel(archReport.claude.arch)} (${archReport.claude.path})`);
    if (archReport.currentProcessRosetta) {
      console.error(
        "[preflight] WARNING: bun is running under Rosetta translation. " +
        "This relay will stop working in macOS 28. " +
        "Reinstall bun for Apple silicon: curl -fsSL https://bun.sh/install | bash",
      );
    } else if (archReport.hasWarnings) {
      console.error(
        "[preflight] WARNING: one or more relay binaries are Intel-only and will stop working in macOS 28. " +
        "Update them to a Universal or Apple silicon version.",
      );
    }
  } catch (err) {
    console.error("[preflight] arch check failed:", err instanceof Error ? err.message : String(err));
  }

  console.log("[relay] running retrieval preflight...");
  try {
    await retrievalPreflight();
    retrievalAvailable = true;
    retrievalStartupError = undefined;
  } catch (err) {
    // Startup preflight is diagnostic only. SQLite can transiently lock while
    // the indexer is active; permanently disabling retrieval for the whole
    // launch would leave FTS off until the next manual restart. Per-request
    // searches already catch and log their own errors, so keep retrieval
    // enabled and retry when the user actually asks a referential question.
    retrievalAvailable = true;
    retrievalStartupError = err instanceof Error ? err.message : String(err);
    console.error(
      "[relay] retrieval preflight failed; will retry indexed retrieval per request:",
      retrievalStartupError,
    );
  }

  try {
    const removed = await sweepOldDecisionLogs();
    if (removed > 0) {
      console.log(`[preflight] removed ${removed} old decision log(s)`);
    }
  } catch (err) {
    console.error("[preflight] decision log sweep failed:", err instanceof Error ? err.message : String(err));
  }

  const watcher = Bun.spawnSync({ cmd: ["pgrep", "-f", "watcher.py"] });
  if (watcher.exitCode !== 0) {
    console.error("[preflight] watcher.py not running; indexed content may be stale");
  } else {
    console.log("[preflight] watcher.py: alive");
  }

  await mkdir(join(homedir(), ".claude-relay", "state", "updates"), { recursive: true });
  await mkdir(join(homedir(), ".claude-relay", "logs"), { recursive: true });
  await Bun.write(join(homedir(), ".claude-relay", "state", ".write-probe"), "");

  const me = await bot.api.getMe();
  if (!me.is_bot) throw new Error("preflight: getMe returned non-bot");
  console.log(`[preflight] Telegram getMe: @${me.username} (id=${me.id})`);

  console.log("[relay] retrieval preflight complete");
}

await runStartupPreflight();

// Catch unhandled errors from any middleware or message handler. Without this,
// a GrammyError (e.g. 400 Bad Request from an invalid URL in a keyboard button)
// propagates as an unhandled rejection → Bun crashes → launchd restarts →
// Telegram re-delivers the same update (since markUpdateSentAndRemember was
// never called) → infinite crash loop. Registering bot.catch keeps the relay
// alive and logs the error.
bot.catch((err) => {
  const ctx = err.ctx;
  const updateId = ctx?.update?.update_id;
  const chatId = ctx?.chat?.id;
  const innerErr = err.error instanceof Error ? err.error : new Error(String(err.error));
  console.error(
    `[bot] unhandled error update_id=${updateId ?? "?"} chat_id=${chatId ?? "?"}: ${innerErr.message}`,
    innerErr,
  );
  // Best-effort: tell the user something went wrong so they know to retry.
  ctx?.reply("Something went wrong on my end. Please try again.").catch(() => undefined);
  // Mark the update as seen if we have the update ID, so the crash-loop guard
  // also prevents duplicate processing via the duplicate-detection path.
  if (updateId !== undefined) {
    markUpdateSent(updateId).catch(() => undefined);
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startTelegramPolling(): Promise<void> {
  let conflictAttempts = 0;
  let firstConflictAt = 0;
  const claudePluginEnvPath = join(homedir(), ".claude", "channels", "telegram", ".env");

  for (;;) {
    try {
      await bot.start({
        onStart: () => {
          console.log("Bot polling loop started.");
          console.log(
            `[telegram] long polling attempt: claude-telegram-relay pid=${process.pid}`,
          );
        },
      });
      return;
    } catch (err) {
      const diagnosis = classifyTelegramPollingConflictError(err);
      if (!diagnosis) throw err;

      conflictAttempts += 1;
      if (firstConflictAt === 0) firstConflictAt = Date.now();
      const pluginEnvExists = existsSync(claudePluginEnvPath);
      console.error(
        formatTelegramPollingConflictLog({
          diagnosis,
          attempt: conflictAttempts,
          elapsedMs: Date.now() - firstConflictAt,
          pid: process.pid,
          retryDelayMs: TELEGRAM_POLLING_CONFLICT_RETRY_DELAY_MS,
          lockFile: LOCK_FILE,
          pluginEnvExists,
        }),
      );
      if (shouldEscalateTelegramPollingConflict(conflictAttempts)) {
        console.error(formatTelegramPollingConflictHint({ diagnosis, pluginEnvExists }));
      }
      await sleep(TELEGRAM_POLLING_CONFLICT_RETRY_DELAY_MS);
    }
  }
}

await startTelegramPolling();
