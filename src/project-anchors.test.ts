import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  findAnchoredProjects,
  __resetProjectAnchorsCacheForTests,
} from "./project-anchors";

const tmpDir = mkdtempSync(join(tmpdir(), "anchors-"));
const tmpConfig = join(tmpDir, "anchors.json");

const FIXTURE = {
  projects: [
    {
      name: "Medicolegal-Case",
      paths: ["/Users/x/ObsidianVault/01-Projects/Medicolegal-Case/%"],
      anchors: ["lawyer", "lawyers", "Saint Amman", "Rob Roy", "MIET", "CaRMS"],
      context_label: "MEDICOLEGAL-CASE CONTEXT:",
    },
    {
      name: "Other-Project",
      paths: ["/some/other/%"],
      anchors: ["unrelated", "Foo Bar"],
      context_label: "OTHER:",
    },
  ],
};

writeFileSync(tmpConfig, JSON.stringify(FIXTURE));
process.env.PROJECT_ANCHORS_CONFIG = tmpConfig;

afterEach(() => {
  __resetProjectAnchorsCacheForTests();
});

afterEach(() => {
  // Last resort: clean tmp dir when all tests complete. Bun runs hooks per
  // test, but the dir is reused — leak is harmless.
});

test("findAnchoredProjects matches phrase anchors with word boundaries", async () => {
  const out = await findAnchoredProjects(
    "Speech to my lawyers about Mark Saint Amman and Dr. Rob Roy via the MIET",
  );
  expect(out).toHaveLength(1);
  expect(out[0].project.name).toBe("Medicolegal-Case");
  expect(new Set(out[0].matchedAnchors)).toEqual(
    new Set(["lawyers", "Saint Amman", "Rob Roy", "MIET"]),
  );
});

test("findAnchoredProjects does NOT match anchor substrings (word boundary)", async () => {
  // "lawyering" contains "lawyer" as substring but not as a word —
  // word-boundary anchors should reject it. Same for case-only matches
  // inside other words ("antiCaRMS").
  const out = await findAnchoredProjects(
    "I was lawyering yesterday at the anticarmsylvania conference.",
  );
  expect(out).toHaveLength(0);
});

test("findAnchoredProjects is case-insensitive", async () => {
  const out = await findAnchoredProjects("MIET update from rob roy");
  expect(out).toHaveLength(1);
  expect(new Set(out[0].matchedAnchors)).toEqual(new Set(["Rob Roy", "MIET"]));
});

test("findAnchoredProjects returns empty for unrelated messages", async () => {
  const out = await findAnchoredProjects(
    "Draft an iMessage to gailene saying hi",
  );
  expect(out).toHaveLength(0);
});

test("findAnchoredProjects can match multiple projects in one message", async () => {
  const out = await findAnchoredProjects(
    "MIET deadline collides with the Foo Bar review on Friday.",
  );
  expect(out).toHaveLength(2);
  const names = new Set(out.map((m) => m.project.name));
  expect(names).toEqual(new Set(["Medicolegal-Case", "Other-Project"]));
});

// Cleanup after the suite (best-effort; Bun calls afterEach after each test).
test("__cleanup tmp config", () => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  expect(true).toBe(true);
});
