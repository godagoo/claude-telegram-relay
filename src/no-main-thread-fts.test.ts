// Structural regression test: no module under src/ may issue FTS5 MATCH
// queries on the main thread. The only main-thread access permitted is the
// PRAGMA / version / preflight read in retrieval.ts; actual MATCH queries
// must route through fts-worker.ts via runFtsInWorker.
//
// PLAN.md section 5: "Add regression tests for ... no main-thread FTS call
// path."

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SRC_DIR = join(import.meta.dir);

// The only files allowed to mention bun:sqlite (or otherwise hold a Database
// handle) are the FTS worker itself and retrieval.ts (which uses a
// query_only handle for non-MATCH preflight checks).
const ALLOWED_SQLITE_FILES = new Set(["fts-worker.ts", "retrieval.ts"]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(path));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

// Any file outside the allowed set that contains a MATCH against
// chunks_fts MUST also dispatch through runFtsInWorker. Mentioning MATCH in
// a SQL string and sending the string to the worker is fine — but
// constructing a `db.query(...MATCH...)` on the main thread is not.
const FTS_MATCH_RE = /\bchunks_fts\b[\s\S]{0,200}?\bMATCH\b/i;
const WORKER_DISPATCH_RE = /\brunFtsInWorker\b/;
const DB_QUERY_RE = /\b(?:new\s+Database|db\s*\.\s*query|db\s*\.\s*prepare)\b/;

describe("no main-thread FTS call path", () => {
  test("only fts-worker.ts and retrieval.ts import bun:sqlite", () => {
    const files = listSourceFiles(SRC_DIR);
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (/from\s+["']bun:sqlite["']/.test(content)) {
        const base = file.slice(SRC_DIR.length + 1);
        if (!ALLOWED_SQLITE_FILES.has(base)) violations.push(base);
      }
    }
    expect(violations).toEqual([]);
  });

  test("any non-allowed file that mentions a chunks_fts MATCH query must dispatch through runFtsInWorker", () => {
    const files = listSourceFiles(SRC_DIR);
    const violations: { file: string; reason: string }[] = [];
    for (const file of files) {
      const base = file.slice(SRC_DIR.length + 1);
      if (ALLOWED_SQLITE_FILES.has(base)) continue;
      const content = readFileSync(file, "utf8");
      if (!FTS_MATCH_RE.test(content)) continue;
      if (!WORKER_DISPATCH_RE.test(content)) {
        violations.push({ file: base, reason: "mentions chunks_fts MATCH without importing runFtsInWorker" });
      }
      if (DB_QUERY_RE.test(content)) {
        violations.push({
          file: base,
          reason: "constructs a main-thread DB handle (new Database / db.query / db.prepare)",
        });
      }
    }
    expect(violations).toEqual([]);
  });

  test("retrieval.ts exports the Worker entry point that all callers must use", () => {
    const content = readFileSync(join(SRC_DIR, "retrieval.ts"), "utf8");
    expect(content).toMatch(/export\s+async\s+function\s+runFtsInWorker/);
  });

  test("project-anchors.ts has been migrated off direct bun:sqlite", () => {
    const content = readFileSync(join(SRC_DIR, "project-anchors.ts"), "utf8");
    expect(content).not.toMatch(/from\s+["']bun:sqlite["']/);
    expect(content).toMatch(/runFtsInWorker/);
  });
});
