import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  detectIMessageWriteIntent,
  extractIMessageDraftRequest,
  fetchIMessageContext,
  renderIMessageContext,
  requestHasIMessageDraftMaterial,
  shouldClarifyMissingIMessageDraftBody,
  type IMessageContextResult,
} from "./imessage-context";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

async function buildTempMessagesHome(
  rows: Array<{
    chatIdentifier: string;
    date: number;
    isFromMe: 0 | 1;
    text: string;
  }>,
): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "imessage-thread-home-"));
  const messagesDir = join(home, "Library", "Messages");
  await mkdir(messagesDir, { recursive: true });
  const dbPath = join(messagesDir, "chat.db");
  const sqlStmts = [
    "CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT);",
    "CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, is_from_me INTEGER, text TEXT, attributedBody BLOB, associated_message_type INTEGER);",
    "CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);",
  ];
  rows.forEach((row, i) => {
    const id = i + 1;
    const chat = row.chatIdentifier.replace(/'/g, "''");
    const text = row.text.replace(/'/g, "''");
    sqlStmts.push(`INSERT INTO chat (ROWID, chat_identifier) VALUES (${id}, '${chat}');`);
    sqlStmts.push(
      `INSERT INTO message (ROWID, date, is_from_me, text, attributedBody, associated_message_type) VALUES (${id}, ${row.date}, ${row.isFromMe}, '${text}', NULL, 0);`,
    );
    sqlStmts.push(`INSERT INTO chat_message_join (chat_id, message_id) VALUES (${id}, ${id});`);
  });
  const proc = Bun.spawn(["sqlite3", dbPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin?.write(sqlStmts.join("\n"));
  await proc.stdin?.end();
  const [, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  return home;
}

test("extracts contact, context flag, and placement flag from a full context+placement request", () => {
  expect(
    extractIMessageDraftRequest(
      "Go through my last 5-10 text messages with Peggy for context and draft an iMessage to her (directly in the iMessage box)",
    ),
  ).toEqual({
    contact: "Peggy",
    wantsContext: true,
    contextLimit: 10,
    wantsPlacement: true,
  });
});

test("plain 'Draft a message to William saying hey wuddup' still triggers placement", () => {
  expect(
    extractIMessageDraftRequest(
      "Draft a message to William (me) saying hey wuddup",
    ),
  ).toEqual({
    contact: "William",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "hey wuddup",
  });
});

test("'iMessage' keyword still works even without explicit placement phrasing", () => {
  expect(
    extractIMessageDraftRequest("Draft an iMessage to Peggy saying thanks"),
  ).toEqual({
    contact: "Peggy",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "thanks",
  });
});

test("returns null when there is no draft verb", () => {
  expect(
    extractIMessageDraftRequest("Tell me about Peggy's cleaning business"),
  ).toBeNull();
});

test("returns null when there is no contact", () => {
  expect(
    extractIMessageDraftRequest("Draft a message saying hey"),
  ).toBeNull();
});

test("clarifies instead of inventing a draft when recipient resolves but body/context are empty", () => {
  const request = extractIMessageDraftRequest("Text Peggy");
  const context: IMessageContextResult = {
    request: { contact: "Peggy", limit: 10 },
    status: "empty",
    messages: [],
    resolvedRecipient: "+15555550123",
  };

  expect(requestHasIMessageDraftMaterial("Text Peggy", request)).toBe(false);
  expect(
    shouldClarifyMissingIMessageDraftBody({
      message: "Text Peggy",
      request,
      contextResult: context,
    }),
  ).toBe(true);

  const selfRequest = extractIMessageDraftRequest("Draft an iMessage to me");
  expect(requestHasIMessageDraftMaterial("Draft an iMessage to me", selfRequest)).toBe(false);
});

test("does not clarify when thread context or user-supplied draft material exists", () => {
  const bareRequest = extractIMessageDraftRequest("Reply to Peggy");
  const foundContext: IMessageContextResult = {
    request: { contact: "Peggy", limit: 10 },
    status: "found",
    messages: [{ id: 1, sender: "them", ts: "2026-05-20 09:00", text: "Are we still on?" }],
    resolvedRecipient: "+15555550123",
  };
  expect(
    shouldClarifyMissingIMessageDraftBody({
      message: "Reply to Peggy",
      request: bareRequest,
      contextResult: foundContext,
    }),
  ).toBe(false);

  const described = extractIMessageDraftRequest("Draft a message to Peggy about tomorrow's plan");
  const emptyContext: IMessageContextResult = {
    request: { contact: "Peggy", limit: 10 },
    status: "empty",
    messages: [],
    resolvedRecipient: "+15555550123",
  };
  expect(requestHasIMessageDraftMaterial("Draft a message to Peggy about tomorrow's plan", described)).toBe(true);
  expect(
    shouldClarifyMissingIMessageDraftBody({
      message: "Draft a message to Peggy about tomorrow's plan",
      request: described,
      contextResult: emptyContext,
    }),
  ).toBe(false);
});

test("'Respond to Conor saying hope all is well man' triggers iMessage draft", () => {
  expect(
    extractIMessageDraftRequest("Respond to Conor saying hope all is well man"),
  ).toEqual({
    contact: "Conor",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "hope all is well man",
  });
});

test("'Reply to Sarah' triggers iMessage draft without explicit message keyword", () => {
  expect(extractIMessageDraftRequest("Reply to Sarah saying I'm in")).toEqual({
    contact: "Sarah",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "I'm in",
  });
});

test("'Respond to John's email' does NOT hijack the email path", () => {
  expect(
    extractIMessageDraftRequest("Respond to John's email saying thanks"),
  ).toBeNull();
});

test("complaint about placement is not parsed as a draft request (regression 2026-05-12)", () => {
  // Live failure: "Nono it needs to be in my iMessages compose box on my phone!"
  // captured "be in my" as a three-word proper noun because the contact regex
  // had a global /i flag, so [A-Z][a-z]+ also matched lowercase. The relay
  // then prefetched context for contact="be in my" and ran an iMessage
  // placement pipeline against a complaint message. Decision log
  // 2026-05-12T17:52:35Z, imessage_context_contact="be in my".
  expect(
    extractIMessageDraftRequest(
      "Nono it needs to be in my iMessages compose box on my phone!",
    ),
  ).toBeNull();
});

test("past-draft references are not parsed as new draft requests (regression 2026-05-13)", () => {
  // Live failure 2026-05-13T00:14Z: "In your draft to Peggy did not not ready
  // through her previous text messages for context?" was treated as a new
  // draft request to Peggy because "draft" + "messages" + "to Peggy" all
  // matched. The relay then prefetched 10 messages and appended the
  // "couldn't place this in Messages this time" footer to a meta-question
  // about a prior draft. Decision log entry confirms ctx_count=10,
  // draft_status=markers_missing, response_chars=1136.
  expect(
    extractIMessageDraftRequest(
      "In your draft to Peggy did not not ready through her previous text messages for context?",
    ),
  ).toBeNull();
});

test("possessive-references to prior drafts/messages do not trigger placement", () => {
  for (const msg of [
    "About your message to Peggy yesterday, did you include the address?",
    "Your reply to Conor seemed off — what was that based on?",
    "Did you read context before your draft to Sarah?",
    "Regarding the text to Mom earlier, can you clarify?",
    "On your previous draft to William, what was the tone?",
    "Did you draft a response to Peggy yesterday?",
    "Have we sent a reply to Sarah already?",
    "Did Claude send a response to Peggy?",
    "Has Claude sent a response to Peggy?",
    "Did the bot send a response to Peggy?",
    "Did it send a response to Peggy?",
  ]) {
    expect(extractIMessageDraftRequest(msg)).toBeNull();
  }
});

test("imperative draft requests still fire after past-reference guard", () => {
  // Defense against over-suppression: the guard must not block legitimate
  // imperative draft requests.
  expect(
    extractIMessageDraftRequest("Draft an iMessage to Peggy saying thanks"),
  ).not.toBeNull();
  expect(
    extractIMessageDraftRequest("Respond to Conor saying hope all is well"),
  ).not.toBeNull();
  expect(
    extractIMessageDraftRequest("Please send a message to William saying hey"),
  ).not.toBeNull();
});

test("lowercase filler phrases after to/with are not parsed as contacts", () => {
  for (const msg of [
    "I need it sent to my phone please",
    "Move the draft to the iMessage box on my phone",
    "Please send to me instead of the Mac",
    "Forward it to her phone via iMessage",
  ]) {
    expect(extractIMessageDraftRequest(msg)).toBeNull();
  }
});

test("'Reply to myself' triggers a self-recipient draft (regression 2026-05-13)", () => {
  // Live failure 2026-05-13T18:26Z: "Reply to myself saying testing this
  // relay" returned null from the parser because "myself" is lowercase and
  // the proper-noun branch requires capitalization. Claude then received
  // the message as a generic chat with no draft pathway and timed out at
  // CLAUDE_TIMEOUT_MS=90000ms. The relay never wrote latest.json and the
  // Telegram reply never contained the `shortcuts://run-shortcut?name=...`
  // URL, so the iPhone handoff never fired.
  expect(extractIMessageDraftRequest("Reply to myself saying testing this relay")).toEqual({
    contact: "myself",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "testing this relay",
  });
  expect(extractIMessageDraftRequest("Draft an iMessage to me about the demo")).toEqual({
    contact: "myself",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
  });
  expect(extractIMessageDraftRequest("Respond to myself with the test body")).toEqual({
    contact: "myself",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "the test body",
  });
  expect(extractIMessageDraftRequest("Reply to me saying testing this relay")).toEqual({
    contact: "myself",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "testing this relay",
  });
  expect(extractIMessageDraftRequest("Text myself a reminder to check the relay")).toEqual({
    contact: "myself",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
  });
  expect(extractIMessageDraftRequest("Text me saying this is a phone handoff test")).toEqual({
    contact: "myself",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "this is a phone handoff test",
  });
  expect(extractIMessageDraftRequest("Ping to me saying this is a phone handoff test")).toEqual({
    contact: "myself",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "this is a phone handoff test",
  });
  expect(extractIMessageDraftRequest("Ping me saying this is a phone handoff test")).toEqual({
    contact: "myself",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "this is a phone handoff test",
  });
  expect(extractIMessageDraftRequest("Send me a message saying this is a phone handoff test")).toEqual({
    contact: "myself",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "this is a phone handoff test",
  });
  expect(extractIMessageDraftRequest("Send myself a message saying this is a phone handoff test")).toEqual({
    contact: "myself",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "this is a phone handoff test",
  });
});

test("direct draft body strips placement-only phrasing", () => {
  expect(
    extractIMessageDraftRequest(
      "Draft an iMessage to Peggy saying hi directly in the iMessage box",
    ),
  ).toMatchObject({
    contact: "Peggy",
    directBody: "hi",
  });
});

test("command-position proper names win over body text that contains 'to <place>'", () => {
  expect(
    extractIMessageDraftRequest("Text Mark saying heading to London"),
  ).toEqual({
    contact: "Mark",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "heading to London",
  });
});

test("command-position lowercase names trigger direct drafts", () => {
  expect(
    extractIMessageDraftRequest("Text jacqueline saying where you at?"),
  ).toEqual({
    contact: "jacqueline",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "where you at?",
  });
});

test("command-position drafts allow short conversational lead-ins", () => {
  expect(
    extractIMessageDraftRequest(
      "Okay, text Nater saying looking forward to our next fire",
    ),
  ).toEqual({
    contact: "Nater",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "looking forward to our next fire",
  });
});

test("message and ping command-position recipients trigger direct drafts", () => {
  expect(
    extractIMessageDraftRequest("Message Peggy saying thanks"),
  ).toMatchObject({
    contact: "Peggy",
    directBody: "thanks",
  });
  expect(
    extractIMessageDraftRequest("Ping Conor saying hi"),
  ).toMatchObject({
    contact: "Conor",
    directBody: "hi",
  });
});

test("command-position direct phone and email recipients trigger direct drafts", () => {
  expect(
    extractIMessageDraftRequest("Text +1 (555) 555-0123 saying hello"),
  ).toMatchObject({
    contact: "+1 (555) 555-0123",
    directBody: "hello",
  });
  expect(
    extractIMessageDraftRequest("Message william@example.com saying hello"),
  ).toMatchObject({
    contact: "william@example.com",
    directBody: "hello",
  });
});

test("'with <contact>' is treated as a recipient, not a draft body", () => {
  expect(
    extractIMessageDraftRequest("Draft an iMessage with Peggy"),
  ).toEqual({
    contact: "Peggy",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
  });
});

test("vague response requests have no direct body", () => {
  expect(
    extractIMessageDraftRequest(
      "Please draft an iMessage response to Mark directly in the chatbox",
    ),
  ).toMatchObject({
    contact: "Mark",
    wantsPlacement: true,
  });
  expect(
    extractIMessageDraftRequest(
      "Please draft an iMessage response to Mark directly in the chatbox",
    )?.directBody,
  ).toBeUndefined();
});

test("relationship alias with recent iMessages triggers context-aware draft", () => {
  expect(
    extractIMessageDraftRequest(
      "It should be able to open up my recent imessages with my mom and draft a response back accordingly with our regular rules applying.",
    ),
  ).toEqual({
    contact: "mom",
    wantsContext: true,
    contextLimit: 10,
    wantsPlacement: true,
  });
});

test("draft a response back to relationship alias triggers iMessage reply path", () => {
  expect(
    extractIMessageDraftRequest("Please draft a response back to my mom"),
  ).toEqual({
    contact: "mom",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
  });
  expect(
    extractIMessageDraftRequest("Please draft a response back to my mom saying I'll call soon"),
  ).toEqual({
    contact: "mom",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "I'll call soon",
  });
});

test("relationship aliases work for reply and direct-body drafts", () => {
  expect(extractIMessageDraftRequest("Reply to my mom")).toEqual({
    contact: "mom",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
  });
  expect(extractIMessageDraftRequest("Text my mother saying I'll call soon")).toEqual({
    contact: "mom",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "I'll call soon",
  });
  expect(extractIMessageDraftRequest("Draft a message for my father saying thanks")).toEqual({
    contact: "dad",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "thanks",
  });
});

test("relationship contact wins over proper noun inside direct body", () => {
  expect(extractIMessageDraftRequest("Text mom saying heading to London")).toEqual({
    contact: "mom",
    wantsContext: false,
    contextLimit: 10,
    wantsPlacement: true,
    directBody: "heading to London",
  });
});

test("multi-relationship requests do not silently choose one recipient", () => {
  expect(extractIMessageDraftRequest("Please reply to mom and dad's message")).toBeNull();
  expect(extractIMessageDraftRequest("Text mom and dad saying hi")).toBeNull();
});

test("self-recipient still respects placement suppression", () => {
  // "just give me the text" forces wantsPlacement=false even for self drafts.
  const r = extractIMessageDraftRequest(
    "Reply to myself in Telegram only saying check",
  );
  expect(r?.contact).toBe("myself");
  expect(r?.wantsPlacement).toBe(false);
});

test("self-recipient context resolves without shelling out to iMessage lookup", async () => {
  const original = process.env.RELAY_SELF_RECIPIENT;
  process.env.RELAY_SELF_RECIPIENT = "self@example.com";
  try {
    await expect(
      fetchIMessageContext("/does/not/matter", { contact: "myself", limit: 10 }),
    ).resolves.toMatchObject({
      request: { contact: "myself", limit: 10 },
      status: "empty",
      resolvedRecipient: "self@example.com",
      messages: [],
    });
  } finally {
    if (original === undefined) {
      delete process.env.RELAY_SELF_RECIPIENT;
    } else {
      process.env.RELAY_SELF_RECIPIENT = original;
    }
  }
});

test("suppresses placement when the user asks for Telegram-only output", () => {
  expect(
    extractIMessageDraftRequest(
      "Just show me the text of a message to Peggy — don't open Messages",
    ),
  ).toMatchObject({
    contact: "Peggy",
    wantsPlacement: false,
  });
});

test("detectIMessageWriteIntent still recognizes explicit placement phrasings", () => {
  expect(
    detectIMessageWriteIntent(
      "draft an iMessage to her (directly in the iMessage box) letting her know...",
    ),
  ).toBe(true);
  expect(
    detectIMessageWriteIntent("put it in the iMessage chatbox when I have it configured"),
  ).toBe(true);
  expect(detectIMessageWriteIntent("drop it into Messages")).toBe(true);
  expect(detectIMessageWriteIntent("open Messages on her thread")).toBe(true);
});

test("renders found context without telling Claude access failed", () => {
  const result: IMessageContextResult = {
    request: { contact: "Peggy", limit: 10 },
    status: "found",
    messages: [
      { id: 2, sender: "them", ts: "2026-05-11 10:01:00", text: "Sounds good." },
      { id: 1, sender: "me", ts: "2026-05-11 10:00:00", text: "Can we book a clean?" },
    ],
  };

  const rendered = renderIMessageContext(result);
  expect(rendered).toContain("IMESSAGE CONTEXT FOR Peggy");
  expect(rendered).toContain("me: Can we book a clean?");
  expect(rendered).toContain("them: Sounds good.");
  expect(rendered).toContain("Do not claim you lacked iMessage access");
});

test("strips NUL and other unsafe control characters from rendered context", () => {
  const result: IMessageContextResult = {
    request: { contact: "Bro", limit: 10 },
    status: "found",
    messages: [
      { id: 1, sender: "me", ts: "2026-05-15 09:00:00", text: "\x00All good bro, can do!" },
      { id: 2, sender: "them", ts: "2026-05-15 09:01:00", text: "ok\x07 sounds great\x7f" },
    ],
  };

  const rendered = renderIMessageContext(result);
  expect(rendered).not.toContain("\x00");
  expect(rendered).not.toContain("\x07");
  expect(rendered).not.toContain("\x7f");
  expect(rendered).toContain("me: All good bro, can do!");
  expect(rendered).toContain("them: ok sounds great");
});

test("renders empty lookup as contact mismatch, not FDA failure", () => {
  const result: IMessageContextResult = {
    request: { contact: "Peggy", limit: 10 },
    status: "empty",
    messages: [],
  };

  const rendered = renderIMessageContext(result);
  expect(rendered).toContain("no matching messages");
  expect(rendered).toContain("Full Disk Access worked");
});

test("imessage-thread helper rejects non-numeric LIMIT before touching chat.db", async () => {
  const proc = Bun.spawn(
    [join(PROJECT_ROOT, "scripts", "imessage-thread.sh"), "+15555550123", "1;DROP TABLE message"],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(code).toBe(64);
  expect(stdout).toBe("");
  expect(stderr).toContain("LIMIT must be a positive integer");
});

test("imessage-thread helper keeps resolver metadata for direct phone identifiers", async () => {
  const appleDate = 200_000_000_000_000_000;
  const home = await buildTempMessagesHome([
    {
      chatIdentifier: "6043154583",
      date: appleDate,
      isFromMe: 0,
      text: "direct phone context row",
    },
  ]);
  try {
    const proc = Bun.spawn(
      [join(PROJECT_ROOT, "scripts", "imessage-thread.sh"), "6043154583", "1"],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: home,
          RELAY_MESSAGES_DB_PATH: join(home, "Library", "Messages", "chat.db"),
          RELAY_CONTACT_ALIASES_PATH: "/nonexistent/contact-aliases.json",
        },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.resolved).toBe("+16043154583");
    expect(parsed.last_messaged_at).toBe(appleDate);
    expect(parsed.messages[0].text).toBe("direct phone context row");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("iMessage normalizer decodes attributedBody rows before stale text rows", async () => {
  const current = "Fresh current body";
  const bodyHex = Buffer.concat([
    Buffer.from("prefix NSString", "utf8"),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, Buffer.byteLength(current)]),
    Buffer.from(current, "utf8"),
    Buffer.from([0x86]),
  ]).toString("hex");
  const rows = [
    {
      id: 3,
      sender: "them",
      ts: "2026-05-17 10:00:00",
      text: "",
      attributed_body_hex: bodyHex,
      associated_message_type: 0,
    },
    {
      id: 4,
      sender: "me",
      ts: "2026-05-17 09:59:30",
      text: "\u0000All good bro",
      attributed_body_hex: "",
      associated_message_type: 0,
    },
    {
      id: 2,
      sender: "me",
      ts: "2026-05-17 09:59:00",
      text: "Loved a message",
      attributed_body_hex: "",
      associated_message_type: 2000,
    },
    {
      id: 1,
      sender: "me",
      ts: "2025-10-17 10:00:00",
      text: "Older plain text",
      attributed_body_hex: "",
      associated_message_type: 0,
    },
  ];

  const proc = Bun.spawn(
    [
      "python3",
      join(PROJECT_ROOT, "scripts", "imessage-normalize-messages.py"),
      "+15555550123",
      "3",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_ROOT,
      env: { ...process.env },
    },
  );
  proc.stdin?.write(JSON.stringify(rows));
  await proc.stdin?.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(stderr).toBe("");
  expect(code).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.messages.map((m: { text: string }) => m.text)).toEqual([
    current,
    "All good bro",
    "Older plain text",
  ]);
});

test("contact resolver normalizes formatted AddressBook phone numbers", async () => {
  const code = `
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("resolve_contact", Path("scripts/resolve-contact.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
assert mod.normalize_phone("1 (604) 315-4583") == "+16043154583"
contacts = [{
    "name": "Mom",
    "nickname": "",
    "org": "",
    "phone": "1 (604) 315-4583",
    "phone_primary": 1,
    "email": "",
    "email_primary": 0,
}]
assert mod.resolve("mom", contacts) == "+16043154583"
assert mod.resolve("1 (604) 315-4583") == "+16043154583"
`;
  const proc = Bun.spawn(["python3", "-c", code], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    // Point at a guaranteed-missing alias file so this test exercises the
    // AddressBook path only and is independent of the user's real
    // ~/.claude-relay/contact-aliases.json contents.
    env: { ...process.env, RELAY_CONTACT_ALIASES_PATH: "/nonexistent/contact-aliases.json" },
  });
  const [stdout, stderr, codeResult] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(codeResult).toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
});

// -----------------------------------------------------------------------
// Regression: relational-term contacts (2026-05-14)
// "mom", "my mom", "my mother", "dad", etc. failed to extract because
// the proper-noun branch requires [A-Z][a-z]+. The relay returned null,
// no draft flow fired, and Claude asked "What's the last thing she sent
// you?" — violating the one-shot rule.
// -----------------------------------------------------------------------

test("'Please draft an iMessage response to my mom' extracts mom as contact (regression 2026-05-14)", () => {
  const result = extractIMessageDraftRequest(
    "Please draft an iMessage response to my mom",
  );
  expect(result).not.toBeNull();
  expect(result?.contact).toBe("mom");
  expect(result?.wantsPlacement).toBe(true);
  expect(result?.wantsContext).toBe(false);
});

test("'draft a message to mom' without possessive still extracts mom (regression 2026-05-14)", () => {
  const result = extractIMessageDraftRequest("draft a message to mom");
  expect(result).not.toBeNull();
  expect(result?.contact).toBe("mom");
  expect(result?.wantsPlacement).toBe(true);
});

test("'reply to my dad saying on my way' extracts dad with direct body", () => {
  const result = extractIMessageDraftRequest(
    "reply to my dad saying on my way",
  );
  expect(result).not.toBeNull();
  expect(result?.contact).toBe("dad");
  expect(result?.directBody).toBe("on my way");
  expect(result?.wantsPlacement).toBe(true);
});

test("'draft a text to my sister' extracts sister", () => {
  const result = extractIMessageDraftRequest("draft a text to my sister");
  expect(result).not.toBeNull();
  expect(result?.contact).toBe("sister");
});

test("past-reference 'the text to Mom earlier' still returns null after relational fix", () => {
  expect(
    extractIMessageDraftRequest("Regarding the text to Mom earlier, can you clarify?"),
  ).toBeNull();
});

test("'mum' normalises to 'mom' and 'mother' also normalises to 'mom'", () => {
  expect(extractIMessageDraftRequest("draft a message to my mum")?.contact).toBe("mom");
  expect(extractIMessageDraftRequest("reply to my mother saying thanks")?.contact).toBe("mom");
});

// Regression: "respond back to" failed because IMPLICIT_MESSAGE_VERB_RE
// required the verb immediately adjacent to "to". Live failure 2026-05-14:
// "Please respond back to my mom" returned null — relay treated it as a
// generic query, Claude asked "What do you want to say to her?" instead of
// drafting. Fix: allow "back" between verb and "to".
test("'respond back to' triggers draft path (regression 2026-05-14)", () => {
  const r = extractIMessageDraftRequest("Please respond back to my mom");
  expect(r).not.toBeNull();
  expect(r?.contact).toBe("mom");
  expect(r?.wantsPlacement).toBe(true);
});

test("'reply back to Sarah' extracts contact and direct body", () => {
  const r = extractIMessageDraftRequest("reply back to Sarah saying I am on my way");
  expect(r).not.toBeNull();
  expect(r?.contact).toBe("Sarah");
  expect(r?.directBody).toBe("I am on my way");
});

test("email guard still fires when back-to phrasing contains email keyword", () => {
  expect(
    extractIMessageDraftRequest("respond back to John about his email"),
  ).toBeNull();
  expect(
    extractIMessageDraftRequest("reply all to John saying thanks"),
  ).toBeNull();
  expect(
    extractIMessageDraftRequest("reply-all to John saying thanks"),
  ).toBeNull();
  expect(
    extractIMessageDraftRequest("reply all back to John saying thanks"),
  ).toBeNull();
});
