/**
 * Install ClaudeDraft.shortcut from iCloud Drive onto the iPhone.
 * Recovery-first: dismisses whatever is on screen, goes home, opens Files.
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
  console.log(text ? text.substring(0, 1500) : "(empty)");
}

async function screen(client) {
  const r = await call(client, "describe_screen", { skip_ocr: false });
  return extractText(r);
}

async function goHome(client) {
  try {
    await call(client, "press_home");
  } catch {
    await call(client, "swipe", { startX: 170, startY: 760, endX: 170, endY: 350, durationMs: 300 });
  }
  await sleep(2500);
  activate();
  await sleep(500);
}

(async () => {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mirroir-mcp", "--dangerously-skip-permissions"],
  });
  const client = new Client({ name: "claude-final-install", version: "1.0" });
  await client.connect(transport);

  activate();
  await sleep(1200);

  let t = await screen(client);
  log("Current screen", t);

  // Dismiss any overlay (Cancel / Done buttons)
  if (/cancel|done/i.test(t)) {
    const cancelMatch = t.match(/\bcancel\b[^)]*?at \((\d+), (\d+)\)/i);
    if (cancelMatch) {
      console.log("Dismissing overlay via Cancel");
      await call(client, "tap", { x: parseInt(cancelMatch[1]), y: parseInt(cancelMatch[2]) });
      await sleep(1200);
      activate();
    }
  }

  await call(client, "press_key", { key: "escape", modifiers: [] });
  await sleep(800);
  await goHome(client);

  t = await screen(client);
  log("Home screen", t);

  // Use Spotlight: swipe down to reveal search
  await call(client, "swipe", { startX: 170, startY: 320, endX: 170, endY: 450, durationMs: 250 });
  await sleep(2000);
  activate();
  await sleep(300);
  await call(client, "type_text", { text: "Files" });
  await sleep(2500);
  activate();

  t = await screen(client);
  log("Spotlight: Files search results", t);

  // Tap the first "Files" result that isn't SearchMyFiles
  const lines = t.split("\n");
  let filesCoord = null;
  for (const line of lines) {
    if (/\bFiles\b/.test(line) && !/searchmyfiles|searchmy|my files/i.test(line)) {
      const m = line.match(/at \((\d+), (\d+)\)/);
      if (m) { filesCoord = m; break; }
    }
  }

  if (filesCoord) {
    console.log(`Tapping Files at (${filesCoord[1]}, ${filesCoord[2]})`);
    await call(client, "tap", { x: parseInt(filesCoord[1]), y: parseInt(filesCoord[2]) });
  } else {
    console.log("Pressing Return for top Spotlight result");
    await call(client, "press_key", { key: "return", modifiers: [] });
  }
  await sleep(3500);
  activate();

  t = await screen(client);
  log("After opening Files", t);

  // Navigate Browse → iCloud Drive
  const browseMatch = t.match(/\bbrowse\b[^)]*?at \((\d+), (\d+)\)/i);
  if (browseMatch) {
    console.log("Tapping Browse tab");
    await call(client, "tap", { x: parseInt(browseMatch[1]), y: parseInt(browseMatch[2]) });
    await sleep(2000);
    activate();
    t = await screen(client);
    log("Browse view", t);
  }

  const icloudMatch = t.match(/icloud\s*drive[^)]*?at \((\d+), (\d+)\)/i)
    || t.match(/icloud[^)]*?at \((\d+), (\d+)\)/i);
  if (icloudMatch) {
    console.log(`Tapping iCloud Drive at (${icloudMatch[1]}, ${icloudMatch[2]})`);
    await call(client, "tap", { x: parseInt(icloudMatch[1]), y: parseInt(icloudMatch[2]) });
    await sleep(2800);
    activate();
    t = await screen(client);
    log("iCloud Drive root", t);
  }

  // Scroll to find ClaudeDraft.shortcut if not visible
  if (!/claudedraft/i.test(t)) {
    await call(client, "swipe", { startX: 170, startY: 450, endX: 170, endY: 200, durationMs: 350 });
    await sleep(1800);
    activate();
    t = await screen(client);
    log("After scroll", t);
  }

  // Tap the .shortcut file (exclude "ClaudeDraft 1" which is the shortcut in the library)
  const fileMatch = t.match(/claudedraft(?:\.shortcut)?[^)]*?at \((\d+), (\d+)\)/i);
  if (!fileMatch) {
    log("ClaudeDraft.shortcut not found — final screen state", t);
    await client.close();
    process.exit(0);
  }

  console.log(`Tapping ClaudeDraft.shortcut at (${fileMatch[1]}, ${fileMatch[2]})`);
  await call(client, "tap", { x: parseInt(fileMatch[1]), y: parseInt(fileMatch[2]) });
  await sleep(5000);
  activate();
  await sleep(500);

  t = await screen(client);
  log("Install prompt", t);

  const installBtn = t.match(/(?:replace|add shortcut|add to shortcuts|set up)[^)]*?at \((\d+), (\d+)\)/i);
  if (installBtn) {
    const label = installBtn[0].split(" at")[0].trim();
    console.log(`Tapping "${label}" at (${installBtn[1]}, ${installBtn[2]})`);
    await call(client, "tap", { x: parseInt(installBtn[1]), y: parseInt(installBtn[2]) });
    await sleep(3000);
    activate();
    t = await screen(client);
    log("Post-install", t);
    console.log("\n✓ ClaudeDraft installation complete!");
  } else {
    log("No install button found — screen state", t);
  }

  await client.close();
  console.log("\n=== DONE ===");
})().catch(err => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
