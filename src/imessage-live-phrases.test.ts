import { describe, expect, test } from "bun:test";
import {
  detectLikelyIMessageDraftIntent,
  extractIMessageDraftRequest,
  type IMessageDraftRequest,
} from "./imessage-context";
import { looksLikeDraftIntent } from "./imessage-intent";

type ExpectedDraft = Pick<
  IMessageDraftRequest,
  "contact" | "wantsContext" | "contextLimit" | "wantsPlacement"
> & { directBody?: string };

const resolvedDraftPhrases: Array<{
  name: string;
  message: string;
  expected: ExpectedDraft;
}> = [
  {
    name: "asking phrasing keeps command contact and placement",
    message: "Please text nater asking if he wants to fire this weekend.",
    expected: {
      contact: "nater",
      wantsContext: false,
      contextLimit: 10,
      wantsPlacement: true,
    },
  },
  {
    name: "following-to phrasing keeps the body after the colon",
    message:
      "Please text the following to madison: your memory was correct about the motion timelines. I was just going through my notes and specifics on the timeline for the motion.",
    expected: {
      contact: "madison",
      wantsContext: false,
      contextLimit: 10,
      wantsPlacement: true,
      directBody:
        "your memory was correct about the motion timelines. I was just going through my notes and specifics on the timeline for the motion.",
    },
  },
  {
    name: "send following text uses the named recipient, not the word text",
    message: "Please send the following text to Mom: hello there",
    expected: {
      contact: "Mom",
      wantsContext: false,
      contextLimit: 10,
      wantsPlacement: true,
      directBody: "hello there",
    },
  },
  {
    name: "email words inside the body do not route to email",
    message:
      "Please send a text to my mom saying hey mom, I just got off the phone with rogers and unfortunately you will have to cancel the account. They said I don't have the authority to do this. Once you call and cancel the account they will then email you the labels which you can forward to me.",
    expected: {
      contact: "mom",
      wantsContext: false,
      contextLimit: 10,
      wantsPlacement: true,
      directBody:
        "hey mom, I just got off the phone with rogers and unfortunately you will have to cancel the account. They said I don't have the authority to do this. Once you call and cancel the account they will then email you the labels which you can forward to me.",
    },
  },
  {
    name: "relationship words inside body do not replace command recipient",
    message: "Text Jacqueline with my mom's address 123 main st",
    expected: {
      contact: "Jacqueline",
      wantsContext: false,
      contextLimit: 10,
      wantsPlacement: true,
      directBody: "my mom's address 123 main st",
    },
  },
  {
    name: "prior-message words inside body do not cancel a new draft",
    message: "Text mom saying I'm replying to your last message about the trip",
    expected: {
      contact: "mom",
      wantsContext: false,
      contextLimit: 10,
      wantsPlacement: true,
      directBody: "I'm replying to your last message about the trip",
    },
  },
  {
    name: "placement-suppression words inside body stay in the body",
    message: "Text Peggy saying no placement for the table at dinner",
    expected: {
      contact: "Peggy",
      wantsContext: false,
      contextLimit: 10,
      wantsPlacement: true,
      directBody: "no placement for the table at dinner",
    },
  },
  {
    name: "email words inside reply body do not suppress iMessage reply",
    message: "Respond to John saying email me when you can",
    expected: {
      contact: "John",
      wantsContext: false,
      contextLimit: 10,
      wantsPlacement: true,
      directBody: "email me when you can",
    },
  },
  {
    name: "context request with relationship alias still resolves",
    message:
      "It should be able to open up my recent imessages with my mom and draft a response back accordingly with our regular rules applying.",
    expected: {
      contact: "mom",
      wantsContext: true,
      contextLimit: 10,
      wantsPlacement: true,
    },
  },
];

const ambiguousDraftPhrases = [
  {
    name: "multi-recipient relationship request",
    message: "Text mom and dad saying hi",
  },
  {
    name: "proper noun only appears after the body boundary",
    message: "Draft a message saying I went to Peggy yesterday",
  },
];

const nonDraftPhrases = [
  "Tell me about the motion timeline",
  "Why didn't you write anything in Nater's iMessage chatbox like you did when we text my dad?",
  "Regarding the text to Mom earlier, can you clarify?",
];

describe("live iMessage draft phrase gate", () => {
  for (const c of resolvedDraftPhrases) {
    test(`resolves: ${c.name}`, () => {
      expect(extractIMessageDraftRequest(c.message)).toEqual(c.expected);
    });
  }

  for (const c of ambiguousDraftPhrases) {
    test(`fail-closes ambiguous draft: ${c.name}`, () => {
      expect(extractIMessageDraftRequest(c.message)).toBeNull();
      expect(detectLikelyIMessageDraftIntent(c.message)).toBe(true);
      expect(looksLikeDraftIntent(c.message)).toBe(true);
    });
  }

  for (const phrase of nonDraftPhrases) {
    test(`ignores non-draft phrase: ${phrase.slice(0, 48)}`, () => {
      expect(extractIMessageDraftRequest(phrase)).toBeNull();
      expect(detectLikelyIMessageDraftIntent(phrase)).toBe(false);
      expect(looksLikeDraftIntent(phrase)).toBe(false);
    });
  }
});
