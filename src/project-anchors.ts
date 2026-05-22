// project-anchors.ts
// Deterministic per-project context injection. Config in
// config/project-anchors.json maps a project (e.g. Medicolegal-Case) to a
// list of anchor terms and a set of indexer path prefixes. When the user's
// message contains any anchor (word-boundary, case-insensitive), the relay
// runs a tiny FTS5 query scoped to those paths and injects the top hits
// into the prompt. No embeddings, no LLM-in-the-loop, no surprises.
//
// Triggered for the 2026-05-11 lawyers/speech turn where FTS didn't surface
// the Medicolegal-Case notes because the user's message had no shared tokens
// with the chunks but DID mention Saint Amman / Rob Roy / MIET / lawyers.
//
// PLAN.md section 5: this module dispatches FTS queries to fts-worker.ts via
// runFtsInWorker so no FTS MATCH call ever runs on the main thread. That keeps
// the relay event loop responsive even if a future anchor set produces a slow
// scan; the worker times out and terminates cleanly.

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { runFtsInWorker } from "./retrieval";

// CONFIG_PATH / DB_PATH are resolved lazily so tests can set
// PROJECT_ANCHORS_CONFIG after importing this module without racing the
// top-level binding. Production reads them once at first call and caches.
function configPath(): string {
  return process.env.PROJECT_ANCHORS_CONFIG
    ?? join(homedir(), "Projects", "claude-telegram-relay", "config", "project-anchors.json");
}

const ANCHOR_TIMEOUT_MS = Number(process.env.PROJECT_ANCHOR_TIMEOUT_MS ?? "3000");
const ANCHOR_PER_QUERY_TIMEOUT_MS = Number(
  process.env.PROJECT_ANCHOR_QUERY_TIMEOUT_MS ?? "1500",
);
const HITS_PER_PROJECT = 4;
const MAX_CHARS_PER_HIT = 600;

export interface ProjectAnchor {
  name: string;
  paths: string[];
  anchors: string[];
  context_label: string;
}

export interface AnchorHit {
  project: ProjectAnchor;
  matchedAnchors: string[];
  chunks: Array<{
    path: string;
    chunkIndex: number;
    content: string;
  }>;
}

let _config: ProjectAnchor[] | null = null;
let _configLoadError: string | null = null;
let _matchers: Map<string, RegExp[]> | null = null;

async function loadConfig(): Promise<ProjectAnchor[]> {
  if (_config !== null) return _config;
  if (_configLoadError) return [];
  try {
    const text = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(text);
    const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];
    _config = projects.filter(
      (p: unknown): p is ProjectAnchor =>
        typeof p === "object"
        && p !== null
        && typeof (p as ProjectAnchor).name === "string"
        && Array.isArray((p as ProjectAnchor).paths)
        && Array.isArray((p as ProjectAnchor).anchors),
    );
    _matchers = new Map(
      _config.map((p) => [p.name, p.anchors.map((a) => anchorToRegex(a))]),
    );
    console.log(
      `[project-anchors] loaded ${_config.length} project(s): ${_config.map((p) => p.name).join(", ")}`,
    );
    return _config;
  } catch (err) {
    _configLoadError = err instanceof Error ? err.message : String(err);
    console.error(`[project-anchors] config load failed: ${_configLoadError}`);
    _config = [];
    return [];
  }
}

/**
 * Escape an anchor for use as a word-boundary regex. Phrases with spaces
 * still get \b around the whole phrase. Periods in "St. Amman" are escaped
 * so they match literally rather than "any char".
 */
function anchorToRegex(anchor: string): RegExp {
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

export interface AnchorMatch {
  project: ProjectAnchor;
  matchedAnchors: string[];
}

export async function findAnchoredProjects(text: string): Promise<AnchorMatch[]> {
  const projects = await loadConfig();
  if (projects.length === 0 || !text) return [];
  const out: AnchorMatch[] = [];
  for (const project of projects) {
    const regexes = _matchers?.get(project.name) ?? [];
    const matched: string[] = [];
    for (let i = 0; i < regexes.length; i++) {
      if (regexes[i].test(text)) matched.push(project.anchors[i]);
    }
    if (matched.length > 0) out.push({ project, matchedAnchors: matched });
  }
  return out;
}

/**
 * Run a project-scoped FTS retrieval for each matched project. The FTS
 * query is built from the matched anchors only (proper-noun heavy, so they
 * pick out the relevant chunks fast). Results are pulled from the same
 * indexer DB the main retrieval path uses, scoped via `files.path LIKE`.
 */
export type FtsWorkerRunner = (
  sql: string,
  params: unknown[],
  timeoutMs: number,
) => Promise<{ rows: unknown[]; ms: number }>;

export interface RetrieveAnchoredContextOptions {
  runFts?: FtsWorkerRunner;
  now?: () => number;
  totalTimeoutMs?: number;
  perQueryTimeoutMs?: number;
}

export async function retrieveAnchoredContext(
  matches: AnchorMatch[],
  options: RetrieveAnchoredContextOptions = {},
): Promise<AnchorHit[]> {
  if (matches.length === 0) return [];

  const runFts: FtsWorkerRunner = options.runFts ?? ((sql, params, timeoutMs) =>
    runFtsInWorker(sql, params, timeoutMs));
  const now = options.now ?? (() => Date.now());
  const totalTimeoutMs = options.totalTimeoutMs ?? ANCHOR_TIMEOUT_MS;
  const perQueryTimeoutMs = options.perQueryTimeoutMs ?? ANCHOR_PER_QUERY_TIMEOUT_MS;

  const hits: AnchorHit[] = [];
  const deadline = now() + totalTimeoutMs;

  for (const m of matches) {
    const remainingBudget = deadline - now();
    if (remainingBudget <= 0) {
      console.error(`[project-anchors] retrieval deadline reached; skipping ${m.project.name}`);
      break;
    }

    // Build an OR-ed phrase query from the matched anchors. Quoted to
    // keep multi-word phrases together. FTS5 will return the best
    // matching chunks anywhere in the corpus; the path filter below
    // scopes it to this project's directories.
    const ftsQuery = m.matchedAnchors
      .map((a) => `"${a.replace(/"/g, '""')}"`)
      .join(" OR ");

    const pathClauses = m.project.paths
      .map((_, i) => `f.path LIKE ?${i + 2}`)
      .join(" OR ");

    const sql = `
      SELECT f.path AS path, c.chunk_index AS chunk_index,
             substr(c.text, 1, ${MAX_CHARS_PER_HIT}) AS content,
             bm25(chunks_fts) AS rank
      FROM chunks_fts
      JOIN chunks c ON c.rowid = chunks_fts.rowid
      JOIN files f ON f.id = c.file_id
      WHERE chunks_fts MATCH ?1
        AND (${pathClauses})
      ORDER BY rank
      LIMIT ${HITS_PER_PROJECT}
    `;

    const queryTimeoutMs = Math.min(perQueryTimeoutMs, remainingBudget);
    const params: (string | number)[] = [ftsQuery, ...m.project.paths];

    try {
      const { rows } = await runFts(sql, params, queryTimeoutMs);
      const typed = rows as Array<{
        path: string;
        chunk_index: number;
        content: string;
        rank: number;
      }>;
      if (typed.length > 0) {
        hits.push({
          project: m.project,
          matchedAnchors: m.matchedAnchors,
          chunks: typed.map((r) => ({
            path: r.path,
            chunkIndex: r.chunk_index,
            content: r.content,
          })),
        });
      }
      console.log(
        `[project-anchors] ${m.project.name}: matched=${m.matchedAnchors.length} hits=${typed.length}`,
      );
    } catch (err) {
      console.error(
        `[project-anchors] FTS query for ${m.project.name} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return hits;
}

export function renderAnchoredContext(hits: AnchorHit[]): string {
  if (hits.length === 0) return "";
  const blocks: string[] = [];
  for (const h of hits) {
    const lines = h.chunks.map((c, i) => {
      const snippet = c.content.replace(/\s+/g, " ").trim();
      return `  [${i + 1}] ${c.path} (chunk ${c.chunkIndex})\n  ${snippet}`;
    });
    blocks.push(
      `${h.project.context_label}\nAnchors matched: ${h.matchedAnchors.join(", ")}\n${lines.join("\n")}`,
    );
  }
  return blocks.join("\n\n");
}

// Test-only reset to clear the cached config between unit tests.
export function __resetProjectAnchorsCacheForTests(): void {
  _config = null;
  _matchers = null;
  _configLoadError = null;
}
