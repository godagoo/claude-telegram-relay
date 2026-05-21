import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { writeRelayVaultArtifacts } from "./vault-writer";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const HELPER = join(PROJECT_ROOT, "scripts", "_vault_handle_lookup.py");

// PR3.5 audit #4 regression (Codex 2026-05-21).
// When AddressBook returns no match, the relay should consult the user's
// per-contact vault notes for a `handle:` frontmatter field before
// falling back to message-text search. Notes live at:
//   $RELAY_OBSIDIAN_VAULT_DIR/02-Cross-Project/people/<slug>.md

async function setupVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vault-handle-"));
  await mkdir(join(root, "02-Cross-Project", "people"), { recursive: true });
  return root;
}

async function runLookup(
  alias: string,
  vaultRoot: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["python3", HELPER, alias], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RELAY_OBSIDIAN_VAULT_DIR: vaultRoot },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("vault lookup finds a handle by exact slug match", async () => {
  const root = await setupVault();
  try {
    await writeFile(
      join(root, "02-Cross-Project", "people", "conor.md"),
      `---
name: Conor McGrath
handle: +15551234567
last_updated: 2026-05-21
---

# Conor McGrath

Recent threads...
`,
    );
    const result = await runLookup("Conor", root);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("+15551234567");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vault lookup finds a writer-created full-name note by unique first-name alias", async () => {
  const root = await setupVault();
  try {
    await writeRelayVaultArtifacts(
      {
        draftId: "550e8400-e29b-41d4-a716-446655440000",
        contactDisplayName: "Conor McGrath",
        contactHandle: "+15551234567",
        userInstruction: "tell him Saturday works",
        draftBody: "Saturday works, what time were you thinking",
        contextMessages: [],
      },
      { vaultRoot: root, now: new Date("2026-05-21T14:23:05.000Z") },
    );

    const result = await runLookup("Conor", root);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("+15551234567");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vault lookup refuses ambiguous first-name prefix matches", async () => {
  const root = await setupVault();
  try {
    await writeFile(
      join(root, "02-Cross-Project", "people", "conor-mcgrath.md"),
      `---
handle: +15551234567
---
`,
    );
    await writeFile(
      join(root, "02-Cross-Project", "people", "conor-smith.md"),
      `---
handle: +15557654321
---
`,
    );

    const result = await runLookup("Conor", root);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vault lookup handles quoted frontmatter values", async () => {
  const root = await setupVault();
  try {
    await writeFile(
      join(root, "02-Cross-Project", "people", "alice.md"),
      `---
handle: "alice@example.com"
---
body
`,
    );
    const result = await runLookup("alice", root);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("alice@example.com");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vault lookup handles single-quoted frontmatter values", async () => {
  const root = await setupVault();
  try {
    await writeFile(
      join(root, "02-Cross-Project", "people", "bob.md"),
      `---
handle: 'bob@example.com'
---
`,
    );
    const result = await runLookup("bob", root);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("bob@example.com");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vault lookup returns empty when no matching note exists", async () => {
  const root = await setupVault();
  try {
    const result = await runLookup("nonexistent", root);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vault lookup returns empty when frontmatter lacks a handle field", async () => {
  const root = await setupVault();
  try {
    await writeFile(
      join(root, "02-Cross-Project", "people", "no-handle.md"),
      `---
name: Person With No Handle
last_updated: 2026-05-21
---

No handle here.
`,
    );
    const result = await runLookup("no handle", root);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vault lookup slugifies aliases with punctuation and spaces", async () => {
  const root = await setupVault();
  try {
    // Filename is the kebab-case slug. The user types the natural alias.
    await writeFile(
      join(root, "02-Cross-Project", "people", "mark-stevens.md"),
      `---
handle: +15551239999
---
`,
    );
    const result = await runLookup("Mark Stevens", root);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("+15551239999");

    const punct = await runLookup("mark.stevens", root);
    expect(punct.stdout).toBe("+15551239999");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vault lookup ignores notes without frontmatter delimiter", async () => {
  const root = await setupVault();
  try {
    await writeFile(
      join(root, "02-Cross-Project", "people", "plain.md"),
      `# Plain note
handle: +15551111111
`,
    );
    const result = await runLookup("plain", root);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
