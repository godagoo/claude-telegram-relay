/**
 * Drive iPhone to install ClaudeDraft.shortcut from iCloud Drive.
 *
 * Current state: iPhone is stuck in Safari.
 * Plan:
 *  1. Type shortcuts:// in Safari address bar → opens Shortcuts app
 *  2. Swipe up from very bottom to go to home screen
 *  3. Tap Files app icon
 *  4. Navigate iCloud Drive → tap ClaudeDraft.shortcut → Replace
 *  5. Run ClaudeDraft → verify compose field has "heading to London"
 */
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { execSync } = require("child_process");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractText(result) {
  let text = "";
  for (const c of result.content || []) {
    if (c.type === "text") text += "\n" + c.text;
  }
  return text.trim();
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  await sleep(1400);
  return result;
}

function activate() {
  try {
    execSync('osascript -e \'tell application "iPhone Mirroring" to activate\'', { timeout: 3000 });
  } catch {}
}

function log(label, text) {
  console.log(`\n=== ${label} ===`);
  console.log(text ? text.substring(0, 1200) : "(empty)");
}

async function describeScreen(client) {
  const r = await call(client, "describe_screen", { skip_ocr: false });
  return extractText(r);
}

async function homeScreen(client) {
  // Swipe up from the very bottom edge (home indicator zone) to go home.
  // On iPhone Mirroring the safe bottom is ~62pt. Screen height ~693pt on SE.
  // Start from y=730 (below content), end at y=300.
  await call(client, "swipe", { startX: 170, startY: 730, endX: 170, endY: 300, durationMs: 300 });
  await sleep(2000);
  activate();
  await sleep(500);
}

(async () => {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mirroir-mcp", "--dangerously-skip-permissions"],
  });
  const client = new Client({ name: "iphone-install-shortcut", version: "1.0.0" });
  await client.connect(transport);

  activate();
  await sleep(1000);

  // ── PHASE 1: Escape Safari by navigating to shortcuts:// ──────────────────
  console.log("\n=== PHASE 1: Escape Safari via address bar ===");

  // Tap the Safari address bar (URL bar at top, around y=90 below status bar)
  await call(client, "tap", { x: 170, y: 90 });
  await sleep(1500);
  activate();
  await sleep(500);

  let t = await describeScreen(client);
  log("After tapping address bar", t);

  // Select all existing text then type new URL
  await call(client, "press_key", { key: "a", modifiers: ["command"] });
  await sleep(500);
  await call(client, "type_text", { text: "shortcuts://" });
  await sleep(800);
  await call(client, "press_key", { key: "return", modifiers: [] });
  await sleep(3000);
  activate();
  await sleep(1000);

  t = await describeScreen(client);
  log("After shortcuts:// navigation", t);
  const inShortcuts = /shortcuts|my shortcuts|all shortcuts|claudedraft/i.test(t);
  console.log(`In Shortcuts: ${inShortcuts}`);

  // ── PHASE 2: Go to home screen ────────────────────────────────────────────
  console.log("\n=== PHASE 2: Go home (swipe from bottom) ===");
  await homeScreen(client);

  t = await describeScreen(client);
  log("Home screen", t);

  // Check if we're on home screen (look for app icons, dock, etc.)
  const onHome = /files|safari|messages|settings|clock/i.test(t);
  console.log(`Looks like home screen: ${onHome}`);

  // ── PHASE 3: Open Files app ───────────────────────────────────────────────
  console.log("\n=== PHASE 3: Find and tap Files app ===");

  // Try to find "Files" in the screen elements
  const filesMatch = t.match(/"Files"\s+at\s+\((\d+),\s*(\d+)\)/i)
    || t.match(/Files.*?at \((\d+), (\d+)\)/i);

  if (filesMatch) {
    const fx = parseInt(filesMatch[1]);
    const fy = parseInt(filesMatch[2]);
    console.log(`Found Files at (${fx}, ${fy}) — tapping`);
    await call(client, "tap", { x: fx, y: fy });
  } else {
    console.log("Files not visible. Searching via Spotlight...");
    // Swipe down to open Spotlight from middle of home screen
    await call(client, "swipe", { startX: 170, startY: 350, endX: 170, endY: 500, durationMs: 200 });
    await sleep(1500);
    activate();

    t = await describeScreen(client);
    log("Spotlight open", t);

    // Type "Files"
    await call(client, "type_text", { text: "Files" });
    await sleep(2000);
    activate();

    t = await describeScreen(client);
    log("Spotlight search for Files", t);

    // Tap the Files app result — usually the first app result
    const appResult = t.match(/"Files".*?at\s+\((\d+),\s*(\d+)\)/i)
      || t.match(/Files\s+app.*?at\s+\((\d+),\s*(\d+)\)/i)
      || t.match(/Files.*?at \((\d+), (\d+)\)/i);

    if (appResult) {
      console.log(`Tapping Files at (${appResult[1]}, ${appResult[2]})`);
      await call(client, "tap", { x: parseInt(appResult[1]), y: parseInt(appResult[2]) });
    } else {
      // Spotlight results area is typically around y=195-250
      console.log("Fallback tap on Spotlight result area y=195");
      await call(client, "tap", { x: 170, y: 195 });
    }
  }

  await sleep(3000);
  activate();
  await sleep(500);

  t = await describeScreen(client);
  log("Files app screen", t);

  // ── PHASE 4: Navigate to iCloud Drive root ────────────────────────────────
  console.log("\n=== PHASE 4: Navigate to iCloud Drive ===");

  const inFiles = /icloud|recents|browse|tags/i.test(t);
  console.log(`In Files app: ${inFiles}`);

  // Look for iCloud Drive in the file list
  const icloudEntry = t.match(/icloud\s+drive.*?at\s+\((\d+),\s*(\d+)\)/i)
    || t.match(/icloud.*?at \((\d+), (\d+)\)/i);

  if (icloudEntry) {
    console.log(`Tapping iCloud Drive at (${icloudEntry[1]}, ${icloudEntry[2]})`);
    await call(client, "tap", { x: parseInt(icloudEntry[1]), y: parseInt(icloudEntry[2]) });
  } else {
    // Try the Browse tab at bottom of Files app
    console.log("Tapping Browse tab");
    await call(client, "tap", { x: 280, y: 700 });
    await sleep(1500);
    activate();

    t = await describeScreen(client);
    log("After Browse tab", t);

    const icloud2 = t.match(/icloud\s+drive.*?at\s+\((\d+),\s*(\d+)\)/i)
      || t.match(/icloud.*?at \((\d+), (\d+)\)/i);
    if (icloud2) {
      await call(client, "tap", { x: parseInt(icloud2[1]), y: parseInt(icloud2[2]) });
    }
  }

  await sleep(2500);
  activate();

  t = await describeScreen(client);
  log("iCloud Drive listing", t);

  // ── PHASE 5: Find and tap ClaudeDraft.shortcut ────────────────────────────
  console.log("\n=== PHASE 5: Tap ClaudeDraft.shortcut ===");

  const hasShortcut = /claudedraft/i.test(t);
  console.log(`ClaudeDraft.shortcut visible: ${hasShortcut}`);

  if (hasShortcut) {
    const shortcutMatch = t.match(/claudedraft[^)]*?at \((\d+), (\d+)\)/i);
    if (shortcutMatch) {
      console.log(`Tapping at (${shortcutMatch[1]}, ${shortcutMatch[2]})`);
      await call(client, "tap", { x: parseInt(shortcutMatch[1]), y: parseInt(shortcutMatch[2]) });
      await sleep(3500);
      activate();

      t = await describeScreen(client);
      log("After tapping shortcut file", t);

      // ── PHASE 6: Tap "Replace" or "Add Shortcut" ─────────────────────────
      const replaceMatch = t.match(/(?:replace|add shortcut|set up)[^)]*?at \((\d+), (\d+)\)/i);
      if (replaceMatch) {
        console.log(`\nTapping "${replaceMatch[0].split(" at")[0]}" at (${replaceMatch[1]}, ${replaceMatch[2]})`);
        await call(client, "tap", { x: parseInt(replaceMatch[1]), y: parseInt(replaceMatch[2]) });
        await sleep(2500);
        activate();

        t = await describeScreen(client);
        log("After install", t);
        console.log("\n✓ Shortcut install step complete");
      } else {
        log("Install dialog (need manual check)", t);
      }
    }
  } else {
    console.log("\niCloud Drive contents (ClaudeDraft not visible — may need to scroll):");
    console.log(t);

    // Try scrolling down to find it
    await call(client, "swipe", { startX: 170, startY: 450, endX: 170, endY: 200, durationMs: 300 });
    await sleep(1500);
    activate();
    t = await describeScreen(client);
    log("After scrolling", t);
    const hasAfterScroll = /claudedraft/i.test(t);
    console.log(`ClaudeDraft visible after scroll: ${hasAfterScroll}`);
  }

  await client.close();
  console.log("\n=== DONE ===");
})().catch(err => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
