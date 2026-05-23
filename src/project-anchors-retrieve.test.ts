// Behavioral tests for retrieveAnchoredContext. The runFts dependency is
// injectable so we can assert exactly what gets dispatched to the worker:
// SQL shape, parameter order, per-call timeout, deadline budget enforcement,
// and the row-to-AnchorHit mapping.
//
// PLAN3: "Add behavioral tests for retrieveAnchoredContext: SQL shape,
// params, worker dispatch, timeout handling, and row mapping."

import { describe, expect, test } from "bun:test";
import {
  retrieveAnchoredContext,
  type AnchorMatch,
  type FtsWorkerRunner,
} from "./project-anchors.ts";

const PROJECT_A: AnchorMatch = {
  project: {
    name: "Medicolegal-Case",
    paths: ["/Users/x/Notes/Medicolegal/%", "/Users/x/Cases/%"],
    anchors: ["lawyer", "Saint Amman"],
    context_label: "MEDICOLEGAL CASE CONTEXT:",
  },
  matchedAnchors: ["lawyer", "Saint Amman"],
};

const PROJECT_B: AnchorMatch = {
  project: {
    name: "Other-Project",
    paths: ["/Users/x/Other/%"],
    anchors: ["Foo Bar"],
    context_label: "OTHER:",
  },
  matchedAnchors: ["Foo Bar"],
};

describe("retrieveAnchoredContext SQL shape and dispatch", () => {
  test("dispatches one runFts call per matched project, each with the bm25-scoped SELECT", async () => {
    const calls: { sql: string; params: unknown[]; timeoutMs: number }[] = [];
    const runFts: FtsWorkerRunner = async (sql, params, timeoutMs) => {
      calls.push({ sql, params, timeoutMs });
      return { rows: [], ms: 0 };
    };
    await retrieveAnchoredContext([PROJECT_A, PROJECT_B], { runFts });
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.sql).toContain("FROM chunks_fts");
      expect(call.sql).toContain("JOIN chunks c ON c.rowid = chunks_fts.rowid");
      expect(call.sql).toContain("JOIN files f ON f.id = c.file_id");
      expect(call.sql).toContain("WHERE chunks_fts MATCH ?1");
      expect(call.sql).toContain("bm25(chunks_fts)");
      expect(call.sql).toContain("ORDER BY rank");
      expect(call.sql).toContain("LIMIT 4");
    }
  });

  test("FTS query is an OR of quoted phrases derived from matchedAnchors", async () => {
    let captured: unknown[] | null = null;
    const runFts: FtsWorkerRunner = async (_sql, params) => {
      captured = params;
      return { rows: [], ms: 0 };
    };
    await retrieveAnchoredContext([PROJECT_A], { runFts });
    expect(captured).not.toBeNull();
    expect(captured?.[0]).toBe('"lawyer" OR "Saint Amman"');
  });

  test("params order is [ftsQuery, ...project.paths]", async () => {
    let captured: unknown[] | null = null;
    const runFts: FtsWorkerRunner = async (_sql, params) => {
      captured = params;
      return { rows: [], ms: 0 };
    };
    await retrieveAnchoredContext([PROJECT_A], { runFts });
    expect(captured).toEqual([
      '"lawyer" OR "Saint Amman"',
      "/Users/x/Notes/Medicolegal/%",
      "/Users/x/Cases/%",
    ]);
  });

  test("path clause has one f.path LIKE ?N per project path", async () => {
    let capturedSql = "";
    const runFts: FtsWorkerRunner = async (sql) => {
      capturedSql = sql;
      return { rows: [], ms: 0 };
    };
    await retrieveAnchoredContext([PROJECT_A], { runFts });
    // Two project paths → two LIKE clauses
    const likeCount = (capturedSql.match(/f\.path LIKE \?/g) ?? []).length;
    expect(likeCount).toBe(2);
  });

  test("escapes embedded quotes in anchors before joining", async () => {
    let captured: unknown[] | null = null;
    const runFts: FtsWorkerRunner = async (_sql, params) => {
      captured = params;
      return { rows: [], ms: 0 };
    };
    const tricky: AnchorMatch = {
      project: { ...PROJECT_A.project, paths: ["/p/%"] },
      matchedAnchors: ['He said "hi"'],
    };
    await retrieveAnchoredContext([tricky], { runFts });
    expect(captured?.[0]).toBe('"He said ""hi"""');
  });
});

describe("retrieveAnchoredContext timeout handling", () => {
  test("passes the smaller of perQueryTimeoutMs and remaining budget", async () => {
    const calls: number[] = [];
    const runFts: FtsWorkerRunner = async (_sql, _params, timeoutMs) => {
      calls.push(timeoutMs);
      return { rows: [], ms: 0 };
    };
    await retrieveAnchoredContext([PROJECT_A], {
      runFts,
      perQueryTimeoutMs: 500,
      totalTimeoutMs: 10_000,
    });
    expect(calls[0]).toBe(500);
  });

  test("clamps to remaining budget when budget is tighter than per-query timeout", async () => {
    let elapsed = 0;
    const now = () => elapsed;
    const calls: number[] = [];
    const runFts: FtsWorkerRunner = async (_sql, _params, timeoutMs) => {
      calls.push(timeoutMs);
      elapsed += 100; // simulate 100ms per call
      return { rows: [], ms: 100 };
    };
    await retrieveAnchoredContext([PROJECT_A, PROJECT_B], {
      runFts,
      now,
      perQueryTimeoutMs: 1_000,
      totalTimeoutMs: 250,
    });
    expect(calls[0]).toBe(250);
    expect(calls[1]).toBe(150);
  });

  test("stops dispatching when the deadline is exhausted", async () => {
    let elapsed = 0;
    const now = () => elapsed;
    const runFts: FtsWorkerRunner = async () => {
      elapsed += 1_000;
      return { rows: [], ms: 1_000 };
    };
    let calls = 0;
    const wrapped: FtsWorkerRunner = async (...args) => {
      calls += 1;
      return runFts(...args);
    };
    await retrieveAnchoredContext([PROJECT_A, PROJECT_B], {
      runFts: wrapped,
      now,
      totalTimeoutMs: 500,
    });
    expect(calls).toBe(1);
  });
});

describe("retrieveAnchoredContext row mapping", () => {
  test("maps {path, chunk_index, content} into AnchorHit.chunks; preserves project + anchors", async () => {
    const runFts: FtsWorkerRunner = async () => ({
      rows: [
        { path: "/Users/x/Notes/Medicolegal/case1.md", chunk_index: 7, content: "First snippet", rank: -10 },
        { path: "/Users/x/Cases/case2.md", chunk_index: 2, content: "Second snippet", rank: -9 },
      ],
      ms: 12,
    });
    const result = await retrieveAnchoredContext([PROJECT_A], { runFts });
    expect(result).toEqual([
      {
        project: PROJECT_A.project,
        matchedAnchors: PROJECT_A.matchedAnchors,
        chunks: [
          { path: "/Users/x/Notes/Medicolegal/case1.md", chunkIndex: 7, content: "First snippet" },
          { path: "/Users/x/Cases/case2.md", chunkIndex: 2, content: "Second snippet" },
        ],
      },
    ]);
  });

  test("zero-hit project is dropped from the result list, not emitted with empty chunks", async () => {
    const runFts: FtsWorkerRunner = async () => ({ rows: [], ms: 0 });
    const result = await retrieveAnchoredContext([PROJECT_A], { runFts });
    expect(result).toEqual([]);
  });

  test("worker error on one project does not abort retrieval for the next", async () => {
    let call = 0;
    const runFts: FtsWorkerRunner = async () => {
      call += 1;
      if (call === 1) throw new Error("fts_timeout_simulated");
      return {
        rows: [{ path: "/Users/x/Other/notes.md", chunk_index: 0, content: "B body", rank: -5 }],
        ms: 5,
      };
    };
    const result = await retrieveAnchoredContext([PROJECT_A, PROJECT_B], { runFts });
    expect(result).toHaveLength(1);
    expect(result[0].project.name).toBe("Other-Project");
  });
});
