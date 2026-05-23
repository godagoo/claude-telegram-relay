import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "relay-session-"));
  process.env.RELAY_DIR = workdir;
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  delete process.env.RELAY_DIR;
});

// Cache-busting import: each test gets a fresh module so process.env mutations
// in beforeEach are picked up. The functions themselves read env at call time,
// so the trick is belt-and-braces.
function freshSession(suffix: string) {
  return import(`./session?fresh-${Date.now()}-${suffix}`);
}

test("loadSession returns null sessionId when no file exists", async () => {
  const mod = await freshSession("absent");
  const s = await mod.loadSession();
  expect(s.sessionId).toBeNull();
  expect(typeof s.lastActivity).toBe("string");
});

test("save + load roundtrip preserves sessionId and lastActivity", async () => {
  const mod = await freshSession("roundtrip");
  await mod.saveSession({ sessionId: "abc-123", lastActivity: "2026-05-17T12:00:00.000Z" });
  const s = await mod.loadSession();
  expect(s.sessionId).toBe("abc-123");
  expect(s.lastActivity).toBe("2026-05-17T12:00:00.000Z");
});

test("save + load preserves optional createdAt when present", async () => {
  const mod = await freshSession("createdAt");
  await mod.saveSession({
    sessionId: "abc-456",
    createdAt: "2026-05-17T11:00:00.000Z",
    lastActivity: "2026-05-17T12:00:00.000Z",
  });
  const s = await mod.loadSession();
  expect(s.createdAt).toBe("2026-05-17T11:00:00.000Z");
});

test("save + load omits createdAt when absent", async () => {
  const mod = await freshSession("noCreatedAt");
  await mod.saveSession({ sessionId: "abc-789", lastActivity: "x" });
  const s = await mod.loadSession();
  expect(s).not.toHaveProperty("createdAt");
});

test("rotateSession deletes the file and returns fresh in-memory state", async () => {
  const mod = await freshSession("rotate");
  await mod.saveSession({ sessionId: "abc-rot", lastActivity: "now" });
  const rotated = await mod.rotateSession("test rotation");
  const reloaded = await mod.loadSession();
  expect(rotated.sessionId).toBeNull();
  expect(typeof rotated.lastActivity).toBe("string");
  expect(reloaded.sessionId).toBeNull();
});

test("rotateSession when file already absent is a no-op", async () => {
  const mod = await freshSession("rotateAbsent");
  const rotated = await mod.rotateSession("noop");
  const s = await mod.loadSession();
  expect(rotated.sessionId).toBeNull();
  expect(s.sessionId).toBeNull();
});

test("saveSession writes file with 0600 permissions", async () => {
  const mod = await freshSession("perm");
  await mod.saveSession({ sessionId: "perm-check", lastActivity: "x" });
  const sessionPath = join(workdir, "session.json");
  const s = await stat(sessionPath);
  expect((s.mode & 0o777).toString(8)).toBe("600");
});

test("saveSession ensures the parent directory exists at 0700", async () => {
  // Point RELAY_DIR at a path that does not yet exist; saveSession must create it.
  const nestedDir = join(workdir, "nested-not-yet-created");
  process.env.RELAY_DIR = nestedDir;
  const mod = await freshSession("ensureDir");
  await mod.saveSession({ sessionId: "ensure", lastActivity: "x" });
  const dirStat = await stat(nestedDir);
  expect(dirStat.isDirectory()).toBe(true);
  expect((dirStat.mode & 0o777).toString(8)).toBe("700");
});

test("loadSession returns fresh default on malformed JSON", async () => {
  await writeFile(join(workdir, "session.json"), "{ not valid json", { mode: 0o600 });
  const mod = await freshSession("malformed");
  const s = await mod.loadSession();
  expect(s.sessionId).toBeNull();
  expect(typeof s.lastActivity).toBe("string");
});

test("loadSession narrows non-string sessionId in stored JSON", async () => {
  // Defensive: even if something writes a numeric sessionId, load returns null.
  await writeFile(
    join(workdir, "session.json"),
    JSON.stringify({ sessionId: 42, lastActivity: "x" }),
    { mode: 0o600 },
  );
  const mod = await freshSession("badType");
  const s = await mod.loadSession();
  expect(s.sessionId).toBeNull();
});

test("sessionFilePath returns the absolute path under RELAY_DIR", async () => {
  const mod = await freshSession("path");
  expect(mod.sessionFilePath()).toBe(join(workdir, "session.json"));
});

test("sessionFilePath default matches relay.ts HOME fallback", async () => {
  const oldHome = process.env.HOME;
  const fakeHome = join(workdir, "fake-home");
  delete process.env.RELAY_DIR;
  process.env.HOME = fakeHome;
  try {
    const mod = await freshSession("homeFallback");
    expect(mod.sessionFilePath()).toBe(join(fakeHome, ".claude-relay", "session.json"));
  } finally {
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
  }
});

test("sessionFilePath default uses tilde fallback when HOME is absent", async () => {
  const oldHome = process.env.HOME;
  delete process.env.RELAY_DIR;
  delete process.env.HOME;
  try {
    const mod = await freshSession("tildeFallback");
    expect(mod.sessionFilePath()).toBe(join("~", ".claude-relay", "session.json"));
  } finally {
    if (oldHome !== undefined) {
      process.env.HOME = oldHome;
    }
  }
});
