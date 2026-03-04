/**
 * Google OAuth2 — Authentication flow via Telegram
 *
 * Users authenticate by:
 * 1. /google connect → bot sends OAuth URL
 * 2. User clicks, authorizes in browser
 * 3. User copies auth code back to Telegram
 * 4. Bot exchanges code for tokens, stores in Supabase
 */

import { google } from "googleapis";
import type { SupabaseClient } from "@supabase/supabase-js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
];

const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob"; // Manual copy-paste flow

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;

  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

/**
 * Generate the OAuth URL for the user to visit.
 */
export function getAuthUrl(): string | null {
  const client = getOAuth2Client();
  if (!client) return null;

  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
}

/**
 * Exchange an auth code for tokens and store them.
 */
export async function exchangeCode(
  supabase: SupabaseClient,
  userId: string,
  code: string
): Promise<boolean> {
  const client = getOAuth2Client();
  if (!client) return false;

  try {
    const { tokens } = await client.getToken(code);

    await supabase.from("google_tokens").upsert(
      {
        user_id: userId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        scopes: SCOPES,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    return true;
  } catch (err) {
    console.error("Google OAuth exchange failed:", err);
    return false;
  }
}

/**
 * Get an authenticated OAuth2 client for a user.
 * Auto-refreshes expired tokens.
 */
export async function getAuthenticatedClient(
  supabase: SupabaseClient,
  userId: string
): Promise<ReturnType<typeof getOAuth2Client> | null> {
  const client = getOAuth2Client();
  if (!client) return null;

  const { data, error } = await supabase
    .from("google_tokens")
    .select("access_token, refresh_token, expiry")
    .eq("user_id", userId)
    .single();

  if (error || !data) return null;

  client.setCredentials({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: data.expiry ? new Date(data.expiry).getTime() : undefined,
  });

  // Auto-refresh if expired
  const expiry = data.expiry ? new Date(data.expiry).getTime() : 0;
  if (expiry && Date.now() > expiry - 60_000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      await supabase.from("google_tokens").update({
        access_token: credentials.access_token,
        expiry: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null,
        updated_at: new Date().toISOString(),
      }).eq("user_id", userId);
    } catch (err) {
      console.error("Google token refresh failed:", err);
      return null;
    }
  }

  return client;
}

/**
 * Check if a user has Google connected.
 */
export async function isGoogleConnected(
  supabase: SupabaseClient,
  userId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("google_tokens")
    .select("user_id")
    .eq("user_id", userId)
    .single();

  return !!data;
}

/**
 * Google setup guide text.
 */
export const SETUP_GUIDE = `To connect Google services, you need a Google Cloud project:

1. Go to console.cloud.google.com
2. Create a new project (e.g., "Gentech Bot")
3. Enable these APIs:
   - Gmail API
   - Google Calendar API
   - Google Sheets API
4. Go to APIs & Services → Credentials
5. Configure OAuth consent screen (External, test mode)
6. Create OAuth 2.0 Client ID (Desktop app type)
7. Copy the Client ID and Client Secret
8. Add them to your .env file:
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
9. Restart the bot, then use /google connect`;
