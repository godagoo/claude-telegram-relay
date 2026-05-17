#!/usr/bin/env bun
import { spawn } from "bun";
import { dirname, join } from "path";

const recipient = process.argv[2] ?? "";
const body = await new Response(Bun.stdin.stream()).text();

function emit(payload: Record<string, unknown>, code = 0): never {
  console.log(JSON.stringify(payload));
  process.exit(code);
}

if (!recipient.trim()) emit({ ok: false, error: "missing_recipient" }, 64);
if (!body.trim()) emit({ ok: false, error: "missing_body" }, 64);

const scriptDir = dirname(new URL(import.meta.url).pathname);
const bridgePath = join(scriptDir, "iphone-mirror-bridge.cjs");

const nodePathCommand =
  'MODROOT=$(python3 -c "import os; print(os.environ[\\"PATH\\"].split(\\":\\")[0].removesuffix(\\"/.bin\\"))"); NODE_PATH="$MODROOT" node "$IPHONE_MIRROR_BRIDGE"';

const proc = spawn(
  [
    "npx",
    "-y",
    "-p",
    "@modelcontextprotocol/sdk",
    "-p",
    "mirroir-mcp",
    "-c",
    nodePathCommand,
  ],
  {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      IPHONE_MIRROR_BRIDGE: bridgePath,
      IPHONE_DRAFT_RECIPIENT: recipient,
      IPHONE_DRAFT_BODY: body,
    },
  },
);

const [stdout, stderr, code] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);

for (const line of stdout.trim().split(/\r?\n/).reverse()) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) continue;
  try {
    const parsed = JSON.parse(trimmed);
    emit(parsed, code === 0 && parsed.ok ? 0 : 1);
  } catch {
    // Continue looking for the bridge JSON line.
  }
}

emit(
  {
    ok: false,
    error: stderr.trim() || `iphone mirror bridge exited ${code} without JSON`,
  },
  code === 0 ? 1 : code,
);
