/**
 * Gentech Telegram Bot — Main Entry Point
 *
 * Multi-user AI assistant powered by Claude Haiku 4.5.
 * OpenClaw-inspired: action-oriented, direct, proactive.
 *
 * Run: bun run src/bot.ts
 */

import { Bot } from "grammy";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "./transcribe.ts";
import { processMemoryIntents, getMemoryContext, getRelevantContext, saveMessage } from "./memory.ts";
import { initAI, loadProfile, callAI, clearHistory, getAIMode } from "./ai.ts";
import { isAuthorized, isOwner, addUser, removeUser, listUsers, checkRateLimit } from "./auth.ts";
import { backupEnv, restoreEnv, listBackups } from "./env-guard.ts";
import { initScheduler, stopScheduler, addCronJob, listCronJobs, deleteCronJob, toggleCronJob, getCronHistory } from "./scheduler.ts";
import { describeTelegramVideo } from "./skills/video.ts";
import { sendResponse, sendToChat, log } from "./utils.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const OWNER_ID = process.env.TELEGRAM_OWNER_ID || process.env.TELEGRAM_USER_ID || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");
const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const GENTECH_GROUP_ID = process.env.GENTECH_GROUP_ID || "";
const LOCK_FILE = join(RELAY_DIR, "bot.lock");

// ============================================================
// STARTUP CHECKS
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\n1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

if (!OWNER_ID) {
  console.error("TELEGRAM_OWNER_ID not set!");
  console.log("\nMessage @userinfobot on Telegram to get your user ID.");
  console.log("Add it to .env as TELEGRAM_OWNER_ID=your_id");
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("\nNo ANTHROPIC_API_KEY found — using Claude CLI mode (your subscription).");
  console.log("Skills available via pre-processing: web search, DeFi, YouTube, smart contracts.\n");
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);
    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0);
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

process.on("SIGINT", async () => {
  stopScheduler();
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  stopScheduler();
  await releaseLock();
  process.exit(0);
});

if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

// ============================================================
// INITIALIZE
// ============================================================

// Supabase
const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// ENV backup on startup
await backupEnv(supabase);

// AI
initAI();
await loadProfile();

// Telegram bot
const bot = new Bot(BOT_TOKEN);
let botUsername = "";

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();
  if (!userId) return;

  // Auth check
  if (!(await isAuthorized(supabase, userId))) {
    log("info", "unauthorized_access", { userId });
    await ctx.reply("You're not authorized to use this bot. Ask the owner to add you.");
    return;
  }

  // Rate limit check
  if (!checkRateLimit(userId)) {
    await ctx.reply("Rate limit exceeded. Please wait before sending more messages.");
    return;
  }

  await next();
});

// ============================================================
// COMMANDS
// ============================================================

bot.command("start", async (ctx) => {
  const name = ctx.from?.first_name || "there";
  await ctx.reply(
    `Hey ${name}! I'm Gentech — your personal AI agent.\n\n` +
    `I can search the web, track crypto & DeFi, analyze smart contracts, ` +
    `summarize YouTube videos, and remember everything.\n\n` +
    `Just talk to me naturally. Type /help to see all commands.`
  );
});

bot.command("help", async (ctx) => {
  const userId = ctx.from?.id.toString() || "";
  const ownerCmds = isOwner(userId)
    ? "\n\nOwner Commands:\n" +
      "/users add <id> — Authorize a user\n" +
      "/users remove <id> — Remove a user\n" +
      "/users list — List authorized users\n" +
      "/env backup — Backup .env now\n" +
      "/env restore — Restore last .env backup\n" +
      "/env list — List backups"
    : "";

  await ctx.reply(
    "Commands:\n\n" +
    "/help — This message\n" +
    "/cron add \"name\" \"schedule\" \"action\" — Schedule a recurring task\n" +
    "/cron list — List scheduled jobs\n" +
    "/cron delete <name> — Delete a job\n" +
    "/cron pause <name> — Pause a job\n" +
    "/cron resume <name> — Resume a job\n" +
    "/cron history <name> — View execution history\n" +
    "/memory — View stored facts & goals\n" +
    "/clear — Clear conversation history" +
    ownerCmds +
    "\n\nSkills (auto-detected):\n" +
    "- Web search (ask me to search/look up anything)\n" +
    "- Crypto prices & DeFi data (ask about any token)\n" +
    "- YouTube summaries (send a YouTube link)\n" +
    "- Smart contract analysis (send contract code)\n" +
    "- Voice messages (send a voice note)\n\n" +
    "Or just send a message — I'll figure out what you need."
  );
});

// ---- Cron Commands ----

bot.command("cron", async (ctx) => {
  if (!supabase) {
    await ctx.reply("Cron jobs require Supabase. Set SUPABASE_URL and SUPABASE_ANON_KEY in .env.");
    return;
  }

  const userId = ctx.from?.id.toString() || "";
  const text = ctx.message?.text || "";
  const args = text.replace(/^\/cron\s*/, "").trim();

  if (!args || args === "help") {
    await ctx.reply(
      "Cron commands:\n\n" +
      '/cron add "name" "schedule" "action"\n' +
      "  Example: /cron add \"morning\" \"0 9 * * *\" \"Give me a morning briefing\"\n\n" +
      "/cron list — Show all jobs\n" +
      "/cron delete <name> — Remove a job\n" +
      "/cron pause <name> — Pause a job\n" +
      "/cron resume <name> — Resume a paused job\n" +
      "/cron history <name> — Last 10 executions\n\n" +
      "Schedule format (cron): minute hour day month weekday\n" +
      "  0 9 * * * = daily at 9 AM\n" +
      "  */30 * * * * = every 30 minutes\n" +
      "  0 9 * * 1-5 = weekdays at 9 AM"
    );
    return;
  }

  // Parse subcommand
  if (args.startsWith("add")) {
    // Parse: add "name" "schedule" "action"
    const match = args.match(/^add\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"$/);
    if (!match) {
      await ctx.reply('Usage: /cron add "name" "schedule" "action"\nExample: /cron add "daily-check" "0 9 * * *" "Check my calendar and emails"');
      return;
    }
    const result = await addCronJob(supabase, userId, match[1], match[2], match[3]);
    await ctx.reply(result);
  } else if (args.startsWith("list")) {
    const result = await listCronJobs(supabase, userId);
    await ctx.reply(result);
  } else if (args.startsWith("delete ")) {
    const name = args.replace("delete ", "").trim();
    const result = await deleteCronJob(supabase, userId, name);
    await ctx.reply(result);
  } else if (args.startsWith("pause ")) {
    const name = args.replace("pause ", "").trim();
    const result = await toggleCronJob(supabase, userId, name, false);
    await ctx.reply(result);
  } else if (args.startsWith("resume ")) {
    const name = args.replace("resume ", "").trim();
    const result = await toggleCronJob(supabase, userId, name, true);
    await ctx.reply(result);
  } else if (args.startsWith("history ")) {
    const name = args.replace("history ", "").trim();
    const result = await getCronHistory(supabase, userId, name);
    await ctx.reply(result);
  } else {
    await ctx.reply("Unknown cron command. Use /cron help for usage.");
  }
});

// ---- User Management (owner only) ----

bot.command("users", async (ctx) => {
  const userId = ctx.from?.id.toString() || "";
  if (!isOwner(userId)) {
    await ctx.reply("Only the bot owner can manage users.");
    return;
  }
  if (!supabase) {
    await ctx.reply("User management requires Supabase.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/users\s*/, "").trim();

  if (args.startsWith("add ")) {
    const targetId = args.replace("add ", "").trim();
    const success = await addUser(supabase, targetId, undefined, userId);
    await ctx.reply(success ? `User ${targetId} authorized.` : `Failed to add user.`);
  } else if (args.startsWith("remove ")) {
    const targetId = args.replace("remove ", "").trim();
    const success = await removeUser(supabase, targetId);
    await ctx.reply(success ? `User ${targetId} removed.` : `Failed to remove user (cannot remove owner).`);
  } else if (args === "list") {
    const users = await listUsers(supabase);
    if (users.length === 0) {
      await ctx.reply(`No authorized users (besides owner: ${OWNER_ID}).`);
    } else {
      const list = users.map((u, i) =>
        `${i + 1}. ${u.telegram_id}${u.username ? ` (@${u.username})` : ""} [${u.role}]`
      ).join("\n");
      await ctx.reply(`Authorized users:\n\nOwner: ${OWNER_ID}\n${list}`);
    }
  } else {
    await ctx.reply("Usage: /users add <id> | /users remove <id> | /users list");
  }
});

// ---- ENV Management (owner only) ----

bot.command("env", async (ctx) => {
  const userId = ctx.from?.id.toString() || "";
  if (!isOwner(userId)) {
    await ctx.reply("Only the bot owner can manage environment backups.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/env\s*/, "").trim();

  if (args === "backup") {
    const name = await backupEnv(supabase, "manual");
    await ctx.reply(name ? `Backup created: ${name}` : "No .env file to backup.");
  } else if (args === "restore") {
    const success = await restoreEnv(supabase);
    await ctx.reply(success ? "ENV restored from latest backup. Restart the bot to apply." : "No backups found.");
  } else if (args === "list") {
    const backups = await listBackups(supabase);
    const parts: string[] = [];
    if (backups.local.length > 0) {
      parts.push("Local backups:\n" + backups.local.map((f, i) => `  ${i + 1}. ${f}`).join("\n"));
    }
    if (backups.remote.length > 0) {
      parts.push("Supabase backups:\n" + backups.remote.map((b, i) =>
        `  ${i + 1}. ${b.created_at} [${b.source}] (${b.id.substring(0, 8)}...)`
      ).join("\n"));
    }
    await ctx.reply(parts.length > 0 ? parts.join("\n\n") : "No backups found.");
  } else {
    await ctx.reply("Usage: /env backup | /env restore | /env list");
  }
});

// ---- Memory ----

bot.command("memory", async (ctx) => {
  const userId = ctx.from?.id.toString() || "";
  const context = await getMemoryContext(supabase, userId);
  await ctx.reply(context || "No stored memories yet. I'll remember things as we chat.");
});

// ---- Clear History ----

bot.command("clear", async (ctx) => {
  const userId = ctx.from?.id.toString() || "";
  clearHistory(userId);
  await ctx.reply("Conversation history cleared. Memory (facts & goals) is preserved.");
});

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id.toString() || "";
  const text = ctx.message.text;

  log("info", "message_received", { userId, type: "text", length: text.length });
  await ctx.replyWithChatAction("typing");

  await saveMessage(supabase, "user", text, userId);

  const [relevantContext, memoryContext] = await Promise.all([
    getRelevantContext(supabase, text, userId),
    getMemoryContext(supabase, userId),
  ]);

  const rawResponse = await callAI(text, {
    userId,
    userName: ctx.from?.first_name || USER_NAME,
    timezone: USER_TIMEZONE,
    memoryContext,
    relevantContext,
  });

  const response = await processMemoryIntents(supabase, rawResponse, userId);
  await saveMessage(supabase, "assistant", response, userId);
  await sendResponse(ctx, response);
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const userId = ctx.from?.id.toString() || "";
  const voice = ctx.message.voice;
  log("info", "message_received", { userId, type: "voice", duration: voice.duration });
  await ctx.replyWithChatAction("typing");

  if (!process.env.VOICE_PROVIDER) {
    await ctx.reply("Voice transcription not set up. Set VOICE_PROVIDER=groq and GROQ_API_KEY in .env.");
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

    await saveMessage(supabase, "user", `[Voice ${voice.duration}s]: ${transcription}`, userId);

    const [relevantContext, memoryContext] = await Promise.all([
      getRelevantContext(supabase, transcription, userId),
      getMemoryContext(supabase, userId),
    ]);

    const rawResponse = await callAI(`[Voice message transcribed]: ${transcription}`, {
      userId,
      userName: ctx.from?.first_name || USER_NAME,
      timezone: USER_TIMEZONE,
      memoryContext,
      relevantContext,
    });

    const aiResponse = await processMemoryIntents(supabase, rawResponse, userId);
    await saveMessage(supabase, "assistant", aiResponse, userId);
    await sendResponse(ctx, aiResponse);
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message.");
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  const userId = ctx.from?.id.toString() || "";
  log("info", "message_received", { userId, type: "photo" });
  await ctx.replyWithChatAction("typing");

  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = Buffer.from(await response.arrayBuffer());
    const base64 = buffer.toString("base64");

    const caption = ctx.message.caption || "Analyze this image.";
    await saveMessage(supabase, "user", `[Image]: ${caption}`, userId);

    const [relevantContext, memoryContext] = await Promise.all([
      getRelevantContext(supabase, caption, userId),
      getMemoryContext(supabase, userId),
    ]);

    const rawResponse = await callAI(caption, {
      userId,
      userName: ctx.from?.first_name || USER_NAME,
      timezone: USER_TIMEZONE,
      memoryContext,
      relevantContext,
      imageData: { base64, mediaType: "image/jpeg" },
    });

    const aiResponse = await processMemoryIntents(supabase, rawResponse, userId);
    await saveMessage(supabase, "assistant", aiResponse, userId);
    await sendResponse(ctx, aiResponse);
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Videos (Telegram video messages + video files)
bot.on(["message:video", "message:video_note"], async (ctx) => {
  const userId = ctx.from?.id.toString() || "";
  const video = ctx.message.video || ctx.message.video_note;
  log("info", "message_received", { userId, type: "video", duration: video?.duration });
  await ctx.replyWithChatAction("typing");

  const caption = ctx.message.caption || "I sent you a video.";
  const videoDesc = describeTelegramVideo(
    (video as any)?.file_name,
    video?.duration,
    (video as any)?.mime_type,
    caption,
    video?.file_size
  );

  await saveMessage(supabase, "user", `[Video]: ${caption}`, userId);

  const [relevantContext, memoryContext] = await Promise.all([
    getRelevantContext(supabase, caption, userId),
    getMemoryContext(supabase, userId),
  ]);

  const rawResponse = await callAI(
    `${videoDesc}\n\nThe user sent a video via Telegram. ${caption}`,
    {
      userId,
      userName: ctx.from?.first_name || USER_NAME,
      timezone: USER_TIMEZONE,
      memoryContext,
      relevantContext,
    }
  );

  const aiResponse = await processMemoryIntents(supabase, rawResponse, userId);
  await saveMessage(supabase, "assistant", aiResponse, userId);
  await sendResponse(ctx, aiResponse);
});

// Documents
bot.on("message:document", async (ctx) => {
  const userId = ctx.from?.id.toString() || "";
  const doc = ctx.message.document;
  log("info", "message_received", { userId, type: "document", name: doc.file_name });
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
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;

    // Read text-based files for direct analysis
    let fileContent = "";
    const textExtensions = [".txt", ".md", ".json", ".csv", ".ts", ".js", ".py", ".sol", ".rs", ".toml", ".yaml", ".yml", ".xml", ".html", ".css", ".env", ".sh"];
    const isText = textExtensions.some((ext) => fileName.toLowerCase().endsWith(ext));

    if (isText) {
      try {
        fileContent = await readFile(filePath, "utf-8");
        if (fileContent.length > 10000) {
          fileContent = fileContent.substring(0, 10000) + "\n\n[File truncated — showing first 10000 characters]";
        }
      } catch {
        // Not readable as text
      }
    }

    await saveMessage(supabase, "user", `[Document: ${doc.file_name}]: ${caption}`, userId);

    const prompt = fileContent
      ? `[File: ${fileName}]\n\n${fileContent}\n\n${caption}`
      : `[File received: ${fileName}, size: ${(doc.file_size || 0) / 1024}KB]\n\n${caption}`;

    const rawResponse = await callAI(prompt, {
      userId,
      userName: ctx.from?.first_name || USER_NAME,
      timezone: USER_TIMEZONE,
    });

    await unlink(filePath).catch(() => {});

    const aiResponse = await processMemoryIntents(supabase, rawResponse, userId);
    await saveMessage(supabase, "assistant", aiResponse, userId);
    await sendResponse(ctx, aiResponse);
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// SCHEDULER INTEGRATION
// ============================================================

async function schedulerExecute(userId: string, action: string): Promise<string> {
  const memoryContext = await getMemoryContext(supabase, userId);

  return callAI(action, {
    userId,
    userName: USER_NAME,
    timezone: USER_TIMEZONE,
    memoryContext,
  });
}

async function schedulerSendMessage(userId: string, text: string): Promise<void> {
  try {
    await sendToChat(bot, userId, text);
  } catch (err) {
    console.error(`Scheduler: Failed to send to ${userId}:`, err);
  }
}

// ============================================================
// START
// ============================================================

console.log("Starting Gentech Bot...");
console.log(`AI Mode: ${getAIMode() === "api" ? "Anthropic API (Haiku 4.5)" : "Claude CLI (subscription)"}`);
console.log(`Owner: ${OWNER_ID}`);
console.log(`Supabase: ${supabase ? "connected" : "not configured"}`);
console.log(`Voice: ${process.env.VOICE_PROVIDER || "not configured"}`);
console.log(`Brave Search: ${process.env.BRAVE_API_KEY ? "configured" : "not configured"}`);

// Initialize scheduler if Supabase is available
if (supabase) {
  await initScheduler(supabase, schedulerExecute, schedulerSendMessage, USER_TIMEZONE, GENTECH_GROUP_ID);
}

bot.start({
  onStart: (botInfo) => {
    botUsername = botInfo.username;
    console.log(`Bot is running! @${botUsername}`);
  },
});
