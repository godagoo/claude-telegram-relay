/**
 * Intent Handler — Pre-processing layer for natural language commands
 *
 * Intercepts messages before they hit Claude to handle actionable intents
 * instantly (no AI call needed). Currently supports:
 *
 * 1. Agenda tracking: "track my agenda for today. 4pm gym, 6pm shopping"
 * 2. Reminders: "remind me at 3pm to call mom"
 * 3. Cron listing: "show my cron jobs" / "what's scheduled"
 *
 * Returns { handled: true, response } if the intent was caught,
 * or { handled: false } to fall through to Claude.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

interface IntentResult {
  handled: boolean;
  response?: string;
}

interface TimeActivity {
  hour: number;
  minute: number;
  label: string;  // e.g., "4 PM"
  activity: string;
}

type AddCronJobFn = (
  supabase: SupabaseClient,
  userId: string,
  name: string,
  schedule: string,
  action: string
) => Promise<string>;

/**
 * Try to handle the message as a direct intent. Returns { handled: false }
 * if no intent matched — caller should proceed to Claude.
 */
export async function handleIntent(
  text: string,
  supabase: SupabaseClient | null,
  userId: string,
  timezone: string,
  addCronJob: AddCronJobFn
): Promise<IntentResult> {
  if (!supabase) return { handled: false };

  const lower = text.toLowerCase().trim();

  // --- Agenda tracking ---
  const agendaResult = await tryAgendaIntent(lower, text, supabase, userId, timezone, addCronJob);
  if (agendaResult.handled) return agendaResult;

  // --- Single reminder ---
  const reminderResult = await tryReminderIntent(lower, text, supabase, userId, timezone, addCronJob);
  if (reminderResult.handled) return reminderResult;

  return { handled: false };
}

// ============================================================
// AGENDA INTENT
// ============================================================
// Matches: "track my agenda", "here's my schedule", "my agenda for today",
//          "today's agenda", "schedule for today", etc.
// Followed by time/activity pairs like "4pm gym, 6pm shopping at krogers"

const AGENDA_TRIGGERS = [
  /(?:track|set|log|save|here(?:'s| is))\s+(?:my\s+)?(?:agenda|schedule|plan|lineup)/i,
  /(?:my|today(?:'s)?)\s+(?:agenda|schedule|plan|lineup)/i,
  /(?:agenda|schedule|plan)\s+for\s+(?:today|tonight|tomorrow|this\s+(?:morning|afternoon|evening))/i,
];

// Matches time entries: "4pm gym", "6:30pm shopping at krogers", "14:00 meeting"
const TIME_ACTIVITY_RE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–—:,]?\s+(.+?)(?=(?:,\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)|$)/gi;

async function tryAgendaIntent(
  lower: string,
  original: string,
  supabase: SupabaseClient,
  userId: string,
  timezone: string,
  addCronJob: AddCronJobFn
): Promise<IntentResult> {
  // Check if any trigger matches
  const triggered = AGENDA_TRIGGERS.some((re) => re.test(lower));
  if (!triggered) return { handled: false };

  // Parse time/activity pairs from the full message
  const items = parseTimeActivities(original, timezone);
  if (items.length === 0) return { handled: false };

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: timezone || undefined,
  });
  const isoDate = now.toLocaleDateString("en-CA", { timeZone: timezone || undefined }); // YYYY-MM-DD

  // Build agenda string for memory
  const agendaItems = items.map((i) => `${i.label} - ${i.activity}`).join(", ");
  const memoryContent = `Agenda for ${dateStr} (${isoDate}): ${agendaItems}`;

  // Save to memory as a fact
  await supabase.from("memory").insert({
    type: "fact",
    content: memoryContent,
    user_id: userId,
  });

  // Set one-time cron reminders for each item
  const reminderResults: string[] = [];
  const [year, month, day] = isoDate.split("-").map(Number);

  for (const item of items) {
    const jobName = `agenda-${isoDate}-${item.hour}${item.minute.toString().padStart(2, "0")}`;
    const cronExpr = `${item.minute} ${item.hour} ${day} ${month} *`;

    try {
      await addCronJob(
        supabase,
        userId,
        jobName,
        cronExpr,
        `Reminder: It's ${item.label} — time for: ${item.activity}`
      );
      reminderResults.push(`• ${item.label} — reminder set`);
    } catch {
      reminderResults.push(`• ${item.label} — could not set reminder`);
    }
  }

  // Build response
  const agendaList = items.map((i) => `• ${i.label} — ${i.activity}`).join("\n");
  const reminderList = reminderResults.join("\n");

  const response =
    `Got it. Agenda tracked for ${dateStr}:\n${agendaList}\n\n` +
    `Reminders set:\n${reminderList}\n\n` +
    `(Use /cron list to manage them)`;

  return { handled: true, response };
}

// ============================================================
// REMINDER INTENT
// ============================================================
// Matches: "remind me at 3pm to call mom", "reminder at 5:30pm pick up kids"

const REMINDER_RE = /^(?:remind\s+me|set\s+(?:a\s+)?reminder|reminder)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to\s+|[-–—:]\s*)(.+)$/i;

async function tryReminderIntent(
  lower: string,
  original: string,
  supabase: SupabaseClient,
  userId: string,
  timezone: string,
  addCronJob: AddCronJobFn
): Promise<IntentResult> {
  const match = original.match(REMINDER_RE);
  if (!match) return { handled: false };

  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const period = match[3]?.toLowerCase();
  const task = match[4].trim();

  if (period === "pm" && hour < 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { handled: false };
  }

  const now = new Date();
  const isoDate = now.toLocaleDateString("en-CA", { timeZone: timezone || undefined });
  const [, month, day] = isoDate.split("-").map(Number);

  const label = formatTimeLabel(hour, minute);
  const jobName = `reminder-${isoDate}-${hour}${minute.toString().padStart(2, "0")}`;
  const cronExpr = `${minute} ${hour} ${day} ${month} *`;

  try {
    await addCronJob(
      supabase,
      userId,
      jobName,
      cronExpr,
      `Reminder: ${task}`
    );

    return {
      handled: true,
      response: `Reminder set for ${label}: ${task}\n\n(Use /cron list to manage reminders)`,
    };
  } catch {
    return { handled: false };
  }
}

// ============================================================
// HELPERS
// ============================================================

function parseTimeActivities(text: string, timezone: string): TimeActivity[] {
  const items: TimeActivity[] = [];

  // Reset lastIndex for global regex
  TIME_ACTIVITY_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TIME_ACTIVITY_RE.exec(text)) !== null) {
    let hour = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    const period = match[3]?.toLowerCase();
    let activity = match[4].trim();

    // Handle am/pm
    if (period === "pm" && hour < 12) hour += 12;
    if (period === "am" && hour === 12) hour = 0;

    // Skip invalid times
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) continue;

    // Clean trailing punctuation from activity
    activity = activity.replace(/[.,;!]+$/, "").trim();
    if (!activity) continue;

    items.push({
      hour,
      minute,
      label: formatTimeLabel(hour, minute),
      activity,
    });
  }

  return items;
}

function formatTimeLabel(hour: number, minute: number): string {
  const h = hour % 12 || 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return minute > 0 ? `${h}:${minute.toString().padStart(2, "0")} ${ampm}` : `${h} ${ampm}`;
}
