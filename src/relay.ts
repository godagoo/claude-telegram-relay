/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "./transcribe.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";
import { search as ftsSearch, renderContext as renderFtsContext, preflight as retrievalPreflight } from "./retrieval.ts";
import { isReferential } from "./trigger.ts";
import { buildSearchQuery, countContentTokens, type Turn } from "./query-builder.ts";
import { loadTurns, appendTurn } from "./short-term.ts";
import { buildSkippedTextbookResponse } from "./textbook-response.ts";
import {
  clearUpdateMarker,
  loadSeenUpdateIds,
  logDecision,
  markUpdateStarted,
  type DecisionRecord,
} from "./decision-log.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
// Pin the cwd for every `claude` spawn so future --resume work (Phase 1.1)
// can locate session JSONLs in a stable project bucket. Per
// platform.claude.com/docs/en/agent-sdk/sessions, sessions are stored under
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl with non-alphanumerics
// replaced by '-'. Inheriting launchd's cwd ('/') would scatter sessions.
const RELAY_CWD = (process.env.HOME ?? "") + "/Projects/claude-telegram-relay";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 10_000;
const MAX_PROMPT_CHARS = 120_000;
const MAX_RECENT_TURNS_RENDERED = 6;

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
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
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
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

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      metadata: metadata || {},
    });
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
let retrievalAvailable = false;
let retrievalStartupError: string | undefined;

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
    await clearUpdateMarker(updateId);
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
    return;
  }

  await next();
});

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "text");

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  const ac = new AbortController();
  let timedOut = false;
  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: RELAY_CWD,
    env: {
      ...process.env,
    },
    signal: ac.signal,
  });

  const sigTermTimer = setTimeout(() => {
    if (proc.exitCode === null) {
      timedOut = true;
      console.error(`[callClaude] timeout after ${CLAUDE_TIMEOUT_MS}ms, sending SIGTERM`);
      ac.abort();
    }
  }, CLAUDE_TIMEOUT_MS);

  const sigKillTimer = setTimeout(() => {
    if (proc.exitCode === null) {
      console.error("[callClaude] grace expired, sending SIGKILL");
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already dead.
      }
    }
  }, CLAUDE_TIMEOUT_MS + KILL_GRACE_MS);

  try {
    const [output, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timedOut || ac.signal.aborted) {
      throw new Error(`claude_timeout_${CLAUDE_TIMEOUT_MS}ms`);
    }

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Extract session ID from output if present (for --resume)
    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return output.trim();
  } catch (error) {
    if (timedOut || String((error as Error).message).startsWith("claude_timeout_")) {
      throw new Error(`claude_timeout_${CLAUDE_TIMEOUT_MS}ms`);
    }
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
  } finally {
    clearTimeout(sigTermTimer);
    clearTimeout(sigKillTimer);
  }
}

// ============================================================
// HARDENING HELPERS (Phase 1 v1)
// ============================================================

// Per-chat FIFO queue. Two messages from the same chat process in order;
// different chats are independent. Prevents state.json races.
const chatQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(chatId: string, updateId: number, fn: () => Promise<T>): Promise<T> {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
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

// Defense-in-depth strip of memory-management tags so they never reach the user.
// Layer 1 (gate the prompt instruction on `supabase`) is in buildPrompt.
function stripMemoryTags(text: string): { clean: string; stripped: number } {
  let stripped = 0;
  const clean = text
    .replace(/\[REMEMBER:[^\]]*\]/g, () => { stripped++; return ""; })
    .replace(/\[GOAL:[^\]]*\]/g,     () => { stripped++; return ""; })
    .replace(/\[DONE:[^\]]*\]/g,     () => { stripped++; return ""; })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { clean, stripped };
}

// Plain-text recent-turns renderer (locked v1 decision: no XML in prompts).
// short-term.ts also exports renderRecentTurns which emits XML; we use this
// plain-text variant instead.
function renderRecentTurnsPlain(turns: Turn[], cap = MAX_RECENT_TURNS_RENDERED): string {
  if (turns.length === 0) return "";
  const trimmed = turns.slice(-cap);
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

    // Trigger gating: only run FTS on referential messages.
    const referential = isReferential(text);
    const queryContentTokens = countContentTokens(text);
    const searchQuery = referential && retrievalAvailable
      ? buildSearchQuery(text, recentTurns)
      : "";
    const tRetrieval0 = Date.now();
    let retrievalMs: number | undefined;
    let timeoutKind: "fts" | "claude" | undefined;
    let retrievalError: string | undefined = referential && !retrievalAvailable
      ? `retrieval_unavailable${retrievalStartupError ? `: ${retrievalStartupError}` : ""}`
      : undefined;
    let ftsHits: Awaited<ReturnType<typeof ftsSearch>> = [];
    if (referential && searchQuery) {
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
    const recentBlock = renderRecentTurnsPlain(recentTurns);
    const [supabaseContext, memoryContext] = supabase
      ? await Promise.all([
          getRelevantContext(supabase, text),
          getMemoryContext(supabase),
        ])
      : ["", ""];
    const combinedRelevant = [recentBlock, indexedContent, supabaseContext]
      .filter(Boolean)
      .join("\n\n");

    const enrichedPrompt = capPrompt(buildPrompt(text, combinedRelevant, memoryContext), text);

    const tClaude0 = Date.now();
    let assistantText = "";
    let stripped = 0;
    let errorMsg: string | undefined;
    const deterministicTextbookResponse = buildSkippedTextbookResponse(text, ftsHits, {
      referentialFired: referential,
      contentTokenCount: queryContentTokens,
    });
    if (deterministicTextbookResponse) {
      assistantText = deterministicTextbookResponse;
    } else {
      try {
        const raw = await callClaude(enrichedPrompt, { resume: true });
        const intentResult = supabase
          ? await processMemoryIntents(supabase, raw)
          : raw;
        const stripResult = stripMemoryTags(intentResult);
        assistantText = ensureSendableResponse(
          stripResult.clean,
          "I’m sorry, I generated an empty response. Please try again.",
        );
        stripped = stripResult.stripped;
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
        if (errorMsg.startsWith("claude_timeout_")) {
          timeoutKind = "claude";
          assistantText = "Sorry, that took too long and I stopped it. Try a narrower request.";
        } else {
          assistantText = "Sorry, something went wrong on my end. Try again.";
        }
      }
    }
    const claudeMs = Date.now() - tClaude0;

    await sendResponse(ctx, assistantText);
    await saveMessage("assistant", assistantText);
    await appendTurn(chatId, { role: "assistant", content: assistantText, ts: new Date().toISOString() });

    if (stripped > 0) {
      console.log(`[memory-tag-leak-strip] stripped ${stripped} tag(s) from response`);
    }

    const rec: DecisionRecord = {
      ts,
      update_id: updateId,
      chat_id: chatId,
      message: text,
      trigger_fired: referential,
      hit_count: ftsHits.length,
      hits_summary: ftsHits.slice(0, 5).map((h) => ({
        path: h.file_path,
        sim: Number(h.display_score.toFixed(3)),
      })),
      injected_count: referential ? Math.min(ftsHits.length, 3) : 0,
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
  try {
    await ctx.replyWithChatAction("typing");

    if (!process.env.VOICE_PROVIDER) {
      await ctx.reply(
        "Voice transcription is not set up yet. " +
          "Run the setup again and choose a voice provider (Groq or local Whisper)."
      );
      return;
    }

    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply("Could not transcribe voice message.");
      return;
    }

    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`);

    const [relevantContext, memoryContext] = supabase
      ? await Promise.all([
          getRelevantContext(supabase, transcription),
          getMemoryContext(supabase),
        ])
      : ["", ""];

    const voiceUserMessage = `[Voice message transcribed]: ${transcription}`;
    const enrichedPrompt = capPrompt(buildPrompt(
      voiceUserMessage,
      relevantContext,
      memoryContext
    ), voiceUserMessage);
    const rawResponse = await callClaude(enrichedPrompt, { resume: true });
    const claudeResponse = supabase
      ? await processMemoryIntents(supabase, rawResponse)
      : rawResponse;

    await saveMessage("assistant", claudeResponse);
    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message. Check logs for details.").catch(() => undefined);
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
  try {
    await ctx.replyWithChatAction("typing");

    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = capPrompt(`[Image: ${filePath}]\n\n${caption}`);

    await saveMessage("user", `[Image]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    const cleanResponse = supabase
      ? await processMemoryIntents(supabase, claudeResponse)
      : claudeResponse;
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Image error:", error);
    await ctx.reply("Could not process image.").catch(() => undefined);
  } finally {
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
  try {
    await ctx.replyWithChatAction("typing");

    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = capPrompt(`[File: ${filePath}]\n\n${caption}`);

    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });

    await unlink(filePath).catch(() => {});

    const cleanResponse = supabase
      ? await processMemoryIntents(supabase, claudeResponse)
      : claudeResponse;
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Document error:", error);
    await ctx.reply("Could not process document.").catch(() => undefined);
  } finally {
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
  memoryContext?: string
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
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.",
  ];

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  // Layer 1 of memory-tag leak fix: only ask Claude to emit tags when there is
  // a Supabase to store them. Layer 2 (response strip) is in the text handler.
  if (supabase) {
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

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;
  response = ensureSendableResponse(
    response,
    "I’m sorry, I generated an empty response. Please try again.",
  );

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

// ============================================================
// START
// ============================================================

async function runStartupPreflight(): Promise<void> {
  console.log("Starting Claude Telegram Relay...");
  console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
  console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);
  console.log("[relay] RELAY_CWD:", RELAY_CWD);

  console.log("[relay] running retrieval preflight...");
  try {
    await retrievalPreflight();
    retrievalAvailable = true;
    retrievalStartupError = undefined;
  } catch (err) {
    retrievalAvailable = false;
    retrievalStartupError = err instanceof Error ? err.message : String(err);
    console.error(
      "[relay] retrieval preflight failed; continuing without indexed retrieval:",
      retrievalStartupError,
    );
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

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
