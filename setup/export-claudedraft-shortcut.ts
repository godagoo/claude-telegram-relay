import { mkdtemp, rm, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_SHORTCUT_NAME,
  defaultICloudDriveDraftDir,
} from "../src/icloud-drive-draft.ts";
import {
  readInstalledShortcutActions,
  readSignedShortcutFileActions,
  validateClaudeDraftShortcutActions,
} from "./shortcut-verify.ts";
import { runCommandWithTimeout } from "./process-timeout.ts";

const DEFAULT_SIGN_MODE = "people-who-know-me";
const DEFAULT_SHORTCUT_CLIENT_VERSION = "900";

interface ExportOptions {
  shortcutName?: string;
  outputPath?: string;
  signMode?: string;
  draftDir?: string;
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await runCommandWithTimeout(args, { timeoutMs: 15_000 });
  return {
    code: result.timedOut ? 124 : result.code,
    stdout: result.stdout,
    stderr: result.timedOut
      ? `Command timed out after 15000ms: ${args[0]}`
      : result.stderr,
  };
}

function iCloudDriveRoot(): string {
  return join(
    homedir(),
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
  );
}

function shortcutWorkflowPlist(actions: unknown[]): Record<string, unknown> {
  return {
    WFWorkflowActions: actions,
    WFWorkflowClientVersion: DEFAULT_SHORTCUT_CLIENT_VERSION,
    WFWorkflowMinimumClientVersion: Number(DEFAULT_SHORTCUT_CLIENT_VERSION),
    WFWorkflowMinimumClientVersionString: DEFAULT_SHORTCUT_CLIENT_VERSION,
    WFWorkflowIcon: {
      WFWorkflowIconGlyphNumber: 61440,
      WFWorkflowIconStartColor: 463140863,
    },
    WFWorkflowImportQuestions: [],
    WFWorkflowInputContentItemClasses: [],
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowTypes: ["NCWidget", "WatchKit"],
  };
}

function parseArgs(args: string[]): ExportOptions {
  const options: ExportOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--name" && next) {
      options.shortcutName = next;
      i += 1;
    } else if (arg === "--output" && next) {
      options.outputPath = next;
      i += 1;
    } else if (arg === "--mode" && next) {
      options.signMode = next;
      i += 1;
    } else if (arg === "--draft-dir" && next) {
      options.draftDir = next;
      i += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return options;
}

export async function exportClaudeDraftShortcut(options: ExportOptions = {}): Promise<string> {
  const shortcutName = options.shortcutName ?? process.env.RELAY_IMESSAGE_SHORTCUT_NAME ?? DEFAULT_SHORTCUT_NAME;
  const draftDir = options.draftDir ?? process.env.RELAY_ICLOUD_DRAFT_DIR ?? defaultICloudDriveDraftDir();
  const outputPath = options.outputPath ?? join(iCloudDriveRoot(), `${shortcutName}.shortcut`);
  const signMode = options.signMode ?? DEFAULT_SIGN_MODE;

  const installed = await readInstalledShortcutActions(shortcutName);
  if (!installed.ok || !installed.actions) {
    throw new Error(installed.error ?? `Could not read installed shortcut: ${shortcutName}`);
  }

  const installedValidation = validateClaudeDraftShortcutActions(installed.actions, { draftDir });
  if (!installedValidation.ok) {
    throw new Error(
      `Installed ${shortcutName} is not safe to export:\n${installedValidation.errors.join("\n")}`,
    );
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), "claudedraft-shortcut-export-"));
  try {
    const workflowJson = join(tmpRoot, `${shortcutName}.json`);
    const unsignedShortcut = join(tmpRoot, `${shortcutName}.shortcut`);
    await writeFile(
      workflowJson,
      JSON.stringify(shortcutWorkflowPlist(installed.actions), null, 2),
    );

    const convert = await run([
      "plutil",
      "-convert",
      "binary1",
      "-o",
      unsignedShortcut,
      workflowJson,
    ]);
    if (convert.code !== 0) {
      throw new Error(convert.stderr.trim() || `plutil exited ${convert.code}`);
    }

    const sign = await run([
      "shortcuts",
      "sign",
      "--mode",
      signMode,
      "--input",
      unsignedShortcut,
      "--output",
      outputPath,
    ]);
    if (sign.code !== 0) {
      throw new Error(sign.stderr.trim() || `shortcuts sign exited ${sign.code}`);
    }

    const signed = await readSignedShortcutFileActions(outputPath);
    if (!signed.ok || !signed.actions) {
      throw new Error(signed.error ?? `Could not read signed shortcut: ${outputPath}`);
    }
    const signedValidation = validateClaudeDraftShortcutActions(signed.actions, { draftDir });
    if (!signedValidation.ok) {
      throw new Error(
        `Signed ${shortcutName} export is invalid:\n${signedValidation.errors.join("\n")}`,
      );
    }

    return outputPath;
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (import.meta.main) {
  try {
    const outputPath = await exportClaudeDraftShortcut(parseArgs(Bun.argv.slice(2)));
    console.log(`Created verified iPhone install file: ${outputPath}`);
    console.log("Install it on iPhone from Files by choosing Replace/Add Shortcut, allow access to claude-relay-drafts, then delete it after the body appears in Messages.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
