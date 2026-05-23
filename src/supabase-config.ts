export type MemoryAuthority = "obsidian" | "supabase";

export interface SupabaseFeatureConfig {
  memoryAuthority: MemoryAuthority;
  messageHistory: boolean;
  relevantContext: boolean;
  durableMemory: boolean;
}

function boolFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function memoryAuthority(value: string | undefined): MemoryAuthority {
  return value?.trim().toLowerCase() === "supabase" ? "supabase" : "obsidian";
}

export function getSupabaseFeatureConfig(
  env: Record<string, string | undefined> = process.env,
): SupabaseFeatureConfig {
  const authority = memoryAuthority(env.MEMORY_AUTHORITY);
  return {
    memoryAuthority: authority,
    messageHistory: boolFlag(env.SUPABASE_MESSAGE_HISTORY, true),
    relevantContext: boolFlag(env.SUPABASE_RELEVANT_CONTEXT, true),
    durableMemory: authority === "supabase",
  };
}

