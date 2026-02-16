/**
 * Claude Telegram Relay - Entry Point
 *
 * Modular entry point that validates configuration,
 * sets up services, and starts the relay.
 *
 * Run: npm run start
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir } from "fs/promises";
import { Bot } from "grammy";

import { validateConfig } from "./config";
import {
  CaptureService,
  ClaudeService,
  DigestService,
  FileService,
  FixerService,
  MemoryService,
  ScannerService,
  SchedulerService,
  SessionManager,
  SynthesisService,
  handleDocument,
  handlePhoto,
  handleVoice,
} from "./services";
import { WatcherService } from "./services/watcher";
import type { AppConfig } from "./types";
import { FileAccessError } from "./types/files";
import type { ShareDiff } from "./types/files";
import {
  MessageQueue,
  createLockManager,
  createLogger,
  sendResponse,
  setupLockCleanup,
} from "./utils";

// Re-export for backwards compatibility
export * from "./types";
export * from "./config";
export * from "./utils";

const log = createLogger("main");
const execFileAsync = promisify(execFile);

/**
 * Verify Claude CLI is available before starting.
 */
async function checkClaudeCli(claudePath: string): Promise<void> {
  try {
    await execFileAsync(claudePath, ["--version"]);
    log.info("Claude CLI available");
  } catch {
    log.error(
      { claudePath },
      "Claude CLI not found. Install it or set CLAUDE_PATH.",
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Validate configuration
  const validation = validateConfig();
  if (!validation.success) {
    console.error("Configuration error:");
    for (const error of validation.errors) {
      console.error(error);
    }
    console.log("\nSetup instructions:");
    console.log("1. Copy .env.example to .env");
    console.log("2. Set TELEGRAM_BOT_TOKEN from @BotFather");
    console.log("3. Set TELEGRAM_USER_ID (your Telegram user ID)");
    process.exit(1);
  }

  const config = validation.config;
  log.info({ nodeEnv: config.nodeEnv }, "Configuration loaded");

  // Check Claude CLI availability
  await checkClaudeCli(config.claudePath);

  // Create required directories
  await mkdir(config.tempDir, { recursive: true });
  await mkdir(config.uploadsDir, { recursive: true });
  log.debug(
    { tempDir: config.tempDir, uploadsDir: config.uploadsDir },
    "Directories created",
  );

  // Acquire lock
  const lockManager = createLockManager(config.lockFile);
  if (!(await lockManager.acquire())) {
    log.error("Could not acquire lock. Another instance may be running.");
    process.exit(1);
  }
  setupLockCleanup(config.lockFile);
  log.debug("Lock acquired");

  // Start bot
  await startBot(config);
}

async function startBot(config: AppConfig): Promise<void> {
  const bot = new Bot(config.botToken);
  const claudeService = new ClaudeService(config, createLogger("claude"));
  const sessionManager = new SessionManager(
    config.sessionFile,
    config.sessionTtlMs,
    createLogger("session"),
  );
  const memoryService = new MemoryService(
    config.memoryFile,
    createLogger("memory"),
  );
  const queue = new MessageQueue();

  // Auth middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id.toString();

    if (config.allowedUserId && userId !== config.allowedUserId) {
      log.warn({ userId }, "Unauthorized access attempt");
      await ctx.reply("This bot is private.");
      return;
    }

    await next();
  });

  // /new command — reset session
  bot.command("new", async (ctx) => {
    await sessionManager.clear();
    await ctx.reply("Session cleared. Starting fresh conversation.");
  });

  // /help command — list available commands
  bot.command("help", async (ctx) => {
    const lines = [
      "**Available commands:**",
      "",
      "/new — start a fresh conversation",
      "/help — show this message",
    ];

    if (config.secondbrain?.enabled) {
      lines.push(
        "",
        "**SecondBrain:**",
        "/capture <thought> — save a note or idea",
        "/stats — show capture statistics",
        "/review — list items needing review",
        "/digest — generate a daily digest",
        "/fix <category> — re-categorise a capture",
      );
    }

    if (config.files?.shareRoot || config.files?.brainRoot) {
      lines.push(
        "",
        "**File access:**",
        "/files — list configured roots",
        "/files <root>/<path> — browse a directory  e.g. /files share/People",
        "/read <root>/<path> — inject file into Claude  e.g. /read share/Notes.md",
        "/search <query> — search file names  e.g. /search alice",
      );
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  // SecondBrain commands (only when enabled)
  let scannerServiceForReindex: ScannerService | undefined;
  if (config.secondbrain?.enabled) {
    const sbLog = createLogger("secondbrain");
    const captureService = new CaptureService(config, claudeService, sbLog);
    scannerServiceForReindex = new ScannerService(config, sbLog);
    const synthesisService = new SynthesisService(
      scannerServiceForReindex,
      config,
      sbLog,
    );
    const digestService = new DigestService(
      claudeService,
      synthesisService,
      config,
      sbLog,
    );
    const fixerService = new FixerService(config, sbLog);
    const schedulerService = new SchedulerService(
      digestService,
      (chatId, text) => bot.api.sendMessage(chatId, text),
      config,
      sbLog,
    );

    schedulerService.start();

    bot.command("capture", async (ctx) => {
      const text = ctx.match;
      if (!text) {
        await ctx.reply("Usage: /capture <your thought>");
        return;
      }
      await ctx.replyWithChatAction("typing");
      const result = await captureService.capture(
        text,
        ctx.from?.id.toString(),
      );
      const reviewNote = result.needsReview ? " (needs review)" : "";
      await ctx.reply(
        `Captured as **${result.category}** (${(result.confidence * 100).toFixed(0)}% confidence)${reviewNote}\nFile: \`${result.filename}\``,
        { parse_mode: "Markdown" },
      );
    });

    bot.command("stats", async (ctx) => {
      await ctx.replyWithChatAction("typing");
      const stats = await synthesisService.getStats();
      const lines = [
        "**Capture Statistics**",
        `Total: ${stats.total} | This week: ${stats.week} | Today: ${stats.today}`,
        `Avg confidence: ${(stats.avgConfidence * 100).toFixed(0)}%`,
        `Needs review: ${stats.needsReview}`,
        "",
        "**By Category:**",
        ...Object.entries(stats.byCategory).map(
          ([cat, count]) => `  ${cat}: ${count}`,
        ),
      ];
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    });

    bot.command("review", async (ctx) => {
      await ctx.replyWithChatAction("typing");
      const docs = await scannerServiceForReindex!.getNeedsReview();
      if (docs.length === 0) {
        await ctx.reply("No items need review. All clear!");
        return;
      }
      const lines = ["**Items Needing Review:**", ""];
      for (const doc of docs) {
        lines.push(
          `- \`${doc.filename}\` (${(doc.confidence * 100).toFixed(0)}%) — ${doc.title}`,
        );
      }
      lines.push("", "Use `/fix <filename> <category>` to reclassify.");
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    });

    bot.command("digest", async (ctx) => {
      await ctx.replyWithChatAction("typing");
      const isWeekly = ctx.match?.trim().toLowerCase() === "weekly";
      const content = isWeekly
        ? await digestService.generateWeeklyReview()
        : await digestService.generateDailyDigest();
      await ctx.reply(content);
    });

    bot.command("fix", async (ctx) => {
      const args = ctx.match?.trim().split(/\s+/) ?? [];
      if (args.length === 1 && args[0]) {
        // /fix <category> — fix last capture
        const filename = await fixerService.findLastUserFile(
          ctx.from?.id.toString() ?? "",
        );
        if (!filename) {
          await ctx.reply("No recent captures found to fix.");
          return;
        }
        const result = await fixerService.fixCapture(
          args[0],
          filename,
          ctx.from?.id.toString(),
        );
        await ctx.reply(result.message);
      } else if (args.length >= 2 && args[0] && args[1]) {
        // /fix <filename> <category>
        const result = await fixerService.fixCapture(
          args[1],
          args[0],
          ctx.from?.id.toString(),
        );
        await ctx.reply(result.message);
      } else {
        await ctx.reply(
          "Usage: `/fix <category>` or `/fix <filename> <category>`",
          {
            parse_mode: "Markdown",
          },
        );
      }
    });

    sbLog.info("SecondBrain commands registered");
  }

  // File access commands (only when configured)
  let watcherService: WatcherService | undefined;
  if (config.files?.shareRoot || config.files?.brainRoot) {
    const filesLog = createLogger("files");
    const fileService = new FileService(config.files, filesLog);

    // Determine the authorized chat ID for watcher notifications
    const authorizedChatId =
      config.allowedUserId || config.secondbrain?.chatId || "";

    // onShareChange callback — send Telegram notification
    const onShareChange = async (diff: ShareDiff) => {
      const lines: string[] = ["Files changed on share:"];
      for (const f of diff.added) lines.push(`  + ${f}`);
      for (const f of diff.modified) lines.push(`  ~ ${f}`);
      for (const f of diff.deleted) lines.push(`  - ${f}`);
      if (authorizedChatId) {
        try {
          await bot.api.sendMessage(authorizedChatId, lines.join("\n"));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          filesLog.warn(
            { error: msg },
            "Failed to send share change notification",
          );
        }
      }
    };

    // onBrainChange callback — trigger scanner re-index (if secondbrain enabled)
    const onBrainChange = async () => {
      if (config.secondbrain?.enabled && scannerServiceForReindex) {
        try {
          await scannerServiceForReindex.scanAllDocuments();
          filesLog.info("Brain change: scanner re-index complete");
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          filesLog.warn({ error: msg }, "Brain change: re-index failed");
        }
      }
    };

    watcherService = new WatcherService(
      config.files,
      { onShareChange, onBrainChange },
      fileService.pendingWrites,
      filesLog,
    );

    // /files command — browse directories
    // Usage: /files [<root>/<path>]
    // Examples: /files  /files share  /files share/People
    bot.command("files", async (ctx) => {
      const args = ctx.match?.trim() || undefined;
      try {
        const entries = await fileService.list(args);
        if (entries.length === 0) {
          await ctx.reply("(empty directory)");
          return;
        }
        const lines = entries.map((e) =>
          e.type === "directory" ? `[DIR] ${e.name}/` : `[FILE] ${e.name}`,
        );
        await ctx.reply(lines.join("\n"));
      } catch (err: unknown) {
        if (err instanceof FileAccessError) {
          await ctx.reply(`Error: ${err.message}`);
        } else {
          await ctx.reply("Unexpected error listing files.");
        }
      }
    });

    // /read <root/path> — inject file content into Claude prompt
    // Example: /read share/People/Alice.md
    bot.command("read", async (ctx) => {
      const rawPath = ctx.match?.trim();
      if (!rawPath) {
        await ctx.reply(
          "Usage: /read <root/path>  e.g. /read share/People/Alice.md",
        );
        return;
      }
      try {
        const result = await fileService.read(rawPath);
        await ctx.replyWithChatAction("typing");

        const filePrefix = `File content from ${rawPath}:\n\n${result.text}\n\n---\n\n`;
        const memoryContext = await memoryService.getContext();
        const prompt = claudeService.buildPrompt(
          `${filePrefix}(File injected — you may now answer questions about it.)`,
          memoryContext || undefined,
        );
        const response = await claudeService.call(prompt);
        await sessionManager.updateActivity();

        let reply = response;
        if (result.truncated) {
          reply += `\n\n_(File was truncated at ${config.files?.maxReadBytes ?? 51200} bytes)_`;
        }
        await sendResponse(ctx, reply);
      } catch (err: unknown) {
        if (err instanceof FileAccessError) {
          await ctx.reply(`Error: ${err.message}`);
        } else {
          await ctx.reply("Unexpected error reading file.");
        }
      }
    });

    // /search <query> — search file names across configured roots
    // Example: /search alice  /search share/alice
    bot.command("search", async (ctx) => {
      const query = ctx.match?.trim();
      if (!query) {
        await ctx.reply("Usage: /search <query>  e.g. /search alice");
        return;
      }
      try {
        const results = await fileService.search(query);
        if (results.length === 0) {
          await ctx.reply(`No results found for \`${query}\``, {
            parse_mode: "Markdown",
          });
          return;
        }
        const lines = results.map(
          (r, i) =>
            `${i + 1}. ${r.root}/${r.relativePath}${r.type === "directory" ? "/" : ""}`,
        );
        await ctx.reply(lines.join("\n"));
      } catch (err: unknown) {
        if (err instanceof FileAccessError) {
          await ctx.reply(`Error: ${err.message}`);
        } else {
          await ctx.reply("Unexpected error searching files.");
        }
      }
    });

    filesLog.info("File access commands registered");
  }

  // Text message handler
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    log.info({ text: text.substring(0, 50) }, "Message received");

    // Send typing indicator before processing
    await ctx.replyWithChatAction("typing");

    queue.enqueue(async () => {
      const memoryContext = await memoryService.getContext();
      const prompt = claudeService.buildPrompt(
        text,
        memoryContext || undefined,
      );
      const response = await claudeService.call(prompt);

      // Update session activity tracking (no CLI session resumption)
      await sessionManager.updateActivity();

      // Process intent markers from Claude's response
      const { cleaned, intents, confirmations } =
        claudeService.detectIntents(response);

      if (intents.remember) {
        await memoryService.addFact(intents.remember);
      }
      if (intents.goal) {
        await memoryService.addGoal(intents.goal.text, intents.goal.deadline);
      }
      if (intents.done) {
        await memoryService.completeGoal(intents.done);
      }

      // Send cleaned response with confirmations appended
      let finalResponse = cleaned;
      if (confirmations.length > 0) {
        finalResponse += `\n\n${confirmations.join("\n")}`;
      }

      await sendResponse(ctx, finalResponse);
    });
  });

  // Media handler options
  const mediaOptions = {
    claudeCall: (prompt: string) => claudeService.call(prompt),
    uploadsDir: config.uploadsDir,
    botToken: config.botToken,
    logger: createLogger("media"),
  };

  // Photo handler
  bot.on("message:photo", async (ctx) => {
    log.info("Photo received");
    await ctx.replyWithChatAction("typing");

    queue.enqueue(async () => {
      const response = await handlePhoto(ctx, mediaOptions);
      await sendResponse(ctx, response);
    });
  });

  // Document handler
  bot.on("message:document", async (ctx) => {
    const fileName = ctx.message.document.file_name;
    log.info({ fileName }, "Document received");
    await ctx.replyWithChatAction("typing");

    queue.enqueue(async () => {
      const response = await handleDocument(ctx, mediaOptions);
      await sendResponse(ctx, response);
    });
  });

  // Voice handler
  bot.on("message:voice", async (ctx) => {
    log.info("Voice message received");
    await ctx.reply(handleVoice());
  });

  log.info(
    { allowedUserId: config.allowedUserId || "ANY" },
    "Starting Claude Telegram Relay",
  );

  bot.start({
    onStart: () => {
      log.info("Bot is running");
      if (watcherService) {
        watcherService.start();
      }
    },
  });
}

// Run if this is the main module
main().catch((error) => {
  log.error({ error }, "Fatal error");
  process.exit(1);
});
