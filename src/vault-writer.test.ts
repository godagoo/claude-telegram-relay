import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildPerThreadFileInitial,
  formatContactSummaryUpdate,
  formatDailySessionLine,
  formatPerThreadEntry,
  slugifyContact,
  writeRelayVaultArtifacts,
  type VaultContextMessage,
  type VaultWriterInput,
} from "./vault-writer";

const FIXED_NOW = new Date("2026-05-21T14:23:05.000Z");
const TODAY = "2026-05-21";
const SAMPLE_DRAFT_ID = "550e8400-e29b-41d4-a716-446655440000";

function sampleInput(overrides: Partial<VaultWriterInput> = {}): VaultWriterInput {
  return {
    draftId: SAMPLE_DRAFT_ID,
    contactDisplayName: "Conor McGrath",
    contactHandle: "+15551234567",
    userInstruction: "tell him I can do Saturday",
    draftBody: "Saturday works, what time were you thinking",
    contextMessages: [
      { ts: "2026-05-21 09:00:00", sender: "them", text: "hey can you do this weekend" },
      { ts: "2026-05-21 09:01:00", sender: "me", text: "let me check my calendar" },
    ],
    ...overrides,
  };
}

// ----- slugifyContact -----

test("slugifyContact lowercases and kebabs a display name", () => {
  expect(slugifyContact("Conor McGrath")).toBe("conor-mcgrath");
  expect(slugifyContact("Madison Rose")).toBe("madison-rose");
});

test("slugifyContact strips punctuation and runs of separators", () => {
  expect(slugifyContact("O'Brien, Sean")).toBe("o-brien-sean");
  expect(slugifyContact("Dr. Alice Smith, Jr.")).toBe("dr-alice-smith-jr");
});

test("slugifyContact handles direct identifiers without losing entropy", () => {
  expect(slugifyContact("+15551234567")).toBe("15551234567");
  expect(slugifyContact("alice@example.com")).toBe("alice-example-com");
});

test("slugifyContact falls back to a stable string when input has no alphanumerics", () => {
  expect(slugifyContact("!!!")).toBe("unknown-contact");
  expect(slugifyContact("")).toBe("unknown-contact");
  expect(slugifyContact("   ")).toBe("unknown-contact");
});

// ----- formatPerThreadEntry -----

test("formatPerThreadEntry includes instruction, context, draft, and metadata", () => {
  const entry = formatPerThreadEntry(sampleInput(), FIXED_NOW);
  expect(entry).toContain("## ");
  expect(entry).toContain(" draft staged");
  expect(entry).toContain("Draft id");
  expect(entry).toContain(SAMPLE_DRAFT_ID);
  expect(entry).toContain("+15551234567");
  expect(entry).toContain("### Instruction");
  expect(entry).toContain("tell him I can do Saturday");
  expect(entry).toContain("### Context");
  expect(entry).toContain("hey can you do this weekend");
  expect(entry).toContain("let me check my calendar");
  expect(entry).toContain("### Draft");
  expect(entry).toContain("Saturday works, what time were you thinking");
});

test("formatPerThreadEntry omits the Context section when no messages", () => {
  const entry = formatPerThreadEntry(
    sampleInput({ contextMessages: [] }),
    FIXED_NOW,
  );
  expect(entry).not.toContain("### Context");
  expect(entry).toContain("Context size:** 0 message(s)");
});

test("formatPerThreadEntry handles unresolved handle gracefully", () => {
  const entry = formatPerThreadEntry(
    sampleInput({ contactHandle: "" }),
    FIXED_NOW,
  );
  expect(entry).toContain("**Handle:** (unresolved)");
});

// ----- buildPerThreadFileInitial -----

test("buildPerThreadFileInitial emits frontmatter + heading + first entry", () => {
  const content = buildPerThreadFileInitial(sampleInput(), FIXED_NOW);
  expect(content.startsWith("---\n")).toBe(true);
  expect(content).toContain('name: "imessage-thread-conor-mcgrath-2026-05-21"');
  expect(content).toContain('contact: "Conor McGrath"');
  expect(content).toContain('handle: "+15551234567"');
  expect(content).toContain('last_updated: "2026-05-21"');
  expect(content).toContain("# iMessage thread: Conor McGrath (2026-05-21)");
  expect(content).toContain("Saturday works");
});

test("buildPerThreadFileInitial escapes double quotes in display names", () => {
  const content = buildPerThreadFileInitial(
    sampleInput({ contactDisplayName: 'Bob "the builder"' }),
    FIXED_NOW,
  );
  expect(content).toContain('contact: "Bob \\"the builder\\""');
});

// ----- formatContactSummaryUpdate -----

test("formatContactSummaryUpdate creates fresh note with frontmatter when no existing", () => {
  const content = formatContactSummaryUpdate(sampleInput(), FIXED_NOW);
  expect(content.startsWith("---\n")).toBe(true);
  expect(content).toContain('name: "contact-conor-mcgrath"');
  expect(content).toContain("# Conor McGrath");
  expect(content).toContain("## Recent Threads");
  expect(content).toContain("- [[2026-05-21|2026-05-21 conor-mcgrath]]");
  expect(content).toContain("## Topics");
  expect(content).toContain("- 2026-05-21: tell him I can do Saturday");
});

test("formatContactSummaryUpdate appends a new Topics line when called again on the same day", () => {
  const first = formatContactSummaryUpdate(sampleInput(), FIXED_NOW);
  const later = new Date(FIXED_NOW.getTime() + 60 * 60 * 1000);
  const updated = formatContactSummaryUpdate(
    sampleInput({ userInstruction: "actually push to Sunday" }),
    later,
    first,
  );
  // Both topic lines must be present, in insertion order (append-only).
  const topicSection = updated.split("## Topics")[1] ?? "";
  expect(topicSection).toContain("- 2026-05-21: tell him I can do Saturday");
  expect(topicSection).toContain("- 2026-05-21: actually push to Sunday");
  expect(topicSection.indexOf("Saturday")).toBeLessThan(
    topicSection.indexOf("Sunday"),
  );
});

test("formatContactSummaryUpdate deduplicates Recent Threads on the same day", () => {
  const first = formatContactSummaryUpdate(sampleInput(), FIXED_NOW);
  const updated = formatContactSummaryUpdate(sampleInput(), FIXED_NOW, first);
  // The wikilink should appear exactly once even after two invocations.
  const matches = updated.match(/\[\[2026-05-21\|2026-05-21 conor-mcgrath\]\]/g);
  expect(matches).not.toBeNull();
  expect(matches!.length).toBe(1);
});

test("formatContactSummaryUpdate adds a new Recent Threads entry for a new day", () => {
  const first = formatContactSummaryUpdate(sampleInput(), FIXED_NOW);
  const tomorrow = new Date("2026-05-22T10:00:00.000Z");
  const updated = formatContactSummaryUpdate(sampleInput(), tomorrow, first);
  expect(updated).toContain("[[2026-05-21|2026-05-21 conor-mcgrath]]");
  expect(updated).toContain("[[2026-05-22|2026-05-22 conor-mcgrath]]");
});

test("formatContactSummaryUpdate bumps last_updated in existing frontmatter", () => {
  const first = formatContactSummaryUpdate(sampleInput(), FIXED_NOW);
  const tomorrow = new Date("2026-05-22T10:00:00.000Z");
  const updated = formatContactSummaryUpdate(sampleInput(), tomorrow, first);
  expect(updated).toContain('last_updated: "2026-05-22"');
  expect(updated).not.toContain('last_updated: "2026-05-21"');
});

// ----- formatDailySessionLine -----

test("formatDailySessionLine produces one-line entry with time and wikilink", () => {
  const line = formatDailySessionLine(sampleInput(), FIXED_NOW);
  expect(line.startsWith("- ")).toBe(true);
  expect(line).toContain("Relayed reply to [[conor-mcgrath]]");
  expect(line).toContain("2 context msg(s)");
  expect(line).toContain(`draft id \`${SAMPLE_DRAFT_ID}\``);
  // Single line; the writer adds a trailing newline when appending.
  expect(line.includes("\n")).toBe(false);
});

// ----- writeRelayVaultArtifacts (filesystem integration) -----

async function makeTempVault(): Promise<string> {
  return mkdtemp(join(tmpdir(), "relay-vault-test-"));
}

test("writeRelayVaultArtifacts creates all three files on first invocation", async () => {
  const vaultRoot = await makeTempVault();
  try {
    const result = await writeRelayVaultArtifacts(sampleInput(), {
      vaultRoot,
      now: FIXED_NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.perThreadPath).toBeDefined();
    expect(result.contactSummaryPath).toBeDefined();
    expect(result.dailySessionPath).toBeDefined();
    expect(result.draftBodySha256).toMatch(/^[a-f0-9]{64}$/);

    const perThread = await readFile(result.perThreadPath!, "utf8");
    expect(perThread).toContain("Saturday works");
    expect(perThread).toContain('contact: "Conor McGrath"');

    const summary = await readFile(result.contactSummaryPath!, "utf8");
    expect(summary).toContain("# Conor McGrath");
    expect(summary).toContain("- 2026-05-21: tell him I can do Saturday");

    const daily = await readFile(result.dailySessionPath!, "utf8");
    expect(daily).toContain("Relayed reply to [[conor-mcgrath]]");
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("writeRelayVaultArtifacts appends to per-thread file on second same-day invocation", async () => {
  const vaultRoot = await makeTempVault();
  try {
    const first = await writeRelayVaultArtifacts(sampleInput(), {
      vaultRoot,
      now: FIXED_NOW,
    });
    const later = new Date(FIXED_NOW.getTime() + 60 * 60 * 1000);
    const second = await writeRelayVaultArtifacts(
      sampleInput({
        draftId: "11111111-2222-4333-8444-555555555555",
        userInstruction: "switch to Sunday actually",
        draftBody: "Sunday is better, same time",
      }),
      { vaultRoot, now: later },
    );
    expect(second.ok).toBe(true);
    expect(second.perThreadPath).toBe(first.perThreadPath);

    const perThread = await readFile(second.perThreadPath!, "utf8");
    // Both invocation sections present
    const sectionHeadings = perThread.match(/## \d{2}:\d{2}:\d{2} draft staged/g);
    expect(sectionHeadings).not.toBeNull();
    expect(sectionHeadings!.length).toBe(2);
    // Both bodies present
    expect(perThread).toContain("Saturday works");
    expect(perThread).toContain("Sunday is better");
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("writeRelayVaultArtifacts appends to daily session on multiple invocations", async () => {
  const vaultRoot = await makeTempVault();
  try {
    await writeRelayVaultArtifacts(sampleInput(), { vaultRoot, now: FIXED_NOW });
    await writeRelayVaultArtifacts(
      sampleInput({
        draftId: "22222222-3333-4444-8555-666666666666",
        contactDisplayName: "Madison Rose",
        contactHandle: "+15557654321",
      }),
      { vaultRoot, now: new Date(FIXED_NOW.getTime() + 30 * 60 * 1000) },
    );
    const dailyPath = join(vaultRoot, "03-Daily", `${TODAY}.md`);
    const daily = await readFile(dailyPath, "utf8");
    expect(daily).toContain("Relayed reply to [[conor-mcgrath]]");
    expect(daily).toContain("Relayed reply to [[madison-rose]]");
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("writeRelayVaultArtifacts honors a pre-existing daily session file", async () => {
  const vaultRoot = await makeTempVault();
  try {
    const dailyPath = join(vaultRoot, "03-Daily", `${TODAY}.md`);
    await Bun.write(dailyPath, "# Existing daily note\n\n- earlier work item\n");
    const result = await writeRelayVaultArtifacts(sampleInput(), {
      vaultRoot,
      now: FIXED_NOW,
    });
    expect(result.ok).toBe(true);
    const daily = await readFile(dailyPath, "utf8");
    expect(daily).toContain("# Existing daily note");
    expect(daily).toContain("earlier work item");
    expect(daily).toContain("Relayed reply to [[conor-mcgrath]]");
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("writeRelayVaultArtifacts persists vault files with 0600 mode", async () => {
  const vaultRoot = await makeTempVault();
  try {
    const result = await writeRelayVaultArtifacts(sampleInput(), {
      vaultRoot,
      now: FIXED_NOW,
    });
    expect(result.ok).toBe(true);
    for (const p of [result.perThreadPath, result.contactSummaryPath, result.dailySessionPath]) {
      if (!p) continue;
      const s = await stat(p);
      expect(s.mode & 0o777).toBe(0o600);
    }
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("writeRelayVaultArtifacts updates the contact summary in place across days", async () => {
  const vaultRoot = await makeTempVault();
  try {
    await writeRelayVaultArtifacts(sampleInput(), { vaultRoot, now: FIXED_NOW });
    const tomorrow = new Date("2026-05-22T10:00:00.000Z");
    await writeRelayVaultArtifacts(
      sampleInput({ userInstruction: "ask if she got the slides" }),
      { vaultRoot, now: tomorrow },
    );
    const summaryPath = join(vaultRoot, "02-Cross-Project", "people", "conor-mcgrath.md");
    const summary = await readFile(summaryPath, "utf8");
    expect(summary).toContain('last_updated: "2026-05-22"');
    expect(summary).toContain("[[2026-05-21|2026-05-21 conor-mcgrath]]");
    expect(summary).toContain("[[2026-05-22|2026-05-22 conor-mcgrath]]");
    expect(summary).toContain("- 2026-05-21: tell him I can do Saturday");
    expect(summary).toContain("- 2026-05-22: ask if she got the slides");
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("writeRelayVaultArtifacts uses contact handle slug when no display name", async () => {
  const vaultRoot = await makeTempVault();
  try {
    const result = await writeRelayVaultArtifacts(
      sampleInput({ contactDisplayName: "", contactHandle: "+15551234567" }),
      { vaultRoot, now: FIXED_NOW },
    );
    expect(result.ok).toBe(true);
    expect(result.perThreadPath).toContain("/imessage-threads/15551234567/");
    expect(result.contactSummaryPath).toContain("/people/15551234567.md");
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test("writeRelayVaultArtifacts returns ok=false with errors when vault root is unwritable", async () => {
  // /dev/null/vault is a path that can never be created or written to.
  const result = await writeRelayVaultArtifacts(sampleInput(), {
    vaultRoot: "/dev/null/vault",
    now: FIXED_NOW,
  });
  expect(result.ok).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
});

test("writeRelayVaultArtifacts never throws on partial failure", async () => {
  // Even on a bad path, the call should resolve, not reject.
  await expect(
    writeRelayVaultArtifacts(sampleInput(), {
      vaultRoot: "/dev/null/vault",
      now: FIXED_NOW,
    }),
  ).resolves.toBeDefined();
});

test("writeRelayVaultArtifacts preserves message body in vault but never logs it", async () => {
  const vaultRoot = await makeTempVault();
  try {
    const SECRET = "this should not be in stdout: nuclear codes";
    const result = await writeRelayVaultArtifacts(
      sampleInput({ draftBody: SECRET }),
      { vaultRoot, now: FIXED_NOW },
    );
    expect(result.ok).toBe(true);
    const perThread = await readFile(result.perThreadPath!, "utf8");
    expect(perThread).toContain(SECRET);
    // The result object itself must not echo the body.
    expect(JSON.stringify(result)).not.toContain(SECRET);
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});
