import {describe, test} from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import FormData from "form-data";
import fetch from "node-fetch";
import * as dotenv from "dotenv";
dotenv.config();

import {parseIntent} from "../geminiParser";

const WHISPER_PROMPT =
  "This is Nigerian English. Common terms: 'k' means thousand " +
  "(e.g. '15k' = 15000), 'naira' is the currency. Phone numbers " +
  "start with '070', '080', '081', '090', '091'. " +
  "Transcribe numbers as digits.";

// Helper to test whisper directly without needing the Firebase emulator 
const transcribeTestAudio = async (filePath: string): Promise<string> => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing in .env");

  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("file", buffer, {
    filename: path.basename(filePath),
    contentType: "audio/wav", // assuming wav/mp3
  });
  form.append("model", "whisper-1");
  form.append("language", "en");
  form.append("prompt", WHISPER_PROMPT);

  console.log("Sending audio to Whisper...");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {Authorization: `Bearer ${apiKey}`},
    body: form,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Whisper API error ${response.status}: ${errorBody}`);
  }

  const data = (await response.json()) as {text: string};
  return data.text;
};

// We only run this if an audio file actually exists exactly where we expect it
const TEST_AUDIO_PATH = path.join(__dirname, "../../test-audio.wav"); 
const runAudioTest = fs.existsSync(TEST_AUDIO_PATH) ? describe : describe.skip;

runAudioTest("Full Audio Pipeline Integration", () => {
  // Give a generous timeout for audio upload + transcription + gemini parsing
  test("transcribes local audio and parses intent", async () => {
    const transcript = await transcribeTestAudio(TEST_AUDIO_PATH);
    console.log("-----------------------------------------");
    console.log("🎙️ Whisper Transcript:", transcript);
    console.log("-----------------------------------------");

    console.log("🧠 Sending to Gemini...");
    const parsedData = await parseIntent(transcript);
    console.log("✅ Final Parsed Data:", parsedData);
    console.log("-----------------------------------------");
  }, 60000); 
});
