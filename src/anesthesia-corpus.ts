// anesthesia-corpus.ts
// Repo-native adaptation of the mobile anesthesia prompt. The relay owns
// retrieval before Claude runs, so these rules must not advertise shell tools.

export const ANESTHESIA_CORPUS_ROOT =
  "/Users/williamregan/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown";

export const ANESTHESIA_CORPUS_SUBFOLDERS = [
  "barash9",
  "chestnut6",
  "cote_ped6",
  "fleisher_uncommon",
  "miller10",
  "stoelting8",
] as const;

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
  `Corpus root: ${ANESTHESIA_CORPUS_ROOT} (${ANESTHESIA_CORPUS_SUBFOLDERS.join(", ")}).`,
  "Do not claim you ran live tools; the relay performs deterministic retrieval before you run and injects the results into the prompt.",
  "If the injected content is absent or insufficient for a specific medical claim, say `Not found in corpus` for that claim instead of guessing or inventing citations.",
  "Use short Telegram-friendly paragraphs and flat bullets. Cite sourced claims inline using the retrieved file path and chunk metadata, for example [miller10/pages/page_1195.md chunk 0].",
].join("\n");
