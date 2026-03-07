/**
 * Human-friendly schedule parser — converts natural language to cron expressions.
 *
 * Supports:
 *   "every 30 minutes" / "every 30m"   → "* /30 * * * *"
 *   "every 2 hours" / "every 2h"       → "0 * /2 * * *"
 *   "hourly"                            → "0 * * * *"
 *   "daily" / "every day"               → "0 0 * * *"
 *   "daily at 9am" / "daily at 9:30am"  → "0 9 * * *" / "30 9 * * *"
 *   "weekdays at 9am"                   → "0 9 * * 1-5"
 *   "weekends at 10am"                  → "0 10 * * 0,6"
 *   "weekly on monday"                  → "0 0 * * 1"
 *   "weekly on monday at 9am"           → "0 9 * * 1"
 *
 * Raw cron expressions (5 fields) pass through unchanged.
 */

const DAY_MAP: Record<string, string> = {
  sunday: "0", sun: "0",
  monday: "1", mon: "1",
  tuesday: "2", tue: "2",
  wednesday: "3", wed: "3",
  thursday: "4", thu: "4",
  friday: "5", fri: "5",
  saturday: "6", sat: "6",
};

function parseTime(timeStr: string): { hour: number; minute: number } {
  const s = timeStr.trim().toLowerCase();

  if (s === "noon") return { hour: 12, minute: 0 };
  if (s === "midnight") return { hour: 0, minute: 0 };

  // "9am", "9pm", "9:30am", "9:30pm", "14:00", "14:30"
  const match = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) throw new Error(`Cannot parse time: "${timeStr}"`);

  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const period = match[3];

  if (period === "pm" && hour < 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid time: "${timeStr}"`);
  }

  return { hour, minute };
}

export function parseSchedule(input: string): string {
  const s = input.trim();

  // Already a cron expression: 5 space-separated fields starting with digit, *, or /
  const fields = s.split(/\s+/);
  if (fields.length === 5 && /^[*\d/,\-]/.test(fields[0])) {
    return s;
  }

  const lower = s.toLowerCase();

  // --- "every Nm" / "every N minutes" ---
  const everyMinMatch = lower.match(/^every\s+(\d+)\s*(?:m|min|mins|minutes?)$/);
  if (everyMinMatch) {
    const n = parseInt(everyMinMatch[1], 10);
    if (n < 1 || n > 59) throw new Error(`Minutes must be 1-59, got ${n}`);
    return `*/${n} * * * *`;
  }

  // --- "every Nh" / "every N hours" ---
  const everyHrMatch = lower.match(/^every\s+(\d+)\s*(?:h|hr|hrs|hours?)$/);
  if (everyHrMatch) {
    const n = parseInt(everyHrMatch[1], 10);
    if (n < 1 || n > 23) throw new Error(`Hours must be 1-23, got ${n}`);
    return `0 */${n} * * *`;
  }

  // --- "every Nd" / "every N days" ---
  const everyDayMatch = lower.match(/^every\s+(\d+)\s*(?:d|days?)$/);
  if (everyDayMatch) {
    const n = parseInt(everyDayMatch[1], 10);
    if (n < 1 || n > 31) throw new Error(`Days must be 1-31, got ${n}`);
    return `0 0 */${n} * *`;
  }

  // --- "hourly" ---
  if (lower === "hourly") return "0 * * * *";

  // --- "daily" / "every day" (no time) ---
  if (lower === "daily" || lower === "every day") return "0 0 * * *";

  // --- "weekly" (no day/time) ---
  if (lower === "weekly") return "0 0 * * 1";

  // --- "daily at TIME" ---
  const dailyAtMatch = lower.match(/^(?:daily|every\s*day)\s+at\s+(.+)$/);
  if (dailyAtMatch) {
    const { hour, minute } = parseTime(dailyAtMatch[1]);
    return `${minute} ${hour} * * *`;
  }

  // --- "weekdays at TIME" ---
  const weekdaysMatch = lower.match(/^weekdays?\s+at\s+(.+)$/);
  if (weekdaysMatch) {
    const { hour, minute } = parseTime(weekdaysMatch[1]);
    return `${minute} ${hour} * * 1-5`;
  }

  // --- "weekends at TIME" ---
  const weekendsMatch = lower.match(/^weekends?\s+at\s+(.+)$/);
  if (weekendsMatch) {
    const { hour, minute } = parseTime(weekendsMatch[1]);
    return `${minute} ${hour} * * 0,6`;
  }

  // --- "weekly on DAY" / "weekly on DAY at TIME" / "every DAY" / "every DAY at TIME" ---
  const weeklyMatch = lower.match(/^(?:weekly\s+on|every)\s+(\w+)(?:\s+at\s+(.+))?$/);
  if (weeklyMatch) {
    const dayStr = weeklyMatch[1];
    const dayNum = DAY_MAP[dayStr];
    if (dayNum !== undefined) {
      if (weeklyMatch[2]) {
        const { hour, minute } = parseTime(weeklyMatch[2]);
        return `${minute} ${hour} * * ${dayNum}`;
      }
      return `0 0 * * ${dayNum}`;
    }
  }

  throw new Error(`Could not parse schedule: "${input}"`);
}
