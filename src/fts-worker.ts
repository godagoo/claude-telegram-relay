// fts-worker.ts
// One-shot FTS query worker. The parent terminates this worker on timeout,
// which is the cancellation primitive missing from synchronous bun:sqlite.

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_PATH = process.env.INDEXER_DB
  ?? join(homedir(), ".local-search", "metadata.db");

// Use the same rw + query_only compromise as the main preflight connection.
// On this host, bun:sqlite readonly mode can fail to recreate WAL -shm state.
const db = new Database(DB_PATH, { readwrite: true, create: false });

try {
  db.exec("PRAGMA query_only = ON;");
  db.exec("PRAGMA busy_timeout = 2000;");
} catch (err) {
  console.error("[fts-worker] PRAGMA setup failed:", (err as Error).message);
}

type QueryMsg = { sql: string; params: unknown[] };
type QueryResult = { rows: unknown[]; ms: number } | { error: string };

self.onmessage = (event: MessageEvent<QueryMsg>) => {
  const { sql, params } = event.data;
  try {
    const t0 = performance.now();
    const stmt = db.query(sql);
    const rows = stmt.all(...(params as any[]));
    const ms = performance.now() - t0;
    self.postMessage({ rows, ms } as QueryResult);
  } catch (err) {
    self.postMessage({ error: (err as Error).message } as QueryResult);
  }
};
