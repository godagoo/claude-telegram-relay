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
import { writeFile, mkdir, readFile, unlink, chmod } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "./transcribe.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";

// Build the full set of allowed user IDs.
// ALLOWED_USER_IDS is a comma-separated list of additional IDs beyond the owner.
const ALLOWED_USER_IDS: Set<string> = new Set(
  [
    ALLOWED_USER_ID,
    ...(process.env.ALLOWED_USER_IDS ?? "").split(",").map((s) => s.trim()),
  ].filter(Boolean)
);

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking per chat for conversation continuity
const SESSIONS_FILE = join(RELAY_DIR, "sessions.json");

interface SessionState {
  sessionId: string;
  lastActivity: string;
}

// ============================================================
// SESSION MANAGEMENT (per chat ID)
// ============================================================

const sessions = new Map<string, SessionState>();

async function loadSessions(): Promise<void> {
  try {
    const content = await readFile(SESSIONS_FILE, "utf-8");
    const data = JSON.parse(content) as Record<string, SessionState>;
    for (const [chatId, state] of Object.entries(data)) {
      sessions.set(chatId, state);
    }
  } catch {
    // No sessions file yet — start fresh
  }
}

async function saveSessions(): Promise<void> {
  const data: Record<string, SessionState> = {};
  for (const [chatId, state] of sessions.entries()) {
    data[chatId] = state;
  }
  await writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

await loadSessions();

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
await mkdir(RELAY_DIR, { recursive: true, mode: 0o755 });
await mkdir(TEMP_DIR, { recursive: true, mode: 0o755 });
await mkdir(UPLOADS_DIR, { recursive: true, mode: 0o755 });

// Explicitly set permissions regardless of whether dirs already existed
// (mkdir with mode does not update permissions on pre-existing directories)
await chmod(RELAY_DIR, 0o755);
await chmod(TEMP_DIR, 0o755);
await chmod(UPLOADS_DIR, 0o755);

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

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  if (ALLOWED_USER_IDS.size > 0 && (!userId || !ALLOWED_USER_IDS.has(userId))) {
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
  options?: { resume?: boolean; chatId?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  const chatId = options?.chatId || "default";
  const chatSession = sessions.get(chatId);

  // Resume the per-chat session if available
  if (options?.resume && chatSession?.sessionId) {
    args.push("--resume", chatSession.sessionId);
  }

  // Explicitly grant tools needed in non-interactive relay mode.
  // --allowedTools auto-approves these without --dangerously-skip-permissions
  // (which is blocked when running as root).
  args.push("--allowedTools", "Read,Write,Edit,Bash,WebFetch,WebSearch,Glob,Grep");

  // JSON output lets us capture the session_id reliably
  args.push("--output-format", "json");

  args.push("--model", "claude-haiku-4-5-20251001");

  console.log(`Calling Claude [chat:${chatId}]: ${prompt.substring(0, 50)}...`);

  try {
    // Strip Claude Code session markers so the spawned claude process doesn't
    // think it's running inside a nested session (causes an immediate crash).
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => k !== "CLAUDECODE" && !k.startsWith("CLAUDE_CODE_")
      )
    ) as NodeJS.ProcessEnv;

    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: childEnv,
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Parse JSON to extract response text and session ID
    try {
      const json = JSON.parse(output);
      if (json.session_id) {
        sessions.set(chatId, {
          sessionId: json.session_id,
          lastActivity: new Date().toISOString(),
        });
        await saveSessions();
      }
      // `result` holds the plain-text response in Claude CLI JSON mode
      return (json.result ?? output).trim();
    } catch {
      // Not valid JSON — return raw output (shouldn't happen normally)
      return output.trim();
    }
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
  }
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const chatId = ctx.chat.id.toString();
  console.log(`Message [chat:${chatId}]: ${text.substring(0, 50)}...`);

  await ctx.replyWithChatAction("typing");

  await saveMessage("user", text);

  // Gather context: semantic search + facts/goals
  const [relevantContext, memoryContext] = await Promise.all([
    getRelevantContext(supabase, text),
    getMemoryContext(supabase),
  ]);

  const enrichedPrompt = buildPrompt(text, relevantContext, memoryContext);
  const rawResponse = await callClaude(enrichedPrompt, { resume: true, chatId });

  // Parse and save any memory intents, strip tags from response
  const response = await processMemoryIntents(supabase, rawResponse);

  await saveMessage("assistant", response);
  await sendResponse(ctx, response);
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  const chatId = ctx.chat.id.toString();
  console.log(`Voice message [chat:${chatId}]: ${voice.duration}s`);
  await ctx.replyWithChatAction("typing");

  if (!process.env.VOICE_PROVIDER) {
    await ctx.reply(
      "Voice transcription is not set up yet. " +
        "Run the setup again and choose a voice provider (Groq or local Whisper)."
    );
    return;
  }

  try {
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

    const [relevantContext, memoryContext] = await Promise.all([
      getRelevantContext(supabase, transcription),
      getMemoryContext(supabase),
    ]);

    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      relevantContext,
      memoryContext
    );
    const rawResponse = await callClaude(enrichedPrompt, { resume: true, chatId });
    const claudeResponse = await processMemoryIntents(supabase, rawResponse);

    await saveMessage("assistant", claudeResponse);
    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message. Check logs for details.");
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  console.log(`Image received [chat:${chatId}]`);
  await ctx.replyWithChatAction("typing");

  try {
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
    await writeFile(filePath, Buffer.from(buffer), { mode: 0o644 });

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Image]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true, chatId });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Videos
bot.on("message:video", async (ctx) => {
  const video = ctx.message.video;
  const chatId = ctx.chat.id.toString();
  console.log(`Video received [chat:${chatId}]: ${video.duration}s, ${video.file_size} bytes`);
  await ctx.replyWithChatAction("typing");

  if (video.file_size && video.file_size > 20 * 1024 * 1024) {
    await ctx.reply(
      "This video is too large for me to download (Telegram's bot API limit is 20 MB). " +
        "Try sending a shorter clip or share a link instead."
    );
    return;
  }

  try {
    const file = await ctx.api.getFile(video.file_id);
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `video_${timestamp}.mp4`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer), { mode: 0o644 });

    const caption = ctx.message.caption || "";
    const prompt =
      `[Video file received: ${filePath}]\n\n` +
      `User sent a video. Caption: "${caption}". ` +
      `Note: you cannot view video content directly. Respond based on the caption or let the user know.`;

    await saveMessage("user", `[Video ${video.duration}s]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true, chatId });

    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    console.error("Video error:", error);
    await ctx.reply("Could not process video. It may be too large or unavailable.");
  }
});

// Round video messages (video notes)
bot.on("message:video_note", async (ctx) => {
  const videoNote = ctx.message.video_note;
  const chatId = ctx.chat.id.toString();
  console.log(`Video note received [chat:${chatId}]: ${videoNote.duration}s, ${videoNote.file_size} bytes`);
  await ctx.replyWithChatAction("typing");

  if (videoNote.file_size && videoNote.file_size > 20 * 1024 * 1024) {
    await ctx.reply(
      "This video note is too large for me to download (Telegram's bot API limit is 20 MB)."
    );
    return;
  }

  try {
    const file = await ctx.api.getFile(videoNote.file_id);
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `video_${timestamp}.mp4`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer), { mode: 0o644 });

    const prompt =
      `[Video file received: ${filePath}]\n\n` +
      `User sent a round video note (${videoNote.duration}s). ` +
      `Note: you cannot view video content directly. Let the user know you received it and ask what they need.`;

    await saveMessage("user", `[Video note ${videoNote.duration}s]`);

    const claudeResponse = await callClaude(prompt, { resume: true, chatId });

    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    console.error("Video note error:", error);
    await ctx.reply("Could not process video note. It may be too large or unavailable.");
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const chatId = ctx.chat.id.toString();
  console.log(`Document [chat:${chatId}]: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer), { mode: 0o644 });

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true, chatId });

    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
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

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

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

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized users: ${ALLOWED_USER_IDS.size ? [...ALLOWED_USER_IDS].join(", ") : "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
