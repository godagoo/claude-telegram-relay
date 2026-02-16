import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { handleDocument, handlePhoto, handleVoice } from "../../../src/services/media";

// Mock fs/promises
vi.mock("fs/promises");

// Mock global fetch
vi.stubGlobal("fetch", vi.fn());

describe("Media Handlers", () => {
  let mockLogger: Logger;
  const testUploadsDir = "/tmp/test-uploads";
  const testBotToken = "test-bot-token";

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("handlePhoto()", () => {
    function createMockCtx(options?: { caption?: string }) {
      const photos = [
        { file_id: "small_id", width: 100, height: 100 },
        { file_id: "medium_id", width: 320, height: 320 },
        { file_id: "large_id", width: 800, height: 800 },
      ];

      return {
        message: {
          photo: photos,
          caption: options?.caption ?? undefined,
        },
        api: {
          getFile: vi.fn().mockResolvedValue({
            file_id: "large_id",
            file_path: "photos/test.jpg",
          }),
        },
        reply: vi.fn().mockResolvedValue(undefined),
      };
    }

    test("successful download and ClaudeService call", async () => {
      const ctx = createMockCtx({ caption: "What is this?" });
      const fs = await import("fs/promises");
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const mockResponse = {
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const mockClaudeCall = vi.fn().mockResolvedValue("It's a cat!");

      const result = await handlePhoto(ctx as any, {
        claudeCall: mockClaudeCall,
        uploadsDir: testUploadsDir,
        botToken: testBotToken,
        logger: mockLogger,
      });

      // Should get highest res photo (last one)
      expect(ctx.api.getFile).toHaveBeenCalledWith("large_id");

      // Should download from Telegram API
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("photos/test.jpg"));

      // Should call Claude with image prompt
      expect(mockClaudeCall).toHaveBeenCalledWith(expect.stringContaining("[Image:"));
      expect(mockClaudeCall).toHaveBeenCalledWith(expect.stringContaining("What is this?"));

      // Should return the response
      expect(result).toBe("It's a cat!");

      // Should clean up temp file
      expect(fs.unlink).toHaveBeenCalled();
    });

    test("download failure returns user-facing error", async () => {
      const ctx = createMockCtx();

      vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

      const mockClaudeCall = vi.fn();

      const result = await handlePhoto(ctx as any, {
        claudeCall: mockClaudeCall,
        uploadsDir: testUploadsDir,
        botToken: testBotToken,
        logger: mockLogger,
      });

      expect(result).toBe("Could not process image.");
      expect(mockClaudeCall).not.toHaveBeenCalled();
    });

    test("temp file cleanup after response", async () => {
      const ctx = createMockCtx();
      const fs = await import("fs/promises");
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const mockResponse = {
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const mockClaudeCall = vi.fn().mockResolvedValue("response");

      await handlePhoto(ctx as any, {
        claudeCall: mockClaudeCall,
        uploadsDir: testUploadsDir,
        botToken: testBotToken,
        logger: mockLogger,
      });

      expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining(testUploadsDir));
    });

    test("temp file cleanup on error", async () => {
      const ctx = createMockCtx();
      const fs = await import("fs/promises");
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const mockResponse = {
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const mockClaudeCall = vi.fn().mockRejectedValue(new Error("Claude failed"));

      const result = await handlePhoto(ctx as any, {
        claudeCall: mockClaudeCall,
        uploadsDir: testUploadsDir,
        botToken: testBotToken,
        logger: mockLogger,
      });

      expect(result).toBe("Could not process image.");
      expect(fs.unlink).toHaveBeenCalled();
    });

    test("uses default caption when none provided", async () => {
      const ctx = createMockCtx();
      const fs = await import("fs/promises");
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const mockResponse = {
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const mockClaudeCall = vi.fn().mockResolvedValue("image analysis");

      await handlePhoto(ctx as any, {
        claudeCall: mockClaudeCall,
        uploadsDir: testUploadsDir,
        botToken: testBotToken,
        logger: mockLogger,
      });

      expect(mockClaudeCall).toHaveBeenCalledWith(expect.stringContaining("Analyze this image"));
    });
  });

  describe("handleDocument()", () => {
    function createMockCtx(options?: {
      caption?: string;
      fileName?: string;
    }) {
      return {
        message: {
          document: {
            file_id: "doc_id",
            file_name: options?.fileName ?? "report.pdf",
          },
          caption: options?.caption ?? undefined,
        },
        getFile: vi.fn().mockResolvedValue({
          file_id: "doc_id",
          file_path: "documents/report.pdf",
        }),
        reply: vi.fn().mockResolvedValue(undefined),
      };
    }

    test("successful download and ClaudeService call with filename", async () => {
      const ctx = createMockCtx({ caption: "Summarize this" });
      const fs = await import("fs/promises");
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const mockResponse = {
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const mockClaudeCall = vi.fn().mockResolvedValue("Summary: ...");

      const result = await handleDocument(ctx as any, {
        claudeCall: mockClaudeCall,
        uploadsDir: testUploadsDir,
        botToken: testBotToken,
        logger: mockLogger,
      });

      expect(ctx.getFile).toHaveBeenCalled();
      expect(mockClaudeCall).toHaveBeenCalledWith(expect.stringContaining("[File:"));
      expect(mockClaudeCall).toHaveBeenCalledWith(expect.stringContaining("Summarize this"));
      expect(result).toBe("Summary: ...");
      expect(fs.unlink).toHaveBeenCalled();
    });

    test("download failure returns user-facing error", async () => {
      const ctx = createMockCtx();

      vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

      const mockClaudeCall = vi.fn();

      const result = await handleDocument(ctx as any, {
        claudeCall: mockClaudeCall,
        uploadsDir: testUploadsDir,
        botToken: testBotToken,
        logger: mockLogger,
      });

      expect(result).toBe("Could not process document.");
      expect(mockClaudeCall).not.toHaveBeenCalled();
    });

    test("temp file cleanup", async () => {
      const ctx = createMockCtx();
      const fs = await import("fs/promises");
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const mockResponse = {
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const mockClaudeCall = vi.fn().mockResolvedValue("response");

      await handleDocument(ctx as any, {
        claudeCall: mockClaudeCall,
        uploadsDir: testUploadsDir,
        botToken: testBotToken,
        logger: mockLogger,
      });

      expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining(testUploadsDir));
    });

    test("uses filename in default caption", async () => {
      const ctx = createMockCtx({ fileName: "data.csv" });
      const fs = await import("fs/promises");
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const mockResponse = {
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const mockClaudeCall = vi.fn().mockResolvedValue("response");

      await handleDocument(ctx as any, {
        claudeCall: mockClaudeCall,
        uploadsDir: testUploadsDir,
        botToken: testBotToken,
        logger: mockLogger,
      });

      expect(mockClaudeCall).toHaveBeenCalledWith(expect.stringContaining("data.csv"));
    });
  });

  describe("handleVoice()", () => {
    test("replies with voice requires transcription service", async () => {
      const result = handleVoice();

      expect(result).toBe(
        "Voice messages require a transcription service. " +
          "Add Whisper, Gemini, or similar to handle voice."
      );
    });
  });
});
