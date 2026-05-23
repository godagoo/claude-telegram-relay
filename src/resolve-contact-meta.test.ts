import { expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const RESOLVER = join(PROJECT_ROOT, "scripts", "resolve-contact.py");

async function runResolver(
  args: string[],
  env: Record<string, string> = {},
) {
  const proc = Bun.spawn(["python3", RESOLVER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function buildChatDb(
  dir: string,
  rows: Array<{ chat_identifier: string; date: number }>,
): Promise<string> {
  const dbPath = join(dir, "chat.db");
  const sqlStmts: string[] = [
    `CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT);`,
    `CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER);`,
    `CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);`,
  ];
  rows.forEach((r, i) => {
    const cid = i + 1;
    const mid = i + 1;
    sqlStmts.push(
      `INSERT INTO chat (ROWID, chat_identifier) VALUES (${cid}, '${r.chat_identifier.replace(
        /'/g,
        "''",
      )}');`,
    );
    sqlStmts.push(`INSERT INTO message (ROWID, date) VALUES (${mid}, ${r.date});`);
    sqlStmts.push(
      `INSERT INTO chat_message_join (chat_id, message_id) VALUES (${cid}, ${mid});`,
    );
  });
  const sql = sqlStmts.join("\n");
  const proc = Bun.spawn(["sqlite3", dbPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin?.write(sql);
  await proc.stdin?.end();
  const [, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  return dbPath;
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

// PR3.5 audit #2 regression (Codex 2026-05-21).
// Before fix: resolve-contact.py checked only (identifier, +naked, naked,
// +1naked). For input "+16043154583" it checked
// ["+16043154583", "+16043154583" (dup), "16043154583", "+116043154583"].
// The bare 10-digit "6043154583" — a common chat_identifier shape in
// chat.db when the contact card stores the number without the country
// prefix — was missed. last_messaged_at fell back to 0 and a duplicate
// "Mark" contact (with no chat history) could win the recency tie-break.

test("--meta last_messaged_at finds chat rows stored as the bare 10-digit identifier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-db-tiebreak-"));
  try {
    const dbPath = await buildChatDb(dir, [
      { chat_identifier: "6043154583", date: 12_345_678_900_000_000 },
    ]);
    const result = await runResolver(
      ["--meta", "+16043154583"],
      { RELAY_MESSAGES_DB_PATH: dbPath },
    );
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.handle).toBe("+16043154583");
    expect(parsed.last_messaged_at).toBe(12_345_678_900_000_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--meta last_messaged_at returns 0 when no chat variant matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-db-empty-"));
  try {
    const dbPath = await buildChatDb(dir, [
      { chat_identifier: "totally-different-id", date: 999 },
    ]);
    const result = await runResolver(
      ["--meta", "+16043154583"],
      { RELAY_MESSAGES_DB_PATH: dbPath },
    );
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.last_messaged_at).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--meta last_messaged_at picks MAX across multiple matching variants", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-db-max-"));
  try {
    // Two chat rows whose identifiers are both in the candidate set for
    // "+16043154583". The older row uses the bare 10-digit form, the
    // newer uses the canonical +1-prefixed form. MAX wins.
    const dbPath = await buildChatDb(dir, [
      { chat_identifier: "6043154583", date: 100_000_000_000_000_000 },
      { chat_identifier: "+16043154583", date: 200_000_000_000_000_000 },
    ]);
    const result = await runResolver(
      ["--meta", "+16043154583"],
      { RELAY_MESSAGES_DB_PATH: dbPath },
    );
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.last_messaged_at).toBe(200_000_000_000_000_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
