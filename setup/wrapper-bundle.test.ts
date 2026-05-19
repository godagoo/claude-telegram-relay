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
  test("execs bun against the relay script with cd to project root", () => {
    const script = generateWrapperShellScript({
      bunRealpath: "/opt/homebrew/Cellar/bun/1.3.13/bin/bun",
      projectRoot: "/Users/x/Projects/claude-telegram-relay",
      script: "src/relay.ts",
    });
    expect(script.startsWith("#!/bin/bash")).toBe(true);
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("cd '/Users/x/Projects/claude-telegram-relay'");
    expect(script).toContain(
      "exec '/opt/homebrew/Cellar/bun/1.3.13/bin/bun' run 'src/relay.ts'",
    );
  });

  test("is static: contains no export statements (env lives in launchd)", () => {
    const script = generateWrapperShellScript({
      bunRealpath: "/bun",
      projectRoot: "/p",
      script: "src/relay.ts",
    });
    const exportLines = script.split("\n").filter((l) => l.startsWith("export "));
    expect(exportLines).toEqual([]);
  });

  test("escapes single quotes in path values safely", () => {
    const script = generateWrapperShellScript({
      bunRealpath: "/bun",
      projectRoot: "/users/o'brien/proj",
      script: "src/relay.ts",
    });
    expect(script).toContain("cd '/users/o'\\''brien/proj'");
  });

  test("rerunning with identical inputs produces byte-identical output", () => {
    const opts = {
      bunRealpath: "/bun",
      projectRoot: "/p",
      script: "src/relay.ts",
    } as const;
    expect(generateWrapperShellScript(opts)).toBe(generateWrapperShellScript(opts));
  });
});
