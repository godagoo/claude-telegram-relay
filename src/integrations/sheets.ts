/**
 * Google Sheets Integration — Read, write, create spreadsheets
 */

import { google } from "googleapis";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAuthenticatedClient } from "./google-auth.ts";

export const definitions: Anthropic.Tool[] = [
  {
    name: "read_sheet",
    description: "Read data from a Google Spreadsheet. Returns cell values from the specified range.",
    input_schema: {
      type: "object" as const,
      properties: {
        spreadsheet_id: {
          type: "string",
          description: "The spreadsheet ID (from the URL: docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit)",
        },
        range: {
          type: "string",
          description: "Cell range in A1 notation (e.g., 'Sheet1!A1:D10', 'A1:C5')",
        },
      },
      required: ["spreadsheet_id", "range"],
    },
  },
  {
    name: "write_sheet",
    description: "Write data to a Google Spreadsheet. Updates cells in the specified range.",
    input_schema: {
      type: "object" as const,
      properties: {
        spreadsheet_id: { type: "string", description: "The spreadsheet ID" },
        range: { type: "string", description: "Target range in A1 notation (e.g., 'Sheet1!A1')" },
        values: {
          type: "array",
          items: {
            type: "array",
            items: { type: "string" },
          },
          description: "2D array of values to write (rows × columns). E.g., [['Name','Age'],['Alice','30']]",
        },
      },
      required: ["spreadsheet_id", "range", "values"],
    },
  },
  {
    name: "create_sheet",
    description: "Create a new Google Spreadsheet with an optional title and initial data.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Spreadsheet title" },
        headers: {
          type: "array",
          items: { type: "string" },
          description: "Column headers for the first row (optional)",
        },
        data: {
          type: "array",
          items: {
            type: "array",
            items: { type: "string" },
          },
          description: "Initial data rows (optional)",
        },
      },
      required: ["title"],
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
  if (!_supabase) return "Supabase not configured. Sheets requires database for token storage.";

  const auth = await getAuthenticatedClient(_supabase, _userId);
  if (!auth) return "Google not connected. Use /google connect to authenticate.";

  const sheets = google.sheets({ version: "v4", auth });

  switch (toolName) {
    case "read_sheet": return readSheet(sheets, input);
    case "write_sheet": return writeSheet(sheets, input);
    case "create_sheet": return createSheet(sheets, input);
    default: return `Unknown sheets tool: ${toolName}`;
  }
}

async function readSheet(
  sheets: ReturnType<typeof google.sheets>,
  input: Record<string, unknown>
): Promise<string> {
  const spreadsheetId = input.spreadsheet_id as string;
  const range = input.range as string;

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const rows = result.data.values || [];
  if (rows.length === 0) return "No data found in the specified range.";

  // Format as a table
  const maxCols = Math.max(...rows.map((r) => r.length));
  const colWidths: number[] = Array(maxCols).fill(0);

  for (const row of rows) {
    for (let i = 0; i < maxCols; i++) {
      colWidths[i] = Math.max(colWidths[i], String(row[i] || "").length);
    }
  }

  const formatted = rows.map((row) =>
    row.map((cell: string, i: number) => String(cell || "").padEnd(colWidths[i])).join(" | ")
  );

  // Add separator after header row
  if (formatted.length > 1) {
    const sep = colWidths.map((w) => "-".repeat(w)).join("-+-");
    formatted.splice(1, 0, sep);
  }

  return formatted.join("\n");
}

async function writeSheet(
  sheets: ReturnType<typeof google.sheets>,
  input: Record<string, unknown>
): Promise<string> {
  const spreadsheetId = input.spreadsheet_id as string;
  const range = input.range as string;
  const values = input.values as string[][];

  const result = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  return `Updated ${result.data.updatedCells} cells in range ${result.data.updatedRange}.`;
}

async function createSheet(
  sheets: ReturnType<typeof google.sheets>,
  input: Record<string, unknown>
): Promise<string> {
  const title = input.title as string;
  const headers = input.headers as string[] | undefined;
  const data = input.data as string[][] | undefined;

  const result = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
    },
  });

  const spreadsheetId = result.data.spreadsheetId!;
  const url = result.data.spreadsheetUrl;

  // Write headers and data if provided
  const values: string[][] = [];
  if (headers) values.push(headers);
  if (data) values.push(...data);

  if (values.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Sheet1!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });
  }

  return `Spreadsheet created: "${title}"\nURL: ${url}\nID: ${spreadsheetId}`;
}
