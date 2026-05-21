import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  DRAFT_MARKER_CLOSE,
  DRAFT_MARKER_OPEN,
  NEW_COMPOSE_SENTINEL,
  extractDraftBody,
  formatPhoneHandoffForTelegram,
  rebuildAroundDraftBlock,
  replaceDraftBlock,
  stripPlacementClaims,
} from "./imessage-draft";
import { stripProseDashes } from "./response-sanitize";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

const wrap = (body: string) =>
  `Here's the draft for Peggy:\n\n${DRAFT_MARKER_OPEN}\n${body}\n${DRAFT_MARKER_CLOSE}\n`;

test("extracts the body between marker pair", () => {
  const body = "Hey Peggy, hoping for a deep clean this week.";
  expect(extractDraftBody(wrap(body))).toBe(body);
});

test("returns null when markers are missing", () => {
  expect(
    extractDraftBody("Here's the draft for Peggy: \"Hey Peggy...\""),
  ).toBeNull();
});

test("returns null when only the opening marker is present", () => {
  expect(extractDraftBody(`Hey there ${DRAFT_MARKER_OPEN}\nbody only`)).toBeNull();
});

test("returns null when the body is whitespace only", () => {
  expect(
    extractDraftBody(`${DRAFT_MARKER_OPEN}\n   \n${DRAFT_MARKER_CLOSE}`),
  ).toBeNull();
});

test("replaceDraftBlock swaps in the confirmation line", () => {
  const input = wrap("Hey Peggy, hoping for a deep clean.");
  const out = replaceDraftBlock(input, "[placed in Messages]");
  expect(out).toContain("[placed in Messages]");
  expect(out).not.toContain(DRAFT_MARKER_OPEN);
  expect(out).not.toContain(DRAFT_MARKER_CLOSE);
});

test("replaceDraftBlock strips orphan markers when no pair exists", () => {
  const input = `Draft preview: ${DRAFT_MARKER_OPEN} body without close`;
  const out = replaceDraftBlock(input, "ignored");
  expect(out).not.toContain(DRAFT_MARKER_OPEN);
  expect(out).not.toContain(DRAFT_MARKER_CLOSE);
  expect(out).toContain("Draft preview:");
});

// Regression: 2026-05-11 screenshot. Claude wrote a trailing "Draft in the
// Messages compose box for Galene. Review and send when ready." line AFTER
// the closing marker. The relay's no_recipient hint said "Couldn't open
// Messages — no thread found for galene." and Telegram showed both,
// contradicting each other. rebuildAroundDraftBlock must discard everything
// after the closing marker so only the relay's status reaches the user.
test("rebuildAroundDraftBlock discards trailing hallucinated success claim", () => {
  const input = [
    "Here's the draft for Galene:",
    "",
    DRAFT_MARKER_OPEN,
    "Thanks again for taking the reins on coordinating tomorrow's meeting.",
    DRAFT_MARKER_CLOSE,
    "",
    "Draft in the Messages compose box for Galene. Review and send when ready.",
  ].join("\n");

  const hint = "Couldn't open Messages on your Mac — no thread found for galene.";
  const out = rebuildAroundDraftBlock(input, `[body]\n\n${hint}`);

  expect(out).toContain("Here's the draft for Galene:");
  expect(out).toContain("[body]");
  expect(out).toContain(hint);
  expect(out).not.toContain("Draft in the Messages compose box");
  expect(out).not.toContain("Review and send when ready");
  expect(out).not.toContain(DRAFT_MARKER_OPEN);
  expect(out).not.toContain(DRAFT_MARKER_CLOSE);
});

test("rebuildAroundDraftBlock strips placement claims from the lead too", () => {
  const input = [
    "I've placed the draft in Messages for Peggy.",
    "Here's the draft for Peggy:",
    DRAFT_MARKER_OPEN,
    "Body.",
    DRAFT_MARKER_CLOSE,
  ].join("\n");

  const out = rebuildAroundDraftBlock(input, "[relay status]");
  expect(out).toContain("Here's the draft for Peggy:");
  expect(out).toContain("[relay status]");
  expect(out).not.toMatch(/I've placed the draft/i);
});

test("rebuildAroundDraftBlock drops an all-claim lead fragment", () => {
  const input = [
    "Draft is in the Messages compose box for Peggy.",
    "",
    DRAFT_MARKER_OPEN,
    "Body.",
    DRAFT_MARKER_CLOSE,
  ].join("\n");

  const out = rebuildAroundDraftBlock(input, "Body.");
  expect(out).toBe("Body.");
  expect(out).not.toMatch(/Messages compose box/i);
});

test("rebuildAroundDraftBlock returns only the replacement when there is no lead", () => {
  const input = `${DRAFT_MARKER_OPEN}\nBody.\n${DRAFT_MARKER_CLOSE}\nDraft is placed.`;
  const out = rebuildAroundDraftBlock(input, "[status]");
  expect(out).toBe("[status]");
});

test("rebuildAroundDraftBlock falls back gracefully when no markers exist", () => {
  const input = [
    "Here's the draft for Peggy:",
    "Body text.",
    "Draft is in the Messages compose box for Peggy. Review and send when ready.",
  ].join("\n");
  const out = rebuildAroundDraftBlock(input, "[status]");
  expect(out).toContain("Here's the draft for Peggy:");
  expect(out).toContain("Body text.");
  expect(out).toContain("[status]");
  expect(out).not.toMatch(/Draft is in the Messages compose box/i);
});

test("rebuildAroundDraftBlock no-marker fallback drops all-claim text", () => {
  const input = "Draft is in the Messages compose box for Peggy. Review and send when ready.";
  const out = rebuildAroundDraftBlock(input, "[status]");
  expect(out).toBe("[status]");
  expect(out).not.toMatch(/Messages compose box/i);
});

// Regression 2026-05-20: directIMessageBody path with an em/en dash in the body.
// The user's raw body (e.g. "Text +1555... saying see you tomorrow — at the
// place") was wrapped in markers without going through postProcessClaudeResponse,
// so the em-dash survived. The relay then called rebuildAroundDraftBlock twice:
// once to inline the dash-stripped body, and once again at the staging-success
// site to finalize. The second call fell into the no-markers branch because the
// first call had already removed them, and appended the body a second time,
// shipping a duplicated reply to Telegram.
//
// The fix in relay.ts: only update the body variable after stripProseDashes;
// do NOT rebuildAroundDraftBlock between the two operations. The single final
// rebuild finds the original markers and produces a clean reply.
test("regression: dash-stripped direct body uses one rebuild, no duplication", () => {
  const userBody = "see you tomorrow — at the place";
  const wrapped = `${DRAFT_MARKER_OPEN}\n${userBody}\n${DRAFT_MARKER_CLOSE}`;

  // Correct sequence (matches relay.ts after fix):
  let body = extractDraftBody(wrapped);
  expect(body).toBe(userBody);
  const sanitized = stripProseDashes(body!);
  expect(sanitized.stripped).toBeGreaterThan(0);
  body = sanitized.clean;
  expect(body).toBe("see you tomorrow, at the place");

  // ONE rebuild against the original wrapped text. The markers are still there,
  // so the function inlines the sanitized body and discards the markers.
  const finalText = rebuildAroundDraftBlock(wrapped, body);
  expect(finalText).toBe("see you tomorrow, at the place");

  // Negative documentation: calling rebuild twice on the same text loses the
  // markers after the first call and duplicates the body on the second. This
  // is the bug the fix avoids; do NOT chain rebuilds.
  const buggyFirst = rebuildAroundDraftBlock(wrapped, body);
  const buggySecond = rebuildAroundDraftBlock(buggyFirst, body);
  expect(buggySecond).toBe(
    "see you tomorrow, at the place\n\nsee you tomorrow, at the place",
  );
});

// Regression: same bug class but with a hint appended (e.g. helper_failed
// path). After the fix, a single rebuild with `${body}\n\n${hint}` produces
// the lead-free reply plus the diagnostic hint, no duplication.
test("regression: dash-stripped direct body with hint produces single body + hint", () => {
  const userBody = "see you — soon";
  const wrapped = `${DRAFT_MARKER_OPEN}\n${userBody}\n${DRAFT_MARKER_CLOSE}`;

  let body = extractDraftBody(wrapped);
  body = stripProseDashes(body!).clean;
  expect(body).toBe("see you, soon");

  const hint = "(Couldn't stage this through the iMessage watcher: osascript_timeout.)";
  const finalText = rebuildAroundDraftBlock(wrapped, `${body}\n\n${hint}`);
  expect(finalText).toBe(`see you, soon\n\n${hint}`);
  // Only one occurrence of the body.
  expect(finalText.match(/see you, soon/g)).toHaveLength(1);
});

test("stripPlacementClaims removes common hallucinated placement lines", () => {
  const input = [
    "Body text stays.",
    "Draft is in the Messages compose box for Galene. Review and send when ready.",
    "I've placed the draft in Messages for Peggy.",
    "Opened Messages on her thread.",
    "More body text stays.",
  ].join("\n");

  const out = stripPlacementClaims(input);
  expect(out).toContain("Body text stays.");
  expect(out).toContain("More body text stays.");
  expect(out).not.toMatch(/Draft is in the Messages/i);
  expect(out).not.toMatch(/I've placed the draft/i);
  expect(out).not.toMatch(/Opened Messages/i);
});

test("stripPlacementClaims is a no-op for normal text", () => {
  const input = "Hey Peggy, hoping for a deep clean this week. Thanks!";
  expect(stripPlacementClaims(input)).toBe(input);
});

// Regression: 2026-05-11 feedback "Never say send manually again". Claude was
// appending the drafting-policy footer to every draft response. Strip every
// known variant of that line so it never reaches Telegram.
test("stripPlacementClaims removes 'Draft above, review and send manually' boilerplate", () => {
  const input = [
    "Here's the draft for Conor:",
    "Hope all is well, man.",
    "Draft above, review and send manually.",
  ].join("\n");
  const out = stripPlacementClaims(input);
  expect(out).toContain("Here's the draft for Conor:");
  expect(out).toContain("Hope all is well, man.");
  expect(out).not.toMatch(/Draft above/i);
  expect(out).not.toMatch(/send manually/i);
});

test("stripPlacementClaims removes 'send it manually' / 'send it yourself' variants", () => {
  const input = [
    "Body line.",
    "Send it manually when you're ready.",
    "You'll need to send it yourself.",
    "I cannot send this for you.",
    "More body line.",
  ].join("\n");
  const out = stripPlacementClaims(input);
  expect(out).toContain("Body line.");
  expect(out).toContain("More body line.");
  expect(out).not.toMatch(/send it manually/i);
  expect(out).not.toMatch(/send it yourself/i);
  expect(out).not.toMatch(/cannot send/i);
});

test("stripPlacementClaims safety guard: never empties a non-empty response", () => {
  // 2026-05-11: an over-aggressive pattern (`(?:you'll|you\s+will|you)\s+
  // (?:need|have|can)\s+to\s+send`) ate the entire response, producing
  // "I'm sorry, I generated an empty response" on Telegram. The safety
  // guard now returns the original text if the strip would empty it.
  // Worst case: the user sees one boilerplate line. Better than an
  // apology with no content.
  const relayStatus = "Draft is in the Messages compose box on your Mac for Gaileen. Review and send from there when ready.";
  // Without the guard this would empty out (pattern 1 matches the whole
  // line). With the guard, the original is returned and the caller — by
  // contract — only ever runs the strip BEFORE adding the relay status.
  expect(stripPlacementClaims(relayStatus)).toBe(relayStatus);
  expect(stripPlacementClaims(relayStatus, { preserveNonEmpty: false })).toBe("");
});

test("stripPlacementClaims preserves legitimate body lines that mention 'send'", () => {
  // Regression for the 8:24 PM Conor failure where Claude returned a
  // legitimate reply and the over-broad pattern stripped it to empty.
  const input = [
    "You need to send Conor a phone number first.",
    "Then I can place the draft directly into Messages.",
  ].join("\n");
  expect(stripPlacementClaims(input)).toBe(input);
});

test("stripPlacementClaims removes Claude refusal-plus-draft footers (regression 2026-05-15)", () => {
  // Live failure uid=814654418: user said "Unacceptable response", Claude replied
  // with "I do not have the ability to send messages on your behalf…" preamble +
  // the draft body + "You'll need to send this directly through your Messages app"
  // footer. stripPlacementClaims must extract only the draft body.
  const input = [
    "I do not have the ability to send messages on your behalf - I can only help you draft messages. Here's what you could send:",
    "",
    "heading to London",
    "",
    "You'll need to send this directly through your Messages app or another messaging platform.",
  ].join("\n");
  expect(stripPlacementClaims(input).trim()).toBe("heading to London");

  // "I don't have…" contraction form
  const contraction = [
    "I don't have the ability to send messages on your behalf.",
    "",
    "Draft body here.",
    "",
    "You'll need to send this directly through your Messages app.",
  ].join("\n");
  expect(stripPlacementClaims(contraction).trim()).toBe("Draft body here.");
});

test("stripPlacementClaims preserves placement-like lines inside draft markers", () => {
  const input = [
    "Lead.",
    DRAFT_MARKER_OPEN,
    "I can't send it today.",
    "I have placed the draft notes in the folder.",
    DRAFT_MARKER_CLOSE,
    "Draft is in the Messages compose box for Peggy.",
  ].join("\n");
  const out = stripPlacementClaims(input);
  expect(extractDraftBody(out)).toBe(
    "I can't send it today.\nI have placed the draft notes in the folder.",
  );
  expect(out).not.toMatch(/Messages compose box for Peggy/i);
});

test("NEW_COMPOSE_SENTINEL is the documented '?' character", () => {
  // Keeping this in lockstep with scripts/draft-imessage.sh's is_blank_sentinel.
  // If you change this constant, update the script's recognized sentinels.
  expect(NEW_COMPOSE_SENTINEL).toBe("?");
});

test("phone handoff formatting strips the handoff line and leaves the body visible", () => {
  const formatted = formatPhoneHandoffForTelegram(
    "Here's the draft for Mark:\n\nHey Mark, sounds good.\n\nPhone handoff ready: shortcuts://run-shortcut?name=ClaudeDraft\n",
  );

  expect(formatted).toBe("Here's the draft for Mark:\n\nHey Mark, sounds good.");
  expect(formatted).not.toContain("Phone handoff ready:");
  expect(formatted).not.toContain("shortcuts://run-shortcut?name=ClaudeDraft");
  expect(formatted).not.toContain("Run ClaudeDraft in Shortcuts");
});

test("phone handoff formatting strips the recipient-tagged handoff line too", () => {
  const formatted = formatPhoneHandoffForTelegram(
    "heading to London\n\nPhone handoff ready for dad (+16048092405): shortcuts://run-shortcut?name=ClaudeDraft\n",
  );

  expect(formatted).toBe("heading to London");
  expect(formatted).not.toContain("Phone handoff ready:");
  expect(formatted).not.toContain("Run ClaudeDraft in Shortcuts");
});

test("phone handoff formatting strips the legacy Open on iPhone line", () => {
  const formatted = formatPhoneHandoffForTelegram(
    "Here's the draft for Mark:\n\nHey Mark, sounds good.\n\nOpen on iPhone: shortcuts://run-shortcut?name=ClaudeDraft\n",
  );

  expect(formatted).toBe("Here's the draft for Mark:\n\nHey Mark, sounds good.");
  expect(formatted).not.toContain("Open on iPhone:");
  expect(formatted).not.toContain("Run ClaudeDraft in Shortcuts");
});

test("phone handoff formatting returns empty string when nothing remains", () => {
  expect(
    formatPhoneHandoffForTelegram(
      "Phone handoff ready: shortcuts://run-shortcut?name=ClaudeDraft",
    ),
  ).toBe("");
});

test("phone handoff formatting leaves ordinary chatbot draft text alone", () => {
  const visible = "Draft ready.\n\nheading to London";

  expect(formatPhoneHandoffForTelegram(visible)).toBe(visible);
});

async function runDraftHelper(recipient: string, body: string) {
  const dir = await mkdtemp(join(tmpdir(), "draft-imessage-helper-"));
  const openLog = join(dir, "open.log");
  const clipboardLog = join(dir, "clipboard.txt");
  const fakeOpen = join(dir, "fake-open.sh");
  const fakePbcopy = join(dir, "fake-pbcopy.sh");

  await writeFile(
    fakeOpen,
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$1\" >> \"$RELAY_FAKE_OPEN_LOG\"\n",
  );
  await writeFile(
    fakePbcopy,
    "#!/usr/bin/env bash\ncat > \"$RELAY_FAKE_CLIPBOARD_LOG\"\n",
  );
  await chmod(fakeOpen, 0o700);
  await chmod(fakePbcopy, 0o700);

  try {
    const proc = Bun.spawn(
      [join(PROJECT_ROOT, "scripts", "draft-imessage.sh"), recipient],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          RELAY_OPEN_CMD: fakeOpen,
          RELAY_PBCOPY_CMD: fakePbcopy,
          RELAY_FAKE_OPEN_LOG: openLog,
          RELAY_FAKE_CLIPBOARD_LOG: clipboardLog,
        },
      },
    );
    proc.stdin?.write(body);
    await proc.stdin?.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      code,
      stdout,
      stderr,
      openLog: await readFile(openLog, "utf8").catch(() => ""),
      clipboard: await readFile(clipboardLog, "utf8").catch(() => ""),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("draft helper treats NEW_COMPOSE_SENTINEL as unverified blank-recipient compose", async () => {
  const result = await runDraftHelper(NEW_COMPOSE_SENTINEL, "Hello world");

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    recipient: NEW_COMPOSE_SENTINEL,
    mode: "clipboard_only",
    reason: "sms_body_url_opened_unverified_new_compose",
  });
  expect(result.openLog.trim()).toBe("sms:&body=Hello%20world");
  expect(result.clipboard).toBe("Hello world");
});

test("draft helper emits JSON-safe recipient values", async () => {
  const result = await runDraftHelper('a"b@example.com', "Hi");

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    recipient: 'a"b@example.com',
    mode: "clipboard_only",
    reason: "sms_body_url_opened_unverified",
  });
  expect(result.openLog.trim()).toBe("sms:a%22b@example.com&body=Hi");
});

async function runStageHelper(
  recipient: string,
  label: string,
  body: string,
  extraEnv: Record<string, string> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "stage-imessage-helper-"));
  const payloadPath = join(dir, "payload.txt");

  try {
    const proc = Bun.spawn(
      [join(PROJECT_ROOT, "scripts", "stage-imessage.sh"), recipient, label],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          RELAY_IMESSAGE_STAGING_HANDLE: "+15550001111",
          RELAY_STAGE_IMESSAGE_DRY_RUN_PATH: payloadPath,
          ...extraEnv,
        },
      },
    );
    proc.stdin?.write(body);
    await proc.stdin?.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      code,
      stdout,
      stderr,
      payload: await readFile(payloadPath, "utf8").catch(() => ""),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("stage helper writes the CLDRAFT/1 JSON payload shape in dry-run mode", async () => {
  const result = await runStageHelper(
    "+15196816391",
    "Peggy",
    "Hey Peggy,\nCould you come by Friday?",
  );

  expect(result.code).toBe(0);
  const envelope = JSON.parse(result.stdout);
  expect(envelope).toMatchObject({
    ok: true,
    recipient: "+15196816391",
    mode: "dry_run",
  });
  expect(envelope.payload_sha256).toMatch(/^[a-f0-9]{64}$/);
  const parsedPayload = JSON.parse(result.payload);
  expect(parsedPayload).toMatchObject({
    version: "CLDRAFT/1",
    to: "+15196816391",
    label: "Peggy",
    body: "Hey Peggy,\nCould you come by Friday?",
  });
  // draft_id is a freshly generated UUIDv4 in the legacy shell-side builder.
  expect(parsedPayload.draft_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test("stage helper sanitizes header newlines without changing the body", async () => {
  const result = await runStageHelper(
    "+15196816391\nignored",
    "Peggy\nLabel",
    "Line one\n---\nLine three",
  );

  expect(result.code).toBe(0);
  expect(JSON.parse(result.payload)).toMatchObject({
    version: "CLDRAFT/1",
    to: "+15196816391 ignored",
    label: "Peggy Label",
    body: "Line one\n---\nLine three",
  });
});

test("stage helper honors a caller-supplied DRAFT_ID env var (legacy path)", async () => {
  const fixedId = "550e8400-e29b-41d4-a716-446655440000";
  const result = await runStageHelper(
    "+15196816391",
    "Peggy",
    "Hi",
    { RELAY_CLDRAFT_DRAFT_ID: fixedId },
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.payload).draft_id).toBe(fixedId);
});

test("stage helper uses RELAY_CLDRAFT_PAYLOAD_JSON verbatim when provided (production path)", async () => {
  const prebuilt = JSON.stringify({
    version: "CLDRAFT/1",
    draft_id: "550e8400-e29b-41d4-a716-446655440000",
    to: "+15196816391",
    label: "Peggy",
    body: "Pre-built body from TypeScript",
  });
  const result = await runStageHelper(
    "+15196816391",
    "Peggy",
    // body on stdin is ignored when RELAY_CLDRAFT_PAYLOAD_JSON is set
    "this-stdin-body-should-not-appear",
    { RELAY_CLDRAFT_PAYLOAD_JSON: prebuilt },
  );
  expect(result.code).toBe(0);
  // The file on dry-run path contains exactly the pre-built JSON, verbatim.
  expect(result.payload).toBe(prebuilt);
});

test("stage helper requires an explicit staging handle", async () => {
  const result = await runStageHelper(
    "+15196816391",
    "Peggy",
    "Hi",
    { RELAY_IMESSAGE_STAGING_HANDLE: "" },
  );

  expect(result.code).toBe(64);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    recipient: "+15196816391",
    reason: "staging_handle_missing",
  });
});

test("stage helper refuses to send a staging payload to the final recipient", async () => {
  const result = await runStageHelper(
    "+1 (519) 681-6391",
    "Peggy",
    "Hi",
    { RELAY_IMESSAGE_STAGING_HANDLE: "+15196816391" },
  );

  expect(result.code).toBe(64);
  expect(result.payload).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    recipient: "+1 (519) 681-6391",
    reason: "staging_handle_matches_recipient",
  });
});

test("stage helper self-staging override is explicit", async () => {
  const result = await runStageHelper(
    "me@example.com",
    "Self",
    "Hi",
    {
      RELAY_IMESSAGE_STAGING_HANDLE: "ME@example.com",
      RELAY_IMESSAGE_ALLOW_SELF_STAGING: "1",
    },
  );

  expect(result.code).toBe(0);
  expect(JSON.parse(result.payload)).toMatchObject({
    version: "CLDRAFT/1",
    to: "me@example.com",
    label: "Self",
    body: "Hi",
  });
});

test(
  "stage helper treats chat.db payload confirmation as success when osascript blocks",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "stage-imessage-confirm-"));
    const dbPath = join(dir, "chat.db");
    const osascriptPath = join(dir, "fake-osascript.sh");

    try {
      await writeFile(
        osascriptPath,
        `#!/usr/bin/env bash
set -euo pipefail
db="$RELAY_MESSAGES_DB_PATH"
payload="$3"
python3 - "$db" "$payload" <<'PY'
import sqlite3
import sys

conn = sqlite3.connect(sys.argv[1])
conn.execute("CREATE TABLE IF NOT EXISTS message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT)")
conn.execute("INSERT INTO message(text) VALUES (?)", (sys.argv[2],))
conn.commit()
PY
sleep 30 &
sleep_pid=$!
trap 'kill "$sleep_pid" 2>/dev/null || true; exit 143' TERM INT
wait "$sleep_pid"
`,
      );
      await chmod(osascriptPath, 0o755);

      const startedAt = Date.now();
      const proc = Bun.spawn(
        [
          join(PROJECT_ROOT, "scripts", "stage-imessage.sh"),
          "+15196816391",
          "Peggy",
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            RELAY_OSASCRIPT_CMD: osascriptPath,
            RELAY_IMESSAGE_STAGING_HANDLE: "+15550001111",
            RELAY_MESSAGES_DB_PATH: dbPath,
            RELAY_STAGE_IMESSAGE_TIMEOUT_SECONDS: "10",
            RELAY_STAGE_IMESSAGE_WRITE_ICLOUD_DRAFT: "0",
          },
        },
      );
      proc.stdin?.write("db-confirmed body");
      await proc.stdin?.end();

      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        recipient: "+15196816391",
        mode: "staging_imessage",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  10_000,
);

test("stage helper writes the iCloud ClaudeDraft handoff file before live staging", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stage-imessage-icloud-"));
  const osascriptPath = join(dir, "fake-osascript.sh");
  const draftDir = join(dir, "drafts");

  try {
    await writeFile(
      osascriptPath,
      `#!/usr/bin/env bash
exit 0
`,
    );
    await chmod(osascriptPath, 0o755);

    const proc = Bun.spawn(
      [
        join(PROJECT_ROOT, "scripts", "stage-imessage.sh"),
        "+15196816391",
        "Peggy",
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          RELAY_OSASCRIPT_CMD: osascriptPath,
          RELAY_IMESSAGE_STAGING_HANDLE: "+15550001111",
          RELAY_MESSAGES_DB_PATH: join(dir, "missing-chat.db"),
          RELAY_ICLOUD_DRAFT_DIR: draftDir,
          RELAY_STAGE_IMESSAGE_TIMEOUT_SECONDS: "1",
        },
      },
    );
    proc.stdin?.write("iPhone file body");
    await proc.stdin?.end();

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      recipient: "+15196816391",
      mode: "staging_imessage",
    });

    const handoff = JSON.parse(await readFile(join(draftDir, "latest.json"), "utf8"));
    expect(handoff).toMatchObject({
      schema_version: 2,
      recipient: "+15196816391",
      recipient_label: "Peggy",
      body: "iPhone file body",
    });
    expect(handoff.body_sha256).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
