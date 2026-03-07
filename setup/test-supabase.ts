/**
 * Claude Telegram Relay — Test Supabase Connection & Permissions
 *
 * Verifies Supabase URL and anon key are valid, tests RLS permissions
 * (INSERT, SELECT, UPDATE, DELETE) on the logs table.
 *
 * Usage: bun run setup/test-supabase.ts
 */

import { join, dirname } from "path";

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

const REQUIRED_TABLES = ["messages", "memory", "logs", "cron_jobs"];

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function main() {
  console.log("");
  console.log(bold("  Supabase Connection & Permissions Test"));
  console.log("");

  const env = await loadEnv();
  const url = env.SUPABASE_URL || process.env.SUPABASE_URL || "";
  const key = env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";

  // Check URL
  if (!url || url === "your_project_url") {
    console.log(`  ${FAIL} SUPABASE_URL not set in .env`);
    console.log(`      ${dim("Get it from Supabase > Project Settings > API")}`);
    process.exit(1);
  }
  console.log(`  ${PASS} Supabase URL configured`);

  // Check key
  if (!key || key === "your_anon_key") {
    console.log(`  ${FAIL} SUPABASE_ANON_KEY not set in .env`);
    console.log(`      ${dim("Get it from Supabase > Project Settings > API")}`);
    process.exit(1);
  }
  console.log(`  ${PASS} Anon key configured`);

  // Test table existence
  console.log(`\n  Testing table existence...`);
  let allTablesExist = true;

  for (const table of REQUIRED_TABLES) {
    try {
      const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      });

      if (res.status === 200 || res.status === 401 || res.status === 403) {
        // 200 = success, 401/403 = permission denied but table exists
        console.log(`  ${PASS} Table "${table}" exists`);
      } else if (res.status === 404 || res.status === 406) {
        console.log(`  ${FAIL} Table "${table}" not found (status ${res.status})`);
        allTablesExist = false;
      } else {
        const body = await res.text();
        console.log(`  ${FAIL} Table "${table}": ${res.status} ${body.slice(0, 60)}`);
        allTablesExist = false;
      }
    } catch (err: any) {
      console.log(`  ${FAIL} Could not reach Supabase: ${err.message}`);
      process.exit(1);
    }
  }

  if (!allTablesExist) {
    console.log(`\n  ${WARN} Some tables are missing. Apply the schema first:`);
    console.log(`      ${dim("1. Go to your Supabase dashboard > SQL Editor")}`);
    console.log(`      ${dim("2. Paste db/schema.sql")}`);
    console.log(`      ${dim("3. Click Run")}`);
    console.log(`      ${dim("4. Re-run this test")}`);
    process.exit(1);
  }

  // Test RLS permissions on logs table
  console.log(`\n  Testing RLS permissions on logs table...`);

  const testId = `test-${Date.now()}`;
  let insertedRowId: string | null = null;

  // Test INSERT
  try {
    const insertRes = await fetch(`${url}/rest/v1/logs`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        event: testId,
        level: "info",
        message: "RLS permission test",
      }),
    });

    if (insertRes.status === 201) {
      const data = await insertRes.json();
      insertedRowId = data[0]?.id;
      console.log(`  ${PASS} INSERT succeeded (anon key has write access)`);
      results.push({ name: "INSERT", passed: true });
    } else if (insertRes.status === 401 || insertRes.status === 403) {
      const body = await insertRes.text();
      console.log(`  ${FAIL} INSERT failed: ${insertRes.status} - no write permission (RLS policy missing?)`);
      console.log(`      ${dim(body.slice(0, 80))}`);
      results.push({ name: "INSERT", passed: false, error: body });
    } else {
      const body = await insertRes.text();
      console.log(`  ${FAIL} INSERT failed: ${insertRes.status}`);
      console.log(`      ${dim(body.slice(0, 80))}`);
      results.push({ name: "INSERT", passed: false, error: body });
    }
  } catch (err: any) {
    console.log(`  ${FAIL} INSERT error: ${err.message}`);
    results.push({ name: "INSERT", passed: false, error: err.message });
  }

  // Test SELECT
  try {
    const selectRes = await fetch(`${url}/rest/v1/logs?event=eq.${testId}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });

    if (selectRes.status === 200) {
      const data = await selectRes.json();
      if (data.length > 0) {
        console.log(`  ${PASS} SELECT succeeded (anon key has read access)`);
        results.push({ name: "SELECT", passed: true });
      } else {
        console.log(`  ${WARN} SELECT returned 0 rows (might be a filtering issue)`);
        results.push({ name: "SELECT", passed: false, error: "No rows returned" });
      }
    } else if (selectRes.status === 401 || selectRes.status === 403) {
      const body = await selectRes.text();
      console.log(`  ${FAIL} SELECT failed: ${selectRes.status} - no read permission (RLS policy missing?)`);
      console.log(`      ${dim(body.slice(0, 80))}`);
      results.push({ name: "SELECT", passed: false, error: body });
    } else {
      const body = await selectRes.text();
      console.log(`  ${FAIL} SELECT failed: ${selectRes.status}`);
      console.log(`      ${dim(body.slice(0, 80))}`);
      results.push({ name: "SELECT", passed: false, error: body });
    }
  } catch (err: any) {
    console.log(`  ${FAIL} SELECT error: ${err.message}`);
    results.push({ name: "SELECT", passed: false, error: err.message });
  }

  // Test UPDATE (if we have a row)
  if (insertedRowId) {
    try {
      const updateRes = await fetch(`${url}/rest/v1/logs?id=eq.${insertedRowId}`, {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: "Updated test message" }),
      });

      if (updateRes.status === 204) {
        console.log(`  ${PASS} UPDATE succeeded (anon key has update access)`);
        results.push({ name: "UPDATE", passed: true });
      } else if (updateRes.status === 401 || updateRes.status === 403) {
        const body = await updateRes.text();
        console.log(`  ${FAIL} UPDATE failed: ${updateRes.status} - no update permission (RLS policy missing?)`);
        results.push({ name: "UPDATE", passed: false, error: body });
      } else {
        const body = await updateRes.text();
        console.log(`  ${FAIL} UPDATE failed: ${updateRes.status}`);
        results.push({ name: "UPDATE", passed: false, error: body });
      }
    } catch (err: any) {
      console.log(`  ${FAIL} UPDATE error: ${err.message}`);
      results.push({ name: "UPDATE", passed: false, error: err.message });
    }

    // Test DELETE
    try {
      const deleteRes = await fetch(`${url}/rest/v1/logs?id=eq.${insertedRowId}`, {
        method: "DELETE",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      });

      if (deleteRes.status === 204) {
        console.log(`  ${PASS} DELETE succeeded (anon key has delete access)`);
        results.push({ name: "DELETE", passed: true });
      } else if (deleteRes.status === 401 || deleteRes.status === 403) {
        const body = await deleteRes.text();
        console.log(`  ${FAIL} DELETE failed: ${deleteRes.status} - no delete permission (RLS policy missing?)`);
        results.push({ name: "DELETE", passed: false, error: body });
      } else {
        const body = await deleteRes.text();
        console.log(`  ${FAIL} DELETE failed: ${deleteRes.status}`);
        results.push({ name: "DELETE", passed: false, error: body });
      }
    } catch (err: any) {
      console.log(`  ${FAIL} DELETE error: ${err.message}`);
      results.push({ name: "DELETE", passed: false, error: err.message });
    }
  }

  // Summary
  console.log("");
  const allPassed = results.every((r) => r.passed);
  if (allPassed) {
    console.log(`  ${green("✓ All tests passed!")} Supabase is ready.`);
    console.log("");
  } else {
    console.log(`  ${red("✗ Some tests failed:")} RLS policies may need fixing.`);
    const failed = results.filter((r) => !r.passed);
    for (const test of failed) {
      console.log(`      - ${test.name}: ${dim(test.error || "Unknown error")}`);
    }
    console.log(`\n  ${dim("If you see permission errors, ensure db/schema.sql has been applied.")}`);
    console.log(`  ${dim("Specifically, check that anon key RLS policies exist for logs table.")}`);
    console.log("");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
