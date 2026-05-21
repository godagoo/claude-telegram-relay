// vault-writer.ts
// Write per-invocation artifacts to the user's Obsidian vault after an
// iMessage draft has been staged successfully. This is the Option D
// full-indexing layer the user explicitly chose: every drafted reply is
// recorded so future composer runs can read accumulated context.
//
// Paths (all relative to the vault root, default ~/ObsidianVault/):
//   01-Projects/claude-telegram-relay/imessage-threads/<slug>/YYYY-MM-DD.md
//     Per-thread daily log. New dated section appended per invocation.
//   02-Cross-Project/people/<slug>.md
//     Contact summary note. Updated in place with append-only Topics
//     section and a deduplicated Recent Threads list.
//   03-Daily/YYYY-MM-DD.md
//     Daily session log. One line appended per invocation.
//
// Failure mode: vault writes are best-effort and fire-and-forget. They
// happen AFTER the Telegram reply has been sent, so a vault write failure
// must never block or surface to the user. Errors are collected into the
// result and logged via the decision record; the relay carries on.
//
// Privacy: message bodies live inside vault files (the user accepted this
// in the Option D decision). Bodies must NEVER appear in stdout, stderr,
// or the decision log. The relay logs only paths and error reasons.

import { createHash, randomUUID } from "crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export const DEFAULT_VAULT_ROOT_ENV = "RELAY_OBSIDIAN_VAULT_DIR";
const PROJECT_FOLDER = "01-Projects/claude-telegram-relay";
const THREADS_SUBFOLDER = "imessage-threads";
const PEOPLE_FOLDER = "02-Cross-Project/people";
const DAILY_FOLDER = "03-Daily";

export interface VaultWriterInput {
  /** UUIDv4 from cldraft-payload.ts. Used for log correlation and idempotency. */
  draftId: string;
  /** Canonical display name from the contact resolver. Falls back to handle. */
  contactDisplayName: string;
  /** Resolved phone or email handle. */
  contactHandle: string;
  /** Pre-computed slug; if omitted, derived from contactDisplayName. */
  contactSlug?: string;
  /** Verbatim user message that initiated the draft request. */
  userInstruction: string;
  /** Composed draft body that was staged. Stored in the vault per Option D. */
  draftBody: string;
  /** Context messages used by the composer. May be empty. */
  contextMessages: VaultContextMessage[];
}

export interface VaultContextMessage {
  ts: string;
  sender: "me" | "them";
  text: string;
}

export interface VaultWriterOptions {
  /** Override the vault root for tests. Defaults to env var or ~/ObsidianVault. */
  vaultRoot?: string;
  /** Fixed clock for tests. Defaults to new Date(). */
  now?: Date;
}

export interface VaultWriterResult {
  ok: boolean;
  perThreadPath?: string;
  contactSummaryPath?: string;
  dailySessionPath?: string;
  draftBodySha256?: string;
  errors: string[];
}

export function defaultVaultRoot(): string {
  const override = process.env[DEFAULT_VAULT_ROOT_ENV];
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), "ObsidianVault");
}

/**
 * Lowercase-kebab slug from a free-form name or handle. The output is the
 * filename stem used under imessage-threads/<slug>/ and people/<slug>.md.
 * Stable across invocations so the same person always lands in the same file.
 */
export function slugifyContact(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "unknown-contact";
}

/** ISO date in UTC slice for filenames (YYYY-MM-DD). */
function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** HH:MM:SS in the system local timezone (matches the user's vault habits). */
function localTimeOfDay(now: Date): string {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function trimToOneLine(value: string, max = 240): string {
  const single = value.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1)}…`;
}

function escapeYamlString(value: string): string {
  // We always quote with double quotes, so only escape backslashes and double
  // quotes. Avoids mishandling characters in display names like "O'Brien".
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildFrontmatter(fields: Record<string, string>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: "${escapeYamlString(value)}"`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/**
 * Build the markdown body for a single per-thread invocation. The output is
 * appended to the per-thread daily file. Each invocation gets its own
 * timestamped section so the daily file shows the chronological draft
 * history for the contact.
 */
export function formatPerThreadEntry(
  input: VaultWriterInput,
  now: Date,
): string {
  const lines: string[] = [];
  lines.push(`## ${localTimeOfDay(now)} — draft staged`);
  lines.push("");
  lines.push(`- **Draft id:** \`${input.draftId}\``);
  lines.push(`- **Handle:** ${input.contactHandle || "(unresolved)"}`);
  lines.push(`- **Context size:** ${input.contextMessages.length} message(s)`);
  lines.push("");
  lines.push(`### Instruction`);
  lines.push("");
  lines.push(input.userInstruction.trim() || "(empty)");
  lines.push("");
  if (input.contextMessages.length > 0) {
    lines.push(`### Context`);
    lines.push("");
    for (const m of input.contextMessages) {
      const sender = m.sender === "me" ? "me" : "them";
      lines.push(`- \`${m.ts}\` **${sender}:** ${trimToOneLine(m.text, 400)}`);
    }
    lines.push("");
  }
  lines.push(`### Draft`);
  lines.push("");
  lines.push(input.draftBody.trimEnd());
  lines.push("");
  return lines.join("\n");
}

/**
 * Build the initial contents of a per-thread daily file (when it does not
 * exist yet). Includes frontmatter + a first invocation entry.
 */
export function buildPerThreadFileInitial(
  input: VaultWriterInput,
  now: Date,
): string {
  const slug = input.contactSlug ?? slugifyContact(input.contactDisplayName || input.contactHandle);
  const frontmatter = buildFrontmatter({
    name: `imessage-thread-${slug}-${isoDate(now)}`,
    description: `iMessage thread with ${input.contactDisplayName || input.contactHandle} on ${isoDate(now)}`,
    type: "reference",
    contact: input.contactDisplayName || "",
    handle: input.contactHandle || "",
    last_updated: isoDate(now),
  });
  const heading = `# iMessage thread — ${input.contactDisplayName || input.contactHandle} — ${isoDate(now)}\n\n`;
  return `${frontmatter}${heading}${formatPerThreadEntry(input, now)}`;
}

/**
 * Update the `last_updated` field in existing per-thread frontmatter when
 * appending. The rest of the frontmatter is preserved. If no frontmatter is
 * present (file was hand-edited), the existing content is left alone.
 */
function updateLastUpdated(existing: string, now: Date): string {
  const re = /^(---\n[\s\S]*?last_updated:\s*"?)([^"\n]+)("?\n[\s\S]*?---\n)/;
  return existing.replace(re, (_match, head, _value, tail) => {
    return `${head}${isoDate(now)}${tail}`;
  });
}

/**
 * Compose the contact summary note. When `existing` is provided, the new
 * Recent Threads entry is added (deduplicated) and a new Topics line is
 * appended. When `existing` is undefined, a fresh note with frontmatter is
 * created.
 */
export function formatContactSummaryUpdate(
  input: VaultWriterInput,
  now: Date,
  existing?: string,
): string {
  const slug = input.contactSlug ?? slugifyContact(input.contactDisplayName || input.contactHandle);
  const today = isoDate(now);
  const recentThreadWikilink = `[[${today}|${today} — ${slug}]]`;
  const topicLine = `- ${today}: ${trimToOneLine(input.userInstruction, 200)}`;

  if (!existing) {
    const frontmatter = buildFrontmatter({
      name: `contact-${slug}`,
      description: `Accumulated notes for ${input.contactDisplayName || input.contactHandle}`,
      type: "reference",
      contact: input.contactDisplayName || "",
      handle: input.contactHandle || "",
      last_updated: today,
    });
    const body = [
      `# ${input.contactDisplayName || input.contactHandle}`,
      "",
      "## Recent Threads",
      "",
      `- ${recentThreadWikilink}`,
      "",
      "## Topics",
      "",
      topicLine,
      "",
    ].join("\n");
    return `${frontmatter}${body}`;
  }

  // Bump last_updated and append into existing sections. Both Recent Threads
  // and Topics sections are appended-only; we never rewrite earlier entries.
  let updated = updateLastUpdated(existing, now);

  // Recent Threads: dedupe by exact wikilink text. If today's link already
  // exists, leave the section alone. Otherwise insert at the top of the
  // section so the newest entry sits first.
  if (!updated.includes(recentThreadWikilink)) {
    updated = insertAfterHeading(updated, "Recent Threads", `- ${recentThreadWikilink}`);
  }
  // Topics: always append a new line (append-only, no dedupe).
  updated = appendToSection(updated, "Topics", topicLine);
  return updated;
}

/**
 * Insert `line` immediately after the heading whose text matches `heading`.
 * If the heading is missing, append a new section at the end of the file.
 */
function insertAfterHeading(content: string, heading: string, line: string): string {
  const re = new RegExp(`(^|\\n)(##\\s+${escapeRegExp(heading)}\\s*\\n)`, "i");
  const match = content.match(re);
  if (!match) {
    return `${content.trimEnd()}\n\n## ${heading}\n\n${line}\n`;
  }
  const insertAt = (match.index ?? 0) + match[0].length;
  return `${content.slice(0, insertAt)}\n${line}\n${content.slice(insertAt)}`;
}

/**
 * Append `line` at the end of the section whose heading matches `heading`,
 * before the next heading or end of file. Creates the section if missing.
 */
function appendToSection(content: string, heading: string, line: string): string {
  const re = new RegExp(`(^|\\n)(##\\s+${escapeRegExp(heading)}\\s*\\n)([\\s\\S]*?)(?=\\n##\\s|$)`, "i");
  const match = content.match(re);
  if (!match) {
    return `${content.trimEnd()}\n\n## ${heading}\n\n${line}\n`;
  }
  const sectionBody = match[3].trimEnd();
  const sectionStart = (match.index ?? 0) + match[1].length + match[2].length;
  const sectionEnd = sectionStart + match[3].length;
  const rebuilt = `${sectionBody}\n${line}\n`;
  return `${content.slice(0, sectionStart)}${rebuilt}${content.slice(sectionEnd)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One-liner appended to the daily session note.
 */
export function formatDailySessionLine(
  input: VaultWriterInput,
  now: Date,
): string {
  const slug = input.contactSlug ?? slugifyContact(input.contactDisplayName || input.contactHandle);
  const time = localTimeOfDay(now).slice(0, 5); // HH:MM
  return `- ${time} Relayed reply to [[${slug}]] (${input.contextMessages.length} context msg(s), draft id \`${input.draftId}\`)`;
}

async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  const dir = targetPath.substring(0, targetPath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tmp, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(tmp, 0o600);
    await rename(tmp, targetPath);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Ignore close failure.
      }
    }
    try {
      await unlink(tmp);
    } catch {
      // Ignore cleanup failure.
    }
    throw err;
  }
}

async function appendFileAtomic(targetPath: string, addition: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(targetPath, "utf8");
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
  // Ensure exactly one blank line between existing content and the addition.
  const trimmed = existing.replace(/\n*$/, "");
  const combined = trimmed.length === 0
    ? addition.endsWith("\n") ? addition : `${addition}\n`
    : `${trimmed}\n\n${addition.endsWith("\n") ? addition : `${addition}\n`}`;
  await writeFileAtomic(targetPath, combined);
}

function isENOENT(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err &&
    (err as { code?: string }).code === "ENOENT",
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (err) {
    if (isENOENT(err)) return false;
    throw err;
  }
}

/**
 * Write all three per-invocation artifacts to the vault. Returns a result
 * object with each path that was successfully written and an errors array
 * for partial failures. Never throws; callers should fire-and-forget.
 */
export async function writeRelayVaultArtifacts(
  input: VaultWriterInput,
  options: VaultWriterOptions = {},
): Promise<VaultWriterResult> {
  const now = options.now ?? new Date();
  const vaultRoot = options.vaultRoot ?? defaultVaultRoot();
  const slug = input.contactSlug ?? slugifyContact(
    input.contactDisplayName || input.contactHandle,
  );
  const today = isoDate(now);

  const draftBodySha256 = createHash("sha256")
    .update(input.draftBody, "utf8")
    .digest("hex");

  const result: VaultWriterResult = { ok: true, errors: [], draftBodySha256 };

  // Per-thread daily log
  const perThreadPath = join(
    vaultRoot,
    PROJECT_FOLDER,
    THREADS_SUBFOLDER,
    slug,
    `${today}.md`,
  );
  try {
    const exists = await pathExists(perThreadPath);
    if (exists) {
      const existing = await readFile(perThreadPath, "utf8");
      const updated = `${updateLastUpdated(existing, now).replace(/\n*$/, "")}\n\n${formatPerThreadEntry(input, now)}`;
      await writeFileAtomic(perThreadPath, updated);
    } else {
      await writeFileAtomic(perThreadPath, buildPerThreadFileInitial(input, now));
    }
    result.perThreadPath = perThreadPath;
  } catch (err) {
    result.ok = false;
    result.errors.push(
      `per_thread_write_failed:${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Contact summary
  const contactSummaryPath = join(vaultRoot, PEOPLE_FOLDER, `${slug}.md`);
  try {
    let existing: string | undefined;
    try {
      existing = await readFile(contactSummaryPath, "utf8");
    } catch (err) {
      if (!isENOENT(err)) throw err;
    }
    const next = formatContactSummaryUpdate(input, now, existing);
    await writeFileAtomic(contactSummaryPath, next);
    result.contactSummaryPath = contactSummaryPath;
  } catch (err) {
    result.ok = false;
    result.errors.push(
      `contact_summary_write_failed:${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Daily session log
  const dailySessionPath = join(vaultRoot, DAILY_FOLDER, `${today}.md`);
  try {
    await appendFileAtomic(dailySessionPath, formatDailySessionLine(input, now));
    result.dailySessionPath = dailySessionPath;
  } catch (err) {
    result.ok = false;
    result.errors.push(
      `daily_session_write_failed:${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result;
}
