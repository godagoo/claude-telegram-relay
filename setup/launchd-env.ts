// Single source of truth for the launchd EnvironmentVariables.PATH used by
// the relay LaunchAgent.
//
// configure-launchd.ts writes this string into the plist; verify.ts both
// simulates launchd's PATH for its python3 resolver probe AND asserts the
// parsed plist's PATH against this same value (drift check);
// launchd-plist.test.ts uses it in fixtures. Centralizing prevents the
// three-way drift that previously made the "one-line edit" wrong.
//
// Order matches `brew shellenv` on Apple Silicon (HOMEBREW_PREFIX=/opt/homebrew,
// which prepends bin then sbin to the inherited PATH) with ${home}/.bun/bin
// at the very front so Bun-installed CLIs resolve before everything else.
// /usr/local/bin and /usr/local/sbin are retained for Intel/legacy Homebrew
// and any installer that still drops binaries there.
export function launchdPath(home: string): string {
  return [
    `${home}/.bun/bin`,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
}
