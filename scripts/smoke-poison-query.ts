// Regression for the multi-part Telegram message that previously created a
// broad OR FTS5 query and stalled sqlite3_step. The fixed query builder must
// produce a bounded AND expression and the worker-backed search must finish.

import { buildSearchQuery, countContentTokens } from "../src/query-builder";
import { search } from "../src/retrieval";

const POISON = "1 remind personal ai stack architecture note 2 hey claude 3 ask";
const MAX_WALL_MS = 8_500;

async function main(): Promise<void> {
  const t0 = performance.now();
  const expr = buildSearchQuery(POISON, []);
  const tokens = countContentTokens(POISON);

  console.log(`tokens after filter: ${tokens}`);
  console.log(`fts_query: ${expr || "(empty)"}`);

  if (/\bOR\b/.test(expr)) {
    console.error("FAIL: poison query still contains OR fanout");
    process.exit(1);
  }
  if (/\b[123]\b/.test(expr)) {
    console.error("FAIL: poison query still contains pure-digit tokens");
    process.exit(2);
  }
  if (!expr) {
    console.log("PASS: filter dropped all tokens; would skip retrieval");
    return;
  }

  let rows: Awaited<ReturnType<typeof search>> = [];
  let timedOut = false;
  try {
    rows = await search(expr, 5);
  } catch (err) {
    if ((err as Error).message.startsWith("fts_timeout_")) {
      timedOut = true;
    } else {
      throw err;
    }
  }

  const elapsed = performance.now() - t0;
  console.log(`elapsed: ${elapsed.toFixed(0)}ms  rows: ${rows.length}  timed_out: ${timedOut}`);

  if (timedOut) {
    console.error("FAIL: worker timeout fired");
    process.exit(3);
  }
  if (elapsed > MAX_WALL_MS) {
    console.error(`FAIL: smoke exceeded ${MAX_WALL_MS}ms wall clock`);
    process.exit(4);
  }

  console.log("PASS: poison query handled within bound");
}

main().catch((err) => {
  console.error("smoke threw:", err);
  process.exit(99);
});
