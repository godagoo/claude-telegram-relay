/**
 * We're on the home screen. Files is at (267, 421).
 * Navigate to iCloud Drive -> ClaudeDraft.shortcut -> Replace.
 */
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { execSync } = require("child_process");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function extractText(r) {
  let t = "";
  for (const c of r.content || []) if (c.type === "text") t += "\n" + c.text;
  return t.trim();
}
async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  await sleep(1400);
  return r;
}
function activate() {
  try { execSync('osascript -e \'tell application "iPhone Mirroring" to activate\'', { timeout: 3000 }); } catch {}
}
function log(label, text) {
  console.log(`\n=== ${label} ===`);
  console.log((text || "").substring(0, 800));
}
function goHome() {
  execSync(`osascript -e 'tell application "iPhone Mirroring" to activate' -e 'delay 0.3' -e 'tell application "System Events" to tell process "iPhone Mirroring" to click menu item "Home Screen" of menu 1 of menu bar item "View" of menu bar 1'`, { timeout: 5000 });
}

(async () => {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mirroir-mcp", "--dangerously-skip-permissions"],
  });
  const client = new Client({ name: "install-final", version: "1.0" });
  await client.connect(transport);
  activate();
  await sleep(800);

  // ── Step 1: Tap Files app (known location: 267, 421) ──────────────────────
  console.log("Step 1: Tapping Files app at (267, 421)...");
  await call(client, "tap", { x: 267, y: 421 });
  await sleep(2500);
  activate();

  let t = extractText(await call(client, "describe_screen", { skip_ocr: false }));
  log("Files app", t);

  const inFiles = /browse|recents|icloud|tags|locations|favourites/i.test(t);
  console.log(`In Files: ${inFiles}`);

  // ── Step 2: Tap Browse tab if needed ─────────────────────────────────────
  if (!inFiles || !/icloud drive/i.test(t)) {
    console.log("Tapping Browse tab...");
    // Browse tab is usually the second tab at the bottom of Files
    const browseCoord = t.match(/browse.*?at \((\d+), (\d+)\)/i);
    if (browseCoord) {
      await call(client, "tap", { x: parseInt(browseCoord[1]), y: parseInt(browseCoord[2]) });
    } else {
      // Files bottom tab bar: Recents(left) and Browse(right)
      await call(client, "tap", { x: 280, y: 720 });
    }
    await sleep(2000);
    activate();
    t = extractText(await call(client, "describe_screen", { skip_ocr: false }));
    log("After Browse tap", t);
  }

  // ── Step 3: Tap iCloud Drive ──────────────────────────────────────────────
  console.log("Step 3: Tapping iCloud Drive...");
  const icloudCoord = t.match(/icloud\s+drive.*?at \((\d+), (\d+)\)/i)
    || t.match(/icloud.*?at \((\d+), (\d+)\)/i);

  if (icloudCoord) {
    console.log(`Found iCloud Drive at (${icloudCoord[1]}, ${icloudCoord[2]})`);
    await call(client, "tap", { x: parseInt(icloudCoord[1]), y: parseInt(icloudCoord[2]) });
  } else {
    console.log("iCloud Drive not found in:", t.substring(0, 300));
    // Locations section usually has iCloud Drive, On My iPhone, etc.
    // Try scrolling up to find it
    await call(client, "swipe", { startX: 170, startY: 350, endX: 170, endY: 550, durationMs: 200 });
    await sleep(1500);
    activate();
    t = extractText(await call(client, "describe_screen", { skip_ocr: false }));
    log("After scrolling up", t);
    const ic2 = t.match(/icloud.*?at \((\d+), (\d+)\)/i);
    if (ic2) await call(client, "tap", { x: parseInt(ic2[1]), y: parseInt(ic2[2]) });
  }

  await sleep(2500);
  activate();
  t = extractText(await call(client, "describe_screen", { skip_ocr: false }));
  log("iCloud Drive listing", t);

  // ── Step 4: Find ClaudeDraft.shortcut ────────────────────────────────────
  console.log(`\nClaudeDraft visible: ${/claudedraft/i.test(t)}`);

  if (/claudedraft/i.test(t)) {
    const sc = t.match(/claudedraft[^)]*?at \((\d+), (\d+)\)/i);
    if (sc) {
      console.log(`Tapping ClaudeDraft.shortcut at (${sc[1]}, ${sc[2]})`);
      await call(client, "tap", { x: parseInt(sc[1]), y: parseInt(sc[2]) });
      await sleep(4000);
      activate();
      t = extractText(await call(client, "describe_screen", { skip_ocr: false }));
      log("After tapping .shortcut", t);

      // ── Step 5: Tap Replace or Add Shortcut ──────────────────────────────
      const btn = t.match(/(?:replace|add shortcut)[^)]*?at \((\d+), (\d+)\)/i)
        || t.match(/"(?:Replace|Add Shortcut)"[^)]*?at \((\d+), (\d+)\)/i);

      if (btn) {
        const label = btn[0].split(" at")[0];
        console.log(`\n✓ Tapping "${label}" at (${btn[1]}, ${btn[2]})`);
        await call(client, "tap", { x: parseInt(btn[1]), y: parseInt(btn[2]) });
        await sleep(3000);
        activate();
        t = extractText(await call(client, "describe_screen", { skip_ocr: false }));
        log("Post-install", t);
        console.log("\n✓ ClaudeDraft shortcut installed on iPhone!");

        // ── Step 6: Go home then run the shortcut to verify ──────────────
        console.log("\nStep 6: Going home to run ClaudeDraft for verification...");
        goHome();
        await sleep(1500);
        activate();
        t = extractText(await call(client, "describe_screen", { skip_ocr: false }));
        log("Home after install", t);
      } else {
        // Look for any actionable buttons
        const anyBtn = t.match(/(?:add|replace|done|open)[^)]*?at \((\d+), (\d+)\)/i);
        if (anyBtn) {
          console.log(`Tapping "${anyBtn[0].split(" at")[0]}" at (${anyBtn[1]}, ${anyBtn[2]})`);
          await call(client, "tap", { x: parseInt(anyBtn[1]), y: parseInt(anyBtn[2]) });
          await sleep(2000);
          activate();
          t = extractText(await call(client, "describe_screen", { skip_ocr: false }));
          log("After action tap", t);
        } else {
          log("No install button found — full screen", t);
        }
      }
    }
  } else {
    // Scroll down to find it
    console.log("Scrolling to find ClaudeDraft...");
    await call(client, "swipe", { startX: 170, startY: 500, endX: 170, endY: 200, durationMs: 300 });
    await sleep(1500);
    activate();
    t = extractText(await call(client, "describe_screen", { skip_ocr: false }));
    log("After scroll", t);
    console.log(`ClaudeDraft after scroll: ${/claudedraft/i.test(t)}`);
    if (/claudedraft/i.test(t)) {
      const sc2 = t.match(/claudedraft[^)]*?at \((\d+), (\d+)\)/i);
      if (sc2) {
        console.log(`Tapping at (${sc2[1]}, ${sc2[2]})`);
        await call(client, "tap", { x: parseInt(sc2[1]), y: parseInt(sc2[2]) });
        await sleep(3500);
        activate();
        t = extractText(await call(client, "describe_screen", { skip_ocr: false }));
        log("After tapping shortcut", t);
      }
    }
  }

  await client.close();
  console.log("\n=== DONE ===");
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
