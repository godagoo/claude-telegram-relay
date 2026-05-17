// retrieval.ts
// FTS5 lexical search over claude-indexer's metadata.db.
// The relay keeps a query_only preflight connection for invariants and runs
// potentially expensive FTS queries inside a Worker so they can be terminated.

import { Database } from "bun:sqlite";
import { accessSync, constants } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { isAnesthesiaCorpusQuery } from "./anesthesia-corpus";
import { BOOKS, BOOK_KEY_SET, CATALOG_BOOK_LIST } from "./books";

const DB_PATH = process.env.INDEXER_DB
  ?? join(homedir(), ".local-search", "metadata.db");

const SCOPE_PATTERNS = [
  join(homedir(), "ObsidianVault") + "/%",
  join(homedir(), ".claude/projects") + "/%/memory/%",
  join(homedir(), ".claude/memory") + "/%",
  join(homedir(), "Desktop", "Exam_Prep", "Textbooks") + "/%",
];

const PATH_FALLBACK_ROOTS = [
  join(homedir(), "Desktop", "Exam_Prep", "Textbooks"),
];

const FTS_TIMEOUT_MS = Number(process.env.FTS_TIMEOUT_MS ?? "8000");
const FTS_PREFLIGHT_TIMEOUT_MS = Number(process.env.FTS_PREFLIGHT_TIMEOUT_MS ?? "250");
const PATH_FALLBACK_CANDIDATE_LIMIT = 200;
const TEXTBOOK_MARKDOWN_ROOTS = [
  join(homedir(), "Desktop", "Exam_Prep", "Textbooks", "anes-textbooks-markdown") + "/",
  join(homedir(), "Downloads", "anes-textbooks-markdown") + "/",
];
const TEXTBOOK_CATALOG_PATH = TEXTBOOK_MARKDOWN_ROOTS[0] + "_catalog";

let _db: Database | null = null;
let ftsPreflight: Promise<void> | null = null;

function getDb(): Database {
  if (!_db) {
    // NOT readonly: bun:sqlite read-only mode cannot coordinate with the
    // watcher's WAL-mode connection when ~/.local-search/metadata.db-shm gets
    // checkpointed away. Open read-write to allow -shm regeneration, then force
    // query_only and verify writes fail.
    _db = new Database(DB_PATH, { readwrite: true, create: false });

    try {
      _db.exec("PRAGMA query_only = ON;");
    } catch (err) {
      console.error("[retrieval] PRAGMA query_only=ON failed:", err);
    }

    try {
      const result = _db
        .query("PRAGMA query_only")
        .get() as { query_only: number } | null;
      if (result?.query_only !== 1) {
        console.error(
          "[retrieval] WARNING: PRAGMA query_only did not engage; got:",
          result,
        );
      }
    } catch (err) {
      console.error("[retrieval] PRAGMA query_only readback failed:", err);
    }

    let probeOutcome:
      | "success-fatal"
      | "expected-readonly"
      | "other-error"
      | "skipped" = "other-error";
    let savepointActive = false;

    try {
      _db.exec("SAVEPOINT readonly_probe");
      savepointActive = true;
    } catch (err) {
      console.error(
        "[retrieval] readonly probe SAVEPOINT setup failed; skipping probe:",
        err,
      );
      probeOutcome = "skipped";
    }

    if (savepointActive) {
      try {
        _db.exec("CREATE TABLE __readonly_probe__ (x INTEGER)");
        probeOutcome = "success-fatal";
      } catch (err) {
        const msg = String((err as Error).message).toLowerCase();
        if (msg.includes("readonly")) {
          probeOutcome = "expected-readonly";
        } else {
          console.error("[retrieval] readonly probe non-readonly error:", err);
        }
      }

      try {
        _db.exec("ROLLBACK TO readonly_probe");
        _db.exec("RELEASE readonly_probe");
      } catch {
        // Best-effort cleanup; fatal handling below preserves the invariant.
      }
    }

    if (probeOutcome === "expected-readonly") {
      console.log("[retrieval] readonly invariant verified");
    } else {
      const fatal = new Error(
        `readonly invariant not verified (outcome=${probeOutcome})`,
      );
      console.error("[retrieval] FATAL:", fatal.message);
      throw fatal;
    }

    try {
      const ver = _db
        .query("SELECT sqlite_version() AS v")
        .get() as { v: string };
      console.log("[retrieval] sqlite_version:", ver.v);
    } catch (err) {
      console.error("[retrieval] sqlite_version probe failed:", err);
    }

    try {
      accessSync(dirname(DB_PATH), constants.W_OK);
    } catch {
      console.error(
        "[retrieval] WARNING: indexer DB directory is not writable; -shm rotation will fail",
      );
    }
  }
  return _db;
}

export async function preflight(): Promise<void> {
  const db = getDb();
  const ver = db
    .query("SELECT sqlite_version() AS v")
    .get() as { v: string };
  console.log("[preflight] sqlite:", ver.v);

  await preflightFtsWorker();

  const hits = await search('"anesthesia" "textbook"', 1);
  if (hits.length === 0) {
    throw new Error("preflight: FTS returned 0 hits for anesthesia textbook catalog probe");
  }
  console.log("[preflight] FTS sanity: textbook catalog probe returns hits");
}

export interface Hit {
  chunk_id: number;
  file_path: string;
  content: string;
  chunk_index: number;
  rank_score: number;       // FTS5 rank, lower is better
  display_score: number;    // Higher is better, for logs/UI only
  score: number;            // Backward-compatible alias for display_score
}

interface RetrievedRow {
  id: number;
  text: string;
  path: string;
  chunk_index: number;
  rank_score: number;
}

const SCOPE_CLAUSE =
  "(" + SCOPE_PATTERNS.map(() => "f.path LIKE ?").join(" OR ") + ")";

const DENY_CLAUSE = [
  "f.path NOT LIKE ?",
  "f.path NOT LIKE ?",
  "f.path NOT LIKE ?",
  "f.path NOT LIKE ?",
  "f.path NOT LIKE ?",
  "f.path NOT LIKE ?",
].join(" AND ");

const DENY_PATTERNS = [
  join(homedir(), "ObsidianVault", "models") + "/%",
  "%.bin",
  "%/tokenizer.json",
  "%/tokenizer_config.json",
  "%/special_tokens_map.json",
  "%/.DS_Store",
];

const SEARCH_SQL = `
SELECT c.id AS id,
       c.text AS text,
       f.path AS path,
       c.chunk_index AS chunk_index,
       rank AS rank_score
  FROM chunks_fts
  JOIN chunks c ON c.id = chunks_fts.rowid
  JOIN files f ON f.id = c.file_id
 WHERE chunks_fts MATCH ?
   AND ${SCOPE_CLAUSE}
   AND ${DENY_CLAUSE}
 ORDER BY rank
 LIMIT ?
`;

const BOOK_PATH_FILTERS: Record<string, string[]> = Object.fromEntries(
  BOOKS.map((book) => [
    book.key,
    TEXTBOOK_MARKDOWN_ROOTS.map((root) => join(root, book.pathSegment) + "/%"),
  ]),
);

const FTS_BOOK_FILTER_TOKENS = BOOK_KEY_SET;

const PATH_ANCHOR_STOPWORDS = new Set([
  "textbook",
  "textbooks",
  "book",
  "books",
]);

const PATH_FALLBACK_TRIGGERS = new Set([
  "anesthesia",
  ...BOOK_KEY_SET,
]);

function pathTokensFromQuery(query: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  let shouldSearchPaths = false;
  for (const token of query.toLowerCase().split(/\s+/)) {
    const cleaned = token.replace(/[^a-z0-9]/g, "");
    if (cleaned.length < 4) continue;
    if (PATH_FALLBACK_TRIGGERS.has(cleaned)) shouldSearchPaths = true;
    if (PATH_ANCHOR_STOPWORDS.has(cleaned)) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    tokens.push(cleaned);
  }
  if (!shouldSearchPaths) return [];

  const namedTitles = tokens.filter((token) => BOOK_KEY_SET.has(token));
  if (namedTitles.length > 0) return namedTitles.slice(0, 2);

  return tokens.slice(0, 2);
}

function caseTolerantGlobToken(token: string): string {
  return `[${token[0].toLowerCase()}${token[0].toUpperCase()}]${token.slice(1)}`;
}

function sanitizeFtsQuery(query: string): string {
  // buildSearchQuery already strips non-alphanumerics from tokens and wraps each
  // in literal quotes, so the wrapping `"` chars are the only quotes the
  // sanitizer can ever see. Stripping them yields whitespace-separated tokens
  // which FTS5 treats as implicit AND — same semantics as quoted phrases of
  // single tokens. Plan §3c requires `"` in the escape set as belt-and-braces.
  return query.replace(/[+~"*()^:\-]/g, " ").replace(/\s+/g, " ").trim();
}

function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
}

function prepareFtsQuery(query: string): {
  match: string;
  scopePatterns: string[];
  contentTokens: string[];
  bookScoped: boolean;
  corpusScoped: boolean;
} {
  const tokens = queryTokens(query);
  const bookScopes = [...new Set(
    tokens
      .filter((token) => FTS_BOOK_FILTER_TOKENS.has(token))
      .flatMap((token) => BOOK_PATH_FILTERS[token] ?? []),
  )];
  const contentTokens = tokens.filter((token) => !FTS_BOOK_FILTER_TOKENS.has(token));
  const corpusScoped = bookScopes.length === 0 && isAnesthesiaCorpusQuery(query);
  const scopePatterns =
    bookScopes.length > 0
      ? bookScopes
      : isBroadTextbookQuery(query) || corpusScoped
        ? TEXTBOOK_MARKDOWN_ROOTS.map((root) => root + "%")
        : SCOPE_PATTERNS;

  return {
    match: contentTokens.length >= 2 ? contentTokens.join(" ") : "",
    scopePatterns,
    contentTokens,
    bookScoped: bookScopes.length > 0,
    corpusScoped,
  };
}

function displayScore(rankScore: number): number {
  return rankScore < 0 ? -rankScore : 1 / (1 + rankScore);
}

function toHit(row: RetrievedRow): Hit {
  const display = displayScore(Number(row.rank_score));
  return {
    chunk_id: row.id,
    file_path: row.path,
    content: row.text,
    chunk_index: row.chunk_index,
    rank_score: Number(row.rank_score),
    display_score: display,
    score: display,
  };
}

async function runFtsInWorker(
  sql: string,
  params: unknown[],
): Promise<{ rows: unknown[]; ms: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./fts-worker.ts", import.meta.url).href);

    const timer = setTimeout(() => {
      try {
        worker.terminate();
      } catch {
        // Already gone.
      }
      reject(new Error(`fts_timeout_${FTS_TIMEOUT_MS}ms`));
    }, FTS_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      const data = event.data as { rows?: unknown[]; ms?: number; error?: string };
      try {
        worker.terminate();
      } catch {
        // Ignore.
      }
      if (data.error) {
        reject(new Error(data.error));
      } else {
        resolve({ rows: data.rows ?? [], ms: data.ms ?? 0 });
      }
    };

    worker.onerror = (err: ErrorEvent) => {
      clearTimeout(timer);
      try {
        worker.terminate();
      } catch {
        // Ignore.
      }
      reject(new Error(err.message || "worker_error"));
    };

    worker.postMessage({ sql, params });
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function preflightFtsWorker(): Promise<void> {
  ftsPreflight ??= withTimeout(
    runFtsInWorker("SELECT COUNT(*) AS n FROM chunks LIMIT 1", []),
    FTS_PREFLIGHT_TIMEOUT_MS,
    `preflight: FTS worker probe exceeded ${FTS_PREFLIGHT_TIMEOUT_MS}ms`,
  ).then(({ rows, ms }) => {
    const row = rows[0] as { n?: number } | undefined;
    if (typeof row?.n !== "number") {
      throw new Error("preflight: FTS worker probe returned no count");
    }
    console.log(`[preflight] FTS worker probe: chunks=${row.n} ms=${ms}`);
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("preflight: FTS worker probe exceeded")) {
      console.error(`[preflight] ${message}; continuing with lazy per-query worker checks`);
      return;
    }
    ftsPreflight = null;
    throw err;
  });
  await ftsPreflight;
}

export async function search(query: string, k = 8): Promise<Hit[]> {
  const safe = sanitizeFtsQuery(query);
  if (!safe) return [];

  const safeK = Math.min(Math.max(1, k | 0), 50);
  if (isBroadTextbookInventoryQuery(safe)) {
    return textbookCatalogHits(safeK);
  }

  const ftsQuery = prepareFtsQuery(safe);
  let ftsHits: Hit[] = [];
  if (ftsQuery.match) {
    ftsHits = await runScopedFts(safe, ftsQuery.match, ftsQuery.scopePatterns, safeK);
    if (ftsHits.length === 0 && (ftsQuery.bookScoped || ftsQuery.corpusScoped)) {
      const relaxedQueries = ftsQuery.bookScoped
        ? relaxedBookQueries(ftsQuery.contentTokens)
        : relaxedCorpusQueries(ftsQuery.contentTokens);
      for (const relaxed of relaxedQueries) {
        ftsHits = await runScopedFts(safe, relaxed, ftsQuery.scopePatterns, safeK);
        if (ftsHits.length > 0) break;
      }
    }
  }
  let pathHits: Hit[] = [];
  try {
    const pathFallbackLimit = Math.floor(safeK / 2);
    pathHits = pathFallbackLimit > 0
      ? await searchPathAnchors(safe, pathFallbackLimit)
      : [];
  } catch (err) {
    console.error(
      "[retrieval] path fallback failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return combineHits(ftsHits, pathHits, safeK);
}

function combineHits(ftsHits: Hit[], pathHits: Hit[], k: number): Hit[] {
  const combined: Hit[] = [];
  const seen = new Set<number>();
  const pathLimit = Math.floor(Math.max(1, k | 0) / 2);
  let pathAdded = 0;

  for (const hit of ftsHits) {
    if (seen.has(hit.chunk_id)) continue;
    seen.add(hit.chunk_id);
    combined.push(hit);
    if (combined.length >= k) break;
  }

  for (const hit of pathHits) {
    if (combined.length >= k || pathAdded >= pathLimit) break;
    if (seen.has(hit.chunk_id)) continue;
    seen.add(hit.chunk_id);
    pathAdded++;
    combined.push(hit);
  }

  return combined;
}

function isBroadTextbookQuery(query: string): boolean {
  const tokens = new Set(queryTokens(query));
  return tokens.has("textbook") || tokens.has("textbooks");
}

async function runScopedFts(
  originalQuery: string,
  match: string,
  scopePatterns: string[],
  k: number,
): Promise<Hit[]> {
  const params = [match, ...scopePatterns, ...DENY_PATTERNS, k];
  const sql = SEARCH_SQL.replace(
    SCOPE_CLAUSE,
    "(" + scopePatterns.map(() => "f.path LIKE ?").join(" OR ") + ")",
  );
  const { rows } = await runFtsInWorker(sql, params);
  return rerankFtsHits(originalQuery, (rows as RetrievedRow[]).map(toHit));
}

function relaxedBookQueries(contentTokens: string[]): string[] {
  if (contentTokens.length <= 2) return [];
  const out: string[] = [];
  for (let i = contentTokens.length - 2; i >= 0; i--) {
    const pair = contentTokens.slice(i, i + 2).join(" ");
    if (!out.includes(pair)) out.push(pair);
  }
  return out;
}

function relaxedCorpusQueries(contentTokens: string[]): string[] {
  if (contentTokens.length <= 2) return [];
  const out: string[] = [];
  const anchor = contentTokens[0];
  for (const token of contentTokens.slice(1)) {
    const pair = `${anchor} ${token}`;
    if (!out.includes(pair)) out.push(pair);
  }
  for (const pair of relaxedBookQueries(contentTokens)) {
    if (!out.includes(pair)) out.push(pair);
  }
  return out.slice(0, 8);
}

function isBroadTextbookInventoryQuery(query: string): boolean {
  const tokens = queryTokens(query);
  const allowed = new Set(["anesthesia", "book", "books", "textbook", "textbooks"]);
  return (
    tokens.some((token) => token === "textbook" || token === "textbooks") &&
    tokens.every((token) => allowed.has(token))
  );
}

export const CATALOG_HIT_PATH = TEXTBOOK_CATALOG_PATH;

function textbookCatalogHits(k: number): Hit[] {
  if (k < 1) return [];

  return [{
    chunk_id: -1_000_000,
    file_path: TEXTBOOK_CATALOG_PATH,
    content: [
      "Converted anesthesia textbook corpus indexed as per-page Markdown.",
      `Available books: ${CATALOG_BOOK_LIST.join(", ")}.`,
      "For clinical retrieval, ask a book-specific or topic-specific question such as: What does Miller say about arterial line indications?",
    ].join("\n"),
    chunk_index: 0,
    rank_score: -100,
    display_score: 100,
    score: 100,
  }];
}

function isConvertedTextbookPath(path: string): boolean {
  return TEXTBOOK_MARKDOWN_ROOTS.some((root) => path.startsWith(root));
}

function textbookFrontMatterPenalty(hit: Hit): number {
  if (!isConvertedTextbookPath(hit.file_path)) return 0;

  const path = hit.file_path.toLowerCase();
  const content = hit.content.toLowerCase();
  let penalty = 0;

  if (path.endsWith("_term_index.md")) penalty += 4;
  if (
    content.includes("front matter") ||
    content.includes("contributor listing") ||
    content.includes("contributor affiliation") ||
    content.includes("chapter authors") ||
    content.includes("title page") ||
    content.includes("table of contents") ||
    content.includes("copyright")
  ) {
    penalty += 20;
  }

  return penalty;
}

function rerankFtsHits(query: string, hits: Hit[]): Hit[] {
  if (!isBroadTextbookQuery(query)) return hits;

  return hits
    .map((hit, index) => ({
      hit,
      index,
      penalty: textbookFrontMatterPenalty(hit),
    }))
    .sort((a, b) =>
      a.penalty - b.penalty ||
      a.hit.rank_score - b.hit.rank_score ||
      a.index - b.index
    )
    .map(({ hit }) => hit);
}

function buildPathAnchorSql(tokens: string[]): {
  sql: string;
  orderedParams: unknown[];
  expectedRoots: number;
} {
  // Per root: (f.path LIKE ? AND (f.path GLOB ? OR f.path GLOB ? ...))
  // The LIKE has no leading wildcard, so SQLite can use a path index to
  // scope the scan to the textbook directory before evaluating the GLOBs.
  const rootClauses: string[] = [];
  const orderedParams: unknown[] = [];

  for (const root of PATH_FALLBACK_ROOTS) {
    const rootGlobs = tokens.map(
      (token) => `${root}/*${caseTolerantGlobToken(token)}*`,
    );
    const globClause = rootGlobs.map(() => "f.path GLOB ?").join(" OR ");
    rootClauses.push(`(f.path LIKE ? AND (${globClause}))`);

    orderedParams.push(`${root}/%`);
    orderedParams.push(...rootGlobs);
  }

  const sql = `
SELECT -f.id AS id,
       'Indexed file path match. extraction_status=' || COALESCE(f.extraction_status, 'unknown') ||
       '; chunk_count=' || COALESCE(f.chunk_count, 0) AS text,
       f.path AS path,
       0 AS chunk_index,
       -1.0 AS rank_score
  FROM files f
 WHERE (${rootClauses.join(" OR ")})
   AND ${DENY_CLAUSE}
 ORDER BY f.path
 LIMIT ?
`;

  return {
    sql,
    orderedParams,
    expectedRoots: PATH_FALLBACK_ROOTS.length,
  };
}

export const __test__buildPathAnchorSql = buildPathAnchorSql;
export const __test__combineHits = combineHits;
export const __test__prepareFtsQuery = prepareFtsQuery;
export const __test__rerankFtsHits = rerankFtsHits;
export const __test__isBroadTextbookInventoryQuery = isBroadTextbookInventoryQuery;
export const __test__relaxedBookQueries = relaxedBookQueries;
export const __test__relaxedCorpusQueries = relaxedCorpusQueries;
export const __test__preflightFtsWorker = preflightFtsWorker;

async function searchPathAnchors(query: string, k: number): Promise<Hit[]> {
  const tokens = pathTokensFromQuery(query);
  if (tokens.length === 0) return [];

  const { sql, orderedParams } = buildPathAnchorSql(tokens);
  // SQL GLOB still runs against the full path for speed, so a token can match a
  // parent directory such as "Miller_Barash". Pull a bounded candidate pool and
  // enforce the title match on the basename below before returning hits.
  const candidateLimit = Math.max(k, PATH_FALLBACK_CANDIDATE_LIMIT);
  const params = [...orderedParams, ...DENY_PATTERNS, candidateLimit];
  const { rows } = await runFtsInWorker(sql, params);
  return filterPathAnchorRows(rows as RetrievedRow[], tokens, k);
}

function pathBasenameMatchesAnyToken(path: string, tokens: string[]): boolean {
  const base = basename(path).toLowerCase();
  return tokens.some((token) => base.includes(token));
}

function filterPathAnchorRows(
  rows: RetrievedRow[],
  tokens: string[],
  k: number,
): Hit[] {
  return rows
    .filter((row) => pathBasenameMatchesAnyToken(row.path, tokens))
    .slice(0, k)
    .map(toHit);
}

export const __test__filterPathAnchorRows = filterPathAnchorRows;

const MAX_HITS_INJECTED = 3;
const MAX_CHARS_PER_HIT = 900;

export function renderContext(hits: Hit[]): string {
  if (hits.length === 0) return "";
  const top = hits.slice(0, MAX_HITS_INJECTED);
  const blocks = top.map((hit, i) => {
    const content =
      hit.content.length > MAX_CHARS_PER_HIT
        ? hit.content.slice(0, MAX_CHARS_PER_HIT) + "..."
        : hit.content;
    return `[${i + 1}] ${hit.file_path} (chunk ${hit.chunk_index}, rank ${hit.rank_score.toFixed(3)}, score ${hit.display_score.toFixed(2)})\n${content}`;
  });
  return `RELEVANT INDEXED CONTENT:\n${blocks.join("\n\n")}`;
}
