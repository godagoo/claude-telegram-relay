/**
 * Voice Transcription Test
 *
 * Verifies the chosen voice provider is configured correctly.
 * Run: bun run test:voice
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);

function loadEnv(): void {
  const envPath = join(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

loadEnv();
const VOICE_PROVIDER = process.env.VOICE_PROVIDER || "";

async function testGroq(): Promise<boolean> {
  if (!process.env.GROQ_API_KEY) {
    console.error("GROQ_API_KEY is not set in .env");
    return false;
  }

  try {
    const Groq = (await import("groq-sdk")).default;
    const groq = new Groq();

    // List models to verify the API key works
    const models = await groq.models.list();
    const whisper = models.data.find((m) => m.id === "whisper-large-v3-turbo");

    if (!whisper) {
      console.error("whisper-large-v3-turbo model not found on Groq");
      return false;
    }

    console.log("Groq API key is valid");
    console.log("Model: whisper-large-v3-turbo available");
    return true;
  } catch (error: any) {
    console.error("Groq API error:", error.message || error);
    return false;
  }
}

async function testLocal(): Promise<boolean> {
  const whisperBinary = process.env.WHISPER_BINARY || "whisper-cpp";
  const modelPath = process.env.WHISPER_MODEL_PATH || "";
  let allGood = true;

  // Check ffmpeg
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    console.log("ffmpeg: installed");
  } catch {
    console.error("ffmpeg: NOT FOUND — install with: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)");
    allGood = false;
  }

  // Check whisper binary
  try {
    const proc = Bun.spawn([whisperBinary, "--help"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    console.log(`${whisperBinary}: installed`);
  } catch {
    console.error(`${whisperBinary}: NOT FOUND — install with: brew install whisper-cpp (macOS) or build from source`);
    allGood = false;
  }

  // Check model file
  if (!modelPath) {
    console.error("WHISPER_MODEL_PATH not set in .env");
    allGood = false;
  } else {
    const file = Bun.file(modelPath);
    if (await file.exists()) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      console.log(`Model: ${modelPath} (${sizeMB} MB)`);
    } else {
      console.error(`Model not found: ${modelPath}`);
      console.error(
        "Download with: curl -L -o " +
          modelPath +
          " https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
      );
      allGood = false;
    }
  }

  return allGood;
}

// ---- Main ----

console.log("Voice Transcription Test\n");

if (!VOICE_PROVIDER) {
  console.log("VOICE_PROVIDER is not set in .env — voice is disabled.");
  console.log('\nTo enable, set VOICE_PROVIDER=groq or VOICE_PROVIDER=local in .env');
  process.exit(0);
}

console.log(`Provider: ${VOICE_PROVIDER}\n`);

let passed = false;

if (VOICE_PROVIDER === "groq") {
  passed = await testGroq();
} else if (VOICE_PROVIDER === "local") {
  passed = await testLocal();
} else {
  console.error(`Unknown VOICE_PROVIDER: "${VOICE_PROVIDER}"`);
  console.log('Valid options: "groq" or "local"');
}

if (passed) {
  console.log("\nVoice transcription is ready.");
} else {
  console.error("\nVoice transcription test failed. Fix the issues above.");
  process.exit(1);
}
