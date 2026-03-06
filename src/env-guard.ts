/**
 * ENV Guard — Backup & Restore Protection
 *
 * Prevents .env loss by:
 * 1. Auto-backing up on startup (local file + Supabase)
 * 2. Keeping last 10 local backups with rotation
 * 3. Telegram commands: /env backup, /env restore, /env list
 */

import { readFile, writeFile, readdir, unlink } from "fs/promises";
import { join, dirname } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const ENV_PATH = join(PROJECT_ROOT, ".env");
const PERSISTENT_BACKUP = join(process.env.HOME || "/root", ".gentech-env");
const MAX_LOCAL_BACKUPS = 10;

export async function backupEnv(supabase: SupabaseClient | null, source = "auto"): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(ENV_PATH, "utf-8");
  } catch {
    console.warn("env-guard: No .env file found, skipping backup");
    return null;
  }

  if (!content.trim()) {
    console.warn("env-guard: .env is empty, skipping backup");
    return null;
  }

  // Local backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `.env.backup.${timestamp}`;
  const backupPath = join(PROJECT_ROOT, backupName);
  await writeFile(backupPath, content);
  console.log(`env-guard: Local backup created → ${backupName}`);

  // Supabase backup
  if (supabase) {
    try {
      await supabase.from("env_backups").insert({ content, source });
      console.log("env-guard: Supabase backup stored");
    } catch (err) {
      console.warn("env-guard: Supabase backup failed:", err);
    }
  }

  // Persistent backup (survives reboots)
  await persistEnv();

  // Rotate old local backups
  await rotateLocalBackups();

  return backupName;
}

export async function restoreEnv(
  supabase: SupabaseClient | null,
  backupId?: string
): Promise<boolean> {
  // Backup current before restoring
  await backupEnv(supabase, "pre-restore");

  if (backupId && supabase) {
    // Restore from Supabase by ID
    const { data, error } = await supabase
      .from("env_backups")
      .select("content")
      .eq("id", backupId)
      .single();

    if (error || !data) {
      console.error("env-guard: Backup not found in Supabase:", backupId);
      return false;
    }

    await writeFile(ENV_PATH, data.content);
    console.log(`env-guard: Restored from Supabase backup ${backupId}`);
    return true;
  }

  // Restore from latest local backup
  const backups = await getLocalBackups();
  if (backups.length === 0) {
    console.error("env-guard: No local backups found");
    return false;
  }

  const latest = backups[0]; // sorted newest first
  const content = await readFile(join(PROJECT_ROOT, latest), "utf-8");
  await writeFile(ENV_PATH, content);
  console.log(`env-guard: Restored from local backup ${latest}`);
  return true;
}

export async function listBackups(supabase: SupabaseClient | null): Promise<{
  local: string[];
  remote: Array<{ id: string; created_at: string; source: string }>;
}> {
  const local = await getLocalBackups();
  let remote: Array<{ id: string; created_at: string; source: string }> = [];

  if (supabase) {
    try {
      const { data } = await supabase
        .from("env_backups")
        .select("id, created_at, source")
        .order("created_at", { ascending: false })
        .limit(10);
      remote = data || [];
    } catch {
      // Table may not exist yet
    }
  }

  return { local, remote };
}

async function getLocalBackups(): Promise<string[]> {
  try {
    const files = await readdir(PROJECT_ROOT);
    return files
      .filter((f) => f.startsWith(".env.backup."))
      .sort()
      .reverse(); // newest first
  } catch {
    return [];
  }
}

async function rotateLocalBackups(): Promise<void> {
  const backups = await getLocalBackups();
  if (backups.length <= MAX_LOCAL_BACKUPS) return;

  const toDelete = backups.slice(MAX_LOCAL_BACKUPS);
  for (const file of toDelete) {
    await unlink(join(PROJECT_ROOT, file)).catch(() => {});
  }
  if (toDelete.length > 0) {
    console.log(`env-guard: Rotated ${toDelete.length} old backup(s)`);
  }
}

/**
 * Save .env to a persistent location outside the repo (~/.gentech-env).
 * Only saves if .env contains a real bot token (not empty placeholders).
 */
export async function persistEnv(): Promise<boolean> {
  try {
    const content = await readFile(ENV_PATH, "utf-8");
    const hasToken = content.match(/^TELEGRAM_BOT_TOKEN=.+$/m);
    if (!hasToken) return false;

    await writeFile(PERSISTENT_BACKUP, content);
    console.log(`env-guard: Persistent backup saved → ${PERSISTENT_BACKUP}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Auto-restore .env from persistent backup if current .env is missing or empty.
 * Called before startup checks so the bot can self-heal after a reboot.
 */
export async function autoRestore(): Promise<boolean> {
  try {
    // Check if .env exists and has a real token
    try {
      const current = await readFile(ENV_PATH, "utf-8");
      if (current.match(/^TELEGRAM_BOT_TOKEN=.+$/m)) return false; // .env is fine
    } catch {
      // .env doesn't exist, try to restore
    }

    // Try persistent backup
    const backup = await readFile(PERSISTENT_BACKUP, "utf-8");
    if (!backup.match(/^TELEGRAM_BOT_TOKEN=.+$/m)) return false; // backup is also empty

    await writeFile(ENV_PATH, backup);
    console.log(`env-guard: .env restored from persistent backup ${PERSISTENT_BACKUP}`);
    return true;
  } catch {
    return false; // no persistent backup exists
  }
}
