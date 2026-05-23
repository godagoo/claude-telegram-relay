// Regression test: scripts/imessage-thread.sh must exit nonzero when the
// Python interpreter is broken or too old, and must never emit the old
// silent-failure envelope {"resolved":"","messages":[]}.
//
// Background: before the 2026-05-16 hardening, a broken python3 caused
// resolve-contact.py to fail silently — the shell script treated the failure
// as "contact not found" and returned exit 0 with an empty envelope. That
// empty envelope then fell through to NEW_COMPOSE_SENTINEL, opening a blank
// Messages compose window instead of surfacing the real error.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, unlinkSync, rmdirSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";

const SCRIPT = join(dirname(import.meta.dir), "scripts", "imessage-thread.sh");
const TIMEOUT_MS = 15_000;

let fakePythonDir: string;
let fakePythonPath: string;

beforeAll(() => {
  fakePythonDir = mkdtempSync(join(tmpdir(), "fake-python3-"));
  fakePythonPath = join(fakePythonDir, "python3");
  // A python3 stub that always exits 1. Simulates a broken interpreter or
  // one that is too old for the version check in resolve_recipient().
  writeFileSync(fakePythonPath, "#!/bin/sh\nexit 1\n");
  chmodSync(fakePythonPath, 0o755);
});

afterAll(() => {
  try { unlinkSync(fakePythonPath); } catch {}
  try { rmdirSync(fakePythonDir); } catch {}
});

test(
  "imessage-thread.sh exits nonzero with diagnostic stderr when python3 fails version check",
  async () => {
    const proc = Bun.spawn([SCRIPT, "mom", "1"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Inject our broken python3 first on PATH so it shadows any real one.
        PATH: `${fakePythonDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    // Must NOT exit cleanly.
    expect(code).not.toBe(0);

    // Must NOT emit the old silent-failure envelope.
    // That envelope was the sign that a broken resolver was treated as "no match".
    expect(stdout.trim()).not.toBe('{"resolved":"","messages":[]}');

    // Must emit a diagnostic pointing at Python or the resolver.
    expect(stderr).toMatch(/python3.*3\.7|3\.7.*required|resolver.*fail|python3.*not found/i);
  },
  TIMEOUT_MS,
);

test(
  "imessage-thread.sh uses RELAY_PYTHON when set, and surfaces that path in error messages",
  async () => {
    const proc = Bun.spawn([SCRIPT, "mom", "1"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // RELAY_PYTHON overrides PATH lookup entirely.
        RELAY_PYTHON: fakePythonPath,
        // Keep real python3 on PATH to prove RELAY_PYTHON takes precedence.
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code).not.toBe(0);
    expect(stdout.trim()).not.toBe('{"resolved":"","messages":[]}');
    // Error message should mention RELAY_PYTHON so the user knows which setting to fix.
    expect(stderr).toMatch(/RELAY_PYTHON/i);
  },
  TIMEOUT_MS,
);
