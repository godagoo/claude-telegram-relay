// Startup-time best-effort rotator for the relay's launchd stderr log.
// launchd owns the StandardErrorPath file descriptor with O_APPEND
// semantics, so the only safe primitive here is copy-and-truncate:
// rename(path, archive) would leave launchd writing to the moved inode,
// and re-opening the path would orphan the existing fd. truncate(path,
// 0) keeps the launchd fd valid; O_APPEND drives the next write back to
// byte 0 of the now-empty file.
//
// Contract: this is observability hygiene, not a lossless archive
// system. There is a small race window between copyFile(path, archive)
// and truncate(path, 0) where a line appended by the running relay may
// be absent from both the archive and the active log. The rotator runs
// once at startup before the bot begins polling, so the race is rare in
// practice, but callers must not assume zero loss under concurrent
// append.

import { stat, copyFile, truncate } from "fs/promises";
import { basename, dirname, join } from "path";

export type LogRotationResult =
  | { rotated: false; reason: "missing"; path: string }
  | { rotated: false; reason: "below_threshold"; path: string; sizeBytes: number }
  | { rotated: true; path: string; archivePath: string; sizeBytes: number };

function formatArchiveTimestamp(now: Date): string {
  // 2026-05-19T09:16:31.000Z -> 20260519T091631Z
  return now.toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
}

function buildArchivePath(path: string, now: Date, pid: number): string {
  return join(
    dirname(path),
    `${basename(path)}.${formatArchiveTimestamp(now)}.${pid}.old`,
  );
}

export async function rotateLogIfTooLarge(input: {
  path: string;
  maxBytes: number;
  now?: Date;
  pid?: number;
}): Promise<LogRotationResult> {
  const path = input.path;
  let sizeBytes: number;
  try {
    const st = await stat(path);
    sizeBytes = st.size;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return { rotated: false, reason: "missing", path };
    }
    throw err;
  }

  if (sizeBytes <= input.maxBytes) {
    return { rotated: false, reason: "below_threshold", path, sizeBytes };
  }

  const now = input.now ?? new Date();
  const pid = input.pid ?? process.pid;
  const archivePath = buildArchivePath(path, now, pid);

  await copyFile(path, archivePath);
  await truncate(path, 0);

  return { rotated: true, path, archivePath, sizeBytes };
}
