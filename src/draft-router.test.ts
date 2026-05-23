import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  containsEmDash,
  gateForEmDash,
  gateForIMessageRecipient,
  resetAllowlistCache,
} from "./draft-router";

test("containsEmDash detects U+2014", () => {
  expect(containsEmDash("hello — world")).toBe(true);
  expect(containsEmDash("hello, world")).toBe(false);
  expect(containsEmDash("range 1-5")).toBe(false);
});

test("containsEmDash also detects en dash", () => {
  expect(containsEmDash("hello – world")).toBe(true);
});

test("gateForEmDash returns ok:false when present", () => {
  expect(gateForEmDash("text with — dash")).toEqual({
    ok: false,
    reason: "em_dash_in_outbound",
  });
});

test("gateForEmDash allows clean text", () => {
  expect(gateForEmDash("text with comma, no dash")).toEqual({ ok: true });
});

let workdir: string;
let oldHome: string | undefined;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "relay-dr-"));
  oldHome = process.env.HOME;
  process.env.RELAY_DIR = workdir;
  process.env.IMESSAGE_ALLOWLIST_PATH = join(workdir, "imessage-allowlist.json");
  resetAllowlistCache();
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  delete process.env.RELAY_DIR;
  delete process.env.IMESSAGE_ALLOWLIST_PATH;
  if (oldHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = oldHome;
  }
  resetAllowlistCache();
});

test("gateForIMessageRecipient: allowlist file missing => fail-closed", async () => {
  const r = await gateForIMessageRecipient("+15551234567");
  expect(r).toEqual({ ok: false, reason: "recipient_not_allowlisted" });
});

test("gateForIMessageRecipient: recipient in allowlist => ok", async () => {
  await writeFile(
    process.env.IMESSAGE_ALLOWLIST_PATH!,
    JSON.stringify(["+15551234567", "alex@example.com"]),
  );
  expect(await gateForIMessageRecipient("+15551234567")).toEqual({ ok: true });
  expect(await gateForIMessageRecipient("alex@example.com")).toEqual({ ok: true });
});

test("gateForIMessageRecipient: recipient not in allowlist => fail", async () => {
  await writeFile(
    process.env.IMESSAGE_ALLOWLIST_PATH!,
    JSON.stringify(["+15551234567"]),
  );
  const r = await gateForIMessageRecipient("+19998887777");
  expect(r).toEqual({ ok: false, reason: "recipient_not_allowlisted" });
});

test("gateForIMessageRecipient: malformed allowlist => fail-closed", async () => {
  await writeFile(process.env.IMESSAGE_ALLOWLIST_PATH!, "{ not valid json");
  const r = await gateForIMessageRecipient("+15551234567");
  expect(r).toEqual({ ok: false, reason: "recipient_not_allowlisted" });
});

test("gateForIMessageRecipient: non-array JSON => fail-closed", async () => {
  await writeFile(process.env.IMESSAGE_ALLOWLIST_PATH!, JSON.stringify({ phones: ["+15551234567"] }));
  const r = await gateForIMessageRecipient("+15551234567");
  expect(r).toEqual({ ok: false, reason: "recipient_not_allowlisted" });
});

test("gateForIMessageRecipient: array with non-string entries => skips non-strings", async () => {
  await writeFile(
    process.env.IMESSAGE_ALLOWLIST_PATH!,
    JSON.stringify(["+15551234567", 42, null, "alex@example.com"]),
  );
  expect(await gateForIMessageRecipient("+15551234567")).toEqual({ ok: true });
  expect(await gateForIMessageRecipient("alex@example.com")).toEqual({ ok: true });
});

test("gateForIMessageRecipient: default path matches relay HOME fallback", async () => {
  delete process.env.IMESSAGE_ALLOWLIST_PATH;
  delete process.env.RELAY_DIR;
  process.env.HOME = workdir;
  await mkdir(join(workdir, ".claude-relay"), { recursive: true });
  await writeFile(
    join(workdir, ".claude-relay", "imessage-allowlist.json"),
    JSON.stringify(["+15551234567"]),
  );
  resetAllowlistCache();

  expect(await gateForIMessageRecipient("+15551234567")).toEqual({ ok: true });
});

test("gateForIMessageRecipient: empty RELAY_DIR does not create a relative allowlist path", async () => {
  delete process.env.IMESSAGE_ALLOWLIST_PATH;
  process.env.RELAY_DIR = "";
  process.env.HOME = workdir;
  await mkdir(join(workdir, ".claude-relay"), { recursive: true });
  await writeFile(
    join(workdir, ".claude-relay", "imessage-allowlist.json"),
    JSON.stringify(["+15551234567"]),
  );
  resetAllowlistCache();

  expect(await gateForIMessageRecipient("+15551234567")).toEqual({ ok: true });
});

test("scheduleStillThinking cancel function prevents the send", async () => {
  const { scheduleStillThinking } = await import("./draft-router");
  let called = false;
  const cancel = scheduleStillThinking(() => { called = true; }, 50);
  await new Promise((r) => setTimeout(r, 20));
  cancel();
  await new Promise((r) => setTimeout(r, 80));
  expect(called).toBe(false);
});

test("scheduleStillThinking fires after the timer when not cancelled", async () => {
  const { scheduleStillThinking } = await import("./draft-router");
  let called = false;
  scheduleStillThinking(() => { called = true; }, 30);
  await new Promise((r) => setTimeout(r, 80));
  expect(called).toBe(true);
});
