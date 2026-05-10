import { buildSearchQuery } from "../src/query-builder";
import { search } from "../src/retrieval";

const checks = [
  {
    message: "Anesthesia textbook",
    expectedQuery: '"anesthesia" "textbook"',
    expectedPathFragment: "/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown/_catalog",
    forbiddenFirstContent: "Front matter",
  },
  {
    message: "Please continue to look for my anesthesia textbooks",
    expectedQuery: '"anesthesia" "textbooks"',
    expectedPathFragment: "/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown/_catalog",
    forbiddenFirstContent: "Front matter",
  },
  {
    message: "What does miller say are the indications for an arterial line?",
    expectedQuery: '"miller" "indications" "arterial" "line"',
    expectedPathFragment: "/Desktop/Exam_Prep/Textbooks/anes-textbooks-markdown/miller10/",
  },
];

for (const check of checks) {
  const query = buildSearchQuery(check.message, [
    {
      role: "user",
      content: "Anesthesia textbook",
      ts: new Date(0).toISOString(),
    },
  ]);

  if (query !== check.expectedQuery) {
    throw new Error(
      `unexpected query for ${JSON.stringify(check.message)}: ${query}`,
    );
  }

  const t0 = Date.now();
  const hits = await search(query, 5);
  const elapsed = Date.now() - t0;
  const expectedHits = hits.filter((hit) =>
    hit.file_path.includes(check.expectedPathFragment)
  );

  console.log(
    JSON.stringify(
      {
        message: check.message,
        query,
        elapsed,
        hit_count: hits.length,
        expected_hit_count: expectedHits.length,
        first_expected_hit: expectedHits[0]?.file_path,
        first_expected_content: expectedHits[0]?.content,
      },
      null,
      2,
    ),
  );

  if (expectedHits.length === 0) {
    throw new Error(`no expected textbook hits for ${query}`);
  }

  if (
    check.expectedPathFragment.includes("anes-textbooks-markdown") &&
    expectedHits[0].content.includes("extraction_status=skipped")
  ) {
    throw new Error(`converted textbook hit was displaced by skipped path fallback for ${query}`);
  }

  if (
    check.forbiddenFirstContent &&
    expectedHits[0].content.includes(check.forbiddenFirstContent)
  ) {
    throw new Error(`first textbook hit still appears to be front matter for ${query}`);
  }
}

console.log("PASS: textbook retrieval smoke checks returned scoped converted/path hits");
