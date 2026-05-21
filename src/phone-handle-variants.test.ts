import { expect, test } from "bun:test";
import { dirname, join } from "path";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const HELPER = join(PROJECT_ROOT, "scripts", "_phone_handle_variants.py");

async function runHelper(identifier: string): Promise<string[]> {
  const proc = Bun.spawn(["python3", HELPER, identifier], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, _stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  return stdout.length > 0 ? stdout.replace(/\n$/, "").split("\n") : [];
}

// PR3.5 audit #2 regression (Codex 2026-05-21).
// Before fix: resolve-contact.py checked (identifier, +naked, naked, +1naked),
// which on an 11-digit "+15551234567" input produced "+115551234567" — a
// malformed E.164 — and was missing the bare 10-digit form. Meanwhile
// imessage-thread.sh built a different (larger, correct) set. Same input,
// two scripts, two answers. Wrong duplicate contact could win recency
// tie-breaking.

test("variants for an 11-digit +1-prefixed phone includes naked, +naked, 10-digit and +10-digit", async () => {
  const vs = await runHelper("+16043154583");
  expect(vs).toEqual([
    "+16043154583",
    "16043154583",
    "+16043154583", // dedup-removed but keeping as a check intent? actually no — let's verify dedup
    "6043154583",
    "+6043154583",
  ].filter((v, i, a) => a.indexOf(v) === i));
  // Defensive: no malformed +1-prefixed-on-already-prefixed shape.
  expect(vs).not.toContain("+116043154583");
});

test("variants for a bare 10-digit phone includes both country-prefixed and plus shapes", async () => {
  const vs = await runHelper("6043154583");
  expect(vs).toEqual([
    "6043154583",
    "+6043154583",
    "16043154583",
    "+16043154583",
  ]);
});

test("variants for a bare 11-digit phone starting with 1 includes the 10-digit form", async () => {
  const vs = await runHelper("16043154583");
  expect(vs).toEqual([
    "16043154583",
    "+16043154583",
    "6043154583",
    "+6043154583",
  ]);
});

test("variants for an email returns only the email", async () => {
  const vs = await runHelper("alice@example.com");
  expect(vs).toEqual(["alice@example.com"]);
});

test("variants for an empty input returns an empty list", async () => {
  const vs = await runHelper("");
  expect(vs).toEqual([]);
});

test("variants for a 7-digit short code returns digit-and-plus forms only", async () => {
  const vs = await runHelper("5551234");
  expect(vs).toEqual(["5551234", "+5551234"]);
});

test("variants strip formatting characters like spaces, dashes, parens", async () => {
  const vs = await runHelper("(604) 315-4583");
  // First entry is the identifier as-is, then the canonicalized variants.
  expect(vs[0]).toBe("(604) 315-4583");
  expect(vs).toContain("6043154583");
  expect(vs).toContain("+16043154583");
});
