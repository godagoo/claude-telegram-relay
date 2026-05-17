// memory-capture.ts
// Deterministic, dependency-free background memory capture for Telegram
// turns. Reads the final user/assistant pair, classifies whether the turn
// contains durable memory, writes a Markdown candidate into the Obsidian
// vault for the existing reconciler to normalize, and never overwrites
// existing notes. No LLM, no embeddings, no new server.
//
// Hard rules (from the handoff):
// - Never block the Telegram reply on capture.
// - Never overwrite an existing memory note.
// - Never store iMessage/email draft bodies as durable memory.
// - When unsure, route to the personal fallback project or skip.
// - When the user says "don't remember/save this", skip.

import { link, mkdir, open, readFile, readdir, unlink } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";

const HOME = process.env.HOME ?? homedir();

function vaultRoot(): string {
  // Resolved lazily so tests can set MEMORY_CAPTURE_VAULT after importing.
  return process.env.MEMORY_CAPTURE_VAULT ?? join(HOME, "ObsidianVault");
}

function projectsDir(): string {
  return join(vaultRoot(), "01-Projects");
}

function pendingDir(): string {
  return join(vaultRoot(), "00-Inbox", "_pending-memories");
}

const RELAY_PROJECT = "claude-telegram-relay";

const PREFERRED_FALLBACK_PROJECTS = [
  "williamregan-home",
  "williamregan-Projects",
  RELAY_PROJECT,
];

/** When no other signal points at a project, route to a personal catch-all.
 *  Overridable via MEMORY_CAPTURE_FALLBACK_PROJECT so the user can re-target
 *  without code changes. */
function fallbackProject(availableProjects?: string[]): string {
  const configured = process.env.MEMORY_CAPTURE_FALLBACK_PROJECT?.trim();
  if (configured) return configured;
  const projects = availableProjects ?? getAvailableProjectsFromDisk();
  for (const preferred of PREFERRED_FALLBACK_PROJECTS) {
    if (projects.includes(preferred)) return preferred;
  }
  return RELAY_PROJECT;
}

// Cache of `01-Projects/*` dirs that look like real projects (have a
// memory/ subdir). Keyed by vault root so tests that flip
// MEMORY_CAPTURE_VAULT don't see stale data.
let _projectsCache: { root: string; projects: string[] } | null = null;

function getAvailableProjectsFromDisk(): string[] {
  const root = vaultRoot();
  if (_projectsCache && _projectsCache.root === root) {
    return _projectsCache.projects;
  }
  const dir = projectsDir();
  let projects: string[] = [];
  try {
    projects = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "memory")))
      .map((e) => e.name);
  } catch {
    projects = [];
  }
  _projectsCache = { root, projects };
  return projects;
}

/** Test-only: clear the cached project list so a test can flip the vault and
 *  re-scan. Not exported via the public API surface. */
export function __resetMemoryCaptureCachesForTests(): void {
  _projectsCache = null;
}

// Tokens shorter than this are too generic to be useful project anchors
// ("app", "test", "case"). Six characters keeps distinctive words like
// "telegram", "medicolegal", "anesthesia" while filtering noise.
const PROJECT_TOKEN_MIN_LEN = 6;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Soft project routing: scan project folder names for a distinctive token
 *  that also appears as a whole word in the user text. Longest match wins so
 *  more specific project names beat shorter overlaps. */
export function inferProjectFromAvailable(
  text: string,
  projects: string[],
): { project: string; token: string } | null {
  if (!text || projects.length === 0) return null;
  let best: { project: string; token: string } | null = null;
  for (const project of projects) {
    const tokens = project
      .split(/[-_\s.]+/)
      .filter((t) => t.length >= PROJECT_TOKEN_MIN_LEN);
    for (const tok of tokens) {
      const re = new RegExp(`\\b${escapeRegExp(tok)}\\b`, "i");
      if (re.test(text)) {
        if (!best || tok.length > best.token.length) {
          best = { project, token: tok };
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryKind = "feedback" | "project" | "user" | "reference" | "bug";

export interface MemoryCaptureCandidate {
  kind: MemoryKind;
  project: string | null;
  confidence: "high" | "medium" | "low";
  criticality: "critical" | "high" | "medium" | "low";
  title: string;
  description: string;
  aliases: string[];
  tags: string[];
  body: string;
  destination: "project-memory" | "pending";
  /** Slug used in the filename (without prefix or extension). */
  slug: string;
  /** Machine-readable reason for the capture decision. */
  reason: string;
}

export interface MemoryCaptureInput {
  userText: string;
  assistantText: string;
  anchoredProjects: string[];
  retrievalUsed: boolean;
  retrievalHitCount: number;
  /** Optional override of "which project folders exist". When omitted the
   *  classifier reads `01-Projects/*` from disk (cached). Tests pass an
   *  explicit list so they don't depend on the real vault state. */
  availableProjects?: string[];
}

export interface MemoryCaptureWriteResult {
  wrote: boolean;
  path?: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Classifier rules
// ---------------------------------------------------------------------------

// Hard suppression — user explicitly tells us NOT to remember this turn.
const SUPPRESS_RE = /\bdon'?t\s+(?:remember|save|note)\s+(?:this|that)\b/i;

// "Remember to <verb>" is a TODO, not a durable fact.
const REMEMBER_TODO_RE = /\bremember\s+to\b/i;

// Pure-draft-request detector. When the user is asking for a draft we never
// capture — the body is private and not durable memory material.
const DRAFT_REQUEST_RE =
  /\b(?:draft|compose|respond|reply|shoot|send)\b[\s\S]{0,40}?\b(?:an?\s+)?(?:imessage|sms|text|email|message|note|letter|to)\b/i;

// Triggers that classify the turn as feedback (a behavioral rule).
const FEEDBACK_TRIGGERS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\b(?:please\s+)?log\s+this\b[\s\S]{0,120}\b(?:un+acceptable|wrong|bad|poor)\s+response\b/i,
    reason: "log_unacceptable_response",
  },
  { re: /\bthis\s+response\s+(?:is|was)\s+(?:un+acceptable|wrong|bad|poor)\b/i, reason: "unacceptable_response" },
  { re: /\bfrom now on\b/i, reason: "from_now_on" },
  { re: /\bgoing forward\b/i, reason: "going_forward" },
  { re: /\buse this going forward\b/i, reason: "use_going_forward" },
  {
    // "Don't say X again", "Don't do that again", "Don't reply with X again"
    re: /\bdon'?t\s+(?:do|say|use|reply|respond|write|append|end)\b[\s\S]{0,80}?\bagain\b/i,
    reason: "dont_do_again",
  },
  { re: /\blesson learned\b/i, reason: "lesson_learned" },
  { re: /\bthat (?:was|is|'?s) wrong\b/i, reason: "that_was_wrong" },
];

// Triggers that classify the turn as a user/project fact.
const FACT_TRIGGERS: Array<{ re: RegExp; reason: string }> = [
  // "Remember that X is Y" / "Remember this: X"
  { re: /\bremember\s+(?:that|this)\b/i, reason: "remember_that_this" },
  // "Remember Peggy is the cleaner" — proper-noun pattern with copula.
  {
    re: /\bremember\s+\S+(?:\s+\S+){0,3}\s+(?:is|are|was|were|means|equals|=)\b/i,
    reason: "remember_x_is_y",
  },
  { re: /\bplease remember\b/i, reason: "please_remember" },
  { re: /\bmake\s+(?:a|the)\s+note\b/i, reason: "make_a_note" },
  { re: /\bsave\s+(?:this|that)\b/i, reason: "save_this" },
];

// Retrieval feedback triggers — only meaningful when retrieval ran.
const RETRIEVAL_FEEDBACK_TRIGGERS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bkeep searching\b/i, reason: "keep_searching" },
  { re: /\bthat'?s not it\b/i, reason: "not_it" },
  { re: /\bnot that (?:one|file|project|book|topic)\b/i, reason: "not_that_thing" },
  { re: /\bi\s+(?:actually\s+)?meant\b/i, reason: "i_meant" },
  { re: /\bwrong\s+(?:file|project|book|topic)\b/i, reason: "wrong_thing" },
  { re: /\btry\s+\S+(?:\s+\S+){0,4}\s+instead\b/i, reason: "try_x_instead" },
];

// Tells that the user is talking about the bot itself.
const RELAY_SELF_REFERENCE_RE =
  /\b(?:the\s+bot|this\s+bot|the\s+relay|telegram\b|telegram\s+repl(?:y|ies)|your\s+repl(?:y|ies)|your\s+responses?|your\s+answers?|in\s+telegram\b|draft\s+above|send\s+manually|review\s+and\s+send)\b/i;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface TriggerMatch {
  family: "feedback-trigger" | "fact-trigger" | "retrieval-feedback";
  reason: string;
}

function findFirstMatch(text: string, triggers: Array<{ re: RegExp; reason: string }>): string | null {
  for (const t of triggers) {
    if (t.re.test(text)) return t.reason;
  }
  return null;
}

function detectTrigger(input: MemoryCaptureInput): TriggerMatch | null {
  const u = input.userText;
  const fb = findFirstMatch(u, FEEDBACK_TRIGGERS);
  if (fb) return { family: "feedback-trigger", reason: fb };
  const fact = findFirstMatch(u, FACT_TRIGGERS);
  if (fact) return { family: "fact-trigger", reason: fact };
  if (input.retrievalUsed) {
    const rf = findFirstMatch(u, RETRIEVAL_FEEDBACK_TRIGGERS);
    if (rf) return { family: "retrieval-feedback", reason: rf };
  }
  return null;
}

export function classifyMemoryCandidate(
  input: MemoryCaptureInput,
): MemoryCaptureCandidate | null {
  const user = (input.userText ?? "").trim();
  if (user.length < 4) return null;

  if (SUPPRESS_RE.test(user)) return null;
  if (REMEMBER_TODO_RE.test(user)) return null;

  const trigger = detectTrigger(input);
  if (!trigger) return null;

  // Drafts are out — even if a memory trigger appears inside a draft request,
  // the body is private and not durable. Retrieval feedback is exempt because
  // "keep searching" never co-occurs with a draft intent in practice.
  if (trigger.family !== "retrieval-feedback" && DRAFT_REQUEST_RE.test(user)) {
    return null;
  }

  // Belt and suspenders: never capture if the assistant emitted an iMessage
  // draft block. That turn is, by definition, a draft turn.
  if (
    input.assistantText.includes("<<<IMESSAGE_DRAFT>>>") ||
    input.assistantText.includes("<<<END_IMESSAGE_DRAFT>>>")
  ) {
    return null;
  }

  // Project inference, in priority order. The user does not want an inbox
  // lane — when no stronger signal exists, fall through to a soft scan of
  // existing project folders and then to a configurable fallback project.
  let project: string | null = null;
  let projectReason = "none";
  const availableProjects = input.availableProjects ?? getAvailableProjectsFromDisk();
  if (input.anchoredProjects.length > 0) {
    project = input.anchoredProjects[0];
    projectReason = "anchored";
  } else if (RELAY_SELF_REFERENCE_RE.test(user)) {
    project = RELAY_PROJECT;
    projectReason = "relay_self_reference";
  } else if (trigger.family === "feedback-trigger") {
    // Behavioral correction with no explicit project — the user is almost
    // always correcting the bot.
    project = RELAY_PROJECT;
    projectReason = "feedback_default_relay";
  } else {
    const guessed = inferProjectFromAvailable(user, availableProjects);
    if (guessed) {
      project = guessed.project;
      projectReason = `available_project_token:${guessed.token.toLowerCase()}`;
    }
  }

  // Retrieval-feedback with no project anchor is genuinely ambiguous — a bare
  // "keep searching" with no clear target would just clutter the fallback
  // project. Drop it on the floor rather than misroute.
  if (trigger.family === "retrieval-feedback" && !project) return null;

  // Final fallback: never leave a fact-trigger unrouted. The user explicitly
  // does not want a pending inbox to review.
  if (!project) {
    project = fallbackProject(availableProjects);
    projectReason = "fallback";
  }

  // Kind selection.
  let kind: MemoryKind;
  if (trigger.family === "feedback-trigger" || trigger.family === "retrieval-feedback") {
    kind = "feedback";
  } else if (
    project !== RELAY_PROJECT &&
    project !== fallbackProject(availableProjects)
  ) {
    kind = "project";
  } else {
    kind = "user";
  }

  // Classifier never emits pending any more — the writer keeps a safety net
  // for the rare case of a missing project dir, but the normal route is
  // always project-memory.
  const destination: "project-memory" | "pending" = "project-memory";
  const confidence: "high" | "medium" | "low" =
    trigger.family === "retrieval-feedback"
      ? "medium"
      : projectReason === "fallback"
      ? "medium"
      : "high";
  const criticality: "critical" | "high" | "medium" | "low" =
    kind === "feedback" ? "high" : "medium";

  const ruleClause = extractRuleClause(user, trigger.family);
  const title = truncate(capitalizeFirst(ruleClause), 90);
  const slug = slugify(ruleClause) || slugify(user) || `capture-${Date.now()}`;
  const description = `Captured from Telegram: ${truncate(user, 140)}`;

  const aliases = uniqueShort([title]);
  const tags: string[] = ["source/telegram-relay"];
  if (kind === "feedback") tags.push("artifact/rule");
  if (trigger.family === "retrieval-feedback") tags.push("workflow/retrieval");
  if (projectReason === "fallback") tags.push("status/needs-routing");

  const body = renderBody({
    title,
    rule: ruleClause,
    userText: user,
    trigger,
    project,
    kind,
    retrievalHitCount: input.retrievalHitCount,
  });

  return {
    kind,
    project,
    confidence,
    criticality,
    title,
    description,
    aliases,
    tags,
    body,
    destination,
    slug,
    reason: `${trigger.family}:${trigger.reason}:${projectReason}`,
  };
}

// ---------------------------------------------------------------------------
// Rule-clause extraction, slug, body
// ---------------------------------------------------------------------------

function extractRuleClause(user: string, family: TriggerMatch["family"]): string {
  let s = user;

  // Strip leading trigger phrases so the slug/title is the rule itself.
  s = s.replace(/^\s*from now on,?\s+/i, "");
  s = s.replace(/^\s*going forward,?\s+/i, "");
  s = s.replace(/^\s*please remember,?\s+(?:that\s+|this\s+)?/i, "");
  s = s.replace(/^\s*remember,?\s+(?:that\s+|this\s+)?/i, "");
  s = s.replace(/^\s*make\s+(?:a|the)\s+note(?:\s+(?:that|to|of))?:?\s+/i, "");
  s = s.replace(/^\s*save\s+(?:this|that),?\s*:?\s*/i, "");
  s = s.replace(/^\s*lesson learned:?\s*/i, "");

  // Take the first sentence so multi-sentence turns don't blow up the slug.
  const firstSentence = s.split(/(?<=[.!?])\s+/)[0]?.trim() ?? s.trim();
  const out = firstSentence || s.trim() || user.trim();

  // For retrieval feedback, prefix with a short qualifier so titles read clearly.
  if (family === "retrieval-feedback") return `Retrieval feedback: ${out}`;
  return out;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function uniqueShort(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const v = it.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v.length > 80 ? v.slice(0, 80) : v);
  }
  return out;
}

interface BodyArgs {
  title: string;
  rule: string;
  userText: string;
  trigger: TriggerMatch;
  project: string | null;
  kind: MemoryKind;
  retrievalHitCount: number;
}

function renderBody(args: BodyArgs): string {
  const today = formatDate(new Date());
  const evidenceQuote = truncate(args.userText.replace(/\s+/g, " "), 280);

  const howToApply = (() => {
    if (args.trigger.family === "retrieval-feedback") {
      return "Apply when retrieval surfaces results from the wrong project or topic. Prefer the anchor associated with this memory before falling back to generic FTS.";
    }
    if (args.kind === "feedback") {
      return args.project === RELAY_PROJECT
        ? "Apply in Telegram-facing replies and draft confirmations from this relay."
        : "Apply in interactions related to this project.";
    }
    if (args.kind === "project") {
      return "Treat as a stable project fact when reasoning about this project.";
    }
    return "Treat as a stable user fact when relevant.";
  })();

  const lines: string[] = [];
  lines.push(`# ${args.title}`);
  lines.push("");
  lines.push("## Rule");
  lines.push("");
  lines.push(args.rule);
  lines.push("");
  lines.push("## Evidence");
  lines.push("");
  lines.push(`- Captured from Telegram interaction on ${today}.`);
  lines.push(`- Trigger: \`${args.trigger.family}:${args.trigger.reason}\`.`);
  lines.push(`- User text: "${evidenceQuote}"`);
  if (args.trigger.family === "retrieval-feedback") {
    lines.push(`- Retrieval hits this turn: ${args.retrievalHitCount}`);
  }
  lines.push("");
  lines.push("## How to apply");
  lines.push("");
  lines.push(howToApply);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Frontmatter + file rendering
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatCaptured(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function tsForFilename(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function yamlQuoted(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlFlowList(items: string[]): string {
  if (!items || items.length === 0) return "[]";
  return "[" + items.map(yamlQuoted).join(", ") + "]";
}

export function renderMemoryFile(c: MemoryCaptureCandidate, now: Date = new Date()): string {
  const captured = formatCaptured(now);
  const updated = formatDate(now);
  const status = c.destination === "pending" ? "pending" : "active";

  const fm: string[] = [];
  fm.push("---");
  fm.push(`name: ${c.slug}`);
  fm.push(`description: ${yamlQuoted(c.description)}`);
  fm.push(`metadata:`);
  fm.push(`  node_type: memory`);
  fm.push(`  type: ${c.kind}`);
  fm.push(`project: ${c.project ?? ""}`);
  fm.push(`status: ${status}`);
  fm.push(`criticality: ${c.criticality}`);
  fm.push(`confidence: ${c.confidence}`);
  fm.push(`source: telegram-relay`);
  fm.push(`tags: ${yamlFlowList(c.tags)}`);
  fm.push(`aliases: ${yamlFlowList(c.aliases)}`);
  fm.push(`captured_at: ${yamlQuoted(captured)}`);
  fm.push(`last_updated: ${yamlQuoted(updated)}`);
  fm.push(`decay_after:`);
  fm.push(`originSessionId:`);
  fm.push(`origin_note:`);
  fm.push("---");
  fm.push("");
  const head = fm.join("\n");
  const body = c.body.endsWith("\n") ? c.body : c.body + "\n";
  return head + body;
}

// ---------------------------------------------------------------------------
// Write (atomic, dedupe, never overwrite)
// ---------------------------------------------------------------------------

async function safeReadFile(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return null;
  }
}

/** Hash the body block (everything after the closing `---\n`) so we can detect
 *  identical-content writes regardless of frontmatter timestamp drift. */
function bodyOnly(text: string): string {
  const m = text.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (m ? m[1] : text).trim();
}

async function findExistingByKindAndSlug(
  dir: string,
  kind: MemoryKind,
  slug: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  // Project-memory uses `<kind>_<slug>.md`; we also tolerate the pending
  // timestamp-prefixed form when scanning archives.
  const exact = `${kind}_${slug}.md`;
  for (const e of entries) {
    if (e === exact) return join(dir, e);
    if (e.endsWith(`_${kind}_${slug}.md`)) return join(dir, e);
  }
  return null;
}

function isSafeProjectSegment(project: string | null): project is string {
  return Boolean(
    project &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(project) &&
      project !== "." &&
      project !== "..",
  );
}

function asPendingCandidate(candidate: MemoryCaptureCandidate): MemoryCaptureCandidate {
  return {
    ...candidate,
    destination: "pending",
    tags: uniqueShort([...candidate.tags, "status/pending-review"]),
  };
}

async function atomicWriteNoOverwrite(target: string, content: string): Promise<boolean> {
  const tmp = join(
    dirname(target),
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${basename(target)}`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tmp, "wx");
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = null;

    // `rename` overwrites on POSIX. Hard-link first so an existing target
    // makes this fail instead, preserving the never-overwrite guarantee.
    await link(tmp, target);
    await unlink(tmp);
    return true;
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // ignore cleanup failures
      }
    }
    try {
      await unlink(tmp);
    } catch {
      // ignore cleanup failures
    }
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (code === "EEXIST") return false;
    throw err;
  }
}

export async function writeMemoryCandidate(
  candidate: MemoryCaptureCandidate,
  now: Date = new Date(),
): Promise<MemoryCaptureWriteResult> {
  if (candidate.destination === "project-memory" && !isSafeProjectSegment(candidate.project)) {
    return { wrote: false, reason: "unsafe_project" };
  }

  let effectiveCandidate = candidate;
  const dir =
    effectiveCandidate.destination === "project-memory"
      ? join(projectsDir(), effectiveCandidate.project as string, "memory")
      : pendingDir();

  // Never create arbitrary new project folders from classifier/config typos.
  // If the intended project memory dir is missing, keep the note reviewable
  // in pending instead of polluting 01-Projects.
  let effectiveDir = dir;
  let routeReason = "written";
  if (effectiveCandidate.destination === "project-memory" && !existsSync(effectiveDir)) {
    effectiveCandidate = asPendingCandidate(effectiveCandidate);
    effectiveDir = pendingDir();
    routeReason = "project_missing_routed_pending";
  }

  await mkdir(effectiveDir, { recursive: true });

  const filename =
    effectiveCandidate.destination === "pending"
      ? `${tsForFilename(now)}_${effectiveCandidate.kind}_${effectiveCandidate.slug}.md`
      : `${effectiveCandidate.kind}_${effectiveCandidate.slug}.md`;
  const target = join(effectiveDir, filename);

  const content = renderMemoryFile(effectiveCandidate, now);
  const newBodyHash = bodyOnly(content);

  // For project-memory we never overwrite. Dedup by kind+slug regardless of
  // timestamp. For pending we scan for an existing file with the same slug
  // so retries don't pile up duplicate notes minutes apart.
  const existingPath = await findExistingByKindAndSlug(
    effectiveDir,
    effectiveCandidate.kind,
    effectiveCandidate.slug,
  );
  if (existingPath) {
    const existing = await safeReadFile(existingPath);
    if (existing !== null && bodyOnly(existing) === newBodyHash) {
      return { wrote: false, path: existingPath, reason: "duplicate_skipped" };
    }
    return { wrote: false, path: existingPath, reason: "exists_no_overwrite" };
  }

  if (existsSync(target)) {
    return { wrote: false, path: target, reason: "exists_no_overwrite" };
  }

  const wrote = await atomicWriteNoOverwrite(target, content);
  if (!wrote) {
    return { wrote: false, path: target, reason: "exists_no_overwrite" };
  }
  return { wrote: true, path: target, reason: routeReason };
}

// ---------------------------------------------------------------------------
// Public orchestrator — fire-and-forget from relay.ts
// ---------------------------------------------------------------------------

export async function captureMemoryFromTurn(
  input: MemoryCaptureInput,
): Promise<MemoryCaptureWriteResult & { candidate: MemoryCaptureCandidate | null }> {
  const candidate = classifyMemoryCandidate(input);
  if (!candidate) {
    return { wrote: false, reason: "no_candidate", candidate: null };
  }
  const result = await writeMemoryCandidate(candidate);
  return { ...result, candidate };
}
