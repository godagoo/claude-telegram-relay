/**
 * Google Calendar Integration — Events CRUD + availability
 */

import { google } from "googleapis";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAuthenticatedClient } from "./google-auth.ts";

export const definitions: Anthropic.Tool[] = [
  {
    name: "get_events",
    description: "Get upcoming calendar events. Can filter by date range.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of days ahead to look (default: 7)" },
        count: { type: "number", description: "Max events to return (default: 10)" },
      },
      required: [],
    },
  },
  {
    name: "create_event",
    description: "Create a new calendar event.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Event title" },
        start: { type: "string", description: "Start time in ISO 8601 format (e.g., 2024-03-15T10:00:00)" },
        end: { type: "string", description: "End time in ISO 8601 format" },
        description: { type: "string", description: "Event description (optional)" },
        location: { type: "string", description: "Event location (optional)" },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Email addresses of attendees (optional)",
        },
      },
      required: ["title", "start", "end"],
    },
  },
  {
    name: "check_availability",
    description: "Check free/busy status for a date range.",
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "Date to check in YYYY-MM-DD format" },
        duration_hours: { type: "number", description: "Duration in hours to check (default: 8 = full workday)" },
      },
      required: ["date"],
    },
  },
  {
    name: "update_event",
    description: "Update an existing calendar event by its ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        event_id: { type: "string", description: "The event ID to update" },
        title: { type: "string", description: "New title (optional)" },
        start: { type: "string", description: "New start time (optional)" },
        end: { type: "string", description: "New end time (optional)" },
        description: { type: "string", description: "New description (optional)" },
      },
      required: ["event_id"],
    },
  },
];

let _supabase: SupabaseClient | null = null;
let _userId: string = "";

export function setContext(supabase: SupabaseClient | null, userId: string): void {
  _supabase = supabase;
  _userId = userId;
}

export async function handler(toolName: string, input: Record<string, unknown>): Promise<string> {
  if (!_supabase) return "Supabase not configured. Calendar requires database for token storage.";

  const auth = await getAuthenticatedClient(_supabase, _userId);
  if (!auth) return "Google not connected. Use /google connect to authenticate.";

  const calendar = google.calendar({ version: "v3", auth });

  switch (toolName) {
    case "get_events": return getEvents(calendar, input);
    case "create_event": return createEvent(calendar, input);
    case "check_availability": return checkAvailability(calendar, input);
    case "update_event": return updateEvent(calendar, input);
    default: return `Unknown calendar tool: ${toolName}`;
  }
}

const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

async function getEvents(
  calendar: ReturnType<typeof google.calendar>,
  input: Record<string, unknown>
): Promise<string> {
  const days = (input.days as number) || 7;
  const count = Math.min((input.count as number) || 10, 25);

  const now = new Date();
  const until = new Date(now.getTime() + days * 86_400_000);

  const result = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: until.toISOString(),
    maxResults: count,
    singleEvents: true,
    orderBy: "startTime",
    timeZone: USER_TIMEZONE,
  });

  const events = result.data.items || [];
  if (events.length === 0) return `No events in the next ${days} days.`;

  return events.map((e, i) => {
    const start = e.start?.dateTime || e.start?.date || "TBD";
    const end = e.end?.dateTime || e.end?.date || "";
    const startFmt = formatEventTime(start);
    const endFmt = end ? formatEventTime(end) : "";

    const parts = [
      `${i + 1}. ${e.summary || "(no title)"}`,
      `   When: ${startFmt}${endFmt ? ` → ${endFmt}` : ""}`,
    ];

    if (e.location) parts.push(`   Where: ${e.location}`);
    if (e.description) parts.push(`   Notes: ${e.description.substring(0, 100)}`);
    parts.push(`   ID: ${e.id}`);

    return parts.join("\n");
  }).join("\n\n");
}

async function createEvent(
  calendar: ReturnType<typeof google.calendar>,
  input: Record<string, unknown>
): Promise<string> {
  const event: any = {
    summary: input.title as string,
    start: { dateTime: input.start as string, timeZone: USER_TIMEZONE },
    end: { dateTime: input.end as string, timeZone: USER_TIMEZONE },
  };

  if (input.description) event.description = input.description as string;
  if (input.location) event.location = input.location as string;
  if (input.attendees) {
    event.attendees = (input.attendees as string[]).map((email) => ({ email }));
  }

  const result = await calendar.events.insert({
    calendarId: "primary",
    requestBody: event,
  });

  return `Event created: "${result.data.summary}"\nLink: ${result.data.htmlLink}\nID: ${result.data.id}`;
}

async function checkAvailability(
  calendar: ReturnType<typeof google.calendar>,
  input: Record<string, unknown>
): Promise<string> {
  const date = input.date as string;
  const hours = (input.duration_hours as number) || 8;

  const start = new Date(`${date}T09:00:00`);
  const end = new Date(start.getTime() + hours * 3_600_000);

  const result = await calendar.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone: USER_TIMEZONE,
      items: [{ id: "primary" }],
    },
  });

  const busy = result.data.calendars?.primary?.busy || [];

  if (busy.length === 0) {
    return `You're free all day on ${date} (${hours} hours checked from 9 AM).`;
  }

  const busySlots = busy.map((b) => {
    const s = formatEventTime(b.start || "");
    const e = formatEventTime(b.end || "");
    return `  Busy: ${s} → ${e}`;
  }).join("\n");

  return `Availability on ${date}:\n${busySlots}\n\nFree slots are the gaps between busy times.`;
}

async function updateEvent(
  calendar: ReturnType<typeof google.calendar>,
  input: Record<string, unknown>
): Promise<string> {
  const eventId = input.event_id as string;
  const patch: any = {};

  if (input.title) patch.summary = input.title as string;
  if (input.start) patch.start = { dateTime: input.start as string, timeZone: USER_TIMEZONE };
  if (input.end) patch.end = { dateTime: input.end as string, timeZone: USER_TIMEZONE };
  if (input.description) patch.description = input.description as string;

  const result = await calendar.events.patch({
    calendarId: "primary",
    eventId,
    requestBody: patch,
  });

  return `Event updated: "${result.data.summary}"\nLink: ${result.data.htmlLink}`;
}

function formatEventTime(isoString: string): string {
  if (!isoString) return "";
  try {
    return new Date(isoString).toLocaleString("en-US", {
      timeZone: USER_TIMEZONE,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}
