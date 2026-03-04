/**
 * Skill Registry — Central tool registration for Anthropic API
 *
 * Each skill exports tool definitions and handlers.
 * This module aggregates them into a single registry.
 *
 * Note: In CLI mode, these tools aren't used directly — see cli-skills.ts
 * for the pre-processing layer that calls skill handlers before Claude CLI.
 */

import type Anthropic from "@anthropic-ai/sdk";

import * as webSearch from "./web-search.ts";
import * as defi from "./defi.ts";
import * as smartContract from "./smart-contract.ts";
import * as video from "./video.ts";

// Skills with single tool definition
const singleTools: Array<{ definition: Anthropic.Tool; handler: (input: Record<string, unknown>) => Promise<string> }> = [
  { definition: webSearch.definition, handler: webSearch.handler },
];

// Skills with multiple tool definitions
const multiTools: Array<{
  definitions: Anthropic.Tool[];
  handler: (toolName: string, input: Record<string, unknown>) => Promise<string>;
}> = [
  { definitions: defi.definitions, handler: defi.handler },
  { definitions: smartContract.definitions, handler: smartContract.handler },
  { definitions: video.definitions, handler: video.handler },
];

/**
 * Get all tool definitions for the Anthropic API.
 */
export function getAllTools(): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];

  for (const { definition } of singleTools) {
    tools.push(definition);
  }

  for (const { definitions } of multiTools) {
    tools.push(...definitions);
  }

  return tools;
}

/**
 * Execute a tool by name and return the result.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  // Check single tools
  for (const tool of singleTools) {
    if (tool.definition.name === name) {
      return tool.handler(input);
    }
  }

  // Check multi tools
  for (const toolGroup of multiTools) {
    const match = toolGroup.definitions.find((d) => d.name === name);
    if (match) {
      return toolGroup.handler(name, input);
    }
  }

  return `Unknown tool: ${name}`;
}
