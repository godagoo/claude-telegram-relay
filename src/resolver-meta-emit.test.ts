import { expect, test } from "bun:test";
import { dirname, join } from "path";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const EMITTER = join(PROJECT_ROOT, "scripts", "_resolver-meta-emit-kv.py");

async function runEmitter(jsonArg: string) {
  const proc = Bun.spawn(["python3", EMITTER, jsonArg], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

// Mirrors the bash while-read parse block in scripts/imessage-thread.sh.
// Used here to prove the full chain (Python emit + bash IFS='=' read) does
// not collapse empty fields the way the previous IFS=$'\t' approach did.
async function runBashParse(emitterOutput: string) {
  const script = `
set -euo pipefail
handle="<UNSET>"
display_name="<UNSET>"
ts="<UNSET>"
while IFS='=' read -r k v; do
  case "$k" in
    handle) handle="$v" ;;
    display_name) display_name="$v" ;;
    last_messaged_at) ts="$v" ;;
  esac
done
printf 'handle=%s\\ndisplay_name=%s\\nts=%s\\n' "$handle" "$display_name" "$ts"
`;
  const proc = Bun.spawn(["bash", "-c", script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  proc.stdin?.write(emitterOutput);
  await proc.stdin?.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

// PR3.5 audit #1 regression (Codex 2026-05-21).
// Before fix: scripts/imessage-thread.sh emitted "handle\\tdisplay_name\\tts\\n"
// and parsed with `IFS=$'\\t' read`. Bash treats \\t as IFS whitespace and
// collapses adjacent empty fields. Empty display_name → "handle\\t\\t0\\n"
// split into two tokens, so display_name received "0" and the timestamp
// was lost. Newline-delimited key=value, read with `IFS='='`, preserves
// empty values correctly.

test("emitter produces newline-delimited key=value for a normal record", async () => {
  const result = await runEmitter(
    '{"handle":"+15551234567","display_name":"Sarah","last_messaged_at":1234567890}',
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(
    "handle=+15551234567\ndisplay_name=Sarah\nlast_messaged_at=1234567890\n",
  );
});

test("emitter preserves empty display_name without conflating it with the timestamp", async () => {
  const result = await runEmitter(
    '{"handle":"+15551234567","display_name":"","last_messaged_at":1234567890}',
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(
    "handle=+15551234567\ndisplay_name=\nlast_messaged_at=1234567890\n",
  );
});

test("emitter emits empty defaults for malformed JSON instead of crashing", async () => {
  const result = await runEmitter("not json at all");
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("handle=\ndisplay_name=\nlast_messaged_at=0\n");
});

test("emitter coerces non-integer timestamp to 0", async () => {
  const result = await runEmitter(
    '{"handle":"x@example.com","display_name":"X","last_messaged_at":"not-a-number"}',
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(
    "handle=x@example.com\ndisplay_name=X\nlast_messaged_at=0\n",
  );
});

test("emitter strips embedded newlines from display_name (safety against parse breaks)", async () => {
  const result = await runEmitter(
    '{"handle":"+15551234567","display_name":"Two\\nLines","last_messaged_at":42}',
  );
  expect(result.code).toBe(0);
  // The embedded newline becomes a space so the bash while-read parse
  // doesn't see a spurious extra line.
  expect(result.stdout).toBe(
    "handle=+15551234567\ndisplay_name=Two Lines\nlast_messaged_at=42\n",
  );
});

test("bash while-read parse handles empty display_name without corruption (full chain)", async () => {
  const emitted = await runEmitter(
    '{"handle":"+15551234567","display_name":"","last_messaged_at":1234567890}',
  );
  expect(emitted.code).toBe(0);
  const parsed = await runBashParse(emitted.stdout);
  expect(parsed.code).toBe(0);
  expect(parsed.stdout).toBe(
    "handle=+15551234567\ndisplay_name=\nts=1234567890\n",
  );
});

test("bash while-read parse populates display_name when present", async () => {
  const emitted = await runEmitter(
    '{"handle":"+15551234567","display_name":"Conor","last_messaged_at":1234567890}',
  );
  expect(emitted.code).toBe(0);
  const parsed = await runBashParse(emitted.stdout);
  expect(parsed.code).toBe(0);
  expect(parsed.stdout).toBe(
    "handle=+15551234567\ndisplay_name=Conor\nts=1234567890\n",
  );
});
