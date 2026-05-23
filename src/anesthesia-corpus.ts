// anesthesia-corpus.ts
// Repo-native adaptation of the mobile anesthesia prompt. The relay owns
// retrieval before Claude runs, so these rules must not advertise shell tools.
//
// Corpus roots are derived from $HOME so the module is portable across
// machines. They are kept in lockstep with retrieval.ts's
// TEXTBOOK_MARKDOWN_ROOTS via the test in this directory; if you change one,
// update both, or import a single source of truth in a follow-up PR.

import { homedir } from "os";
import { join } from "path";

export const ANESTHESIA_CORPUS_ROOTS: readonly string[] = [
  join(homedir(), "Desktop", "Exam_Prep", "Textbooks", "anes-textbooks-markdown"),
  join(homedir(), "Downloads", "anes-textbooks-markdown"),
];

// Back-compat: the original API exported a single root path. Kept so existing
// imports keep building; new code should prefer ANESTHESIA_CORPUS_ROOTS.
export const ANESTHESIA_CORPUS_ROOT = ANESTHESIA_CORPUS_ROOTS[0];

export const ANESTHESIA_CORPUS_SUBFOLDERS = [
  "barash9",
  "chestnut6",
  "cote_ped6",
  "fleisher_uncommon",
  "miller10",
  "stoelting8",
] as const;

// Anesthesia-domain pattern set used to widen the retrieval gate for
// clinical questions that do not name a textbook explicitly. The patterns
// are deliberately broad on the anesthesia side and accept a small number
// of false positives (e.g. "airway" in a non-clinical context, "RSI" as
// repetitive strain injury). The downside of a false positive is a single
// scoped FTS call with empty hits — no crash, no wrong answer. The upside
// is that terse queries like "RSI dosing for rocuronium" route to the
// textbook corpus without needing the user to remember a textbook name.
const ANESTHESIA_QUERY_PATTERNS: RegExp[] = [
  /\b(?:anesthesi|anaesthesi)\w*\b/i,
  /\bperioperative\b/i,
  /\bairway\b/i,
  /\bintubat\w*\b/i,
  /\brsi\b/i,
  /\b(?:laryngoscopy|supraglottic|laryngeal mask|endotracheal)\b/i,
  /\b(?:rocuronium|succinylcholine|sugammadex|vecuronium|cisatracurium|atracurium|neuromuscular)\b/i,
  /\b(?:propofol|etomidate|ketamine|dexmedetomidine|midazolam|fentanyl|remifentanil|hydromorphone|opioids?)\b/i,
  /\b(?:sevoflurane|desflurane|isoflurane|nitrous oxide|volatile agents?)\b/i,
  /\b(?:neuraxial|epidural|intrathecal|regional anesthesia|nerve block)\b/i,
  /\b(?:malignant hyperthermia|dantrolene)\b/i,
  /\b(?:vasopressors?|phenylephrine|ephedrine|norepinephrine)\b/i,
  /\b(?:pacu|post-?anesthesia)\b/i,
  /\b(?:obstetric anesthesia|pediatric anesthesia|paediatric anesthesia|fetal heart rate)\b/i,
  /\bcritical care\b/i,
];

export function isAnesthesiaCorpusQuery(message: string): boolean {
  return ANESTHESIA_QUERY_PATTERNS.some((rx) => rx.test(message));
}

export const ANESTHESIA_CORPUS_INSTRUCTIONS = [
  "Anesthesia corpus mode: for anesthesia, perioperative medicine, pharmacology, airway, regional, pain, obstetric, pediatric, and critical-care questions, answer as a board-level anesthesia educator using injected RELEVANT INDEXED CONTENT from the local Markdown textbook corpus when available.",
  `Corpus roots (the relay searches both): ${ANESTHESIA_CORPUS_ROOTS.join(", ")}. Each contains the subfolders ${ANESTHESIA_CORPUS_SUBFOLDERS.join(", ")}.`,
  "Do not claim you ran live tools; the relay performs deterministic retrieval before you run and injects the results into the prompt.",
  "If the injected content is absent or insufficient for a specific medical claim, say `Not found in corpus` for that claim instead of guessing or inventing citations. Do not add a fallback answer from general medical knowledge after saying `Not found in corpus`.",
  "Use short Telegram-friendly paragraphs and flat bullets. Cite sourced claims inline using the retrieved file path and chunk metadata, for example [miller10/pages/page_1195.md chunk 0].",
].join("\n");
