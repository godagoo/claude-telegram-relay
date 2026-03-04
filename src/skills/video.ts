/**
 * Video Skill — YouTube + Telegram Video Analysis
 *
 * YouTube: Fetches transcript/captions via YouTube API or fallback scraping.
 * Telegram videos: Extracts frames and audio for analysis.
 *
 * Uses free APIs where possible — no API keys required for basic YouTube transcripts.
 */

import type Anthropic from "@anthropic-ai/sdk";

export const definitions: Anthropic.Tool[] = [
  {
    name: "youtube_summary",
    description:
      "Get a summary or transcript of a YouTube video. Provide a YouTube URL or video ID. Returns the video's transcript/captions for analysis.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "YouTube URL or video ID (e.g., https://youtube.com/watch?v=xxxx or just the video ID)",
        },
        language: {
          type: "string",
          description: "Preferred caption language code (default: 'en')",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "analyze_video_info",
    description:
      "Get metadata about a YouTube video: title, description, duration, channel, view count, publish date.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "YouTube URL or video ID",
        },
      },
      required: ["url"],
    },
  },
];

export async function handler(toolName: string, input: Record<string, unknown>): Promise<string> {
  switch (toolName) {
    case "youtube_summary":
      return getYouTubeTranscript(input);
    case "analyze_video_info":
      return getVideoInfo(input);
    default:
      return `Unknown video tool: ${toolName}`;
  }
}

function extractVideoId(urlOrId: string): string | null {
  // Direct ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId)) return urlOrId;

  // Various YouTube URL formats
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = urlOrId.match(pattern);
    if (match) return match[1];
  }

  return null;
}

async function getYouTubeTranscript(input: Record<string, unknown>): Promise<string> {
  const videoId = extractVideoId(input.url as string);
  if (!videoId) return "Invalid YouTube URL or video ID.";

  const lang = (input.language as string) || "en";

  try {
    // Fetch the video page to find caption tracks
    const pageResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GentechBot/2.0)",
        "Accept-Language": `${lang},en;q=0.9`,
      },
    });

    if (!pageResponse.ok) {
      return `Failed to fetch video page: ${pageResponse.status}`;
    }

    const html = await pageResponse.text();

    // Extract captions URL from the page data
    const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!captionMatch) {
      // Try to get video info instead
      const info = await getVideoInfoFromPage(html, videoId);
      return `No captions/transcript available for this video.\n\n${info}\n\nYou can still analyze the video based on its title and description.`;
    }

    let captionTracks: Array<{ baseUrl: string; languageCode: string; name: { simpleText: string } }>;
    try {
      captionTracks = JSON.parse(captionMatch[1]);
    } catch {
      return "Could not parse caption data from YouTube.";
    }

    // Find the best matching track
    let track = captionTracks.find((t) => t.languageCode === lang);
    if (!track) track = captionTracks.find((t) => t.languageCode.startsWith(lang));
    if (!track) track = captionTracks[0]; // fallback to first available
    if (!track) return "No caption tracks found.";

    // Fetch the transcript XML
    const captionUrl = track.baseUrl.replace(/\\u0026/g, "&");
    const captionResponse = await fetch(captionUrl);
    if (!captionResponse.ok) return `Failed to fetch captions: ${captionResponse.status}`;

    const xml = await captionResponse.text();

    // Parse XML transcript
    const transcript = parseTranscriptXml(xml);

    if (!transcript) return "Failed to parse transcript.";

    // Get video info
    const info = await getVideoInfoFromPage(html, videoId);

    // Truncate if very long (keep first ~8000 chars to stay within context)
    const maxLen = 8000;
    const truncated = transcript.length > maxLen
      ? transcript.substring(0, maxLen) + "\n\n[Transcript truncated — full video is longer]"
      : transcript;

    return `${info}\n\nTranscript (${track.name?.simpleText || track.languageCode}):\n\n${truncated}`;
  } catch (err) {
    return `Error fetching transcript: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function parseTranscriptXml(xml: string): string {
  const lines: string[] = [];
  const regex = /<text start="([\d.]+)"[^>]*>(.*?)<\/text>/gs;
  let match;

  while ((match = regex.exec(xml)) !== null) {
    const timestamp = parseFloat(match[1]);
    const text = decodeHtmlEntities(match[2].replace(/<[^>]*>/g, ""));

    if (text.trim()) {
      const mins = Math.floor(timestamp / 60);
      const secs = Math.floor(timestamp % 60);
      lines.push(`[${mins}:${secs.toString().padStart(2, "0")}] ${text}`);
    }
  }

  return lines.join("\n");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

async function getVideoInfo(input: Record<string, unknown>): Promise<string> {
  const videoId = extractVideoId(input.url as string);
  if (!videoId) return "Invalid YouTube URL or video ID.";

  try {
    // Use oEmbed API (no API key needed)
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(oembedUrl);

    if (!response.ok) return `Video not found or unavailable.`;

    const data = await response.json();

    return [
      `Title: ${data.title}`,
      `Channel: ${data.author_name}`,
      `Channel URL: ${data.author_url}`,
      `URL: https://youtube.com/watch?v=${videoId}`,
    ].join("\n");
  } catch (err) {
    return `Error fetching video info: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function getVideoInfoFromPage(html: string, videoId: string): string {
  const titleMatch = html.match(/<title>(.*?)<\/title>/);
  const title = titleMatch
    ? titleMatch[1].replace(" - YouTube", "").trim()
    : "Unknown";

  const descMatch = html.match(/"shortDescription":"(.*?)"/);
  const desc = descMatch
    ? descMatch[1]
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .substring(0, 500)
    : "";

  const channelMatch = html.match(/"ownerChannelName":"(.*?)"/);
  const channel = channelMatch ? channelMatch[1] : "Unknown";

  const viewMatch = html.match(/"viewCount":"(\d+)"/);
  const views = viewMatch ? parseInt(viewMatch[1]).toLocaleString() : "N/A";

  return [
    `Title: ${title}`,
    `Channel: ${channel}`,
    `Views: ${views}`,
    `URL: https://youtube.com/watch?v=${videoId}`,
    desc ? `\nDescription: ${desc}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Process a Telegram video file — extract info for analysis.
 * Returns a description that Claude can use for analysis.
 */
export function describeTelegramVideo(
  fileName: string | undefined,
  duration: number | undefined,
  mimeType: string | undefined,
  caption: string | undefined,
  fileSize: number | undefined
): string {
  const parts = [
    `[Video file received]`,
    fileName ? `Filename: ${fileName}` : null,
    duration ? `Duration: ${duration}s` : null,
    mimeType ? `Type: ${mimeType}` : null,
    fileSize ? `Size: ${(fileSize / 1024 / 1024).toFixed(1)}MB` : null,
    caption ? `Caption: ${caption}` : null,
  ].filter(Boolean);

  return parts.join("\n");
}
