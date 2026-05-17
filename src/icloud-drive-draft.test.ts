import { afterEach, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  clearICloudDriveDraft,
  defaultICloudDriveRoot,
  defaultICloudDriveDraftDir,
  isCloudDocsDraftDir,
  shortcutInstallPath,
  shortcutRunUrl,
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

test("writes latest.json with recipient, body, timestamp, and body hash", async () => {
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
    },
  );

  expect(result.ok).toBe(true);
  expect(result.path).toBe(join(dir, "latest.json"));
  expect(result.shortcutUrl).toBe("shortcuts://run-shortcut?name=ClaudeDraft");
  expect(result.bodySha256).toMatch(/^[a-f0-9]{64}$/);

  const payload = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
  expect(payload).toEqual({
    recipient: "+15198545324",
    recipient_label: "William",
    body: "icloud-drive-test-body",
    ts: "2026-05-13T13:30:00.000Z",
    body_sha256: result.bodySha256,
  });
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
