import { expect, test } from "bun:test";
import { runCommandWithTimeout } from "./process-timeout";

test("runCommandWithTimeout returns successful command output", async () => {
  const result = await runCommandWithTimeout(
    ["/bin/sh", "-c", "printf shortcut-ok"],
    { timeoutMs: 1_000 },
  );

  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("shortcut-ok");
});

test("runCommandWithTimeout terminates commands that exceed the timeout", async () => {
  const startedAt = Date.now();
  const result = await runCommandWithTimeout(
    ["/bin/sleep", "5"],
    { timeoutMs: 50, killGraceMs: 50 },
  );

  expect(result.timedOut).toBe(true);
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});
