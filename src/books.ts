// books.ts
// Single source of truth for the converted anesthesia textbook corpus.

export interface BookDefinition {
  key: string;
  label: string;
  pathSegment: string;
  aliases: readonly string[];
}

export const BOOKS: readonly BookDefinition[] = [
  {
    key: "barash",
    label: "Barash 9",
    pathSegment: "barash9",
    aliases: ["barash"],
  },
  {
    key: "chestnut",
    label: "Chestnut 6",
    pathSegment: "chestnut6",
    aliases: ["chestnut"],
  },
  {
    key: "cote",
    label: "Cote Pediatric Anesthesia 6",
    pathSegment: "cote_ped6",
    aliases: ["cote"],
  },
  {
    key: "fleisher",
    label: "Fleisher Uncommon Diseases",
    pathSegment: "fleisher_uncommon",
    aliases: ["fleisher"],
  },
  {
    key: "miller",
    label: "Miller 10",
    pathSegment: "miller10",
    aliases: ["miller"],
  },
  {
    key: "stoelting",
    label: "Stoelting 8",
    pathSegment: "stoelting8",
    aliases: ["stoelting"],
  },
] as const;

export const BOOK_KEYS = BOOKS.map((book) => book.key);
export const BOOK_KEY_SET: ReadonlySet<string> = new Set(BOOK_KEYS);
export const CATALOG_BOOK_LIST = BOOKS.map((book) => book.label);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const BOOK_TRIGGER_PATTERN = BOOKS
  .flatMap((book) => book.aliases)
  .map(escapeRegex)
  .join("|");
