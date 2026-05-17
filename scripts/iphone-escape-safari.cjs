/**
 * Escape Safari by pressing Escape to dismiss keyboard, then open shortcuts://
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
  await sleep(1200);
  return r;
}
function activate() {
  try { execSync('osascript -e \'tell application "iPhone Mirroring" to activate\'', { timeout: 3000 }); } catch {}
}

(async () => {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mirroir-mcp", "--dangerously-skip-permissions"],
  });
  const client = new Client({ name: "escape", version: "1.0" });
  await client.connect(transport);
  activate();
  await sleep(1000);

  // 1. Press Escape to dismiss any focused text field / keyboard
  console.log("1. Pressing Escape to dismiss keyboard...");
  await call(client, "press_key", { key: "escape", modifiers: [] });
  await sleep(1000);
  activate();

  // 2. Press Escape again to dismiss search overlay if any
  await call(client, "press_key", { key: "escape", modifiers: [] });
  await sleep(800);

  // 3. Now open shortcuts:// - with no text field focused, this should trigger iOS routing
  console.log("2. Opening shortcuts:// URL scheme...");
  await call(client, "open_url", { url: "shortcuts://" });
  await sleep(3000);
  activate();
  await sleep(500);

  let t = extractText(await call(client, "describe_screen", { skip_ocr: false }));
  console.log("\nScreen after shortcuts://:");
  console.log(t.substring(0, 600));

  const inShortcuts = /shortcuts|all shortcuts|my shortcuts|claudedraft/i.test(t);
  console.log(`In Shortcuts app: ${inShortcuts}`);

  if (!inShortcuts) {
    // Still stuck. Try going home via multiple swipe attempts from different y values.
    console.log("\nNot in Shortcuts. Trying aggressive home swipe from y=700...");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const startY = 690 + (attempt * 5);
      console.log(`  Swipe attempt ${attempt}: startY=${startY}`);
      await call(client, "swipe", { startX: 170, startY, endX: 170, endY: 300, durationMs: 400 });
      await sleep(1800);
      activate();
      t = extractText(await call(client, "describe_screen", { skip_ocr: false }));
      const onHome = /files|shortcuts|messages|settings|photos|camera/i.test(t)
        && !/google|kant|shopping/i.test(t);
      console.log(`  onHome=${onHome}, snippet: ${t.substring(0, 200)}`);
      if (onHome) break;
    }
  }

  // 4. After getting out of Safari, try to open the Shortcuts app via URL
  console.log("\n3. One more shortcuts:// attempt...");
  await call(client, "open_url", { url: "shortcuts://run-shortcut?name=ClaudeDraft" });
  await sleep(4000);
  activate();
  await sleep(500);

  t = extractText(await call(client, "describe_screen", { skip_ocr: false }));
  console.log("\nFinal screen:");
  console.log(t.substring(0, 800));

  const ran = /heading to london|dad|recipient|message|imessage|compose/i.test(t);
  const inSC = /shortcuts|claudedraft/i.test(t);
  const inFiles = /files|icloud/i.test(t);
  console.log(`ranShortcut=${ran} inShortcuts=${inSC} inFiles=${inFiles}`);

  await client.close();
})().catch(e => { console.error(e.message); process.exit(1); });
