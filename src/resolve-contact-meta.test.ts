import { expect, test } from "bun:test";
import { dirname, join } from "path";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const RESOLVER = join(PROJECT_ROOT, "scripts", "resolve-contact.py");

async function runResolver(args: string[]) {
  const proc = Bun.spawn(["python3", RESOLVER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

test("legacy mode prints the bare identifier for a direct phone", async () => {
  const result = await runResolver(["+15551234567"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("+15551234567");
});

test("legacy mode prints the bare identifier for a direct email", async () => {
  const result = await runResolver(["alice@example.com"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("alice@example.com");
});

test("--meta mode returns JSON with handle, display_name, last_messaged_at", async () => {
  const result = await runResolver(["--meta", "+15551234567"]);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed).toMatchObject({
    handle: "+15551234567",
    display_name: "",
  });
  // last_messaged_at is the raw chat.db timestamp for this handle; on a fresh
  // test machine that has never messaged the number, it is 0. On a machine
  // with history it would be an integer. Either is acceptable; just assert
  // the field exists and is numeric.
  expect(typeof parsed.last_messaged_at).toBe("number");
});

test("--meta mode normalizes a US 10-digit phone to +1 form", async () => {
  const result = await runResolver(["--meta", "5551234567"]);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.handle).toBe("+15551234567");
});

test("--meta mode returns empty handle JSON for an unknown name", async () => {
  // A made-up name that should not appear in any AddressBook source.
  const result = await runResolver(["--meta", "zzz-very-unlikely-contact-name-zzz"]);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed).toEqual({
    handle: "",
    display_name: "",
    last_messaged_at: 0,
  });
});

test("--meta mode with no argument returns the empty envelope", async () => {
  const result = await runResolver(["--meta"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    handle: "",
    display_name: "",
    last_messaged_at: 0,
  });
});

test("--meta JSON output is single-line compact JSON (no whitespace)", async () => {
  const result = await runResolver(["--meta", "+15551234567"]);
  expect(result.code).toBe(0);
  // Compact = no spaces after structural tokens.
  expect(result.stdout).not.toMatch(/: /);
  expect(result.stdout).not.toMatch(/, /);
  // Single line: the trim above already removed the trailing newline, so
  // there should be no internal newlines.
  expect(result.stdout).not.toMatch(/\n/);
});
