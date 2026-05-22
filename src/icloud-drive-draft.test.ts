import { afterEach, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  ICLOUD_DRIVE_DRAFT_SCHEMA_VERSION,
  clearICloudDriveDraft,
  defaultICloudDriveRoot,
  defaultICloudDriveDraftDir,
  isCloudDocsDraftDir,
  shortcutInstallPath,
  shortcutRunUrl,
  validateICloudDriveDraftPayload,
  writeICloudDriveDraft,
} from "./icloud-drive-draft";

const tmpRoots: string[] = [];

async function tempDraftDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "relay-icloud-drive-draft-"));
  tmpRoots.push(root);
  return join(root, "claude-relay-drafts");
}

function tempCloudDocsRootFor(dir: string): string {
  return dirname(dir);
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

test("writes latest.json with the v2 draft contract fields", async () => {
  const dir = await tempDraftDir();
  const result = await writeICloudDriveDraft(
    {
      recipient: "+15198545324",
      recipientLabel: "William",
      body: "icloud-drive-test-body",
    },
    {
      dir,
      cloudDocsRoot: tempCloudDocsRootFor(dir),
      now: new Date("2026-05-13T13:30:00.000Z"),
      shortcutName: "ClaudeDraft",
      writerHost: "test-host",
      draftId: "11111111-2222-3333-4444-555555555555",
      ttlMs: 60_000,
    },
  );

  expect(result.ok).toBe(true);
  expect(result.path).toBe(join(dir, "latest.json"));
  expect(result.shortcutUrl).toBe("shortcuts://run-shortcut?name=ClaudeDraft");
  expect(result.bodySha256).toMatch(/^[a-f0-9]{64}$/);

  const payload = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
  expect(payload).toEqual({
    schema_version: ICLOUD_DRIVE_DRAFT_SCHEMA_VERSION,
    draft_id: "11111111-2222-3333-4444-555555555555",
    writer_host: "test-host",
    created_at: "2026-05-13T13:30:00.000Z",
    expires_at: "2026-05-13T13:31:00.000Z",
    recipient: "+15198545324",
    recipient_label: "William",
    body: "icloud-drive-test-body",
    body_sha256: result.bodySha256,
  });
});

test("generates a uuid draft_id when not supplied", async () => {
  const dir = await tempDraftDir();
  const result = await writeICloudDriveDraft(
    { recipient: "+1", recipientLabel: "W", body: "b" },
    { dir, cloudDocsRoot: tempCloudDocsRootFor(dir), now: new Date("2026-05-13T13:30:00.000Z") },
  );
  expect(result.ok).toBe(true);
  const payload = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
  expect(payload.draft_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("expires_at defaults to created_at + 10 minutes when no ttl is provided", async () => {
  const dir = await tempDraftDir();
  await writeICloudDriveDraft(
    { recipient: "+1", recipientLabel: "W", body: "b" },
    { dir, cloudDocsRoot: tempCloudDocsRootFor(dir), now: new Date("2026-05-13T13:30:00.000Z") },
  );
  const payload = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
  expect(payload.created_at).toBe("2026-05-13T13:30:00.000Z");
  expect(payload.expires_at).toBe("2026-05-13T13:40:00.000Z");
});

test("atomically replaces latest.json on subsequent writes", async () => {
  const dir = await tempDraftDir();
  const first = await writeICloudDriveDraft(
    { recipient: "+1", recipientLabel: "First", body: "first body" },
    { dir, cloudDocsRoot: tempCloudDocsRootFor(dir), now: new Date("2026-05-13T13:30:00.000Z") },
  );
  const second = await writeICloudDriveDraft(
    { recipient: "+2", recipientLabel: "Second", body: "second body" },
    { dir, cloudDocsRoot: tempCloudDocsRootFor(dir), now: new Date("2026-05-13T13:31:00.000Z") },
  );

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  const payload = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
  expect(payload.recipient).toBe("+2");
  expect(payload.body).toBe("second body");
});

test("refuses when the handoff root is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-missing-icloud-root-"));
  tmpRoots.push(root);
  const dir = join(root, "missing", "claude-relay-drafts");

  const result = await writeICloudDriveDraft({
    recipient: "+15198545324",
    recipientLabel: "William",
    body: "body",
  }, { dir, cloudDocsRoot: dirname(dir) });

  expect(result.ok).toBe(false);
  expect(result.error).toContain(`icloud_drive_root_missing:${dirname(dir)}`);
});

test("refuses draft directories outside the CloudDocs root", async () => {
  const dir = await tempDraftDir();

  const result = await writeICloudDriveDraft({
    recipient: "+15198545324",
    recipientLabel: "William",
    body: "body",
  }, { dir });

  expect(result.ok).toBe(false);
  expect(result.error).toBe(`icloud_drive_draft_dir_not_clouddocs:${dir}`);
  expect(isCloudDocsDraftDir(dir)).toBe(false);
});

test("returns ok false instead of throwing when draft directory cannot be created", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-blocked-icloud-dir-"));
  tmpRoots.push(root);
  const dir = join(root, "claude-relay-drafts");
  await writeFile(dir, "not a directory", "utf8");

  const result = await writeICloudDriveDraft({
    recipient: "+15198545324",
    recipientLabel: "William",
    body: "body",
  }, { dir, cloudDocsRoot: tempCloudDocsRootFor(dir) });

  expect(result.ok).toBe(false);
  expect(result.error).toBeTruthy();
});

test("shortcutRunUrl URL-encodes custom shortcut names", () => {
  expect(shortcutRunUrl("Claude Draft")).toBe(
    "shortcuts://run-shortcut?name=Claude%20Draft",
  );
});

test("default handoff dir targets the iCloud Drive container", () => {
  const original = process.env.RELAY_ICLOUD_DRAFT_DIR;
  delete process.env.RELAY_ICLOUD_DRAFT_DIR;
  try {
    expect(defaultICloudDriveDraftDir()).toContain(
      "Library/Mobile Documents/com~apple~CloudDocs/claude-relay-drafts",
    );
  } finally {
    if (original === undefined) {
      delete process.env.RELAY_ICLOUD_DRAFT_DIR;
    } else {
      process.env.RELAY_ICLOUD_DRAFT_DIR = original;
    }
  }
});

test("shortcut install path uses the iCloud Drive root and exact shortcut filename", () => {
  expect(defaultICloudDriveRoot()).toContain(
    "Library/Mobile Documents/com~apple~CloudDocs",
  );
  expect(shortcutInstallPath("ClaudeDraft")).toBe(
    join(defaultICloudDriveRoot(), "ClaudeDraft.shortcut"),
  );
});

test("latest.json is owner-readable only on write", async () => {
  const dir = await tempDraftDir();
  const result = await writeICloudDriveDraft({
    recipient: "+15198545324",
    recipientLabel: "William",
    body: "body",
  }, { dir, cloudDocsRoot: tempCloudDocsRootFor(dir) });

  expect(result.ok).toBe(true);
  const mode = (await stat(join(dir, "latest.json"))).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("validateICloudDriveDraftPayload accepts a fresh v2 payload", async () => {
  const dir = await tempDraftDir();
  await writeICloudDriveDraft(
    { recipient: "+1", recipientLabel: "W", body: "fresh body" },
    { dir, cloudDocsRoot: tempCloudDocsRootFor(dir), now: new Date("2026-05-13T13:30:00.000Z") },
  );
  const payload = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
  const result = validateICloudDriveDraftPayload(payload, { now: new Date("2026-05-13T13:31:00.000Z") });
  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
});

test("validateICloudDriveDraftPayload rejects an expired draft", async () => {
  const dir = await tempDraftDir();
  await writeICloudDriveDraft(
    { recipient: "+1", recipientLabel: "W", body: "old body" },
    { dir, cloudDocsRoot: tempCloudDocsRootFor(dir), now: new Date("2026-05-13T13:30:00.000Z"), ttlMs: 60_000 },
  );
  const payload = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
  const result = validateICloudDriveDraftPayload(payload, { now: new Date("2026-05-13T14:00:00.000Z") });
  expect(result.ok).toBe(false);
  expect(result.errors.some((e) => e.includes("expired"))).toBe(true);
});

test("validateICloudDriveDraftPayload rejects mismatched body_sha256", async () => {
  const payload = {
    schema_version: 2,
    draft_id: "id",
    writer_host: "host",
    created_at: "2026-05-13T13:30:00.000Z",
    expires_at: "2026-05-13T13:40:00.000Z",
    recipient: "+1",
    recipient_label: "W",
    body: "real body",
    body_sha256: "0".repeat(64),
  };
  const result = validateICloudDriveDraftPayload(payload, { now: new Date("2026-05-13T13:31:00.000Z") });
  expect(result.ok).toBe(false);
  expect(result.errors.some((e) => e.includes("body_sha256"))).toBe(true);
});

test("validateICloudDriveDraftPayload rejects missing required fields", () => {
  const result = validateICloudDriveDraftPayload({}, { now: new Date() });
  expect(result.ok).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
});

test("validateICloudDriveDraftPayload rejects unsupported schema_version", () => {
  const payload = {
    schema_version: 99,
    draft_id: "id",
    writer_host: "host",
    created_at: "2026-05-13T13:30:00.000Z",
    expires_at: "2026-05-13T13:40:00.000Z",
    recipient: "+1",
    recipient_label: "W",
    body: "b",
    body_sha256: "0".repeat(64),
  };
  const result = validateICloudDriveDraftPayload(payload, { now: new Date("2026-05-13T13:31:00.000Z") });
  expect(result.ok).toBe(false);
  expect(result.errors.some((e) => e.includes("schema_version"))).toBe(true);
});

test("clears latest.json to prevent stale shortcut handoff reuse", async () => {
  const dir = await tempDraftDir();
  const result = await writeICloudDriveDraft({
    recipient: "+15198545324",
    recipientLabel: "William",
    body: "stale body",
  }, { dir, cloudDocsRoot: tempCloudDocsRootFor(dir) });

  expect(result.ok).toBe(true);
  expect(existsSync(join(dir, "latest.json"))).toBe(true);

  const cleared = await clearICloudDriveDraft({
    dir,
    cloudDocsRoot: tempCloudDocsRootFor(dir),
  });
  expect(cleared.ok).toBe(true);
  expect(existsSync(join(dir, "latest.json"))).toBe(false);

  const clearedAgain = await clearICloudDriveDraft({
    dir,
    cloudDocsRoot: tempCloudDocsRootFor(dir),
  });
  expect(clearedAgain.ok).toBe(true);
});
