/**
 * iPhone Mirroring diagnostic: check ClaudeDraft shortcut and Files state.
 * Steps:
 *  1. Screenshot current state
 *  2. Open Files app -> iCloud Drive -> look for ClaudeDraft.shortcut
 *  3. Tap it to install/replace shortcut
 *  4. Then run the shortcut to verify the compose flow works
 */
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { execSync } = require("child_process");
const fs = require("fs");

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
  await sleep(1200);
  return result;
}

function activate() {
  try {
    execSync('osascript -e \'tell application "iPhone Mirroring" to activate\'', { timeout: 3000 });
  } catch {}
}

(async () => {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mirroir-mcp", "--dangerously-skip-permissions"],
  });
  const client = new Client({ name: "iphone-diagnose", version: "1.0.0" });
  await client.connect(transport);

  activate();
  await sleep(1000);

  // Step 1: what's on screen right now?
  console.log("\n=== STEP 1: Current screen ===");
  const s1 = await call(client, "describe_screen", { skip_ocr: false });
  const t1 = extractText(s1);
  console.log(t1.substring(0, 600));

  // Step 2: Go home first
  console.log("\n=== STEP 2: Press Home ===");
  await call(client, "press_key", { key: "h", modifiers: [] });
  await sleep(1500);
  activate();
  await sleep(800);

  const s2 = await call(client, "describe_screen", { skip_ocr: false });
  const t2 = extractText(s2);
  console.log(t2.substring(0, 400));

  // Step 3: Open Files app
  console.log("\n=== STEP 3: Open Files app ===");
  // Try URL scheme first
  await call(client, "open_url", { url: "shareddocuments://" });
  await sleep(2000);
  activate();
  await sleep(800);

  const s3 = await call(client, "describe_screen", { skip_ocr: false });
  const t3 = extractText(s3);
  console.log(t3.substring(0, 600));

  // Step 4: Navigate to iCloud Drive
  console.log("\n=== STEP 4: Screen after Files open ===");
  // Look for iCloud Drive in the output
  const hasICloud = /icloud/i.test(t3);
  const hasFiles = /files/i.test(t3);
  console.log(`hasICloud=${hasICloud} hasFiles=${hasFiles}`);

  // Take a screenshot so we can see visually
  console.log("\n=== STEP 5: Taking screenshot ===");
  const screenshot = await call(client, "take_screenshot", {});
  const imgData = screenshot.content?.find(c => c.type === "image");
  if (imgData?.data) {
    const buf = Buffer.from(imgData.data, "base64");
    fs.writeFileSync("/tmp/iphone-files-screen.png", buf);
    console.log("Screenshot saved to /tmp/iphone-files-screen.png");
  }

  console.log("\n=== STEP 6: Full screen text ===");
  console.log(t3);

  await client.close();
})().catch(err => {
  console.error("ERROR:", err.message || err);
  process.exit(1);
});
