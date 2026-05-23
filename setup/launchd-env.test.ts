import { describe, expect, test } from "bun:test";
import { dirname, join } from "path";
import { launchdPath } from "./launchd-env.ts";

describe("launchdPath", () => {
  const home = "/Users/x";
  const path = launchdPath(home);
  const segments = path.split(":");

  test("puts ${home}/.bun/bin first so Bun-installed CLIs win", () => {
    expect(segments[0]).toBe(`${home}/.bun/bin`);
  });

  test("includes /opt/homebrew/bin (Apple Silicon Homebrew default prefix)", () => {
    expect(segments).toContain("/opt/homebrew/bin");
  });

  test("includes /opt/homebrew/sbin so brew shellenv parity holds", () => {
    expect(segments).toContain("/opt/homebrew/sbin");
  });

  test("includes /usr/local/sbin beside legacy /usr/local/bin", () => {
    expect(segments).toContain("/usr/local/sbin");
    expect(segments.indexOf("/usr/local/sbin")).toBe(segments.indexOf("/usr/local/bin") + 1);
  });

  test("orders /opt/homebrew/bin before /usr/local/bin (matches brew shellenv on Apple Silicon)", () => {
    expect(segments.indexOf("/opt/homebrew/bin")).toBeLessThan(segments.indexOf("/usr/local/bin"));
  });

  test("orders /opt/homebrew/bin immediately before /opt/homebrew/sbin (canonical pair)", () => {
    const binIdx = segments.indexOf("/opt/homebrew/bin");
    const sbinIdx = segments.indexOf("/opt/homebrew/sbin");
    expect(sbinIdx).toBe(binIdx + 1);
  });

  test("includes the macOS default PATH tail (/usr/bin:/bin:/usr/sbin:/sbin)", () => {
    expect(path).toMatch(/\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/);
  });

  test("contains no duplicate segments", () => {
    expect(new Set(segments).size).toBe(segments.length);
  });

  test("interpolates the home dir literally (no resolution, no trailing slash)", () => {
    expect(launchdPath("/Users/williamregan").startsWith("/Users/williamregan/.bun/bin:"))
      .toBe(true);
  });

  test("returns the exact canonical string expected by configure-launchd and verify", () => {
    expect(launchdPath("/Users/y")).toBe(
      "/Users/y/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
  });

  test("manual launchagent template uses the same placeholder PATH", async () => {
    const projectRoot = dirname(import.meta.dir);
    const template = await Bun.file(join(projectRoot, "daemon", "launchagent.plist")).text();
    expect(template).toContain(`<string>${launchdPath("/Users/YOUR_USERNAME")}</string>`);
  });
});
