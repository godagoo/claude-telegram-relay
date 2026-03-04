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

const CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds
let checkTimer: ReturnType<typeof setInterval> | null = null;
let _supabase: SupabaseClient | null = null;
let _onExecute: ((userId: string, action: string) => Promise<string>) | null = null;
let _sendMessage: ((userId: string, text: string) => Promise<void>) | null = null;
let _timezone: string = "";

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
}

// In-memory job cache
let jobs: CronJob[] = [];

/**
 * Initialize the scheduler.
 * @param supabase - Supabase client for persistence
 * @param onExecute - Callback to execute a job action (sends to AI)
 * @param sendMessage - Callback to send result message to user
 */
export async function initScheduler(
  supabase: SupabaseClient,
  onExecute: (userId: string, action: string) => Promise<string>,
  sendMessage: (userId: string, text: string) => Promise<void>,
  timezone?: string
): Promise<void> {
  _supabase = supabase;
  _onExecute = onExecute;
  _sendMessage = sendMessage;
  _timezone = timezone || "";

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
    console.error("Scheduler: Failed to load jobs:", error);
    return;
  }

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

  const now = new Date();

  for (const job of jobs) {
    if (!job.enabled || !job.next_run) continue;

    const nextRun = new Date(job.next_run);
    if (nextRun > now) continue;

    // Time to execute this job
    await executeJob(job);
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
    result = await _onExecute(job.user_id, job.action);

    // Send result to user
    await _sendMessage(
      job.user_id,
      `[Scheduled: ${job.name}]\n\n${result}`
    );
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
  // Validate cron expression
  try {
    parseExpression(schedule, _timezone ? { tz: _timezone } : undefined);
  } catch {
    return `Invalid cron schedule: "${schedule}"\n\nExamples:\n  "0 9 * * *" = every day at 9 AM\n  "*/30 * * * *" = every 30 minutes\n  "0 9 * * 1-5" = weekdays at 9 AM`;
  }

  const nextRun = calculateNextRun(schedule, null);

  const { error } = await supabase.from("cron_jobs").upsert(
    {
      user_id: userId,
      name,
      schedule,
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

  return `Job "${name}" created.\nSchedule: ${schedule}\nAction: ${action}\nNext run: ${new Date(nextRun).toLocaleString()}`;
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
