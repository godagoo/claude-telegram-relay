import { describe, expect, test } from "bun:test";
import { buildClaudeCliArgs } from "./claude-cli-args.ts";

describe("buildClaudeCliArgs", () => {
  test("constructs the canonical -p / --append-system-prompt / --tools args", () => {
    const args = buildClaudeCliArgs({
      claudePath: "/usr/local/bin/claude",
      prompt: "system rules go here\nUser: what time is it",
      allowedTools: ["Read", "Grep"],
      resume: false,
      resumeEnabled: true,
      sessionId: undefined,
    });
    expect(args).toEqual([
      "/usr/local/bin/claude",
      "-p",
      "what time is it",
      "--append-system-prompt",
      "system rules go here",
      "--tools",
      "Read,Grep",
      "--output-format",
      "json",
    ]);
  });

  test("falls back to whole prompt as -p when there is no User: marker", () => {
    const args = buildClaudeCliArgs({
      claudePath: "/c",
      prompt: "just a bare prompt",
      allowedTools: [],
      resume: false,
      resumeEnabled: true,
      sessionId: undefined,
    });
    expect(args.slice(0, 3)).toEqual(["/c", "-p", "just a bare prompt"]);
    expect(args).not.toContain("--append-system-prompt");
  });

  test("appends --resume when resume requested, enabled, and session present", () => {
    const args = buildClaudeCliArgs({
      claudePath: "/c",
      prompt: "User: hi",
      allowedTools: [],
      resume: true,
      resumeEnabled: true,
      sessionId: "abc-123",
    });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("abc-123");
    expect(args).not.toContain("--no-session-persistence");
  });

  test("emits --no-session-persistence when resume globally disabled", () => {
    const args = buildClaudeCliArgs({
      claudePath: "/c",
      prompt: "User: hi",
      allowedTools: [],
      resume: false,
      resumeEnabled: false,
      sessionId: "abc-123",
    });
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--resume");
  });

  test("adds --add-dir entries", () => {
    const args = buildClaudeCliArgs({
      claudePath: "/c",
      prompt: "User: hi",
      allowedTools: [],
      addDirs: ["/a/b", "/c/d"],
      resume: false,
      resumeEnabled: true,
      sessionId: undefined,
    });
    const i = args.indexOf("--add-dir");
    expect(i).toBeGreaterThan(-1);
    expect(args.filter((a) => a === "--add-dir").length).toBe(2);
  });

  test("strips NUL bytes from the user prompt before they reach Bun spawn", () => {
    const args = buildClaudeCliArgs({
      claudePath: "/c",
      prompt: "rules\nUser: me: \x00All good bro, can do!",
      allowedTools: [],
      resume: false,
      resumeEnabled: true,
      sessionId: undefined,
    });
    expect(args[2]).toBe("me: All good bro, can do!");
    for (const arg of args) {
      expect(arg.includes("\x00")).toBe(false);
    }
  });

  test("strips NUL bytes from the system prompt", () => {
    const args = buildClaudeCliArgs({
      claudePath: "/c",
      prompt: "system rules with a \x00embedded\nUser: hi",
      allowedTools: [],
      resume: false,
      resumeEnabled: true,
      sessionId: undefined,
    });
    const sysIdx = args.indexOf("--append-system-prompt");
    expect(args[sysIdx + 1]).toBe("system rules with a embedded");
  });

  test("strips other unsafe control characters but keeps newlines and tabs", () => {
    const args = buildClaudeCliArgs({
      claudePath: "/c",
      prompt: "a\tb\nc\x07\nUser: line1\nline2\there\x01",
      allowedTools: [],
      resume: false,
      resumeEnabled: true,
      sessionId: undefined,
    });
    expect(args[2]).toBe("line1\nline2\there");
    const sysIdx = args.indexOf("--append-system-prompt");
    expect(args[sysIdx + 1]).toBe("a\tb\nc");
  });
});
