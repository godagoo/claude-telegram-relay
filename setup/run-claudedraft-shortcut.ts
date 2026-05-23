import { existsSync } from "fs";
import { DEFAULT_SHORTCUT_NAME } from "../src/icloud-drive-draft.ts";
import {
  runCommandWithTimeout,
  type TimedCommandResult,
} from "./process-timeout.ts";

export const DEFAULT_SHORTCUT_RUN_TIMEOUT_MS = 20_000;

interface RunShortcutOptions {
  shortcutName: string;
  timeoutMs: number;
}

function parseArgs(args: string[]): RunShortcutOptions {
  const options: RunShortcutOptions = {
    shortcutName: process.env.RELAY_IMESSAGE_SHORTCUT_NAME || DEFAULT_SHORTCUT_NAME,
    timeoutMs: DEFAULT_SHORTCUT_RUN_TIMEOUT_MS,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if ((arg === "--name" || arg === "--shortcut-name") && next) {
      options.shortcutName = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number.parseInt(next, 10);
      i += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`--timeout-ms must be a positive integer; got ${options.timeoutMs}`);
  }

  return options;
}

function shortcutsBinary(): string {
  return existsSync("/usr/bin/shortcuts") ? "/usr/bin/shortcuts" : "shortcuts";
}

export async function runClaudeDraftShortcut(options: RunShortcutOptions): Promise<TimedCommandResult> {
  return runCommandWithTimeout(
    [shortcutsBinary(), "run", options.shortcutName],
    { timeoutMs: options.timeoutMs },
  );
}

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    const result = await runClaudeDraftShortcut(options);

    if (result.stdout.trim()) console.log(result.stdout.trim());
    if (result.stderr.trim()) console.error(result.stderr.trim());

    if (result.timedOut) {
      console.error(
        `ClaudeDraft shortcut run timed out after ${options.timeoutMs}ms. ` +
        "Close any open Shortcuts privacy prompt or Messages compose sheet, then rerun setup:verify.",
      );
      process.exit(124);
    }

    if (result.code !== 0) {
      console.error(`shortcuts run exited ${result.code}`);
      process.exit(result.code);
    }

    console.log(`${options.shortcutName} completed.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
