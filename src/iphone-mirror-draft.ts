import { spawn } from "bun";
import { dirname, join } from "path";

const DEFAULT_TIMEOUT_MS = 45_000;
const PROJECT_ROOT = dirname(dirname(import.meta.path));

export interface IPhoneMirrorDraftResult {
  ok: boolean;
  mode?: "typed";
  verified?: boolean;
  error?: string;
}

export function shouldUseIPhoneMirrorPlacement(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return /^(1|true|yes|on)$/i.test(env.RELAY_IPHONE_MIRROR_PLACEMENT ?? "");
}

export function parseIPhoneMirrorHelperOutput(
  stdout: string,
): IPhoneMirrorDraftResult {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as IPhoneMirrorDraftResult;
      return parsed;
    } catch {
      // Keep looking: mirroir startup logs can be noisy.
    }
  }
  return {
    ok: false,
    error: `iphone mirror helper did not emit JSON: ${stdout.slice(-240)}`,
  };
}

export async function placeIPhoneMirrorDraft(
  recipient: string,
  body: string,
  options: {
    projectRoot?: string;
    timeoutMs?: number;
    scriptPath?: string;
  } = {},
): Promise<IPhoneMirrorDraftResult> {
  if (!recipient.trim()) return { ok: false, error: "missing_recipient" };
  if (!body.trim()) return { ok: false, error: "missing_body" };

  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const scriptPath =
    options.scriptPath ?? join(projectRoot, "scripts", "iphone-mirror-draft.ts");
  const proc = spawn([process.execPath, "run", scriptPath, recipient], {
    cwd: projectRoot,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  proc.stdin?.write(body);
  await proc.stdin?.end();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      reject(new Error(`iphone_mirror_draft_timeout_${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeout,
    ]);
    if (timeoutId) clearTimeout(timeoutId);

    const parsed = parseIPhoneMirrorHelperOutput(stdout);
    if (code === 0 && parsed.ok) return parsed;

    return {
      ok: false,
      error: parsed.error ?? (stderr.trim() || `iphone mirror helper exited ${code}`),
    };
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
