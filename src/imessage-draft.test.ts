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
