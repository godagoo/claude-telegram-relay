const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { execSync } = require("child_process");
const { isLikelyMessagesComposeSurface } = require("./iphone-mirror-screen.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function extractText(result) {
  let text = "";
  for (const content of result.content || []) {
    if (content.type === "text") text += `\n${content.text}`;
  }
  return text;
}

function isMirroringLocked(text) {
  return /iphone mirroring is locked|enter password|touch id/i.test(text);
}

function isMirroringUnavailable(text) {
  return /failed to capture\/analyze screen|window visible|no window|not connected/i.test(text);
}

function buildSmsUrl(recipient) {
  const cleaned = String(recipient || "").trim().replace(/\s+/g, "");
  return `sms:${cleaned}`;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  await sleep(1200);
  return result;
}

(async () => {
  const recipient = process.env.IPHONE_DRAFT_RECIPIENT || "";
  const body = process.env.IPHONE_DRAFT_BODY || "";
  if (!recipient.trim()) throw new Error("missing_recipient");
  if (!body.trim()) throw new Error("missing_body");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mirroir-mcp", "--dangerously-skip-permissions"],
  });
  const client = new Client({
    name: "claude-relay-iphone-mirror-draft",
    version: "1.0.0",
  });
  await client.connect(transport);

  // Bring iPhone Mirroring window to the front on the Mac so that type_text
  // sends keystrokes to the iPhone and not to whatever Mac app had focus.
  // This must happen before describing the screen so the MCP tool itself
  // operates on the correct surface.
  try {
    execSync('osascript -e \'tell application "iPhone Mirroring" to activate\'', {
      timeout: 3000,
    });
    await sleep(800);
  } catch {
    // iPhone Mirroring may not be running — the unavailability check below
    // will catch this and return a clean error.
  }

  const initial = await call(client, "describe_screen", { skip_ocr: false });
  const initialText = extractText(initial);
  if (isMirroringUnavailable(initialText)) {
    console.log(JSON.stringify({ ok: false, error: "iphone_mirroring_unavailable" }));
    await client.close();
    return;
  }
  if (isMirroringLocked(initialText)) {
    console.log(JSON.stringify({ ok: false, error: "iphone_mirroring_locked" }));
    await client.close();
    return;
  }

  await call(client, "open_url", { url: buildSmsUrl(recipient) });
  await call(client, "tap", { x: 170, y: 657 });
  const opened = await call(client, "describe_screen", { skip_ocr: false });
  const openedText = extractText(opened);
  if (!isLikelyMessagesComposeSurface(openedText)) {
    console.log(JSON.stringify({
      ok: false,
      verified: false,
      error: "iphone_messages_surface_not_visible",
    }));
    await client.close();
    return;
  }

  // Re-activate iPhone Mirroring after open_url, which may open Mac Messages
  // and steal Mac window focus. Without this, type_text types into Mac Messages
  // (or any other Mac app that grabbed focus) instead of the iPhone.
  try {
    execSync('osascript -e \'tell application "iPhone Mirroring" to activate\'', {
      timeout: 3000,
    });
    await sleep(600);
  } catch {
    // Best-effort.
  }

  // Do NOT use press_key with Mac modifiers (e.g. command+A) here.
  // macOS intercepts modifier-key combos and routes them to the frontmost
  // Mac app rather than the iPhone, shifting focus to Gmail or Mac Messages.
  // The compose field is empty when freshly opened via open_url — no need
  // to select-all before typing.
  await call(client, "type_text", { text: body });
  const described = await call(client, "describe_screen", { skip_ocr: false });
  const screenText = extractText(described);

  const verified = isLikelyMessagesComposeSurface(screenText) &&
    normalizeText(screenText).includes(normalizeText(body));
  console.log(
    JSON.stringify({
      ok: verified,
      mode: verified ? "typed" : undefined,
      verified,
      error: verified
        ? undefined
        : isMirroringUnavailable(screenText)
          ? "iphone_mirroring_unavailable"
        : isMirroringLocked(screenText)
          ? "iphone_mirroring_locked"
          : "body_not_visible_after_type",
    }),
  );

  await client.close();
})().catch((err) => {
  console.log(
    JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
