// Stress harness for the token-lock atomic-claim takeover.
//
// PLAN5: "Add scripts/stress-token-lock.ts for manual 500-pair lock stress
// runs; keep the main unit test fast."
//
// Usage:
//   bun run scripts/stress-token-lock.ts            # default 500 pairs
//   bun run scripts/stress-token-lock.ts 2000       # custom pair count
//
// Exit code: 0 if exactly one acquire wins on every pair; non-zero on
// any double-success or io_error result, with a per-trial dump.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  acquireTokenLock,
  tokenHash,
  tokenLockPath,
  type TokenLockPayload,
} from "../src/token-lock.ts";

const FAKE_TOKEN = "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FAKE_HOST = "stress-host";

const PAIR_COUNT = Number.parseInt(process.argv[2] ?? "500", 10);
if (!Number.isFinite(PAIR_COUNT) || PAIR_COUNT <= 0) {
  console.error(`invalid pair count: ${process.argv[2]}`);
  process.exit(2);
}

async function runOnePair(trial: number): Promise<{
  trial: number;
  successes: number;
  ioErrors: number;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), `relay-stress-token-lock-${trial}-`));
  try {
    const path = tokenLockPath(FAKE_TOKEN, tempDir);
    mkdirSync(join(tempDir, "locks"), { recursive: true });

    const stalePayload: TokenLockPayload = {
      schema_version: 1,
      token_hash: tokenHash(FAKE_TOKEN),
      host: FAKE_HOST,
      pid: 70000 + (trial % 1000),
      started_at: "2026-05-18T09:00:00.000Z",
      heartbeat_at: "2026-05-18T09:00:00.000Z",
    };
    writeFileSync(path, JSON.stringify(stalePayload));

    const now = new Date("2026-05-19T10:00:00Z");
    const results = await Promise.all([
      acquireTokenLock({
        token: FAKE_TOKEN,
        host: FAKE_HOST,
        pid: 11111,
        now,
        baseDir: tempDir,
        isLiveRelay: () => false,
      }),
      acquireTokenLock({
        token: FAKE_TOKEN,
        host: FAKE_HOST,
        pid: 22222,
        now,
        baseDir: tempDir,
        isLiveRelay: () => false,
      }),
    ]);

    const successes = results.filter((r) => r.ok).length;
    const ioErrors = results.filter((r) => !r.ok && r.reason === "io_error").length;
    return { trial, successes, ioErrors };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log(`token-lock stress: ${PAIR_COUNT} concurrent stale-takeover pairs`);
  const t0 = performance.now();

  let totalDouble = 0;
  let totalZero = 0;
  let totalIoErrors = 0;
  let totalExactOne = 0;

  for (let trial = 0; trial < PAIR_COUNT; trial++) {
    const result = await runOnePair(trial);
    if (result.successes === 2) {
      totalDouble += 1;
      console.error(`trial ${trial}: TWO acquires won - race regressed`);
    } else if (result.ioErrors > 0) {
      totalIoErrors += result.ioErrors;
      console.error(`trial ${trial}: IO error result observed - verification failed`);
    } else if (result.successes === 0) {
      totalZero += 1;
      console.error(`trial ${trial}: ZERO acquires won - unexpected`);
    } else {
      totalExactOne += 1;
    }
    if ((trial + 1) % 100 === 0) {
      const elapsed = performance.now() - t0;
      console.log(
        `  progress: ${trial + 1}/${PAIR_COUNT} pairs in ${elapsed.toFixed(0)}ms ` +
          `(doubles=${totalDouble}, zeros=${totalZero}, io_errors=${totalIoErrors})`,
      );
    }
  }

  const elapsed = performance.now() - t0;
  console.log("");
  console.log(`done in ${elapsed.toFixed(0)}ms`);
  console.log(`  exactly-one winners: ${totalExactOne}`);
  console.log(`  double winners:      ${totalDouble}`);
  console.log(`  zero winners:        ${totalZero}`);
  console.log(`  io_error results:    ${totalIoErrors}`);

  if (totalDouble > 0 || totalZero > 0 || totalIoErrors > 0) {
    console.error("FAIL: lock race regressed");
    process.exit(1);
  }

  console.log("PASS: every pair elected exactly one winner");
}

main().catch((err) => {
  console.error("stress harness threw:", err);
  process.exit(99);
});
