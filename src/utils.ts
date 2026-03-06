/**
 * Shared Utilities
 */

import type { Context } from "grammy";

const MAX_TELEGRAM_LENGTH = 4000;

/**
 * Send a response to Telegram, splitting long messages at natural boundaries.
 */
export async function sendResponse(ctx: Context, response: string): Promise<void> {
  if (!response.trim()) {
    await ctx.reply("(No response generated)");
    return;
  }

  if (response.length <= MAX_TELEGRAM_LENGTH) {
    await ctx.reply(response, { parse_mode: undefined });
    return;
  }

  const chunks = splitMessage(response, MAX_TELEGRAM_LENGTH);
  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: undefined });
  }
}

/**
 * Send a response to a specific chat (for cron jobs / proactive messages).
 */
export async function sendToChat(
  bot: { api: { sendMessage: (chatId: string | number, text: string) => Promise<unknown> } },
  chatId: string | number,
  text: string
): Promise<void> {
  if (!text.trim()) return;

  if (text.length <= MAX_TELEGRAM_LENGTH) {
    await bot.api.sendMessage(chatId, text);
    return;
  }

  const chunks = splitMessage(text, MAX_TELEGRAM_LENGTH);
  for (const chunk of chunks) {
    await bot.api.sendMessage(chatId, chunk);
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", maxLength);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", maxLength);
    if (splitIndex === -1) splitIndex = maxLength;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

/**
 * Format a date in user's timezone.
 */
export function formatTime(timezone: string): string {
  return new Date().toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Simple logger with structured output.
 */
export function log(level: "info" | "warn" | "error" | "debug", event: string, data?: Record<string, unknown>): void {
  const entry = {
    time: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}
