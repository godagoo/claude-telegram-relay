import { createHash, randomUUID } from "crypto";
import { chmod, mkdir, open, rename, stat, unlink } from "fs/promises";
import { homedir } from "os";
import { join, resolve, sep } from "path";

export const DEFAULT_SHORTCUT_NAME = "ClaudeDraft";
export const ICLOUD_DRIVE_DRAFT_FILE_NAME = "latest.json";

export interface ICloudDriveDraftInput {
  recipient: string;
  recipientLabel: string;
  body: string;
}

export interface ICloudDriveDraftResult {
  ok: boolean;
  path?: string;
  shortcutUrl?: string;
  bodySha256?: string;
  error?: string;
}

export interface ClearICloudDriveDraftResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export function defaultICloudDriveDraftDir(): string {
  return process.env.RELAY_ICLOUD_DRAFT_DIR
    ?? join(
      homedir(),
      "Library",
      "Mobile Documents",
      "com~apple~CloudDocs",
      "claude-relay-drafts",
    );
}

export function defaultICloudDriveRoot(): string {
  return join(
    homedir(),
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
  );
}

export function isCloudDocsDraftDir(
  dir: string,
  cloudDocsRoot = defaultICloudDriveRoot(),
): boolean {
  const root = resolve(cloudDocsRoot);
  const candidate = resolve(dir);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function shortcutInstallPath(
  shortcutName = process.env.RELAY_IMESSAGE_SHORTCUT_NAME ?? DEFAULT_SHORTCUT_NAME,
): string {
  return join(defaultICloudDriveRoot(), `${shortcutName}.shortcut`);
}

export function shortcutRunUrl(
  shortcutName = process.env.RELAY_IMESSAGE_SHORTCUT_NAME ?? DEFAULT_SHORTCUT_NAME,
): string {
  return `shortcuts://run-shortcut?name=${encodeURIComponent(shortcutName)}`;
}

export async function writeICloudDriveDraft(
  input: ICloudDriveDraftInput,
  options: { dir?: string; now?: Date; shortcutName?: string; cloudDocsRoot?: string } = {},
): Promise<ICloudDriveDraftResult> {
  const dir = options.dir ?? defaultICloudDriveDraftDir();
  const cloudDocsRoot = options.cloudDocsRoot ?? defaultICloudDriveRoot();

  if (!isCloudDocsDraftDir(dir, cloudDocsRoot)) {
    return { ok: false, error: `icloud_drive_draft_dir_not_clouddocs:${dir}` };
  }

  try {
    const rootStats = await stat(cloudDocsRoot);
    if (!rootStats.isDirectory()) {
      return { ok: false, error: `icloud_drive_root_not_directory:${cloudDocsRoot}` };
    }
  } catch {
    return { ok: false, error: `icloud_drive_root_missing:${cloudDocsRoot}` };
  }

  const bodySha256 = createHash("sha256").update(input.body, "utf8").digest("hex");
  const payload = {
    recipient: input.recipient,
    recipient_label: input.recipientLabel,
    body: input.body,
    ts: (options.now ?? new Date()).toISOString(),
    body_sha256: bodySha256,
  };

  const target = join(dir, ICLOUD_DRIVE_DRAFT_FILE_NAME);
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}-${randomUUID()}.json`);

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    handle = await open(tmp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(payload, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Ignore cleanup failure.
      }
    }
    try {
      await unlink(tmp);
    } catch {
      // Ignore cleanup failure.
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ok: true,
    path: target,
    shortcutUrl: shortcutRunUrl(options.shortcutName),
    bodySha256,
  };
}

export async function clearICloudDriveDraft(
  options: { dir?: string; cloudDocsRoot?: string } = {},
): Promise<ClearICloudDriveDraftResult> {
  const dir = options.dir ?? defaultICloudDriveDraftDir();
  const cloudDocsRoot = options.cloudDocsRoot ?? defaultICloudDriveRoot();

  if (!isCloudDocsDraftDir(dir, cloudDocsRoot)) {
    return { ok: false, error: `icloud_drive_draft_dir_not_clouddocs:${dir}` };
  }

  const target = join(dir, ICLOUD_DRIVE_DRAFT_FILE_NAME);
  try {
    await unlink(target);
    return { ok: true, path: target };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return { ok: true, path: target };
    }
    return {
      ok: false,
      path: target,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
