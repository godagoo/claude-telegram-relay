import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const PROJECT_ROOT = (() => {
  const here = import.meta.dir;
  return here.endsWith("/src") ? here.slice(0, -4) : here;
})();

async function runResolver(query: string, aliasesPath: string): Promise<{ exit: number; out: string; err: string }> {
  const proc = Bun.spawn(["python3", "scripts/resolve-contact.py", query], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RELAY_CONTACT_ALIASES_PATH: aliasesPath },
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, out: out.trim(), err };
}

let workdir: string | null = null;

function setupAliases(json: string): string {
  workdir = mkdtempSync(join(tmpdir(), "contact-alias-"));
  const path = join(workdir, "contact-aliases.json");
  writeFileSync(path, json);
  return path;
}

function teardown() {
  if (workdir) {
    rmSync(workdir, { recursive: true, force: true });
    workdir = null;
  }
}

test("alias override returns the configured identifier", async () => {
  const aliasPath = setupAliases(JSON.stringify({ dad: "+16048092405" }));
  try {
    const r = await runResolver("dad", aliasPath);
    expect(r.exit).toBe(0);
    expect(r.out).toBe("+16048092405");
  } finally {
    teardown();
  }
});

test("alias lookup is case-insensitive", async () => {
  const aliasPath = setupAliases(JSON.stringify({ dad: "+16048092405" }));
  try {
    expect((await runResolver("Dad", aliasPath)).out).toBe("+16048092405");
    expect((await runResolver("DAD", aliasPath)).out).toBe("+16048092405");
  } finally {
    teardown();
  }
});

test("alias values are normalized to E.164 if they look like a phone", async () => {
  const aliasPath = setupAliases(JSON.stringify({ dad: "6048092405" }));
  try {
    const r = await runResolver("dad", aliasPath);
    expect(r.out).toBe("+16048092405");
  } finally {
    teardown();
  }
});

test("parent aliases stay distinct when both are configured", async () => {
  const aliasPath = setupAliases(JSON.stringify({
    dad: "6048092405",
    mom: "6043154583",
  }));
  try {
    expect((await runResolver("Dad", aliasPath)).out).toBe("+16048092405");
    expect((await runResolver("Mom", aliasPath)).out).toBe("+16043154583");
  } finally {
    teardown();
  }
});

test("alias values that look like email pass through unchanged", async () => {
  const aliasPath = setupAliases(JSON.stringify({ contact: "alex@example.com" }));
  try {
    const r = await runResolver("contact", aliasPath);
    expect(r.out).toBe("alex@example.com");
  } finally {
    teardown();
  }
});

test("alias values that are neither phone nor email are silently ignored", async () => {
  // "not-a-phone-or-email" is rejected; resolver falls through to AddressBook
  // which will return its own answer (or empty). We just confirm the alias
  // value is not blindly returned.
  const aliasPath = setupAliases(JSON.stringify({ randomalias: "not-a-phone-or-email" }));
  try {
    const r = await runResolver("randomalias", aliasPath);
    expect(r.out).not.toBe("not-a-phone-or-email");
  } finally {
    teardown();
  }
});

test("missing alias file falls through to AddressBook (no error)", async () => {
  const r = await runResolver("xx-no-such-contact-xx", "/nonexistent/contact-aliases.json");
  expect(r.exit).toBe(0);
  // AddressBook won't find this, returns empty. The point is no crash.
  expect(r.err).toBe("");
});

test("malformed alias file is silently ignored", async () => {
  const aliasPath = setupAliases("{ this is not valid json");
  try {
    const r = await runResolver("xx-no-such-contact-xx", aliasPath);
    expect(r.exit).toBe(0);
    expect(r.err).toBe("");
  } finally {
    teardown();
  }
});

test("non-object alias JSON is silently ignored", async () => {
  const aliasPath = setupAliases(JSON.stringify(["array", "not", "object"]));
  try {
    const r = await runResolver("xx-no-such-contact-xx", aliasPath);
    expect(r.exit).toBe(0);
    expect(r.err).toBe("");
  } finally {
    teardown();
  }
});

test("non-string alias values are skipped (mixed-type file)", async () => {
  const aliasPath = setupAliases(JSON.stringify({
    dad: "+16048092405",
    badvalue: 42,
    nested: { phone: "+1xxxxxxxxxx" },
  }));
  try {
    expect((await runResolver("dad", aliasPath)).out).toBe("+16048092405");
    // 'badvalue' and 'nested' silently dropped; resolver falls through.
    expect((await runResolver("badvalue", aliasPath)).out).not.toBe("42");
  } finally {
    teardown();
  }
});
