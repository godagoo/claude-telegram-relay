// prompt-split.ts
// buildPrompt() in relay.ts concatenates durable system rules, per-turn
// context (profile, memory, retrieval, recent conversation), and finally a
// trailing block "\nUser: <message>". Passing the whole thing as -p (the user
// message) made Claude occasionally paraphrase the system rules back as its
// reply when retrieval was weak (live failure 2026-05-17T07:17 cote/arterial-
// line query). Split at the LAST "\nUser: " so the durable instructions go
// through --append-system-prompt and the actual question goes through -p.
//
// The inner "User: " / "Assistant: " labels inside a RECENT CONVERSATION block
// are preserved because we split on the LAST occurrence, not the first.

export function splitPromptForClaudeCli(
  prompt: string,
): { systemPrompt: string; userPrompt: string } {
  const marker = "\nUser: ";
  const idx = prompt.lastIndexOf(marker);
  if (idx === -1) return { systemPrompt: "", userPrompt: prompt };
  return {
    systemPrompt: prompt.slice(0, idx),
    userPrompt: prompt.slice(idx + marker.length),
  };
}
