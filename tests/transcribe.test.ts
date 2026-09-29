import { describe, it, expect } from "vitest";

describe("WhatsApp voice notes", () => {
  it("are audio by name even without an extension", async () => {
    const { isAudio, sniffAudio } = await import("../src/lib/transcribe");
    expect(isAudio("application/octet-stream", "PTT-20260911-WA0014")).toBe(true);
    expect(isAudio("application/octet-stream", "AUD-20260911-WA0003")).toBe(true);
    expect(isAudio("application/octet-stream", "IMG-20260911-WA0001")).toBe(false);
    expect(sniffAudio(Buffer.from("OggS\0\0\0\0", "latin1"))).toBe("ogg");
    expect(sniffAudio(Buffer.from("RIFF....WAVE", "latin1"))).toBe("wav");
    expect(sniffAudio(Buffer.from("\x89PNG", "latin1"))).toBeNull();
  });
});

describe("opus sample rate", () => {
  it("reads the input rate from the OpusHead packet", async () => {
    const { opusInputRate } = await import("../src/lib/transcribe");
    const head = Buffer.alloc(64); head.write("OggS", 0, "latin1"); head.write("OpusHead", 28, "latin1"); head.writeUInt32LE(48000, 28 + 12);
    expect(opusInputRate(head)).toBe(48000);
    const h2 = Buffer.alloc(64); h2.write("OpusHead", 28, "latin1"); h2.writeUInt32LE(16000, 28 + 12);
    expect(opusInputRate(h2)).toBe(16000);
    expect(opusInputRate(Buffer.from("RIFF"))).toBeNull();
  });
});

describe("audio length from size, by format", () => {
  it("counts an .m4a clip at AAC rates so a short clip goes to the v2 recogniser (25 Sep: a 37 s clip was read as 147 s of Opus)", async () => {
    const { estimateSeconds } = await import("../src/lib/transcribe");
    const buf = Buffer.alloc(293_268);
    expect(Math.round(estimateSeconds(buf, "audio/mp4", "Audio clip (2026-09-25 09:31:05).m4a"))).toBe(37);
    expect(Math.round(estimateSeconds(buf, "application/octet-stream", "PTT-20260925-WA0004"))).toBe(147);
    expect(Math.round(estimateSeconds(buf, "audio/mpeg", "note.mp3"))).toBe(18);
  });
});
