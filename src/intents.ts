// intents.ts
// Parses Claude's inline intent tags out of a response. Returns the cleaned
// user-facing text plus a list of structured intents for fan-out to the
// memory facade (PR #2), draft helpers (PR #3), etc.
//
// Tag shapes:
//   [REMEMBER: free text]
//   [GOAL: text]                       or [GOAL: text | DEADLINE: yyyy-mm-dd]
//   [DONE: search text]
//   [DECISION: free text]
//   [EMAIL_DRAFT: to=addr subject=line body=text]
//   [IMSG_DRAFT: contact=name body=text]
//   [WHATSAPP_DRAFT: contact=name body=text]

export type Intent =
  | { kind: "remember"; content: string }
  | { kind: "goal"; content: string; deadline: string | null }
  | { kind: "done"; content: string }
  | { kind: "decision"; content: string }
  | { kind: "email_draft"; to: string; subject: string; body: string }
  | { kind: "imsg_draft"; contact: string; body: string }
  | { kind: "whatsapp_draft"; contact: string; body: string };

export interface ParsedIntents {
  clean: string;
  intents: Intent[];
}

const TAG_RE = /\[(REMEMBER|GOAL|DONE|DECISION|EMAIL_DRAFT|IMSG_DRAFT|WHATSAPP_DRAFT):\s*([\s\S]*?)\]/gi;

function parseKV(payload: string): Record<string, string> {
  // Tolerant key=value extractor. Supports values containing spaces and
  // punctuation; the next "key=" begins the next field. Example:
  //   to=alex@example.com subject=Re: schedule body=Tomorrow at 3 works.
  // yields { to, subject: "Re: schedule", body: "Tomorrow at 3 works." }.
  const fields: Record<string, string> = {};
  const re = /\b(\w+)=([\s\S]*?)(?=\s+\b\w+=|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(payload)) !== null) {
    fields[m[1].toLowerCase()] = m[2].trim();
  }
  return fields;
}

export function parseIntents(text: string): ParsedIntents {
  const intents: Intent[] = [];
  const clean = text
    .replace(TAG_RE, (_match, kindRaw, payloadRaw) => {
      const kind = String(kindRaw).toUpperCase();
      const payload = String(payloadRaw).trim();
      switch (kind) {
        case "REMEMBER":
          intents.push({ kind: "remember", content: payload });
          return "";
        case "GOAL": {
          const split = payload.split(/\s*\|\s*DEADLINE:\s*/i);
          const content = split[0].trim();
          const deadline = split[1] ? split[1].trim() : null;
          intents.push({ kind: "goal", content, deadline });
          return "";
        }
        case "DONE":
          intents.push({ kind: "done", content: payload });
          return "";
        case "DECISION":
          intents.push({ kind: "decision", content: payload });
          return "";
        case "EMAIL_DRAFT": {
          const kv = parseKV(payload);
          intents.push({
            kind: "email_draft",
            to: kv.to ?? "",
            subject: kv.subject ?? "",
            body: kv.body ?? "",
          });
          return "";
        }
        case "IMSG_DRAFT": {
          const kv = parseKV(payload);
          intents.push({
            kind: "imsg_draft",
            contact: kv.contact ?? "",
            body: kv.body ?? "",
          });
          return "";
        }
        case "WHATSAPP_DRAFT": {
          const kv = parseKV(payload);
          intents.push({
            kind: "whatsapp_draft",
            contact: kv.contact ?? "",
            body: kv.body ?? "",
          });
          return "";
        }
        default:
          return "";
      }
    })
    .replace(/\s+/g, " ")
    .trim();
  return { clean, intents };
}
