import { expect, test } from "bun:test";
import { splitForTelegram } from "./draft-router";

test("short message returns single chunk", () => {
  const chunks = splitForTelegram("hello world");
  expect(chunks).toEqual(["hello world"]);
});

test("4000-char message splits on paragraph boundary", () => {
  const para = "x".repeat(2000);
  const text = `${para}\n\n${para}\n\n${para}`;
  const chunks = splitForTelegram(text);
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(4000);
  }
});

test("paragraph-less long text splits on sentence boundary", () => {
  const sent = "This is a sentence. ".repeat(300);
  const chunks = splitForTelegram(sent);
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(4000);
  }
});

test("single huge token gets hard-split", () => {
  const blob = "x".repeat(8500);
  const chunks = splitForTelegram(blob);
  expect(chunks.length).toBe(3);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(4000);
  }
});

test("custom limit passes through", () => {
  const text = "a".repeat(100);
  const chunks = splitForTelegram(text, 30);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(30);
  }
});
