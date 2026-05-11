// decision-log.ts
// Append-only JSONL log of inbound Telegram decisions plus update markers used
// to avoid Telegram redelivery loops after crashes.

import { appendFile, mkdir, readdir, unlink } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const LOG_DIR = process.env.RELAY_LOG_DIR
  ?? join(homedir(), ".claude-relay", "logs");
const STATE_DIR = join(homedir(), ".claude-relay", "state");
const MARKERS_DIR = join(STATE_DIR, "updates");

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
  memory_tags_stripped?: number;
  wrapper_tags_stripped?: number;
  prose_dashes_stripped?: number;
  response_chars?: number;
  catalog_response_used?: boolean;
  skipped_textbook_response_used?: boolean;
}

function dateUtc(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function decisionLogPath(date: string): string {
  return join(LOG_DIR, `decisions-${date}.jsonl`);
}

export async function loadSeenUpdateIds(): Promise<Set<number>> {
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(MARKERS_DIR, { recursive: true });
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
      if (match) seen.add(Number(match[1]));
    }
  } catch {
    // First run.
  }

  return seen;
}

export async function markUpdateStarted(updateId: number): Promise<void> {
  await mkdir(MARKERS_DIR, { recursive: true });
  await Bun.write(join(MARKERS_DIR, `${updateId}.started`), "");
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
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(file, JSON.stringify(rec) + "\n", "utf8");
}
