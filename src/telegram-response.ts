import { formatPhoneHandoffForTelegram } from "./imessage-draft";

export const DEFAULT_EMPTY_RESPONSE =
  "I’m sorry, I generated an empty response. Please try again.";

export interface TelegramReplyTarget {
  reply(
    text: string,
    options?: { link_preview_options?: { is_disabled?: boolean } },
  ): Promise<unknown>;
}

export interface SendTelegramResponseResult {
  chunksSent: number;
  chunkCount: number;
  partialFailure?: string;
}

export function prepareTelegramResponseText(
  text: string,
  fallback = DEFAULT_EMPTY_RESPONSE,
): string {
  const trimmed = text.trim();
  return formatPhoneHandoffForTelegram(trimmed.length > 0 ? trimmed : fallback);
}

export function splitTelegramResponseText(
  text: string,
  maxLength = 4000,
): string[] {
  const prepared = prepareTelegramResponseText(text);
  if (prepared.length <= maxLength) return [prepared];

  const chunks: string[] = [];
  let remaining = prepared;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", maxLength);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", maxLength);
    if (splitIndex <= 0) splitIndex = maxLength;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

export async function sendTelegramResponse(
  target: TelegramReplyTarget,
  response: string,
  maxLength = 4000,
): Promise<SendTelegramResponseResult> {
  const chunks = splitTelegramResponseText(response, maxLength);
  let chunksSent = 0;

  for (const chunk of chunks) {
    try {
      await target.reply(chunk, { link_preview_options: { is_disabled: true } });
      chunksSent += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (chunksSent > 0) {
        const partialFailure =
          `telegram_partial_send_after_${chunksSent}_of_${chunks.length}: ${msg}`;
        console.error(`[telegram] ${partialFailure}`);
        return { chunksSent, chunkCount: chunks.length, partialFailure };
      }
      throw err;
    }
  }

  return { chunksSent, chunkCount: chunks.length };
}
