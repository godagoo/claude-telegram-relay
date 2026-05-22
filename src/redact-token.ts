// Token redaction helper used at every boundary where the bot token might
// leak into stdout/stderr/logs: error.message from fetch, Telegram API URLs,
// shell traces, etc.
//
// PLAN.md section 1: "Redact token in all logs; never print the full token
// in setup or verify output."

export const REDACTED_TOKEN_PLACEHOLDER = "[REDACTED_TOKEN]";

// Matches a Telegram-shaped token in any URL of the form:
//   https://api.telegram.org/bot<TOKEN>/...
//   https://api.telegram.org/file/bot<TOKEN>/...
// The token has the shape "<numeric_id>:<alnum-/-/_ characters>".
const URL_TOKEN_PATTERN = /(api\.telegram\.org\/(?:file\/)?bot)([0-9]+:[A-Za-z0-9_-]+)/g;

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

export function redactBotToken(input: string, token?: string): string {
  if (input === null || input === undefined) return "";
  let out = String(input);
  if (token && token.length > 0) {
    out = out.split(token).join(REDACTED_TOKEN_PLACEHOLDER);
  }
  out = out.replace(URL_TOKEN_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED_TOKEN_PLACEHOLDER}`);
  return out;
}
