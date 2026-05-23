/**
 * Claude Telegram Relay — Test Supabase Connection
 *
 * Verifies Supabase URL and service_role key are valid, and checks if
 * required tables exist. The env var name SUPABASE_ANON_KEY is preserved
 * for backwards compatibility, but the configured RLS policies in
 * db/schema.sql only grant access to service_role.
 *
 * Usage: bun run setup/test-supabase.ts
 */

import { join, dirname } from "path";
import { getSupabaseFeatureConfig } from "../src/supabase-config.ts";

const PROJECT_ROOT = dirname(import.meta.dir);

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");
const WARN = yellow("!");

// Load .env manually
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

type TableCheck = { table: string; required: boolean };

async function main() {
  console.log("");
  console.log(bold("  Supabase Connection Test"));
  console.log("");

  const env = await loadEnv();
  const url = env.SUPABASE_URL || process.env.SUPABASE_URL || "";
  const key = env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";
  const features = getSupabaseFeatureConfig({ ...process.env, ...env });

  // Check URL
  if (!url || url === "your_project_url") {
    console.log(`  ${FAIL} SUPABASE_URL not set in .env`);
    console.log(`      ${dim("Get it from Supabase > Project Settings > API")}`);
    process.exit(1);
  }
  console.log(`  ${PASS} Supabase URL: ${url}`);

  // Check key
  if (!key || key === "your_anon_key" || key === "your_service_role_key") {
    console.log(`  ${FAIL} SUPABASE_ANON_KEY (service_role key) not set in .env`);
    console.log(`      ${dim("Get the service_role key from Supabase > Project Settings > API")}`);
    process.exit(1);
  }
  console.log(`  ${PASS} Service-role key found`);

  console.log(
    `  ${PASS} Memory authority: ${features.memoryAuthority}` +
      (features.durableMemory ? " (Supabase durable memory enabled)" : " (Obsidian durable memory)"),
  );

  // Test connection by querying required and optional tables.
  console.log(`\n  Testing connection...`);

  let allRequiredTablesExist = true;
  const checks: TableCheck[] = [];
  if (features.messageHistory || features.relevantContext) {
    checks.push({ table: "messages", required: true });
  }
  if (features.durableMemory) {
    checks.push({ table: "memory", required: true });
  } else {
    checks.push({ table: "memory", required: false });
  }
  checks.push({ table: "logs", required: false });

  for (const { table, required } of checks) {
    try {
      const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      });

      if (res.status === 200) {
        console.log(`  ${PASS} ${required ? "Required" : "Optional"} table "${table}" exists`);
      } else if (res.status === 404 || res.status === 406) {
        console.log(`  ${required ? FAIL : WARN} ${required ? "Required" : "Optional"} table "${table}" not found`);
        if (required) allRequiredTablesExist = false;
      } else {
        const body = await res.text();
        console.log(`  ${required ? FAIL : WARN} Table "${table}": ${res.status} ${body.slice(0, 100)}`);
        if (required) allRequiredTablesExist = false;
      }
    } catch (err: any) {
      console.log(`  ${FAIL} Could not reach Supabase`);
      console.log(`      ${dim(err.message)}`);
      process.exit(1);
    }
  }

  if (!allRequiredTablesExist) {
    console.log(`\n  ${WARN} Some required tables are missing. Run the schema in your Supabase SQL Editor:`);
    console.log(`      ${dim("1. Open your Supabase dashboard > SQL Editor")}`);
    console.log(`      ${dim("2. Paste contents of db/schema.sql")}`);
    console.log(`      ${dim("3. Click Run")}`);
    console.log(`      ${dim("4. Re-run this test")}`);
  } else {
    console.log(`\n  ${green("All good!")} Supabase is configured for the selected role.`);
    if (!features.durableMemory) {
      console.log(`      ${dim("Obsidian remains the durable memory source of truth.")}`);
    }
  }

  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
