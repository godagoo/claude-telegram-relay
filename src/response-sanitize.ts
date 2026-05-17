// response-sanitize.ts
// Defense-in-depth sanitization of Claude responses before they reach the user.
//
// Memory tags ([REMEMBER:], [GOAL:], [DONE:]) are an opt-in instruction that
// Claude sometimes emits even when memory storage is disabled, and wrapper
// tags (<response>, <answer>, …) are an occasional structured-output false
// start that leak the bare tag without inner content. Both must be cleaned
// before the response is forwarded to Telegram.

export function stripMemoryTags(text: string): { clean: string; stripped: number } {
  let stripped = 0;
  const clean = text
    .replace(/\[REMEMBER:[^\]]*\]/g, () => { stripped++; return ""; })
    .replace(/\[GOAL:[^\]]*\]/g,     () => { stripped++; return ""; })
    .replace(/\[DONE:[^\]]*\]/g,     () => { stripped++; return ""; })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { clean, stripped };
}

// Live failure 2026-05-10T21:08:25 and 21:58:25: Claude emitted the literal
// string "<response>" as its entire reply to a textbook comparison query
// (and then again, because the resumed session preserved the behaviour).
// The relay sent the bare tag straight to Telegram. Strip orphan wrapper
// tags and unwrap matched pairs so a structured-output false start never
// reaches the user.
export function stripWrapperTags(text: string): { clean: string; stripped: number } {
  let stripped = 0;
  const unwrapped = text.replace(
    /<(response|answer|reply|message|output|result)>([\s\S]*?)<\/\1>/gi,
    (_match, _tag, inner) => { stripped++; return inner; },
  );
  const clean = unwrapped
    .replace(
      /<\/?\s*(response|answer|reply|message|output|result)\s*\/?>/gi,
      () => { stripped++; return ""; },
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { clean, stripped };
}

export function stripProseDashes(text: string): { clean: string; stripped: number } {
  let stripped = 0;
  const parts = text.split(
    /(```[\s\S]*?```|`[^`\n]*`|<pre\b[\s\S]*?<\/pre>|^>>>[^\n]*(?:\n>>>[^\n]*)*)/gim,
  );
  const clean = parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replace(/(\d)\s*–\s*(\d)/g, (_match, left, right) => {
          stripped++;
          return `${left} to ${right}`;
        })
        .replace(/\s*[—–]\s*/g, () => {
          stripped++;
          return ", ";
        });
    })
    .join("")
    .replace(/,\s*,/g, ",")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { clean, stripped };
}

// Live failure 2026-05-11T12:54: in response to "Okay, please draft an email
// to myself" the relay forwarded ~5.4 KB of internal Claude Code scaffolding
// to Telegram. Three <system-reminder> blocks leaked: a /compact continuation
// marker, a bash-escaping rule, and a full conversation summary including
// file paths, technical context, and every prior user message in the thread.
//
// These are internal tokens Claude emits when confused about session
// continuity. They are never appropriate user-facing content and must be
// stripped before the response reaches Telegram.
const SCAFFOLDING_TAGS = "system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|user-prompt-submit-hook|tool-use|tool-result|function_calls|function_results";

export function stripScaffoldingTags(text: string): { clean: string; stripped: number } {
  let stripped = 0;
  const unwrap = new RegExp(`<(${SCAFFOLDING_TAGS})>[\\s\\S]*?<\\/\\1>`, "gi");
  const orphan = new RegExp(`<\\/?\\s*(${SCAFFOLDING_TAGS})\\s*\\/?>`, "gi");
  const clean = text
    .replace(unwrap, () => { stripped++; return ""; })
    .replace(orphan, () => { stripped++; return ""; })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { clean, stripped };
}

// Live failure 2026-05-11T13:06:24Z: the bot drafted an iMessage to Peggy
// correctly, then appended a literal `User: Okay, please draft an email to
// myself ...` block to its reply. The relay's prompt template ends with
// `\nUser: ${userMessage}` so Claude was trained on this dialogue format and
// occasionally pre-emits the next User: turn at the end of its own response.
// Cut everything from the first leaked turn marker onward.
export function stripTurnMarkers(text: string): { clean: string; stripped: number } {
  const re = /\r?\n(?:User|Assistant):\s+\S/;
  const idx = text.search(re);
  if (idx < 0) return { clean: text, stripped: 0 };
  return { clean: text.slice(0, idx).replace(/\s+$/, ""), stripped: 1 };
}

export interface SanitizedClaudeResponse {
  clean: string;
  memoryTagsStripped: number;
  wrapperTagsStripped: number;
  scaffoldingTagsStripped: number;
  turnMarkersStripped: number;
  proseDashesStripped: number;
}

export function sanitizeClaudeResponse(text: string): SanitizedClaudeResponse {
  const memResult = stripMemoryTags(text);
  const wrapResult = stripWrapperTags(memResult.clean);
  const scaffoldResult = stripScaffoldingTags(wrapResult.clean);
  const turnResult = stripTurnMarkers(scaffoldResult.clean);
  const dashResult = stripProseDashes(turnResult.clean);

  return {
    clean: dashResult.clean,
    memoryTagsStripped: memResult.stripped,
    wrapperTagsStripped: wrapResult.stripped,
    scaffoldingTagsStripped: scaffoldResult.stripped,
    turnMarkersStripped: turnResult.stripped,
    proseDashesStripped: dashResult.stripped,
  };
}
