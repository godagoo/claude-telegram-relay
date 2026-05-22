import { describe, expect, test } from "bun:test";
import { REDACTED_TOKEN_PLACEHOLDER, redactBotToken } from "./redact-token.ts";

const FAKE_TOKEN = "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("redactBotToken", () => {
  test("replaces the raw token anywhere in the string", () => {
    expect(redactBotToken(`oops ${FAKE_TOKEN} oops`, FAKE_TOKEN)).toBe(
      `oops ${REDACTED_TOKEN_PLACEHOLDER} oops`,
    );
  });

  test("replaces the token inside a Telegram API URL", () => {
    const url = `https://api.telegram.org/bot${FAKE_TOKEN}/getMe`;
    const redacted = redactBotToken(url, FAKE_TOKEN);
    expect(redacted).not.toContain(FAKE_TOKEN);
    expect(redacted).toBe(`https://api.telegram.org/bot${REDACTED_TOKEN_PLACEHOLDER}/getMe`);
  });

  test("replaces every occurrence, not just the first", () => {
    const text = `${FAKE_TOKEN} ${FAKE_TOKEN}`;
    expect(redactBotToken(text, FAKE_TOKEN)).toBe(
      `${REDACTED_TOKEN_PLACEHOLDER} ${REDACTED_TOKEN_PLACEHOLDER}`,
    );
  });

  test("returns the input unchanged when no token is present", () => {
    expect(redactBotToken("nothing to redact", FAKE_TOKEN)).toBe("nothing to redact");
  });

  test("is a no-op when the token argument is empty (avoid pathological replace)", () => {
    expect(redactBotToken("free text", "")).toBe("free text");
  });

  test("redacts the api.telegram.org URL shape even without an exact token reference", () => {
    const url = "Network error: https://api.telegram.org/bot1234567890:AAAA-XXXX/getUpdates timed out";
    const redacted = redactBotToken(url, undefined);
    expect(redacted).toContain("api.telegram.org/bot");
    expect(redacted).toContain(REDACTED_TOKEN_PLACEHOLDER);
    expect(redacted).not.toContain("1234567890:AAAA-XXXX");
  });

  test("redacts the api.telegram.org/file/bot... shape too", () => {
    const url = "https://api.telegram.org/file/bot1234567890:AAAA-XXXX/voice.ogg";
    const redacted = redactBotToken(url, undefined);
    expect(redacted).not.toContain("1234567890:AAAA-XXXX");
    expect(redacted).toContain(REDACTED_TOKEN_PLACEHOLDER);
  });

  test("treats undefined/null inputs as empty strings", () => {
    expect(redactBotToken(undefined as unknown as string, FAKE_TOKEN)).toBe("");
    expect(redactBotToken(null as unknown as string, FAKE_TOKEN)).toBe("");
  });

  test("redacts even when token has URL-special characters", () => {
    const weird = "999:abc-DEF_xyz.123";
    expect(redactBotToken(`see ${weird} here`, weird)).toBe(
      `see ${REDACTED_TOKEN_PLACEHOLDER} here`,
    );
  });
});
