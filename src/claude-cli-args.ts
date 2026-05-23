import { splitPromptForClaudeCli } from "./prompt-split.ts";
import { sanitizeSpawnArgs } from "./sanitize-spawn-arg.ts";

export interface ClaudeCliArgsInput {
  claudePath: string;
  prompt: string;
  allowedTools: readonly string[];
  addDirs?: readonly string[];
  resume: boolean;
  resumeEnabled: boolean;
  sessionId: string | undefined;
}

export function buildClaudeCliArgs(input: ClaudeCliArgsInput): string[] {
  const { systemPrompt, userPrompt } = splitPromptForClaudeCli(input.prompt);
  const args: string[] = [input.claudePath, "-p", userPrompt];

  if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }

  if (input.resumeEnabled && input.resume && input.sessionId) {
    args.push("--resume", input.sessionId);
  }

  if (!input.resumeEnabled) {
    args.push("--no-session-persistence");
  }

  args.push("--tools", (input.allowedTools ?? []).join(","));

  for (const dir of input.addDirs ?? []) {
    args.push("--add-dir", dir);
  }

  args.push("--output-format", "json");

  return sanitizeSpawnArgs(args);
}
