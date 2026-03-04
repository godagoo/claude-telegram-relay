/**
 * AI Core — Anthropic API with Claude Haiku 4.5
 *
 * Replaces the Claude CLI subprocess approach with direct API calls.
 * Supports native tool_use for skills and integrations.
 * OpenClaw-inspired personality: action-oriented, direct, proactive.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { getAllTools, executeTool } from "./skills/index.ts";
import { formatTime } from "./utils.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 4096;
const MAX_TOOL_ROUNDS = 10;

// Per-user conversation history (in-memory, last N messages)
const MAX_HISTORY_PER_USER = 20;
const conversationHistory: Map<string, Anthropic.MessageParam[]> = new Map();

let client: Anthropic | null = null;
let profileContext = "";

export function initAI(): void {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set! AI responses will not work.");
    return;
  }
  client = new Anthropic({ apiKey });
  console.log(`AI initialized: model=${MODEL}`);
}

// Load profile on startup
export async function loadProfile(): Promise<void> {
  try {
    profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
  } catch {
    // No profile yet
  }
}

function buildSystemPrompt(userName: string, timezone: string, memoryContext: string, relevantContext: string): string {
  const timeStr = formatTime(timezone);

  const parts = [
    `You are Gentech — a personal AI agent. You are action-oriented, direct, and efficient.

Core traits:
- You take initiative. When you can act, you act — don't just describe what could be done.
- You remember everything. Use memory tags to store important facts and track goals.
- You're brief and direct. No filler, no over-explaining. Get to the point.
- You adapt your style to match the user's preferences and energy.
- You proactively surface relevant information when you notice patterns.
- You're a decision-maker: assess situations, weigh options, recommend the best path.
- You protect the user's time and attention — only interrupt when it matters.

You have access to tools for web search, email, calendar, spreadsheets, DeFi data,
travel planning, smart contract analysis, and video analysis. Use them proactively when relevant.`,
  ];

  if (userName) parts.push(`You are speaking with ${userName}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
    "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
    "include these tags in your response (they are processed automatically and hidden from the user):" +
    "\n[REMEMBER: fact to store]" +
    "\n[GOAL: goal text | DEADLINE: optional date]" +
    "\n[DONE: search text for completed goal]"
  );

  return parts.join("\n");
}

export interface AICallOptions {
  userId: string;
  userName?: string;
  timezone?: string;
  memoryContext?: string;
  relevantContext?: string;
  imageData?: { base64: string; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" };
}

export async function callAI(
  userMessage: string,
  options: AICallOptions
): Promise<string> {
  if (!client) {
    return "AI is not configured. Set ANTHROPIC_API_KEY in .env.";
  }

  const {
    userId,
    userName = "",
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    memoryContext = "",
    relevantContext = "",
    imageData,
  } = options;

  const systemPrompt = buildSystemPrompt(userName, timezone, memoryContext, relevantContext);

  // Build the user message content
  const userContent: Anthropic.ContentBlockParam[] = [];
  if (imageData) {
    userContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: imageData.mediaType,
        data: imageData.base64,
      },
    });
  }
  userContent.push({ type: "text", text: userMessage });

  // Get or create conversation history
  const history = getHistory(userId);
  history.push({ role: "user", content: userContent });

  const tools = getAllTools();

  try {
    let response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: history,
      tools: tools.length > 0 ? tools : undefined,
    });

    // Tool use loop
    let rounds = 0;
    while (response.stop_reason === "tool_use" && rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      // Add assistant response to history
      history.push({ role: "assistant", content: response.content });

      // Execute all tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        console.log(`Tool call: ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 100)})`);
        try {
          const result = await executeTool(toolUse.name, toolUse.input as Record<string, unknown>);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: typeof result === "string" ? result : JSON.stringify(result),
          });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          });
        }
      }

      // Add tool results and continue
      history.push({ role: "user", content: toolResults });

      response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: history,
        tools: tools.length > 0 ? tools : undefined,
      });
    }

    // Extract text from final response
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    const finalText = textBlocks.map((b) => b.text).join("\n");

    // Add assistant response to history
    history.push({ role: "assistant", content: response.content });

    // Trim history if too long
    trimHistory(userId);

    return finalText;
  } catch (err) {
    console.error("AI call failed:", err);
    // Remove the user message we added on failure
    history.pop();
    return `Error: ${err instanceof Error ? err.message : "AI request failed"}`;
  }
}

function getHistory(userId: string): Anthropic.MessageParam[] {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  return conversationHistory.get(userId)!;
}

function trimHistory(userId: string): void {
  const history = conversationHistory.get(userId);
  if (!history) return;

  // Keep last N message pairs (user + assistant = 2 entries each)
  // Also account for tool_use entries which add extra messages
  while (history.length > MAX_HISTORY_PER_USER * 2) {
    history.shift();
  }
  // Ensure history starts with a user message
  while (history.length > 0 && history[0].role !== "user") {
    history.shift();
  }
}

export function clearHistory(userId: string): void {
  conversationHistory.delete(userId);
}
