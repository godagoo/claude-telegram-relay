import { describe, expect, test } from "bun:test";
import {
  WRAPPER_BUNDLE_ID,
  WRAPPER_BUNDLE_NAME,
  WRAPPER_EXECUTABLE_NAME,
  generateWrapperInfoPlist,
  generateWrapperShellScript,
} from "./wrapper-bundle.ts";

describe("generateWrapperInfoPlist", () => {
  test("emits the fixed bundle id, package type, and executable name", () => {
    const plist = generateWrapperInfoPlist({ version: "1.0.0" });
    expect(plist).toContain(`<key>CFBundleIdentifier</key>\n    <string>${WRAPPER_BUNDLE_ID}</string>`);
    expect(plist).toContain(`<key>CFBundleName</key>\n    <string>${WRAPPER_BUNDLE_NAME}</string>`);
    expect(plist).toContain(`<key>CFBundleExecutable</key>\n    <string>${WRAPPER_EXECUTABLE_NAME}</string>`);
    expect(plist).toContain("<key>CFBundlePackageType</key>\n    <string>APPL</string>");
    expect(plist).toContain("<key>CFBundleShortVersionString</key>\n    <string>1.0.0</string>");
    expect(plist).toContain("<key>LSUIElement</key>\n    <true/>");
  });

  test("is a syntactically valid plist envelope", () => {
    const plist = generateWrapperInfoPlist({ version: "0.1.0" });
    expect(plist.startsWith('<?xml version="1.0"')).toBe(true);
    expect(plist).toContain("<!DOCTYPE plist");
    expect(plist).toContain("<plist version=\"1.0\">");
    expect(plist.trim().endsWith("</plist>")).toBe(true);
  });

  test("bundle id is the documented stable string", () => {
    expect(WRAPPER_BUNDLE_ID).toBe("com.claude.telegram-relay-wrapper");
  });
});

describe("generateWrapperShellScript", () => {
  test("execs bun against the relay script with explicit env", () => {
    const script = generateWrapperShellScript({
      bunRealpath: "/opt/homebrew/Cellar/bun/1.3.13/bin/bun",
      projectRoot: "/Users/x/Projects/claude-telegram-relay",
      script: "src/relay.ts",
      env: {
        HOME: "/Users/x",
        RELAY_DIR: "/Users/x/.claude-relay",
        RELAY_LOG_DIR: "/Users/x/.claude-relay/logs",
        CLAUDE_PATH: "/Users/x/.local/bin/claude",
      },
      logsDir: "/Users/x/.claude-relay/logs",
    });
    expect(script.startsWith("#!/bin/bash")).toBe(true);
    expect(script).toContain("export HOME='/Users/x'");
    expect(script).toContain("export RELAY_DIR='/Users/x/.claude-relay'");
    expect(script).toContain("export RELAY_LOG_DIR='/Users/x/.claude-relay/logs'");
    expect(script).toContain("export CLAUDE_PATH='/Users/x/.local/bin/claude'");
    expect(script).toContain(
      "exec '/opt/homebrew/Cellar/bun/1.3.13/bin/bun' run 'src/relay.ts'",
    );
    expect(script).toContain("cd '/Users/x/Projects/claude-telegram-relay'");
  });

  test("escapes single quotes in env values safely", () => {
    const script = generateWrapperShellScript({
      bunRealpath: "/bun",
      projectRoot: "/p",
      script: "src/relay.ts",
      env: { NOTE: "user's notes" },
      logsDir: "/log",
    });
    expect(script).toContain("export NOTE='user'\\''s notes'");
  });

  test("does NOT include hardcoded PATH that hides the launchd env", () => {
    const script = generateWrapperShellScript({
      bunRealpath: "/bun",
      projectRoot: "/p",
      script: "src/relay.ts",
      env: { HOME: "/h", PATH: "/usr/bin" },
      logsDir: "/log",
    });
    // PATH explicitly set is allowed (it's part of env), but the wrapper must
    // not silently override or merge — it just exports what it's given.
    const pathLines = script.split("\n").filter((l) => l.startsWith("export PATH="));
    expect(pathLines).toEqual(["export PATH='/usr/bin'"]);
  });
});
