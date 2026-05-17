import { expect, test } from "bun:test";
import { splitPromptForClaudeCli as split } from "./prompt-split";

test("splits at the trailing User: marker", () => {
  const { systemPrompt, userPrompt } = split(
    "You are an assistant.\nDefault to concise replies.\nUser: What is 2+2?",
  );
  expect(systemPrompt).toBe("You are an assistant.\nDefault to concise replies.");
  expect(userPrompt).toBe("What is 2+2?");
});

test("preserves RECENT CONVERSATION labels by splitting on the LAST User:", () => {
  const prompt = [
    "You are an assistant.",
    "RECENT CONVERSATION:",
    "User: hi",
    "Assistant: hello",
    "User: what next?",
    "Assistant: not sure",
    "",
    "User: search for arterial line indications",
  ].join("\n");
  const { systemPrompt, userPrompt } = split(prompt);
  expect(systemPrompt).toContain("RECENT CONVERSATION:");
  expect(systemPrompt).toContain("User: hi");
  expect(systemPrompt).toContain("Assistant: hello");
  expect(systemPrompt).toContain("User: what next?");
  expect(systemPrompt).toContain("Assistant: not sure");
  expect(userPrompt).toBe("search for arterial line indications");
});

test("returns empty system when prompt has no User: marker", () => {
  const { systemPrompt, userPrompt } = split("just a user query");
  expect(systemPrompt).toBe("");
  expect(userPrompt).toBe("just a user query");
});

test("handles a user message that itself contains 'User:' literal in body", () => {
  const prompt = "rules go here\nUser: please log this as 'User: testing'";
  const { systemPrompt, userPrompt } = split(prompt);
  expect(systemPrompt).toBe("rules go here");
  expect(userPrompt).toBe("please log this as 'User: testing'");
});

test("handles multiline user message", () => {
  const prompt = "system block\nUser: line one\nline two\nline three";
  const { systemPrompt, userPrompt } = split(prompt);
  expect(systemPrompt).toBe("system block");
  expect(userPrompt).toBe("line one\nline two\nline three");
});

test("handles empty user message edge case", () => {
  const { systemPrompt, userPrompt } = split("system block\nUser: ");
  expect(systemPrompt).toBe("system block");
  expect(userPrompt).toBe("");
});
