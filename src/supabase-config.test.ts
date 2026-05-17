import { expect, test } from "bun:test";
import { getSupabaseFeatureConfig } from "./supabase-config";

test("defaults to Obsidian as durable memory authority while enabling Supabase history/search", () => {
  expect(getSupabaseFeatureConfig({})).toEqual({
    memoryAuthority: "obsidian",
    messageHistory: true,
    relevantContext: true,
    durableMemory: false,
  });
});

test("MEMORY_AUTHORITY=supabase enables Supabase durable memory intentionally", () => {
  expect(getSupabaseFeatureConfig({ MEMORY_AUTHORITY: "supabase" })).toMatchObject({
    memoryAuthority: "supabase",
    durableMemory: true,
  });
});

test("history and relevant context can be disabled independently", () => {
  expect(
    getSupabaseFeatureConfig({
      SUPABASE_MESSAGE_HISTORY: "0",
      SUPABASE_RELEVANT_CONTEXT: "false",
    }),
  ).toMatchObject({
    messageHistory: false,
    relevantContext: false,
  });
});

test("invalid MEMORY_AUTHORITY fails back to Obsidian", () => {
  expect(getSupabaseFeatureConfig({ MEMORY_AUTHORITY: "postgres" })).toMatchObject({
    memoryAuthority: "obsidian",
    durableMemory: false,
  });
});

