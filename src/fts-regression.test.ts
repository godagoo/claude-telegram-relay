// Regression tests for the FTS retrieval safeguards. These are kept in their
// own file so the rationale stays close to the tests and so future changes to
// retrieval.ts can run this file alone.
//
// PLAN2 — Phase E:
//   - broad OR avoidance
//   - Worker timeout terminates cleanly
//   - zero-hit poison query bounded
//   - verify treats zero hits as warning, not fatal

import { describe, expect, test } from "bun:test";
import { buildSearchQuery, countContentTokens } from "./query-builder.ts";
import {
  __test__prepareFtsQuery,
  __test__withTimeout,
} from "./retrieval.ts";
import { scanRelayLogForRecentFailures } from "../setup/verify-checks.ts";

describe("broad OR avoidance", () => {
  test("buildSearchQuery never emits the FTS5 OR operator on multi-clause input", () => {
    const broad = "rocuronium dosing onset adult pediatric RSI intubation paralysis";
    const expr = buildSearchQuery(broad, []);
    expect(expr.length).toBeGreaterThan(0);
    expect(expr).not.toMatch(/\bOR\b/);
    expect(expr).not.toMatch(/\bAND\b/);
    expect(expr).not.toMatch(/\bNEAR\b/);
  });

  test("prepareFtsQuery's match string is a space-joined AND list", () => {
    const result = __test__prepareFtsQuery("rocuronium dosing");
    expect(result.match).not.toMatch(/\bOR\b/);
    if (result.match) {
      expect(result.match.split(/\s+/).length).toBeLessThanOrEqual(8);
    }
  });

  test("the poison Telegram message does not produce an OR fanout", () => {
    const poison = "1 remind personal ai stack architecture note 2 hey claude 3 ask";
    const expr = buildSearchQuery(poison, []);
    expect(expr).not.toMatch(/\bOR\b/);
    // Pure-digit tokens must not survive into the FTS expression.
    expect(expr).not.toMatch(/\b[123]\b/);
  });
});

describe("zero-hit poison query is bounded", () => {
  test("countContentTokens drops control words and digits before FTS sees them", () => {
    const poison = "1 remind personal ai stack architecture note 2 hey claude 3 ask";
    const count = countContentTokens(poison);
    // Bounded, not unbounded: this used to grow a 12-token OR fanout that
    // stalled sqlite3_step.
    expect(count).toBeLessThanOrEqual(8);
  });

  test("empty input yields empty expression, no SQL ever issued", () => {
    expect(buildSearchQuery("", [])).toBe("");
  });

  test("a single-token current message returns empty (skip retrieval)", () => {
    expect(buildSearchQuery("rocuronium", [])).toBe("");
  });
});

describe("Worker timeout policy", () => {
  test("withTimeout rejects when the wrapped promise never resolves", async () => {
    const hangs = new Promise<number>(() => {
      /* never resolves */
    });
    await expect(__test__withTimeout(hangs, 25, "fts_timeout_25ms")).rejects.toThrow(
      /fts_timeout_25ms/,
    );
  });

  test("withTimeout resolves with the wrapped value when it beats the deadline", async () => {
    const fast = Promise.resolve("ok");
    await expect(__test__withTimeout(fast, 100, "fts_timeout_100ms")).resolves.toBe("ok");
  });

  test("withTimeout clears its timer on success (no late-firing rejection)", async () => {
    const fast = Promise.resolve(42);
    const value = await __test__withTimeout(fast, 50, "fts_timeout_50ms");
    expect(value).toBe(42);
    // If the timer were leaking we would see an unhandled rejection here.
    await new Promise((r) => setTimeout(r, 75));
  });
});

describe("verify treats zero hits as warning, not fatal", () => {
  test("scanRelayLogForRecentFailures does not classify FTS-related zero-hit lines as failures", () => {
    const log = [
      "[preflight] FTS sanity: textbook catalog probe returns hits",
      "[retrieval] zero hits for query: rocuronium dosing onset",
      "[bot] Telegram getUpdates 401 unauthorized",
    ].join("\n");
    const scan = scanRelayLogForRecentFailures(log, { lineLimit: 100 });
    const kinds = scan.hits.map((h) => h.kind);
    expect(kinds).toContain("telegram_401");
    expect(kinds).not.toContain("telegram_409");
    expect(kinds).not.toContain("spawn_nul_crash");
  });
});
