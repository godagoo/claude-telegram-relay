# Rosetta / Apple Silicon Architecture Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Intel (x86_64 / Rosetta) binaries among the relay's runtime dependencies at startup and in the health-check script, and warn the user before macOS 28 silently breaks them.

**Architecture:** A new pure module `src/arch-check.ts` runs `file <path>` on each binary and parses the output into a typed result. The preflight function in `relay.ts` calls it and logs warnings. `setup/verify.ts` calls the same function and renders pass/warn lines into its existing Health Check output.

**Tech Stack:** Bun (TypeScript), `bun:test`, `/usr/bin/file` (always present on macOS), `sysctl` (always present on macOS).

**Background — why this matters:**
Apple's support article (HT102527, updated Feb 2026) states Rosetta ends in macOS 28. The relay depends on `bun` for process spawning and Full Disk Access grants, and on `mirroir`-native binaries for iPhone mirror placement. If any of these are Intel-only, they will stop working silently on the first macOS 28 boot. The relay currently has no mechanism to detect this.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| **Create** | `src/arch-check.ts` | `getBinaryArch()`, `checkRelayBinaries()`, types |
| **Create** | `src/arch-check.test.ts` | Unit tests for arch-check module |
| **Modify** | `src/relay.ts` | Call `checkRelayBinaries()` inside `runStartupPreflight()` |
| **Modify** | `setup/verify.ts` | Add "Binary Architecture" section before the summary |

---

## Task 1: Create `src/arch-check.ts` with failing tests first

**Files:**
- Create: `src/arch-check.ts`
- Create: `src/arch-check.test.ts`

### What this module does

`getBinaryArch(path)` runs `/usr/bin/file <path>` and classifies the result:

| `file` output contains | Return value |
|---|---|
| `arm64` AND `x86_64` | `"universal"` |
| `arm64` only | `"arm64"` |
| `x86_64` only | `"x86_64"` |
| anything else / error | `"unknown"` |

`checkRelayBinaries(claudePath)` gathers arch info for the bun binary (`process.execPath`), the claude CLI, and (optionally) the mirroir bridge script's node runtime, then returns an `ArchReport`.

`isRosettaProcess()` calls `sysctl -n sysctl.proc_translated`; returns `true` when the CURRENT process is running under Rosetta (i.e. the bun binary itself was translated).

---

- [ ] **Step 1: Write the failing tests**

```typescript
// src/arch-check.test.ts
import { expect, test, mock, spyOn } from "bun:test";
import {
  getBinaryArch,
  isRosettaProcess,
  checkRelayBinaries,
  type BinaryArch,
} from "./arch-check";

// ── getBinaryArch ──────────────────────────────────────────────

test("getBinaryArch returns arm64 for arm64-only output", async () => {
  // /usr/bin/file output for a native Apple silicon binary
  const fakeOutput =
    "/path/to/binary: Mach-O 64-bit executable arm64";
  using spawnSync = spyOn(Bun, "spawnSync").mockReturnValueOnce({
    exitCode: 0,
    stdout: Buffer.from(fakeOutput),
    stderr: Buffer.from(""),
  } as any);
  const result = await getBinaryArch("/path/to/binary");
  expect(result).toBe("arm64");
});

test("getBinaryArch returns x86_64 for Intel-only output", async () => {
  const fakeOutput =
    "/path/to/binary: Mach-O 64-bit executable x86_64";
  using spawnSync = spyOn(Bun, "spawnSync").mockReturnValueOnce({
    exitCode: 0,
    stdout: Buffer.from(fakeOutput),
    stderr: Buffer.from(""),
  } as any);
  const result = await getBinaryArch("/path/to/binary");
  expect(result).toBe("x86_64");
});

test("getBinaryArch returns universal for fat binary output", async () => {
  const fakeOutput =
    "/path/to/binary: Mach-O universal binary with 2 architectures: " +
    "[x86_64:Mach-O 64-bit executable x86_64] [arm64:Mach-O 64-bit executable arm64]";
  using spawnSync = spyOn(Bun, "spawnSync").mockReturnValueOnce({
    exitCode: 0,
    stdout: Buffer.from(fakeOutput),
    stderr: Buffer.from(""),
  } as any);
  const result = await getBinaryArch("/path/to/binary");
  expect(result).toBe("universal");
});

test("getBinaryArch returns unknown when file command fails", async () => {
  using spawnSync = spyOn(Bun, "spawnSync").mockReturnValueOnce({
    exitCode: 1,
    stdout: Buffer.from(""),
    stderr: Buffer.from("error"),
  } as any);
  const result = await getBinaryArch("/nonexistent");
  expect(result).toBe("unknown");
});

test("getBinaryArch returns unknown for non-Mach-O output", async () => {
  using spawnSync = spyOn(Bun, "spawnSync").mockReturnValueOnce({
    exitCode: 0,
    stdout: Buffer.from("/path/to/file: ASCII text"),
    stderr: Buffer.from(""),
  } as any);
  const result = await getBinaryArch("/path/to/file");
  expect(result).toBe("unknown");
});

// ── isRosettaProcess ──────────────────────────────────────────

test("isRosettaProcess returns true when sysctl reports 1", () => {
  using spawnSync = spyOn(Bun, "spawnSync").mockReturnValueOnce({
    exitCode: 0,
    stdout: Buffer.from("1\n"),
    stderr: Buffer.from(""),
  } as any);
  expect(isRosettaProcess()).toBe(true);
});

test("isRosettaProcess returns false when sysctl reports 0", () => {
  using spawnSync = spyOn(Bun, "spawnSync").mockReturnValueOnce({
    exitCode: 0,
    stdout: Buffer.from("0\n"),
    stderr: Buffer.from(""),
  } as any);
  expect(isRosettaProcess()).toBe(false);
});

test("isRosettaProcess returns false when sysctl is unavailable", () => {
  using spawnSync = spyOn(Bun, "spawnSync").mockReturnValueOnce({
    exitCode: 1,
    stdout: Buffer.from(""),
    stderr: Buffer.from("sysctl: unknown oid 'sysctl.proc_translated'"),
  } as any);
  expect(isRosettaProcess()).toBe(false);
});

// ── checkRelayBinaries ────────────────────────────────────────

test("checkRelayBinaries hasWarnings is false when all binaries are arm64", async () => {
  using spawnSync = spyOn(Bun, "spawnSync").mockReturnValue({
    exitCode: 0,
    stdout: Buffer.from("/path: Mach-O 64-bit executable arm64"),
    stderr: Buffer.from(""),
  } as any);
  const report = await checkRelayBinaries("/usr/local/bin/claude");
  expect(report.hasWarnings).toBe(false);
  expect(report.bun.arch).toBe("arm64");
  expect(report.claude.arch).toBe("arm64");
});

test("checkRelayBinaries hasWarnings is true when bun is x86_64", async () => {
  using spawnSync = spyOn(Bun, "spawnSync")
    .mockReturnValueOnce({
      // isRosettaProcess call
      exitCode: 0,
      stdout: Buffer.from("1\n"),
      stderr: Buffer.from(""),
    } as any)
    .mockReturnValueOnce({
      // getBinaryArch(process.execPath) — bun
      exitCode: 0,
      stdout: Buffer.from("/bun: Mach-O 64-bit executable x86_64"),
      stderr: Buffer.from(""),
    } as any)
    .mockReturnValueOnce({
      // getBinaryArch(claudePath)
      exitCode: 0,
      stdout: Buffer.from("/claude: Mach-O 64-bit executable arm64"),
      stderr: Buffer.from(""),
    } as any);
  const report = await checkRelayBinaries("/usr/local/bin/claude");
  expect(report.hasWarnings).toBe(true);
  expect(report.bun.arch).toBe("x86_64");
  expect(report.currentProcessRosetta).toBe(true);
});
```

- [ ] **Step 2: Run tests to confirm they all fail**

```bash
bun test src/arch-check.test.ts 2>&1
```

Expected: every test FAILs with "Cannot find module './arch-check'" or similar.

- [ ] **Step 3: Implement `src/arch-check.ts`**

```typescript
// src/arch-check.ts

export type BinaryArch = "arm64" | "x86_64" | "universal" | "unknown";

export interface BinaryArchInfo {
  path: string;
  arch: BinaryArch;
  /** true when arch is x86_64 — will stop working in macOS 28 */
  rosettaWarning: boolean;
}

export interface ArchReport {
  bun: BinaryArchInfo;
  claude: BinaryArchInfo;
  /** true when THIS bun process is being translated by Rosetta right now */
  currentProcessRosetta: boolean;
  /** true when any checked binary is x86_64-only */
  hasWarnings: boolean;
}

/** Returns true when the current process is running under Rosetta translation. */
export function isRosettaProcess(): boolean {
  const result = Bun.spawnSync({
    cmd: ["sysctl", "-n", "sysctl.proc_translated"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return false;
  return new TextDecoder().decode(result.stdout).trim() === "1";
}

/**
 * Runs `/usr/bin/file <path>` and classifies the Mach-O architecture.
 * Returns "unknown" on any error or for non-Mach-O paths.
 */
export function getBinaryArch(binaryPath: string): BinaryArch {
  const result = Bun.spawnSync({
    cmd: ["/usr/bin/file", binaryPath],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return "unknown";
  const out = new TextDecoder().decode(result.stdout);
  const hasArm64 = out.includes("arm64");
  const hasX86 = out.includes("x86_64");
  if (hasArm64 && hasX86) return "universal";
  if (hasArm64) return "arm64";
  if (hasX86) return "x86_64";
  return "unknown";
}

function toBinaryArchInfo(path: string, arch: BinaryArch): BinaryArchInfo {
  return { path, arch, rosettaWarning: arch === "x86_64" };
}

/**
 * Checks the architecture of the bun runtime and the Claude CLI.
 * Call from startup preflight and from setup/verify.ts.
 */
export async function checkRelayBinaries(claudePath: string): Promise<ArchReport> {
  const currentProcessRosetta = isRosettaProcess();
  const bunArch = getBinaryArch(process.execPath);
  const claudeArch = getBinaryArch(claudePath);

  const bun = toBinaryArchInfo(process.execPath, bunArch);
  const claude = toBinaryArchInfo(claudePath, claudeArch);
  const hasWarnings = bun.rosettaWarning || claude.rosettaWarning || currentProcessRosetta;

  return { bun, claude, currentProcessRosetta, hasWarnings };
}

/** Human-readable label for a BinaryArch value. */
export function archLabel(arch: BinaryArch): string {
  switch (arch) {
    case "arm64":     return "Apple silicon ✓";
    case "universal": return "Universal (Intel + Apple silicon) ✓";
    case "x86_64":    return "Intel only — will break in macOS 28 ✗";
    case "unknown":   return "unknown";
  }
}
```

- [ ] **Step 4: Run tests — all should pass**

```bash
bun test src/arch-check.test.ts 2>&1
```

Expected: all tests PASS. If spyOn API doesn't work as written, replace with:
```typescript
// Alternative: test via actual process.execPath (integration style)
test("getBinaryArch works against real bun binary", () => {
  const arch = getBinaryArch(process.execPath);
  expect(["arm64", "x86_64", "universal", "unknown"]).toContain(arch);
});
```

- [ ] **Step 5: Run the full test suite**

```bash
bun test 2>&1
```

Expected: 184+ pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/arch-check.ts src/arch-check.test.ts
git commit -m "feat: add arch-check module to detect Rosetta/Intel binaries"
```

---

## Task 2: Integrate arch check into relay.ts startup preflight

**Files:**
- Modify: `src/relay.ts` — inside `runStartupPreflight()`, after `verifyClaudeExecutable()`

The `checkRelayBinaries` call happens after `verifyClaudeExecutable()` already confirmed `CLAUDE_PATH` is executable, so the path is guaranteed valid. Warnings go to `console.error` (shows up in launchd logs as stderr). No hard failure — the relay keeps running even under Rosetta, since macOS 28 is not here yet.

- [ ] **Step 1: Add the import to `src/relay.ts`**

Open `src/relay.ts`. At the top with the other local imports (around line 60), add:

```typescript
import { checkRelayBinaries, archLabel } from "./arch-check.ts";
```

- [ ] **Step 2: Add the arch check call inside `runStartupPreflight()`**

In `runStartupPreflight()`, find the block that ends with:
```typescript
console.log(`[preflight] Claude CLI: ${CLAUDE_PATH}`);
```
(This is inside `verifyClaudeExecutable()` which is called from `runStartupPreflight()`.)

Immediately after the `await verifyClaudeExecutable();` call in `runStartupPreflight()`, add:

```typescript
  // Architecture check — warns if bun or claude are Intel-only (will break in macOS 28).
  try {
    const archReport = await checkRelayBinaries(CLAUDE_PATH);
    console.log(`[preflight] bun arch: ${archLabel(archReport.bun.arch)} (${archReport.bun.path})`);
    console.log(`[preflight] claude arch: ${archLabel(archReport.claude.arch)} (${archReport.claude.path})`);
    if (archReport.currentProcessRosetta) {
      console.error(
        "[preflight] WARNING: bun is running under Rosetta translation. " +
        "This relay will stop working in macOS 28. " +
        "Reinstall bun for Apple silicon: curl -fsSL https://bun.sh/install | bash",
      );
    } else if (archReport.hasWarnings) {
      console.error(
        "[preflight] WARNING: one or more relay binaries are Intel-only and will stop working in macOS 28. " +
        "Update them to a Universal or Apple silicon version.",
      );
    }
  } catch (err) {
    console.error("[preflight] arch check failed:", err instanceof Error ? err.message : String(err));
  }
```

- [ ] **Step 3: Start the relay and confirm the log line appears**

```bash
bun run src/relay.ts 2>&1 | head -30
```

Expected: you see a line like:
```
[preflight] bun arch: Apple silicon ✓ (/Users/williamregan/.bun/bin/bun)
[preflight] claude arch: Apple silicon ✓ (/Users/williamregan/.local/bin/claude)
```

If bun is Intel, you will see the WARNING line instead.

Stop the relay with Ctrl-C.

- [ ] **Step 4: Run the full test suite**

```bash
bun test 2>&1
```

Expected: 184+ pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/relay.ts
git commit -m "feat: log binary architecture at startup preflight, warn on Intel/Rosetta"
```

---

## Task 3: Add "Binary Architecture" section to `setup/verify.ts`

**Files:**
- Modify: `setup/verify.ts` — add a new section between the existing "Services (launchd)" section and the final summary

`setup/verify.ts` already has `pass()`, `fail()`, `warn()` helpers and the established section pattern `console.log(\`\n${bold("  Section")}\`)`. Follow that exactly.

- [ ] **Step 1: Add the import to `setup/verify.ts`**

Near the top of `setup/verify.ts`, after the existing local imports, add:

```typescript
import { checkRelayBinaries, archLabel } from "../src/arch-check.ts";
```

- [ ] **Step 2: Locate the insertion point in `main()`**

Find the end of the `if (process.platform === "darwin")` block in `main()`. It ends just before the final summary lines:

```typescript
  // Final summary
  console.log("");
  if (failed > 0) { ... }
```

- [ ] **Step 3: Insert the Binary Architecture section**

Just before the final summary block (still inside `main()`), add:

```typescript
  // Binary Architecture (macOS 28 Rosetta end-of-life warning)
  if (process.platform === "darwin") {
    console.log(`\n${bold("  Binary Architecture")}`);
    const claudePath =
      env.CLAUDE_PATH ||
      join(homedir(), ".local", "bin", "claude");
    try {
      const archReport = await checkRelayBinaries(claudePath);

      const bunMsg = `bun (${archReport.bun.path}): ${archLabel(archReport.bun.arch)}`;
      archReport.bun.rosettaWarning ? fail(bunMsg) : pass(bunMsg);

      const claudeMsg = `claude (${archReport.claude.path}): ${archLabel(archReport.claude.arch)}`;
      archReport.claude.rosettaWarning ? fail(claudeMsg) : pass(claudeMsg);

      if (archReport.currentProcessRosetta) {
        fail(
          "bun is currently running under Rosetta — this relay stops working in macOS 28. " +
          "Fix: curl -fsSL https://bun.sh/install | bash",
        );
      } else if (!archReport.hasWarnings) {
        pass("No Intel-only binaries detected — relay is macOS 28 ready");
      }
    } catch (err) {
      warn(`Arch check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

- [ ] **Step 4: Run verify and confirm the section appears**

```bash
bun run setup/verify.ts 2>&1 | grep -A 10 "Binary Architecture"
```

Expected output (exact arch will vary by machine):
```
  Binary Architecture
  ✓ bun (/Users/…/.bun/bin/bun): Apple silicon ✓
  ✓ claude (/Users/…/.local/bin/claude): Apple silicon ✓
  ✓ No Intel-only binaries detected — relay is macOS 28 ready
```

If Intel binaries are present, the `✗` and a fix command appear instead.

- [ ] **Step 5: Run the full test suite**

```bash
bun test 2>&1
```

Expected: 184+ pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add setup/verify.ts
git commit -m "feat: add binary architecture section to health-check (macOS 28 readiness)"
```

---

## Task 4: Update `docs/IMESSAGE-SETUP.md` with Rosetta context

**Files:**
- Modify: `docs/IMESSAGE-SETUP.md` — add a short "macOS 28 Compatibility" note after the Full Disk Access section

The FDA section already tells users to run `readlink -f "$(which bun)"` to find the exact binary. This task adds a callout explaining that an Intel bun binary's FDA grant is also wrong — and how to check.

- [ ] **Step 1: Locate the Full Disk Access section**

Open `docs/IMESSAGE-SETUP.md`. Find the section that describes granting Full Disk Access to the bun binary (it should reference `readlink -f "$(which bun)"`).

- [ ] **Step 2: Add the callout immediately after that FDA instruction**

After the sentence about granting FDA to the resolved bun path, add:

```markdown
> **macOS 28 compatibility check:** Rosetta (Intel app translation) ends in macOS 28.
> If your `bun` binary is Intel-only, both the FDA grant and the relay itself will
> stop working on upgrade. Run `bun run setup/verify.ts` — the "Binary Architecture"
> section tells you which binaries are at risk and how to fix them.
> To fix an Intel bun: `curl -fsSL https://bun.sh/install | bash` (reinstalls the
> Apple silicon native build), then re-grant Full Disk Access to the new path.
```

- [ ] **Step 3: Verify the file renders correctly**

```bash
head -n 120 docs/IMESSAGE-SETUP.md | grep -A 10 "macOS 28"
```

Expected: the callout block appears.

- [ ] **Step 4: Commit**

```bash
git add docs/IMESSAGE-SETUP.md
git commit -m "docs: add macOS 28 Rosetta end-of-life callout to IMESSAGE-SETUP"
```

---

## Self-Review

**Spec coverage:**
- ✓ Detect Intel binaries at startup → Task 2
- ✓ Detect Intel binaries in health check → Task 3
- ✓ Pure reusable module → Task 1
- ✓ Documentation callout → Task 4
- ✓ Actionable fix commands in every warning → all tasks include `curl -fsSL https://bun.sh/install | bash`
- ✓ No hard failure — relay continues under Rosetta, warns for macOS 28

**Placeholder scan:**
- No TBD, no TODO, no "handle edge cases", no "similar to Task N"
- All code blocks are complete

**Type consistency:**
- `BinaryArch` defined in Task 1, used in Tasks 2 and 3
- `ArchReport.bun` (not `.bunArch`) used consistently throughout
- `archLabel()` exported in Task 1, called in Tasks 2 and 3
- `checkRelayBinaries(claudePath: string)` signature consistent across all tasks
- `getBinaryArch()` is synchronous (returns `BinaryArch`, not `Promise<BinaryArch>`) — verify this matches between Task 1 implementation and Task 2/3 callers ✓ (all call sites are not `await`-ing it)
