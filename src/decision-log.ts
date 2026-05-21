// decision-log.ts
// Append-only JSONL log of inbound Telegram decisions plus update markers used
// to avoid Telegram redelivery loops after crashes.

import { appendFile, chmod, mkdir, readdir, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const RELAY_DIR = process.env.RELAY_DIR ?? join(homedir(), ".claude-relay");
const LOG_DIR = process.env.RELAY_LOG_DIR ?? join(RELAY_DIR, "logs");
const STATE_DIR = process.env.RELAY_STATE_DIR ?? join(RELAY_DIR, "state");
const MARKERS_DIR = join(STATE_DIR, "updates");
const RETAIN_DECISIONS_DAYS = Number(process.env.RETAIN_DECISIONS_DAYS ?? "30");

type UpdateMarker =
  | { status: "started"; ts: string }
  | { status: "sent"; ts: string };

export interface DecisionRecord {
  ts: string;
  chat_id: number | string;
  message: string;
  trigger_fired: boolean;
  hit_count: number;
  hits_summary: { path: string; sim: number }[];
  injected_count: number;
  claude_ms?: number;
  total_ms: number;
  error?: string;

  update_id?: number;
  query_content_tokens?: number;
  fts_query?: string;
  retrieval_ms?: number;
  top_rank_score?: number;
  second_rank_score?: number;
  prompt_chars?: number;
  turn_buffer_size_before?: number;
  timeout_kind?: "fts" | "claude";
  imessage_context_status?: "found" | "empty" | "fda_denied" | "error" | "timeout";
  imessage_context_count?: number;
  imessage_context_contact?: string;
  imessage_draft_status?:
    | "placed"
    | "staging_handoff_sent"
    | "phone_handoff_ready"
    | "phone_shortcut_install_pending"
    | "markers_missing"
    | "empty_body"
    | "no_recipient"
    | "helper_failed"
    | "no_intent";
  imessage_draft_mode?:
    | "pasted"
    | "clipboard_only"
    | "new_compose"
    | "staging_imessage"
    | "icloud_drive_file"
    | "iphone_mirror_typed";
  imessage_draft_handoff_path?: string;
  imessage_draft_payload_sha256?: string;
  imessage_draft_body_sha256?: string;
  imessage_draft_shortcut_url?: string;
  /**
   * UUIDv4 from the CLDRAFT/1 envelope built by src/cldraft-payload.ts.
   * Same value flows into the iCloud fallback file so logs and Shortcut
   * state correlate across both transports.
   */
  imessage_draft_id?: string;
  /**
   * True when src/vault-writer.ts was invoked after staging success. The
   * actual write is fire-and-forget; result paths land in console output
   * keyed by draft_id and are not captured here because the write may still
   * be in flight when this record is appended.
   */
  vault_write_attempted?: boolean;
  /** Draft id correlator for joining decision logs to vault-writer logs. */
  vault_draft_id?: string;
  memory_tags_stripped?: number;
  wrapper_tags_stripped?: number;
  scaffolding_tags_stripped?: number;
  turn_markers_stripped?: number;
  prose_dashes_stripped?: number;
  response_chars?: number;
  catalog_response_used?: boolean;
  skipped_textbook_response_used?: boolean;
  // Background memory-capture fields. The classifier runs synchronously after
  // the user-facing reply is sent; the actual write is fire-and-forget so
  // memory_capture_wrote / memory_capture_path are best-effort and may be
  // absent if the write is still in flight when this record is logged.
  memory_capture_attempted?: boolean;
  memory_capture_reason?: string;
  memory_capture_confidence?: "high" | "medium" | "low";
  memory_capture_kind?: "feedback" | "project" | "user" | "reference" | "bug";
  memory_capture_destination?: "project-memory" | "pending";
  memory_capture_project?: string;
}

function dateUtc(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function decisionLogPath(date: string): string {
  return join(LOG_DIR, `decisions-${date}.jsonl`);
}

function decisionDateFromName(name: string): string | null {
  const match = name.match(/^decisions-(\d{4}-\d{2}-\d{2})\.jsonl$/);
  return match?.[1] ?? null;
}

async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

export async function loadSeenUpdateIds(): Promise<Set<number>> {
  await ensurePrivateDir(LOG_DIR);
  await ensurePrivateDir(STATE_DIR);
  await ensurePrivateDir(MARKERS_DIR);
  const seen = new Set<number>();

  for (const date of [dateUtc(), dateUtc(-1)]) {
    try {
      const text = await Bun.file(decisionLogPath(date)).text();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as DecisionRecord;
          if (typeof rec.update_id === "number") seen.add(rec.update_id);
        } catch {
          // Ignore malformed historical lines.
        }
      }
    } catch {
      // The log may not exist yet.
    }
  }

  try {
    for (const entry of await readdir(MARKERS_DIR)) {
      const match = entry.match(/^(\d+)\.started$/);
      if (!match) continue;

      const markerPath = join(MARKERS_DIR, entry);
      let marker: UpdateMarker | null = null;
      try {
        const text = await Bun.file(markerPath).text();
        marker = JSON.parse(text) as UpdateMarker;
      } catch {
        marker = null;
      }

      // A `sent` marker means Telegram already accepted the user-visible reply
      // but the process died before the final decision JSONL was appended.
      // Treat it as seen to avoid a duplicate reply. A `started` marker is only
      // in-flight work; retry it after a crash instead of silently dropping it.
      if (marker?.status === "sent") {
        seen.add(Number(match[1]));
      }
    }
  } catch {
    // First run.
  }

  return seen;
}

export async function markUpdateStarted(updateId: number): Promise<void> {
  await ensurePrivateDir(MARKERS_DIR);
  const file = join(MARKERS_DIR, `${updateId}.started`);
  await writeFile(
    file,
    JSON.stringify({ status: "started", ts: new Date().toISOString() }),
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(file, 0o600).catch(() => undefined);
}

export async function markUpdateSent(updateId: number): Promise<void> {
  await ensurePrivateDir(MARKERS_DIR);
  const file = join(MARKERS_DIR, `${updateId}.started`);
  await writeFile(
    file,
    JSON.stringify({ status: "sent", ts: new Date().toISOString() }),
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(file, 0o600).catch(() => undefined);
}

export async function clearUpdateMarker(updateId: number): Promise<void> {
  try {
    await unlink(join(MARKERS_DIR, `${updateId}.started`));
  } catch {
    // Already gone.
  }
}

export async function logDecision(rec: DecisionRecord): Promise<void> {
  const file = decisionLogPath(rec.ts.slice(0, 10));
  await ensurePrivateDir(LOG_DIR);
  await appendFile(file, JSON.stringify(rec) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(file, 0o600).catch(() => undefined);
}

export async function sweepOldDecisionLogs(
  retainDays = RETAIN_DECISIONS_DAYS,
): Promise<number> {
  if (!Number.isFinite(retainDays) || retainDays <= 0) return 0;
  await ensurePrivateDir(LOG_DIR);

  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - Math.floor(retainDays));

  let removed = 0;
  for (const entry of await readdir(LOG_DIR)) {
    const date = decisionDateFromName(entry);
    if (!date) continue;
    const entryDate = new Date(`${date}T00:00:00.000Z`);
    if (entryDate >= cutoff) continue;
    await unlink(join(LOG_DIR, entry)).catch(() => undefined);
    removed++;
  }
  return removed;
}
