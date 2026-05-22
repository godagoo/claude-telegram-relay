import { describe, expect, test } from "bun:test";
import { generateRelayPlist } from "./launchd-plist.ts";
import { launchdPath } from "./launchd-env.ts";

const baseOptions = {
  label: "com.claude.telegram-relay",
  script: "src/relay.ts",
  bunRealpath: "/opt/homebrew/Cellar/bun/1.3.13/bin/bun",
  projectRoot: "/Users/x/Projects/claude-telegram-relay",
  home: "/Users/x",
  logsDir: "/Users/x/.claude-relay/logs",
  env: {
    HOME: "/Users/x",
    PATH: launchdPath("/Users/x"),
    RELAY_DIR: "/Users/x/.claude-relay",
    RELAY_LOG_DIR: "/Users/x/.claude-relay/logs",
    CLAUDE_PATH: "/Users/x/.local/bin/claude",
    CLAUDE_TIMEOUT_MS: "90000",
    CLAUDE_RESUME: "0",
  },
  keepAlive: { successfulExit: false, crashed: true } as const,
  throttleInterval: 30,
  exitTimeOut: 20,
};

describe("generateRelayPlist", () => {
  test("renders a KeepAlive dict, not the legacy boolean", () => {
    const plist = generateRelayPlist(baseOptions);
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
    expect(plist).toContain("<key>Crashed</key>");
    expect(plist).toContain("<true/>");
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  test("emits ThrottleInterval=30 and ExitTimeOut=20", () => {
    const plist = generateRelayPlist(baseOptions);
    expect(plist).toContain("<key>ThrottleInterval</key>\n    <integer>30</integer>");
    expect(plist).toContain("<key>ExitTimeOut</key>\n    <integer>20</integer>");
  });

  test("uses the realpath in ProgramArguments rather than the symlink", () => {
    const plist = generateRelayPlist(baseOptions);
    expect(plist).toContain(
      "<string>/opt/homebrew/Cellar/bun/1.3.13/bin/bun</string>",
    );
    expect(plist).not.toContain("/Users/x/.bun/bin/bun");
  });

  test("includes RELAY_DIR and RELAY_LOG_DIR env vars", () => {
    const plist = generateRelayPlist(baseOptions);
    expect(plist).toMatch(/<key>RELAY_DIR<\/key>\s*<string>\/Users\/x\/\.claude-relay<\/string>/);
    expect(plist).toMatch(/<key>RELAY_LOG_DIR<\/key>\s*<string>\/Users\/x\/\.claude-relay\/logs<\/string>/);
  });

  test("includes RELAY_PYTHON when provided", () => {
    const plist = generateRelayPlist({
      ...baseOptions,
      env: { ...baseOptions.env, RELAY_PYTHON: "/usr/local/bin/python3" },
    });
    expect(plist).toMatch(/<key>RELAY_PYTHON<\/key>\s*<string>\/usr\/local\/bin\/python3<\/string>/);
  });

  test("writes stdout/stderr paths under the provided logsDir", () => {
    const plist = generateRelayPlist(baseOptions);
    expect(plist).toContain(
      "<string>/Users/x/.claude-relay/logs/com.claude.telegram-relay.log</string>",
    );
    expect(plist).toContain(
      "<string>/Users/x/.claude-relay/logs/com.claude.telegram-relay.error.log</string>",
    );
  });

  test("XML-escapes special characters in paths", () => {
    const plist = generateRelayPlist({
      ...baseOptions,
      projectRoot: "/Users/x/Projects/AT&T Notes",
    });
    expect(plist).toContain("AT&amp;T Notes");
    expect(plist).not.toContain("AT&T Notes");
  });

  test("wrapper mode points ProgramArguments at the wrapper executable and tags the bundle ID", () => {
    const plist = generateRelayPlist({
      ...baseOptions,
      wrapperExecutablePath: "/Users/x/Applications/ClaudeRelay.app/Contents/MacOS/ClaudeRelay",
      wrapperBundleId: "com.claude.telegram-relay-wrapper",
    });
    expect(plist).toContain(
      "<string>/Users/x/Applications/ClaudeRelay.app/Contents/MacOS/ClaudeRelay</string>",
    );
    expect(plist).not.toContain("<string>run</string>");
    expect(plist).toContain(
      "<key>AssociatedBundleIdentifiers</key>\n    <string>com.claude.telegram-relay-wrapper</string>",
    );
  });

  test("non-wrapper mode does not emit AssociatedBundleIdentifiers", () => {
    const plist = generateRelayPlist(baseOptions);
    expect(plist).not.toContain("AssociatedBundleIdentifiers");
  });

  test("scheduled jobs (no keepAlive) get StartCalendarInterval and no Throttle/Exit policy", () => {
    const plist = generateRelayPlist({
      ...baseOptions,
      keepAlive: false,
      calendarIntervals: [{ Hour: 9, Minute: 0 }],
    });
    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).toContain("<key>Hour</key>\n            <integer>9</integer>");
    expect(plist).not.toContain("<key>KeepAlive</key>");
    expect(plist).not.toContain("<key>ThrottleInterval</key>");
  });
});
