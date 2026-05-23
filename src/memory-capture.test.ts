import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolate writes from the real Obsidian vault BEFORE importing the module
// (the module reads MEMORY_CAPTURE_VAULT lazily but tests should still set it
// upfront so import-time work cannot escape).
const TMP_VAULT = mkdtempSync(join(tmpdir(), "mem-capture-"));
process.env.MEMORY_CAPTURE_VAULT = TMP_VAULT;

import {
  classifyMemoryCandidate,
  writeMemoryCandidate,
  renderMemoryFile,
  captureMemoryFromTurn,
} from "./memory-capture";

const PENDING = join(TMP_VAULT, "00-Inbox", "_pending-memories");
const RELAY_MEM = join(TMP_VAULT, "01-Projects", "claude-telegram-relay", "memory");
const MEDICOLEGAL_MEM = join(TMP_VAULT, "01-Projects", "Medicolegal-Case", "memory");

mkdirSync(RELAY_MEM, { recursive: true });
mkdirSync(MEDICOLEGAL_MEM, { recursive: true });

afterAll(() => {
  try {
    rmSync(TMP_VAULT, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function findCapturedFile(dir: string, slugFragment: string): string | null {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir)) {
    if (e.includes(slugFragment)) return join(dir, e);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. "From now on, keep Telegram replies concise" — high-confidence feedback
//    routed to claude-telegram-relay.
// ---------------------------------------------------------------------------
test("from-now-on + Telegram self-reference → high-confidence relay feedback", () => {
  const c = classifyMemoryCandidate({
    userText: "From now on, keep Telegram replies concise",
    assistantText: "Okay, will do.",
    anchoredProjects: [],
    retrievalUsed: false,
    retrievalHitCount: 0,
  });
  expect(c).not.toBeNull();
  expect(c!.kind).toBe("feedback");
  expect(c!.project).toBe("claude-telegram-relay");
  expect(c!.confidence).toBe("high");
  expect(c!.destination).toBe("project-memory");
  expect(c!.reason.startsWith("feedback-trigger:from_now_on:")).toBe(true);
  expect(c!.slug).toContain("telegram");
});

// ---------------------------------------------------------------------------
// 2. "Don't say draft above ... again" — relay behavior feedback (high).
// ---------------------------------------------------------------------------
test("don't say X again with relay-output quote → relay feedback", () => {
  const c = classifyMemoryCandidate({
    userText: "Don't say \"draft above, review and send manually\" again",
    assistantText: "Got it.",
    anchoredProjects: [],
    retrievalUsed: false,
    retrievalHitCount: 0,
  });
  expect(c).not.toBeNull();
  expect(c!.kind).toBe("feedback");
  expect(c!.project).toBe("claude-telegram-relay");
  expect(c!.reason.startsWith("feedback-trigger:dont_do_again:")).toBe(true);
  // "send manually" / "draft above" is a relay self-reference; project pinned.
  expect(c!.confidence).toBe("high");
});

test("'log this as an unacceptable response' → relay feedback", () => {
  const c = classifyMemoryCandidate({
    userText: "Please log this again as an unnacceptable response",
    assistantText: "Logged.",
    anchoredProjects: [],
    retrievalUsed: false,
    retrievalHitCount: 0,
  });
  expect(c).not.toBeNull();
  expect(c!.kind).toBe("feedback");
  expect(c!.project).toBe("claude-telegram-relay");
  expect(c!.reason.startsWith("feedback-trigger:log_unacceptable_response:")).toBe(true);
});

// ---------------------------------------------------------------------------
// 3. "Remember Peggy is the cleaner" — user fact, pending lane.
// ---------------------------------------------------------------------------
test("remember <person> is <role> with no anchor → fallback project (no inbox)", () => {
  const c = classifyMemoryCandidate({
    userText: "Remember Peggy is the cleaner",
    assistantText: "Noted.",
    anchoredProjects: [],
    availableProjects: [],
    retrievalUsed: false,
    retrievalHitCount: 0,
  });
  expect(c).not.toBeNull();
  expect(c!.kind).toBe("user");
  // Routing is now best-guess + fallback — never pending.
  expect(c!.project).toBe("claude-telegram-relay");
  expect(c!.destination).toBe("project-memory");
  expect(c!.confidence).toBe("medium");
  expect(c!.reason).toMatch(/^fact-trigger:remember_.*:fallback$/);
  expect(c!.tags).toContain("status/needs-routing");
});

test("MEMORY_CAPTURE_FALLBACK_PROJECT env overrides the catch-all", () => {
  const prev = process.env.MEMORY_CAPTURE_FALLBACK_PROJECT;
  process.env.MEMORY_CAPTURE_FALLBACK_PROJECT = "personal";
  try {
    const c = classifyMemoryCandidate({
      userText: "Remember Peggy is the cleaner",
      assistantText: "Noted.",
      anchoredProjects: [],
      availableProjects: [],
      retrievalUsed: false,
      retrievalHitCount: 0,
    });
    expect(c).not.toBeNull();
    expect(c!.project).toBe("personal");
    expect(c!.destination).toBe("project-memory");
    expect(c!.kind).toBe("user");
  } finally {
    if (prev === undefined) delete process.env.MEMORY_CAPTURE_FALLBACK_PROJECT;
    else process.env.MEMORY_CAPTURE_FALLBACK_PROJECT = prev;
  }
});

test("fallback prefers williamregan-home when it exists", () => {
  const c = classifyMemoryCandidate({
    userText: "Remember Peggy is the cleaner",
    assistantText: "Noted.",
    anchoredProjects: [],
    availableProjects: ["claude-telegram-relay", "williamregan-home"],
    retrievalUsed: false,
    retrievalHitCount: 0,
  });
  expect(c).not.toBeNull();
  expect(c!.project).toBe("williamregan-home");
  expect(c!.kind).toBe("user");
  expect(c!.destination).toBe("project-memory");
  expect(c!.reason).toMatch(/^fact-trigger:remember_.*:fallback$/);
});

test("availableProjects token scan routes by distinctive project word", () => {
  const c = classifyMemoryCandidate({
    userText: "Remember the Medicolegal binder is in the bottom drawer",
    assistantText: "Noted.",
    anchoredProjects: [],
    availableProjects: ["Medicolegal-Case", "claude-telegram-relay"],
    retrievalUsed: false,
    retrievalHitCount: 0,
  });
  expect(c).not.toBeNull();
  expect(c!.project).toBe("Medicolegal-Case");
  expect(c!.kind).toBe("project");
  expect(c!.destination).toBe("project-memory");
  expect(c!.reason).toMatch(/^fact-trigger:.*:available_project_token:medicolegal$/);
});

test("remember <person> is <role> WITH anchor → project memory", () => {
  const c = classifyMemoryCandidate({
    userText: "Remember Saint Amman is the supervisor on the appeal",
    assistantText: "Saved.",
    anchoredProjects: ["Medicolegal-Case"],
    retrievalUsed: true,
    retrievalHitCount: 3,
  });
  expect(c).not.toBeNull();
  expect(c!.project).toBe("Medicolegal-Case");
  expect(c!.destination).toBe("project-memory");
  expect(c!.kind).toBe("project");
  expect(c!.confidence).toBe("high");
});

// ---------------------------------------------------------------------------
// 4. "keep searching" — retrieval feedback only when project anchor present.
// ---------------------------------------------------------------------------
test("'keep searching' with anchored project → retrieval feedback captured", () => {
  const c = classifyMemoryCandidate({
    userText: "keep searching",
    assistantText: "Looking again.",
    anchoredProjects: ["Medicolegal-Case"],
    retrievalUsed: true,
    retrievalHitCount: 0,
  });
  expect(c).not.toBeNull();
  expect(c!.kind).toBe("feedback");
  expect(c!.project).toBe("Medicolegal-Case");
  expect(c!.tags).toContain("workflow/retrieval");
  expect(c!.reason.startsWith("retrieval-feedback:keep_searching:")).toBe(true);
});

test("'keep searching' with no anchor → skipped (too noisy)", () => {
  const c = classifyMemoryCandidate({
    userText: "keep searching",
    assistantText: "Sure.",
    anchoredProjects: [],
    retrievalUsed: true,
    retrievalHitCount: 0,
  });
  expect(c).toBeNull();
});

// ---------------------------------------------------------------------------
// 5. Random drafting request → no memory.
// ---------------------------------------------------------------------------
test("plain drafting request creates no memory", () => {
  expect(
    classifyMemoryCandidate({
      userText: "Draft an iMessage to Peggy saying thanks for last week",
      assistantText: "Here's the draft.",
      anchoredProjects: [],
      retrievalUsed: false,
      retrievalHitCount: 0,
    }),
  ).toBeNull();
});

test("'remember to ...' is a TODO, not a durable memory", () => {
  expect(
    classifyMemoryCandidate({
      userText: "Remember to email mom on Sunday",
      assistantText: "Will do.",
      anchoredProjects: [],
      retrievalUsed: false,
      retrievalHitCount: 0,
    }),
  ).toBeNull();
});

test("'don't save this' suppresses capture even with other triggers", () => {
  expect(
    classifyMemoryCandidate({
      userText: "Remember that — actually don't save this",
      assistantText: "Okay.",
      anchoredProjects: [],
      retrievalUsed: false,
      retrievalHitCount: 0,
    }),
  ).toBeNull();
});

// ---------------------------------------------------------------------------
// 6. Private email/iMessage draft body does not get saved.
// ---------------------------------------------------------------------------
test("turn with iMessage draft markers in assistant text is not captured", () => {
  // Even if the user's message contains "remember Peggy" verbatim, the
  // assistantText carries the marker block — never save a draft turn.
  const c = classifyMemoryCandidate({
    userText: "Remember Peggy is the cleaner and draft her an iMessage saying thanks",
    assistantText:
      "Here's the draft for Peggy:\n<<<IMESSAGE_DRAFT>>>\nThanks for last week!\n<<<END_IMESSAGE_DRAFT>>>",
    anchoredProjects: [],
    retrievalUsed: false,
    retrievalHitCount: 0,
  });
  expect(c).toBeNull();
});

// ---------------------------------------------------------------------------
// 7. Scalar aliases/tags are emitted as valid YAML flow lists.
// ---------------------------------------------------------------------------
test("renderMemoryFile emits aliases/tags as YAML flow lists", () => {
  const c = classifyMemoryCandidate({
    userText: "From now on, prefer bullets in Telegram replies",
    assistantText: "Got it.",
    anchoredProjects: [],
    retrievalUsed: false,
    retrievalHitCount: 0,
  });
  expect(c).not.toBeNull();
  const out = renderMemoryFile(c!);
  // Frontmatter block present.
  expect(out.startsWith("---\n")).toBe(true);
  // Flow lists like `tags: ["a", "b"]` (never `tags: a` and never `tags: [c, h, a, r]`).
  expect(out).toMatch(/^tags: \[".*"\]$/m);
  expect(out).toMatch(/^aliases: \[".*"\]$/m);
  // metadata nested correctly (node_type + type only).
  expect(out).toMatch(/^metadata:\n  node_type: memory\n  type: feedback$/m);
  // Required canonical keys present.
  for (const key of [
    "name:",
    "description:",
    "project:",
    "status:",
    "criticality:",
    "confidence:",
    "source:",
    "captured_at:",
    "last_updated:",
    "decay_after:",
    "originSessionId:",
    "origin_note:",
  ]) {
    expect(out.includes(`\n${key}`) || out.startsWith(key)).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// 8. Duplicate candidates are skipped; existing files are not overwritten.
// ---------------------------------------------------------------------------
test("writeMemoryCandidate writes once, then dedupes on identical content", async () => {
  const c = classifyMemoryCandidate({
    userText: "From now on, prefer bullets over prose in Telegram replies",
    assistantText: "Got it.",
    anchoredProjects: [],
    retrievalUsed: false,
    retrievalHitCount: 0,
  });
  expect(c).not.toBeNull();

  // Pin `now` so body content (which contains the captured date) matches
  // between calls.
  const fixed = new Date("2026-05-12T14:23:00");
  const first = await writeMemoryCandidate(c!, fixed);
  expect(first.wrote).toBe(true);
  expect(first.path).toBeDefined();
  expect(existsSync(first.path!)).toBe(true);

  const second = await writeMemoryCandidate(c!, fixed);
  expect(second.wrote).toBe(false);
  expect(second.reason).toBe("duplicate_skipped");
  expect(second.path).toBe(first.path);
});

test("writeMemoryCandidate never overwrites a file with different content", async () => {
  const c = classifyMemoryCandidate({
    userText: "From now on, always include a code fence around shell commands",
    assistantText: "Got it.",
    anchoredProjects: [],
    retrievalUsed: false,
    retrievalHitCount: 0,
  });
  expect(c).not.toBeNull();

  const first = await writeMemoryCandidate(c!, new Date("2026-05-12T15:00:00"));
  expect(first.wrote).toBe(true);

  // Mutate body so the hash differs.
  const mutated = { ...c!, body: c!.body + "\nExtra line.\n" };
  const second = await writeMemoryCandidate(mutated, new Date("2026-05-12T15:01:00"));
  expect(second.wrote).toBe(false);
  expect(second.reason).toBe("exists_no_overwrite");

  // Original file content is preserved.
  const onDisk = readFileSync(first.path!, "utf-8");
  expect(onDisk.includes("Extra line.")).toBe(false);
});

test("writeMemoryCandidate rejects unsafe project path segments", async () => {
  const c = classifyMemoryCandidate({
    userText: "Remember Saint Amman is the supervisor on the appeal",
    assistantText: "Saved.",
    anchoredProjects: ["Medicolegal-Case"],
    retrievalUsed: true,
    retrievalHitCount: 3,
  });
  expect(c).not.toBeNull();

  const unsafe = { ...c!, project: "../outside" };
  const result = await writeMemoryCandidate(unsafe, new Date("2026-05-12T16:00:00"));
  expect(result.wrote).toBe(false);
  expect(result.reason).toBe("unsafe_project");
});

test("writeMemoryCandidate routes missing project dirs to pending instead of creating them", async () => {
  const c = classifyMemoryCandidate({
    userText: "Remember Foobar is the project with the blue binder",
    assistantText: "Saved.",
    anchoredProjects: ["Missing-Project"],
    retrievalUsed: true,
    retrievalHitCount: 1,
  });
  expect(c).not.toBeNull();
  const result = await writeMemoryCandidate(c!, new Date("2026-05-12T16:05:00"));
  expect(result.wrote).toBe(true);
  expect(result.reason).toBe("project_missing_routed_pending");
  expect(result.path!.startsWith(PENDING)).toBe(true);
  expect(existsSync(join(TMP_VAULT, "01-Projects", "Missing-Project"))).toBe(false);
  const content = readFileSync(result.path!, "utf-8");
  expect(content).toContain("status: pending");
  expect(content).toContain("status/pending-review");
});

// ---------------------------------------------------------------------------
// End-to-end orchestrator
// ---------------------------------------------------------------------------
test("captureMemoryFromTurn writes a real file into the relay project memory dir", async () => {
  const result = await captureMemoryFromTurn({
    userText: "From now on, don't end drafts with policy footers",
    assistantText: "Understood.",
    anchoredProjects: [],
    retrievalUsed: false,
    retrievalHitCount: 0,
  });
  expect(result.candidate).not.toBeNull();
  expect(result.wrote).toBe(true);
  expect(result.path).toBeDefined();
  const file = findCapturedFile(RELAY_MEM, "policy");
  expect(file).not.toBeNull();
});

test("captureMemoryFromTurn routes ambiguous facts to the fallback project, not pending", async () => {
  const result = await captureMemoryFromTurn({
    userText: "Remember Peggy is the cleaner",
    assistantText: "Noted.",
    anchoredProjects: [],
    availableProjects: [],
    retrievalUsed: false,
    retrievalHitCount: 0,
  });
  expect(result.wrote).toBe(true);
  expect(result.path).toBeDefined();
  // Lands in the relay project (the default catch-all), never the inbox.
  expect(result.path!.startsWith(RELAY_MEM)).toBe(true);
  const inInbox = findCapturedFile(PENDING, "peggy");
  expect(inInbox).toBeNull();
});

test("captureMemoryFromTurn writes Medicolegal-Case candidate to that project dir", async () => {
  const result = await captureMemoryFromTurn({
    userText: "Remember the MIET hearing date is the third week of June",
    assistantText: "Saved.",
    anchoredProjects: ["Medicolegal-Case"],
    retrievalUsed: true,
    retrievalHitCount: 2,
  });
  expect(result.wrote).toBe(true);
  expect(result.path).toBeDefined();
  expect(result.path!.startsWith(MEDICOLEGAL_MEM)).toBe(true);
});

test("captureMemoryFromTurn returns no_candidate on a benign turn", async () => {
  const result = await captureMemoryFromTurn({
    userText: "What time is it?",
    assistantText: "It's 2 PM.",
    anchoredProjects: [],
    retrievalUsed: false,
    retrievalHitCount: 0,
  });
  expect(result.wrote).toBe(false);
  expect(result.reason).toBe("no_candidate");
  expect(result.candidate).toBeNull();
});

// Sanity: ensure the suite cleaned up the tmp vault contents we created.
test("__tmp vault exists during run", () => {
  expect(existsSync(TMP_VAULT)).toBe(true);
});
