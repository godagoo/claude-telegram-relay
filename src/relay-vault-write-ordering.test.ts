import { expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { dirname, join } from "path";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const RELAY_PATH = join(PROJECT_ROOT, "src", "relay.ts");

// PR3.5 audit #8-timing regression (Codex 2026-05-21).
//
// src/vault-writer.ts:16-17 docstring is the contract:
//   "Failure mode: vault writes are best-effort and fire-and-forget. They
//    happen AFTER the Telegram reply has been sent..."
//
// Before fix: src/relay.ts:1306 fired `void writeRelayVaultArtifacts(...)`
// during the staging-success branch, well before line 1363's
// `await sendTelegramResponse(...)`. The Promise was kicked off in parallel
// with the network call, not after — implementation drifted from contract.
//
// These tests assert the ordering at the source-text level. Full dependency
// injection of the relay's I/O would be a much larger refactor; the static
// check is enough to catch a future regression where someone reintroduces
// the early-fire pattern.

test("relay.ts fires writeRelayVaultArtifacts only AFTER awaiting sendTelegramResponse", async () => {
  const source = await readFile(RELAY_PATH, "utf8");

  // The kicked-off vault write must be the ONLY runtime call site for
  // writeRelayVaultArtifacts in relay.ts (the type-position usage at
  // `Parameters<typeof writeRelayVaultArtifacts>` is not a call).
  const callPattern = /void\s+writeRelayVaultArtifacts\s*\(/g;
  const callMatches = [...source.matchAll(callPattern)];
  expect(callMatches.length).toBe(1);
  const writeIdx = callMatches[0].index!;

  const sendIdx = source.indexOf("await sendTelegramResponse(");
  expect(sendIdx).toBeGreaterThanOrEqual(0);

  const markIdx = source.indexOf("await markUpdateSentAndRemember(");
  expect(markIdx).toBeGreaterThanOrEqual(0);

  // Both gating awaits must precede the vault write call.
  expect(writeIdx).toBeGreaterThan(sendIdx);
  expect(writeIdx).toBeGreaterThan(markIdx);
});

test("relay.ts never schedules a vault write inside the staging-success branch", async () => {
  const source = await readFile(RELAY_PATH, "utf8");

  // The staging-success branch reads roughly as `if (staged.ok) { ... }`.
  // Locate that block and confirm the runtime write call does not appear
  // inside it. The block is identified by the `staging_handoff_sent` log
  // line, which is unique to the success path.
  const successAnchor = source.indexOf('staging_handoff_sent');
  expect(successAnchor).toBeGreaterThanOrEqual(0);

  // Find the next closing brace of the if-block. Walk forward, tracking
  // brace depth from the next `{` after the anchor.
  const openIdx = source.indexOf("{", successAnchor);
  expect(openIdx).toBeGreaterThanOrEqual(0);

  // Walk back to the matching outer `if (staged.ok) {` open brace so we
  // bound the success branch. The anchor sits inside that block already.
  const ifMatch = source.lastIndexOf("if (staged.ok)", successAnchor);
  expect(ifMatch).toBeGreaterThanOrEqual(0);
  const branchOpen = source.indexOf("{", ifMatch);
  expect(branchOpen).toBeGreaterThanOrEqual(0);

  let depth = 0;
  let branchClose = -1;
  for (let i = branchOpen; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        branchClose = i;
        break;
      }
    }
  }
  expect(branchClose).toBeGreaterThan(branchOpen);

  const branchText = source.slice(branchOpen, branchClose);
  // The success branch is allowed to QUEUE the input via pendingVaultWriteInput
  // but must not fire the write. The call site sits outside, after the awaits.
  expect(branchText).not.toMatch(/void\s+writeRelayVaultArtifacts\s*\(/);
});
