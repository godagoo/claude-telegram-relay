import { expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { dirname, join } from "path";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// PR3.5 audit #8 em-dash guard (Codex 2026-05-21).
//
// Project rule (William 2026-05-11): zero em-dashes (U+2014) in any string
// that the user will eventually see, OR in any vault note the composer
// reads back when drafting future replies. Em-dashes are an AI tell that
// drift the draft style away from the user's own voice.
//
// This guard locks down the files that produce vault output AND the tests
// that assert on those strings. Add to GUARDED_FILES when introducing new
// files that emit user-visible or vault-bound text. Do NOT widen the scope
// to all *.ts files: relay.ts contains em-dashes inside placement-claim
// regexes that are intentional (they match the AI tells we strip).
const GUARDED_FILES = [
  "src/vault-writer.ts",
  "src/vault-writer.test.ts",
];

const EM_DASH = "—";

for (const rel of GUARDED_FILES) {
  test(`${rel} contains no U+2014 (em-dash)`, async () => {
    const abs = join(PROJECT_ROOT, rel);
    const text = await readFile(abs, "utf8");
    const index = text.indexOf(EM_DASH);
    if (index !== -1) {
      const lineNumber = text.slice(0, index).split("\n").length;
      const lineStart = text.lastIndexOf("\n", index) + 1;
      const lineEnd = text.indexOf("\n", index);
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      throw new Error(
        `${rel}:${lineNumber} contains an em-dash (U+2014). Replace with hyphen, colon, or rephrase. Line: ${line}`,
      );
    }
    expect(index).toBe(-1);
  });
}
