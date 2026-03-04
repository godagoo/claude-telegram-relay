/**
 * Gmail Integration — Read, send, search, draft emails
 */

import { google } from "googleapis";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAuthenticatedClient } from "./google-auth.ts";

export const definitions: Anthropic.Tool[] = [
  {
    name: "read_emails",
    description: "Read recent or unread emails from Gmail. Returns subject, sender, date, and preview.",
    input_schema: {
      type: "object" as const,
      properties: {
        filter: {
          type: "string",
          description: "Filter: 'unread', 'recent', or 'starred' (default: recent)",
        },
        count: {
          type: "number",
          description: "Number of emails to return (default: 5, max: 20)",
        },
      },
      required: [],
    },
  },
  {
    name: "search_emails",
    description: "Search Gmail using Gmail search operators (same syntax as Gmail search bar).",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Gmail search query (e.g., 'from:boss@company.com subject:meeting', 'has:attachment', 'after:2024/01/01')",
        },
        count: { type: "number", description: "Max results (default: 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "send_email",
    description: "Send an email via Gmail. Confirm with the user before sending.",
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body (plain text)" },
        cc: { type: "string", description: "CC recipients (comma-separated, optional)" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "draft_email",
    description: "Create an email draft in Gmail (does not send — saved for review).",
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body (plain text)" },
      },
      required: ["to", "subject", "body"],
    },
  },
];

// userId from Telegram, supabase client injected at execution time
let _supabase: SupabaseClient | null = null;
let _userId: string = "";

export function setContext(supabase: SupabaseClient | null, userId: string): void {
  _supabase = supabase;
  _userId = userId;
}

export async function handler(toolName: string, input: Record<string, unknown>): Promise<string> {
  if (!_supabase) return "Supabase not configured. Gmail requires database for token storage.";

  const auth = await getAuthenticatedClient(_supabase, _userId);
  if (!auth) return "Google not connected. Use /google connect to authenticate.";

  const gmail = google.gmail({ version: "v1", auth });

  switch (toolName) {
    case "read_emails": return readEmails(gmail, input);
    case "search_emails": return searchEmails(gmail, input);
    case "send_email": return sendEmail(gmail, input);
    case "draft_email": return draftEmail(gmail, input);
    default: return `Unknown Gmail tool: ${toolName}`;
  }
}

async function readEmails(gmail: ReturnType<typeof google.gmail>, input: Record<string, unknown>): Promise<string> {
  const filter = (input.filter as string) || "recent";
  const count = Math.min((input.count as number) || 5, 20);

  let query = "";
  if (filter === "unread") query = "is:unread";
  else if (filter === "starred") query = "is:starred";

  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: count,
  });

  const messages = list.data.messages || [];
  if (messages.length === 0) return `No ${filter} emails found.`;

  const results: string[] = [];
  for (const msg of messages.slice(0, count)) {
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: msg.id!,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = detail.data.payload?.headers || [];
    const from = headers.find((h) => h.name === "From")?.value || "Unknown";
    const subject = headers.find((h) => h.name === "Subject")?.value || "(no subject)";
    const date = headers.find((h) => h.name === "Date")?.value || "";
    const snippet = detail.data.snippet || "";

    results.push(`From: ${from}\nSubject: ${subject}\nDate: ${date}\nPreview: ${snippet}`);
  }

  return results.join("\n\n---\n\n");
}

async function searchEmails(gmail: ReturnType<typeof google.gmail>, input: Record<string, unknown>): Promise<string> {
  const query = input.query as string;
  const count = Math.min((input.count as number) || 5, 20);

  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: count,
  });

  const messages = list.data.messages || [];
  if (messages.length === 0) return `No emails found for query: "${query}"`;

  const results: string[] = [];
  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: msg.id!,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = detail.data.payload?.headers || [];
    const from = headers.find((h) => h.name === "From")?.value || "Unknown";
    const subject = headers.find((h) => h.name === "Subject")?.value || "(no subject)";
    const date = headers.find((h) => h.name === "Date")?.value || "";
    const snippet = detail.data.snippet || "";

    results.push(`From: ${from}\nSubject: ${subject}\nDate: ${date}\nPreview: ${snippet}`);
  }

  return results.join("\n\n---\n\n");
}

async function sendEmail(gmail: ReturnType<typeof google.gmail>, input: Record<string, unknown>): Promise<string> {
  const to = input.to as string;
  const subject = input.subject as string;
  const body = input.body as string;
  const cc = input.cc as string | undefined;

  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
  ];
  if (cc) headers.push(`Cc: ${cc}`);

  const raw = Buffer.from(headers.join("\r\n") + "\r\n\r\n" + body)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const result = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  return `Email sent successfully to ${to}. Message ID: ${result.data.id}`;
}

async function draftEmail(gmail: ReturnType<typeof google.gmail>, input: Record<string, unknown>): Promise<string> {
  const to = input.to as string;
  const subject = input.subject as string;
  const body = input.body as string;

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const result = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: { raw },
    },
  });

  return `Draft created successfully. Draft ID: ${result.data.id}. Check your Gmail Drafts folder.`;
}
