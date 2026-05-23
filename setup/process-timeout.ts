export interface TimedCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface TimedCommandOptions {
  timeoutMs: number;
  killGraceMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

const DEFAULT_KILL_GRACE_MS = 1_000;

export async function runCommandWithTimeout(
  args: string[],
  options: TimedCommandOptions,
): Promise<TimedCommandResult> {
  if (args.length === 0) throw new Error("runCommandWithTimeout requires a command");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Invalid timeout: ${options.timeoutMs}`);
  }

  let timedOut = false;
  const proc = Bun.spawn(args, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => {
    if (proc.exitCode !== null) return;
    timedOut = true;
    proc.kill("SIGTERM");
  }, options.timeoutMs);

  const kill = setTimeout(() => {
    if (timedOut && proc.exitCode === null) {
      proc.kill("SIGKILL");
    }
  }, options.timeoutMs + (options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timeout);
    clearTimeout(kill);
  }
}
