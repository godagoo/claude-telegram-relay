/**
 * Integration Registry — Aggregates all Google integration tools
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import * as gmail from "./gmail.ts";
import * as calendar from "./calendar.ts";
import * as sheets from "./sheets.ts";

const integrationGroups = [
  { definitions: gmail.definitions, handler: gmail.handler, setContext: gmail.setContext },
  { definitions: calendar.definitions, handler: calendar.handler, setContext: calendar.setContext },
  { definitions: sheets.definitions, handler: sheets.handler, setContext: sheets.setContext },
];

/**
 * Get all integration tool definitions.
 */
export function getIntegrationTools(): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  for (const group of integrationGroups) {
    tools.push(...group.definitions);
  }
  return tools;
}

/**
 * Set context (supabase client + userId) for all integrations.
 * Must be called before each AI request.
 */
export function setIntegrationContext(supabase: SupabaseClient | null, userId: string): void {
  for (const group of integrationGroups) {
    group.setContext(supabase, userId);
  }
}

/**
 * Execute an integration tool by name.
 */
export async function executeIntegrationTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  for (const group of integrationGroups) {
    const match = group.definitions.find((d) => d.name === name);
    if (match) {
      return group.handler(name, input);
    }
  }

  return `Unknown integration tool: ${name}`;
}
