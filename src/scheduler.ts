/**
 * Cron Scheduler — In-process with Supabase persistence + deduplication
 *
 * CRITICAL FIXES over previous implementation:
 * 1. In-process — no external cron/launchd that can misfire
 * 2. Deduplicated — each execution has a unique ID checked before running
 * 3. Locked — row-level lock prevents concurrent execution
 * 4. Audited — every execution logged with timestamp + result
 * 5. Persistent — jobs survive restarts via Supabase
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseExpression } from "cron-parser";
import { spawn } from "bun";
import { dirname } from "path";
import { parseSchedule } from "./parse-schedule.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

const CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds
const REFRESH_EVERY_N_CHECKS = 10; // Refresh jobs from DB every 10 cycles (~5 min)
const MAX_INIT_RETRIES = 5;

let checkTimer: ReturnType<typeof setInterval> | null = null;
let _supabase: SupabaseClient | null = null;
let _onExecute: ((userId: string, action: string) => Promise<string>) | null = null;
let _sendMessage: ((userId: string, text: string) => Promise<void>) | null = null;
let _timezone: string = "";
let _groupId: string = "";
let _initialized = false;
let _initRetries = 0;
let _checkCount = 0;

interface CronJob {
  id: string;
  user_id: string;
  name: string;
  schedule: string;
  action: string;
  enabled: boolean;
  last_run: string | null;
  next_run: string | null;
  run_count: number;
  target_type?: "user" | "group";
}

// In-memory job cache
let jobs: CronJob[] = [];

/**
 * Initialize the scheduler.
 * @param supabase - Supabase client for persistence
 * @param onExecute - Callback to execute a job action (sends to AI)
 * @param sendMessage - Callback to send result message to user/group
 * @param timezone - Timezone for cron calculations (e.g., "America/New_York")
 * @param groupId - Telegram group ID for posting scheduled reports
 */
export async function initScheduler(
  supabase: SupabaseClient,
  onExecute: (userId: string, action: string) => Promise<string>,
  sendMessage: (userId: string, text: string) => Promise<void>,
  timezone?: string,
  groupId?: string
): Promise<void> {
  _supabase = supabase;
  _onExecute = onExecute;
  _sendMessage = sendMessage;
  _timezone = timezone || "";
  _groupId = groupId || "";

  // Load all enabled jobs
  await refreshJobs();

  // Start the check loop
  checkTimer = setInterval(checkAndExecuteJobs, CHECK_INTERVAL_MS);
  console.log(`Scheduler started: ${jobs.length} jobs loaded, checking every ${CHECK_INTERVAL_MS / 1000}s`);
}

export function stopScheduler(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

/**
 * Reload jobs from Supabase.
 */
async function refreshJobs(): Promise<void> {
  if (!_supabase) return;

  const { data, error } = await _supabase
    .from("cron_jobs")
    .select("*")
    .eq("enabled", true);

  if (error) {
    console.error(`Scheduler: Failed to load jobs: ${error.message}`);
    if (!_initialized && _initRetries < MAX_INIT_RETRIES) {
      _initRetries++;
      const delayMs = Math.min(1000 * Math.pow(2, _initRetries), 60_000);
      console.log(`Scheduler: Retrying in ${delayMs / 1000}s (attempt ${_initRetries}/${MAX_INIT_RETRIES})`);
      setTimeout(() => refreshJobs(), delayMs);
    }
    return;
  }

  _initialized = true;
  _initRetries = 0;
  jobs = data || [];

  // Calculate next_run for any jobs that don't have it
  for (const job of jobs) {
    if (!job.next_run) {
      job.next_run = calculateNextRun(job.schedule, job.last_run);
      await _supabase
        .from("cron_jobs")
        .update({ next_run: job.next_run })
        .eq("id", job.id);
    }
  }
}

/**
 * Main check loop — runs every 30 seconds.
 */
async function checkAndExecuteJobs(): Promise<void> {
  if (!_supabase || !_onExecute || !_sendMessage) return;

  // Periodically refresh jobs from DB to pick up changes and recover from failures
  _checkCount++;
  if (_checkCount % REFRESH_EVERY_N_CHECKS === 0) {
    await refreshJobs();
  }

  const now = new Date();

  for (const job of jobs) {
    if (!job.enabled || !job.next_run) continue;

    const nextRun = new Date(job.next_run);
    if (nextRun > now) continue;

    try {
      await executeJob(job);
    } catch (err) {
      console.error(`Scheduler: Unexpected error executing job "${job.name}":`, err);
    }
  }
}

/**
 * Execute a single job with deduplication and locking.
 */
async function executeJob(job: CronJob): Promise<void> {
  if (!_supabase || !_onExecute || !_sendMessage) return;

  // Generate unique execution ID based on job + scheduled time
  const executionId = `${job.id}_${job.next_run}`;

  // DEDUP CHECK: Has this execution already happened?
  const { data: existing } = await _supabase
    .from("cron_executions")
    .select("id")
    .eq("execution_id", executionId)
    .limit(1);

  if (existing && existing.length > 0) {
    // Already executed — just advance next_run
    const newNextRun = calculateNextRun(job.schedule, job.next_run);
    job.next_run = newNextRun;
    await _supabase
      .from("cron_jobs")
      .update({ next_run: newNextRun })
      .eq("id", job.id);
    return;
  }

  // LOCK: Attempt to acquire execution lock (atomic update)
  const { data: lockResult, error: lockError } = await _supabase
    .from("cron_jobs")
    .update({ execution_lock: executionId })
    .eq("id", job.id)
    .is("execution_lock", null) // Only if no one else has the lock
    .select("id");

  if (lockError || !lockResult || lockResult.length === 0) {
    // Another instance got the lock — skip
    return;
  }

  const startTime = Date.now();
  let status: "success" | "error" = "success";
  let result = "";

  try {
    console.log(`Scheduler: Executing job "${job.name}" for user ${job.user_id}`);
    if (job.action.startsWith("EXEC:")) {
      result = await runScript(job.action.slice(5).trim());
    } else {
      result = await _onExecute(job.user_id, job.action);
    }

    // Determine target: group or user
    const targetType = job.target_type || "user";
    const targetId = targetType === "group" ? _groupId : job.user_id;

    // Send result to target
    if (targetId) {
      await _sendMessage(
        targetId,
        `[Scheduled: ${job.name}]\n\n${result}`
      );
    } else if (targetType === "group" && !_groupId) {
      console.warn(`Scheduler: Job "${job.name}" targets group but GENTECH_GROUP_ID not set`);
    }
  } catch (err) {
    status = "error";
    result = err instanceof Error ? err.message : String(err);
    console.error(`Scheduler: Job "${job.name}" failed:`, result);
  }

  const durationMs = Date.now() - startTime;
  const newNextRun = calculateNextRun(job.schedule, new Date().toISOString());

  // Log the execution
  await _supabase.from("cron_executions").insert({
    job_id: job.id,
    execution_id: executionId,
    result: result.substring(0, 5000), // Truncate long results
    duration_ms: durationMs,
    status,
  });

  // Update job state and release lock
  await _supabase
    .from("cron_jobs")
    .update({
      last_run: new Date().toISOString(),
      next_run: newNextRun,
      run_count: job.run_count + 1,
      last_result: result.substring(0, 1000),
      execution_lock: null, // Release lock
    })
    .eq("id", job.id);

  // Update in-memory cache
  job.last_run = new Date().toISOString();
  job.next_run = newNextRun;
  job.run_count += 1;
}

/**
 * Run a shell command and return its stdout.
 * Used when cron action starts with "EXEC:".
 */
async function runScript(cmd: string): Promise<string> {
  const parts = cmd.split(/\s+/);
  const proc = spawn(parts[0], parts.slice(1), {
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
    env: { ...process.env },
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(err.trim() || `Script exited with code ${code}`);
  return out.trim();
}

/**
 * Calculate the next run time from a cron expression.
 */
function calculateNextRun(schedule: string, afterTime: string | null): string {
  try {
    const options: Record<string, unknown> = {
      currentDate: afterTime ? new Date(afterTime) : new Date(),
    };
    if (_timezone) options.tz = _timezone;
    const interval = parseExpression(schedule, options);
    return interval.next().toISOString();
  } catch (err) {
    console.error(`Invalid cron expression "${schedule}":`, err);
    // Fallback: 1 hour from now
    return new Date(Date.now() + 3_600_000).toISOString();
  }
}

// ============================================================
// TELEGRAM COMMAND HANDLERS
// ============================================================

export async function addCronJob(
  supabase: SupabaseClient,
  userId: string,
  name: string,
  schedule: string,
  action: string
): Promise<string> {
  // Parse human-friendly schedule into cron expression
  let cronExpression: string;
  try {
    cronExpression = parseSchedule(schedule);
  } catch {
    return (
      `Could not understand schedule: "${schedule}"\n\n` +
      "Examples:\n" +
      '  "every 30 minutes"\n' +
      '  "daily at 9am"\n' +
      '  "weekdays at 9:30am"\n' +
      '  "weekly on monday at 10am"\n' +
      '  "hourly"\n' +
      '  "0 9 * * *" (raw cron)'
    );
  }

  // Validate the resulting cron expression
  try {
    parseExpression(cronExpression, _timezone ? { tz: _timezone } : undefined);
  } catch {
    return `Invalid schedule: "${schedule}" (parsed as "${cronExpression}")`;
  }

  const nextRun = calculateNextRun(cronExpression, null);

  const { error } = await supabase.from("cron_jobs").upsert(
    {
      user_id: userId,
      name,
      schedule: cronExpression,
      action,
      enabled: true,
      next_run: nextRun,
      run_count: 0,
      execution_lock: null,
    },
    { onConflict: "user_id,name" }
  );

  if (error) {
    return `Failed to create job: ${error.message}`;
  }

  // Refresh in-memory cache
  await refreshJobs();

  // Show both human input and cron expression if they differ
  const scheduleInfo = cronExpression !== schedule
    ? `Schedule: ${schedule} (${cronExpression})`
    : `Schedule: ${cronExpression}`;

  return `Job "${name}" created.\n${scheduleInfo}\nAction: ${action}\nNext run: ${new Date(nextRun).toLocaleString()}`;
}

export async function listCronJobs(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const { data, error } = await supabase
    .from("cron_jobs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) return `Failed to list jobs: ${error.message}`;
  if (!data || data.length === 0) return "No scheduled jobs.";

  const tzOpts = _timezone ? { timeZone: _timezone } : undefined;

  return data.map((j, i) => {
    const status = j.enabled ? "ACTIVE" : "PAUSED";
    const nextRun = j.next_run ? new Date(j.next_run).toLocaleString(undefined, tzOpts) : "N/A";
    const lastRun = j.last_run ? new Date(j.last_run).toLocaleString(undefined, tzOpts) : "Never";

    return [
      `${i + 1}. ${j.name} [${status}]`,
      `   Schedule: ${j.schedule}`,
      `   Action: ${j.action.substring(0, 80)}`,
      `   Runs: ${j.run_count} | Last: ${lastRun}`,
      `   Next: ${nextRun}`,
    ].join("\n");
  }).join("\n\n");
}

export async function deleteCronJob(
  supabase: SupabaseClient,
  userId: string,
  name: string
): Promise<string> {
  const { error } = await supabase
    .from("cron_jobs")
    .delete()
    .eq("user_id", userId)
    .eq("name", name);

  if (error) return `Failed to delete: ${error.message}`;

  await refreshJobs();
  return `Job "${name}" deleted.`;
}

export async function toggleCronJob(
  supabase: SupabaseClient,
  userId: string,
  name: string,
  enabled: boolean
): Promise<string> {
  const update: Record<string, unknown> = { enabled };

  if (enabled) {
    // Recalculate next_run when resuming
    const { data } = await supabase
      .from("cron_jobs")
      .select("schedule")
      .eq("user_id", userId)
      .eq("name", name)
      .single();

    if (data) {
      update.next_run = calculateNextRun(data.schedule, null);
    }
  }

  const { error } = await supabase
    .from("cron_jobs")
    .update(update)
    .eq("user_id", userId)
    .eq("name", name);

  if (error) return `Failed to ${enabled ? "resume" : "pause"}: ${error.message}`;

  await refreshJobs();
  return `Job "${name}" ${enabled ? "resumed" : "paused"}.`;
}

export async function getCronHistory(
  supabase: SupabaseClient,
  userId: string,
  name: string
): Promise<string> {
  // Find the job ID
  const { data: job } = await supabase
    .from("cron_jobs")
    .select("id")
    .eq("user_id", userId)
    .eq("name", name)
    .single();

  if (!job) return `Job "${name}" not found.`;

  const { data, error } = await supabase
    .from("cron_executions")
    .select("*")
    .eq("job_id", job.id)
    .order("executed_at", { ascending: false })
    .limit(10);

  if (error) return `Failed to fetch history: ${error.message}`;
  if (!data || data.length === 0) return `No execution history for "${name}".`;

  const tzOpts = _timezone ? { timeZone: _timezone } : undefined;

  return `Last ${data.length} executions of "${name}":\n\n` +
    data.map((e, i) => {
      const time = new Date(e.executed_at).toLocaleString(undefined, tzOpts);
      const dur = e.duration_ms ? `${e.duration_ms}ms` : "N/A";
      return `${i + 1}. [${e.status}] ${time} (${dur})\n   ${(e.result || "").substring(0, 100)}`;
    }).join("\n\n");
}
