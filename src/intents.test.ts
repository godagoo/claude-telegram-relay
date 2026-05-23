import { expect, test } from "bun:test";
import { parseIntents } from "./intents";

test("strips [REMEMBER:] tag and captures payload", () => {
  const { clean, intents } = parseIntents(
    "Done. [REMEMBER: preferred font is Iosevka] Anything else?"
  );
  expect(clean).toBe("Done. Anything else?");
  expect(intents).toEqual([{ kind: "remember", content: "preferred font is Iosevka" }]);
});

test("strips [GOAL: ... | DEADLINE: ...] with deadline", () => {
  const { clean, intents } = parseIntents(
    "[GOAL: finish audit | DEADLINE: 2026-06-01] On it."
  );
  expect(clean).toBe("On it.");
  expect(intents).toEqual([
    { kind: "goal", content: "finish audit", deadline: "2026-06-01" },
  ]);
});

test("strips [GOAL: ...] without deadline", () => {
  const { clean, intents } = parseIntents("[GOAL: drink water]");
  expect(clean).toBe("");
  expect(intents).toEqual([{ kind: "goal", content: "drink water", deadline: null }]);
});

test("strips [DONE: ...] for goal completion", () => {
  const { clean, intents } = parseIntents("Marked. [DONE: finish audit]");
  expect(clean).toBe("Marked.");
  expect(intents).toEqual([{ kind: "done", content: "finish audit" }]);
});

test("strips [DECISION: ...] for decision log", () => {
  const { clean, intents } = parseIntents("Logged. [DECISION: use HNSW over IVFFlat]");
  expect(clean).toBe("Logged.");
  expect(intents).toEqual([{ kind: "decision", content: "use HNSW over IVFFlat" }]);
});

test("strips [EMAIL_DRAFT: to=x subject=y body=z]", () => {
  const { clean, intents } = parseIntents(
    "Draft ready. [EMAIL_DRAFT: to=alex@example.com subject=Re: schedule body=Tomorrow at 3 works.]"
  );
  expect(clean).toBe("Draft ready.");
  expect(intents).toHaveLength(1);
  expect(intents[0].kind).toBe("email_draft");
  expect((intents[0] as any).to).toBe("alex@example.com");
  expect((intents[0] as any).subject).toBe("Re: schedule");
  expect((intents[0] as any).body).toBe("Tomorrow at 3 works.");
});

test("strips [IMSG_DRAFT: contact=Sarah body=on my way]", () => {
  const { clean, intents } = parseIntents(
    "iMessage drafted. [IMSG_DRAFT: contact=Sarah body=on my way]"
  );
  expect(clean).toBe("iMessage drafted.");
  expect(intents[0]).toEqual({ kind: "imsg_draft", contact: "Sarah", body: "on my way" });
});

test("strips [WHATSAPP_DRAFT: contact=Sarah body=hello]", () => {
  const { clean, intents } = parseIntents(
    "WA ready. [WHATSAPP_DRAFT: contact=Sarah body=hello]"
  );
  expect(clean).toBe("WA ready.");
  expect(intents[0]).toEqual({ kind: "whatsapp_draft", contact: "Sarah", body: "hello" });
});

test("multiple tags coexist; all stripped, all captured", () => {
  const { clean, intents } = parseIntents(
    "[REMEMBER: tea] [GOAL: stretch | DEADLINE: 2026-06-01] back to work"
  );
  expect(clean).toBe("back to work");
  expect(intents).toHaveLength(2);
});

test("text with no intents passes through unchanged", () => {
  const { clean, intents } = parseIntents("just a normal message");
  expect(clean).toBe("just a normal message");
  expect(intents).toEqual([]);
});

test("case-insensitive tag matching", () => {
  const { clean, intents } = parseIntents("[remember: lower case works]");
  expect(clean).toBe("");
  expect(intents[0]).toEqual({ kind: "remember", content: "lower case works" });
});

test("unknown bracket tags pass through unmodified", () => {
  const { clean, intents } = parseIntents("see [BUG-1234] for more");
  expect(clean).toBe("see [BUG-1234] for more");
  expect(intents).toEqual([]);
});

test("collapses multiple spaces left by stripped tags", () => {
  const { clean } = parseIntents("a [REMEMBER: x] b [REMEMBER: y] c");
  expect(clean).toBe("a b c");
});
