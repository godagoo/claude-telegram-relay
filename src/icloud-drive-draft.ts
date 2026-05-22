import { createHash, randomUUID } from "crypto";
import { chmod, mkdir, open, rename, stat, unlink } from "fs/promises";
import { hostname } from "os";
import { homedir } from "os";
import { join, resolve, sep } from "path";

export const DEFAULT_SHORTCUT_NAME = "ClaudeDraft";
export const ICLOUD_DRIVE_DRAFT_FILE_NAME = "latest.json";
export const ICLOUD_DRIVE_DRAFT_SCHEMA_VERSION = 2;
export const ICLOUD_DRIVE_DRAFT_DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface ICloudDriveDraftPayload {
  schema_version: typeof ICLOUD_DRIVE_DRAFT_SCHEMA_VERSION;
  draft_id: string;
  writer_host: string;
  created_at: string;
  expires_at: string;
  recipient: string;
  recipient_label: string;
  body: string;
  body_sha256: string;
}

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
  options: {
    dir?: string;
    now?: Date;
    shortcutName?: string;
    cloudDocsRoot?: string;
    writerHost?: string;
    draftId?: string;
    ttlMs?: number;
  } = {},
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
  const createdAt = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? ICLOUD_DRIVE_DRAFT_DEFAULT_TTL_MS;
  const expiresAt = new Date(createdAt.getTime() + ttlMs);
  const payload: ICloudDriveDraftPayload = {
    schema_version: ICLOUD_DRIVE_DRAFT_SCHEMA_VERSION,
    draft_id: options.draftId ?? randomUUID(),
    writer_host: options.writerHost ?? hostname(),
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    recipient: input.recipient,
    recipient_label: input.recipientLabel,
    body: input.body,
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

export interface ValidateICloudDriveDraftPayloadResult {
  ok: boolean;
  errors: string[];
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export function validateICloudDriveDraftPayload(
  payload: unknown,
  options: { now: Date },
): ValidateICloudDriveDraftPayloadResult {
  const errors: string[] = [];
  if (!payload || typeof payload !== "object") {
    return { ok: false, errors: ["draft payload is not an object"] };
  }
  const p = payload as Partial<ICloudDriveDraftPayload> & Record<string, unknown>;

  if (p.schema_version !== ICLOUD_DRIVE_DRAFT_SCHEMA_VERSION) {
    errors.push(
      `unsupported schema_version: expected ${ICLOUD_DRIVE_DRAFT_SCHEMA_VERSION}, got ${String(p.schema_version)}`,
    );
  }
  for (const field of ["draft_id", "writer_host", "recipient", "recipient_label", "body"] as const) {
    if (typeof p[field] !== "string" || !(p[field] as string).length) {
      errors.push(`missing or empty ${field}`);
    }
  }
  if (!isIsoTimestamp(p.created_at)) errors.push("created_at is not an ISO timestamp");
  if (!isIsoTimestamp(p.expires_at)) errors.push("expires_at is not an ISO timestamp");

  const bodySha = typeof p.body_sha256 === "string" ? p.body_sha256 : "";
  if (!/^[a-f0-9]{64}$/.test(bodySha)) {
    errors.push("body_sha256 is not a 64-char lowercase hex string");
  } else if (typeof p.body === "string") {
    const recomputed = createHash("sha256").update(p.body, "utf8").digest("hex");
    if (recomputed !== bodySha) {
      errors.push("body_sha256 does not match sha256(body)");
    }
  }

  if (isIsoTimestamp(p.expires_at) && Date.parse(p.expires_at) <= options.now.getTime()) {
    errors.push(`draft expired at ${p.expires_at}`);
  }

  return { ok: errors.length === 0, errors };
}
