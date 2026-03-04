/**
 * Claude Telegram Relay — Test Telegram Connection
 *
 * Verifies bot token and user ID are valid by sending a test message.
 *
 * Usage: bun run setup/test-telegram.ts
 */

import { join, dirname } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");

// Load .env manually (no dotenv dependency)
async function loadEnv(): Promise<Record<string, string>> {
  const envPath = join(PROJECT_ROOT, ".env");
  try {
    const content = await Bun.file(envPath).text();
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

async function main() {
  console.log("");
  console.log(bold("  Telegram Connection Test"));
  console.log("");

  const env = await loadEnv();
  const token = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
  const userId = env.TELEGRAM_OWNER_ID || env.TELEGRAM_USER_ID || process.env.TELEGRAM_OWNER_ID || process.env.TELEGRAM_USER_ID || "";

  // Check token exists
  if (!token || token === "your_bot_token_from_botfather") {
    console.log(`  ${FAIL} TELEGRAM_BOT_TOKEN not set in .env`);
    console.log(`      ${dim("Get one from @BotFather on Telegram")}`);
    process.exit(1);
  }
  console.log(`  ${PASS} Bot token found`);

  // Check user ID exists
  if (!userId || userId === "your_telegram_user_id") {
    console.log(`  ${FAIL} TELEGRAM_OWNER_ID not set in .env`);
    console.log(`      ${dim("Get yours from @userinfobot on Telegram")}`);
    process.exit(1);
  }
  console.log(`  ${PASS} User ID found: ${userId}`);

  // Test bot token with getMe
  console.log(`\n  Testing bot token...`);
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const meData = await meRes.json() as any;

    if (!meData.ok) {
      console.log(`  ${FAIL} Invalid bot token`);
      console.log(`      ${dim(meData.description || "Check your token with @BotFather")}`);
      process.exit(1);
    }

    console.log(`  ${PASS} Bot: @${meData.result.username} (${meData.result.first_name})`);
  } catch (err: any) {
    console.log(`  ${FAIL} Could not reach Telegram API`);
    console.log(`      ${dim(err.message)}`);
    process.exit(1);
  }

  // Send test message
  console.log(`\n  Sending test message...`);
  try {
    const msgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: userId,
        text: "✅ Connection test successful! Your bot is working.",
      }),
    });
    const msgData = await msgRes.json() as any;

    if (!msgData.ok) {
      if (msgData.description?.includes("chat not found")) {
        console.log(`  ${FAIL} Could not reach user ${userId}`);
        console.log(`      ${dim("Make sure you've started a conversation with your bot first.")}`);
        console.log(`      ${dim("Open Telegram, find your bot, and send /start")}`);
      } else {
        console.log(`  ${FAIL} Send failed: ${msgData.description}`);
      }
      process.exit(1);
    }

    console.log(`  ${PASS} Test message sent! Check your Telegram.`);
  } catch (err: any) {
    console.log(`  ${FAIL} Could not send message`);
    console.log(`      ${dim(err.message)}`);
    process.exit(1);
  }

  console.log(`\n  ${green("All good!")} Your Telegram bot is configured correctly.`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
