/**
 * Auth Module — Multi-user Authorization
 *
 * Owner (TELEGRAM_OWNER_ID) has full access.
 * Approved users stored in Supabase authorized_users table.
 * In groups: only responds to @mentions or replies.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const OWNER_ID = process.env.TELEGRAM_OWNER_ID || process.env.TELEGRAM_USER_ID || "";

// In-memory cache of authorized users (refreshed periodically)
let authorizedCache: Map<string, string> = new Map(); // telegram_id → role
let lastCacheRefresh = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

export function isOwner(userId: string): boolean {
  return userId === OWNER_ID;
}

export async function isAuthorized(
  supabase: SupabaseClient | null,
  userId: string
): Promise<boolean> {
  if (isOwner(userId)) return true;
  if (!supabase) return false;

  await refreshCacheIfNeeded(supabase);
  return authorizedCache.has(userId);
}

export async function addUser(
  supabase: SupabaseClient,
  telegramId: string,
  username: string | undefined,
  addedBy: string
): Promise<boolean> {
  const { error } = await supabase.from("authorized_users").upsert(
    {
      telegram_id: telegramId,
      username: username || null,
      role: "user",
      added_by: addedBy,
    },
    { onConflict: "telegram_id" }
  );

  if (error) {
    console.error("auth: Failed to add user:", error);
    return false;
  }

  authorizedCache.set(telegramId, "user");
  return true;
}

export async function removeUser(
  supabase: SupabaseClient,
  telegramId: string
): Promise<boolean> {
  if (isOwner(telegramId)) return false; // Can't remove owner

  const { error } = await supabase
    .from("authorized_users")
    .delete()
    .eq("telegram_id", telegramId);

  if (error) {
    console.error("auth: Failed to remove user:", error);
    return false;
  }

  authorizedCache.delete(telegramId);
  return true;
}

export async function listUsers(
  supabase: SupabaseClient
): Promise<Array<{ telegram_id: string; username: string | null; role: string; created_at: string }>> {
  const { data, error } = await supabase
    .from("authorized_users")
    .select("telegram_id, username, role, created_at")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("auth: Failed to list users:", error);
    return [];
  }

  return data || [];
}

export function shouldRespondInGroup(
  text: string,
  botUsername: string,
  isReplyToBot: boolean
): boolean {
  if (isReplyToBot) return true;
  if (text.includes(`@${botUsername}`)) return true;
  // Also respond to /commands in groups
  if (text.startsWith("/")) return true;
  return false;
}

async function refreshCacheIfNeeded(supabase: SupabaseClient): Promise<void> {
  if (Date.now() - lastCacheRefresh < CACHE_TTL_MS) return;

  try {
    const { data } = await supabase
      .from("authorized_users")
      .select("telegram_id, role");

    authorizedCache = new Map();
    if (OWNER_ID) authorizedCache.set(OWNER_ID, "owner");
    for (const row of data || []) {
      authorizedCache.set(row.telegram_id, row.role);
    }
    lastCacheRefresh = Date.now();
  } catch {
    // Keep existing cache on error
  }
}

// Rate limiting per user
const rateLimits: Map<string, number[]> = new Map();
const RATE_LIMIT_WINDOW_MS = 3_600_000; // 1 hour
const RATE_LIMIT_MAX_OWNER = 1000;
const RATE_LIMIT_MAX_USER = 30;

export function checkRateLimit(userId: string): boolean {
  const max = isOwner(userId) ? RATE_LIMIT_MAX_OWNER : RATE_LIMIT_MAX_USER;
  const now = Date.now();
  const timestamps = (rateLimits.get(userId) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );

  if (timestamps.length >= max) return false;

  timestamps.push(now);
  rateLimits.set(userId, timestamps);
  return true;
}
