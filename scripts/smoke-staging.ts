import { createHash } from "crypto";
import { mkdtemp, readFile, rm } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { spawn } from "bun";
import {
  buildCldraftPayload,
  parseCldraftPayload,
} from "../src/cldraft-payload.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    out[key] = value;
  }
  return out;
}

async function loadDotEnv(): Promise<Record<string, string>> {
  try {
    return parseDotEnv(await Bun.file(join(PROJECT_ROOT, ".env")).text());
  } catch {
    return {};
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function usage(): never {
  console.error([
    "usage: bun run scripts/smoke-staging.ts [--dry-run|--live]",
    "",
    "Default is --dry-run. --live sends one staging iMessage and may open the",
    "ClaudeDraft compose sheet on the iPhone. It never sends the final draft.",
  ].join("\n"));
  process.exit(64);
}

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) usage();
if (args.has("--dry-run") && args.has("--live")) usage();

const live = args.has("--live");
const dotenv = await loadDotEnv();
const env = { ...dotenv, ...process.env };
const stagingHandle = (env.RELAY_IMESSAGE_STAGING_HANDLE || "").trim();

if (live && !stagingHandle) {
  fail("RELAY_IMESSAGE_STAGING_HANDLE is required for --live");
}

const recipient = (env.RELAY_SMOKE_STAGING_RECIPIENT || "").trim()
  || (live ? stagingHandle : "+15555550123");
const label = (env.RELAY_SMOKE_STAGING_LABEL || "").trim() || "ClaudeRelay Smoke";
const body = env.RELAY_SMOKE_STAGING_BODY
  || `staging smoke ${new Date().toISOString()}`;

const { payload, draftId } = buildCldraftPayload({
  to: recipient,
  label,
  body,
});
const payloadSha256 = sha256Hex(payload);
const script = join(PROJECT_ROOT, "scripts", "stage-imessage.sh");
const tmpRoot = live ? "" : await mkdtemp(join(tmpdir(), "relay-staging-smoke-"));
const dryRunPath = tmpRoot ? join(tmpRoot, "payload.json") : "";

try {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...dotenv,
    RELAY_CLDRAFT_PAYLOAD_JSON: payload,
    RELAY_CLDRAFT_DRAFT_ID: draftId,
    RELAY_IMESSAGE_STAGING_HANDLE: stagingHandle || "+15555550000",
  };

  if (dryRunPath) {
    childEnv.RELAY_STAGE_IMESSAGE_DRY_RUN_PATH = dryRunPath;
  }
  if (live && stagingHandle && recipient === stagingHandle) {
    childEnv.RELAY_IMESSAGE_ALLOW_SELF_STAGING = "1";
  }

  const proc = spawn([script, recipient, label], {
    cwd: PROJECT_ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
  });

  proc.stdin?.write(body);
  await proc.stdin?.end();

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(stdout.trim());
  } catch {
    fail(`stage helper stdout was not JSON: ${stdout.trim().slice(0, 160)}`);
  }

  if (code !== 0 || envelope.ok !== true) {
    fail(`stage helper failed code=${code} reason=${String(envelope.reason || stderr.trim() || "unknown")}`);
  }

  const expectedMode = live ? "staging_imessage" : "dry_run";
  if (envelope.mode !== expectedMode) {
    fail(`stage helper mode=${String(envelope.mode)} expected=${expectedMode}`);
  }
  if (envelope.payload_sha256 !== payloadSha256) {
    fail(`payload sha mismatch expected=${payloadSha256} got=${String(envelope.payload_sha256 || "")}`);
  }

  if (dryRunPath) {
    const written = await readFile(dryRunPath, "utf8");
    const parsed = parseCldraftPayload(written);
    if (parsed.draft_id !== draftId || parsed.to !== recipient || parsed.body !== body) {
      fail("dry-run payload did not round-trip recipient, body, and draft_id");
    }
  }

  console.log(`PASS: ${expectedMode} staging smoke ok draft_id=${draftId} payload_sha256=${payloadSha256}`);
} finally {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
}
