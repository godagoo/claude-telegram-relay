/**
 * Smart Check-in Example
 *
 * A proactive assistant pattern where Claude decides:
 * - IF to check in (based on context)
 * - WHAT to say (based on goals, time, etc.)
 *
 * Run periodically (e.g., every 30 minutes) and Claude
 * intelligently decides whether to message you.
 *
 * Run: bun run examples/smart-checkin.ts
 */

import { spawn } from "bun";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const PROJECT_ROOT = dirname(import.meta.dir);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

const DATA_DIR = join(PROJECT_ROOT, "data");
const STATE_FILE =
  process.env.CHECKIN_STATE_FILE || join(DATA_DIR, "checkin-state.json");

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// ============================================================
// STATE MANAGEMENT
// ============================================================

interface CheckinState {
  lastMessageTime: string; // Last time user messaged
  lastCheckinTime: string; // Last time we checked in
  pendingItems: string[]; // Things to follow up on
}

async function loadState(): Promise<CheckinState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      lastMessageTime: new Date().toISOString(),
      lastCheckinTime: "",
      pendingItems: [],
    };
  }
}

async function saveState(state: CheckinState): Promise<void> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// CONTEXT GATHERING
// ============================================================

async function getGoals(): Promise<string[]> {
  if (supabase) {
    try {
      const { data } = await supabase.rpc("get_active_goals");
      if (data?.length) {
        return data.map((g: any) => {
          const deadline = g.deadline
            ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
            : "";
          return `${g.content}${deadline}`;
        });
      }
    } catch (e) {
      console.error("Supabase goals fetch failed:", e);
    }
  }
  return [];
}

async function getCalendarContext(): Promise<string> {
  if (supabase) {
    try {
      const { data } = await supabase.rpc("get_facts");
      if (data?.length) {
        return data
          .slice(0, 3)
          .map((f: any) => f.content)
          .join("; ");
      }
    } catch (e) {
      console.error("Supabase facts fetch failed:", e);
    }
  }
  return "No recent context";
}

async function getLastActivity(): Promise<string> {
  const state = await loadState();
  const lastMsg = new Date(state.lastMessageTime);
  const now = new Date();
  const hoursSince = (now.getTime() - lastMsg.getTime()) / (1000 * 60 * 60);

  return `Last message: ${hoursSince.toFixed(1)} hours ago`;
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
        }),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================
// CLAUDE DECISION
// ============================================================

async function askClaudeToDecide(): Promise<{
  shouldCheckin: boolean;
  message: string;
}> {
  const state = await loadState();
  const goals = await getGoals();
  const calendar = await getCalendarContext();
  const activity = await getLastActivity();

  const now = new Date();
  const hour = now.getHours();
  const timeContext =
    hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

  const prompt = `
You are a proactive AI assistant. Decide if you should check in with the user.

CONTEXT:
- Current time: ${now.toLocaleTimeString()} (${timeContext})
- ${activity}
- Last check-in: ${state.lastCheckinTime || "Never"}
- Active goals: ${goals.join(", ") || "None"}
- Calendar: ${calendar}
- Pending follow-ups: ${state.pendingItems.join(", ") || "None"}

RULES:
1. Don't be annoying - max 2-3 check-ins per day
2. Only check in if there's a REASON (goal deadline, long silence, important event)
3. Be brief and helpful, not intrusive
4. Consider time of day (don't interrupt deep work hours)
5. If nothing important, respond with NO_CHECKIN

RESPOND IN THIS EXACT FORMAT:
DECISION: YES or NO
MESSAGE: [Your message if YES, or "none" if NO]
REASON: [Why you decided this]
`;

  try {
    const proc = spawn([CLAUDE_PATH, "-p", prompt, "--output-format", "text"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();

    // Parse Claude's response
    const decisionMatch = output.match(/DECISION:\s*(YES|NO)/i);
    const messageMatch = output.match(/MESSAGE:\s*(.+?)(?=\nREASON:|$)/is);
    const reasonMatch = output.match(/REASON:\s*(.+)/is);

    const shouldCheckin = decisionMatch?.[1]?.toUpperCase() === "YES";
    const message = messageMatch?.[1]?.trim() || "";
    const reason = reasonMatch?.[1]?.trim() || "";

    console.log(`Decision: ${shouldCheckin ? "YES" : "NO"}`);
    console.log(`Reason: ${reason}`);

    return { shouldCheckin, message };
  } catch (error) {
    console.error("Claude error:", error);
    return { shouldCheckin: false, message: "" };
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running smart check-in...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    console.error(`Expected .env at: ${join(PROJECT_ROOT, ".env")}`);
    process.exit(1);
  }

  const { shouldCheckin, message } = await askClaudeToDecide();

  if (shouldCheckin && message && message !== "none") {
    console.log("Sending check-in...");
    const success = await sendTelegram(message);

    if (success) {
      // Update state
      const state = await loadState();
      state.lastCheckinTime = new Date().toISOString();
      await saveState(state);
      console.log("Check-in sent!");
    } else {
      console.error("Failed to send check-in");
    }
  } else {
    console.log("No check-in needed");
  }
}

main();

// ============================================================
// SCHEDULING
// ============================================================
/*
Run every 30 minutes:

CRON (Linux):
*/30 * * * * cd /path/to/relay && bun run examples/smart-checkin.ts

LAUNCHD (macOS) - save as ~/Library/LaunchAgents/com.claude.smart-checkin.plist:

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.smart-checkin</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOU/.bun/bin/bun</string>
        <string>run</string>
        <string>examples/smart-checkin.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/relay</string>
    <key>StartInterval</key>
    <integer>1800</integer>  <!-- 30 minutes in seconds -->
</dict>
</plist>

WINDOWS Task Scheduler:
- Create task with "Daily" trigger
- Set to repeat every 30 minutes
*/
