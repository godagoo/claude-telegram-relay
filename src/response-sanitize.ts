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
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
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

export interface SanitizedClaudeResponse {
  clean: string;
  memoryTagsStripped: number;
  wrapperTagsStripped: number;
  proseDashesStripped: number;
}

export function sanitizeClaudeResponse(text: string): SanitizedClaudeResponse {
  const memResult = stripMemoryTags(text);
  const wrapResult = stripWrapperTags(memResult.clean);
  const dashResult = stripProseDashes(wrapResult.clean);

  return {
    clean: dashResult.clean,
    memoryTagsStripped: memResult.stripped,
    wrapperTagsStripped: wrapResult.stripped,
    proseDashesStripped: dashResult.stripped,
  };
}
