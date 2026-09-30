import { describe, it, expect } from "vitest";
import { meetingTitle, heldAtFrom, notesNotReady, headlineTitle, meetingHeadline, meetingTallyLine, readerEmails, readerError, readerProblem } from "../src/lib/meet";

describe("meeting headline", () => {
  it("names the call, whose it was and the day; the tally and notes link are the first reply", () => {
    expect(meetingHeadline({ title: "Introduction Call – 2026/09/15 15:22 CEST", who: "Leicester MediSpa", day: "15 Sep" })).toBe("📝 *Introduction Call* · Leicester MediSpa · 15 Sep");
    expect(meetingTallyLine("5 cards · 1 idea", "https://docs/x")).toBe("5 cards · 1 idea · <https://docs/x|notes>");
  });
});

describe("the feed headline carries the call's name", () => {
  it("drops Gemini's date-time tail", () => {
    expect(headlineTitle("Introduction Call  – 2026/09/15 15:22 CEST")).toBe("Introduction Call");
    expect(headlineTitle("HOH monthly review - 2026-09-15 10:00 AM IST")).toBe("HOH monthly review");
    expect(headlineTitle("Strategy call")).toBe("Strategy call");
  });
  it("a generic title reads Meeting", () => {
    expect(headlineTitle("Meeting started 2026/09/15 11:23 IST")).toBe("Meeting");
    expect(headlineTitle("Meeting")).toBe("Meeting");
  });
});

describe("a notes doc Gemini has not finished", () => {
  const real = "Sep 15, 2026\n\nSummary\n" + "The client asked for the booking page to be fixed and a new offer banner. ".repeat(12) + "\nAction items\n- Fix the booking page (Vishnu)";
  it("is not ready when short or when it says the notes are still being generated", () => {
    expect(notesNotReady("")).toBe(true);
    expect(notesNotReady("Sep 15, 2026\nNotes are being generated and will appear here shortly.")).toBe(true);
    expect(notesNotReady("x".repeat(500) + " Transcription is in progress.")).toBe(true);
  });
  it("is ready once real notes are there", () => {
    expect(notesNotReady(real)).toBe(false);
  });
  it("is not ready when the sorter found nothing and blames the transcript", () => {
    expect(notesNotReady(real, ["No usable meeting content was captured due to a transcription issue."], 0)).toBe(true);
    expect(notesNotReady(real, ["Booking page fix agreed."], 0)).toBe(false);
  });
});

describe("meeting notes", () => {
  it("strips the Gemini suffix from the doc name", () => {
    expect(meetingTitle("HOH monthly review - Notes by Gemini")).toBe("HOH monthly review");
    expect(meetingTitle("Team standup – Notes by Gemini")).toBe("Team standup");
  });
  it("reads the meeting date from the notes head", () => {
    expect(heldAtFrom("HOH monthly review\nSep 9, 2026\n\nSummary", "2026-09-10T10:00:00Z").toISOString().slice(0, 10)).toBe("2026-09-09");
    expect(heldAtFrom("Tue, 9 Sep 2026 · 3:00 PM", "2026-09-10T10:00:00Z").toISOString().slice(0, 10)).toBe("2026-09-09");
    expect(heldAtFrom("no date here", "2026-09-10T10:00:00Z").toISOString().slice(0, 10)).toBe("2026-09-10");
  });
});

describe("whose Drives the hub reads (2026-09-30: no folder sharing)", () => {
  it("every team member with a work address, the mailbox owner first, each once, outsiders never", () => {
    const members = [{ email: "heena@mangoeyesagency.com" }, { email: null }, { email: "Arun@MangoEyesAgency.com" }, { email: "someone@gmail.com" }, { email: "vishnu@mangoeyesagency.com" }];
    expect(readerEmails(members, "arun@mangoeyesagency.com", ["mangoeyesagency.com"])).toEqual(["arun@mangoeyesagency.com", "heena@mangoeyesagency.com", "vishnu@mangoeyesagency.com"]);
    expect(readerEmails([], null, ["mangoeyesagency.com"])).toEqual([]);
  });
  it("tells a missing Admin scope from an address that is no Google account", () => {
    expect(readerProblem(new Error("unauthorized_client: Client is unauthorized to retrieve access tokens using this method")).kind).toBe("scope");
    expect(readerError(new Error("unauthorized_client: Client is unauthorized to retrieve access tokens using this method"))).toContain("Google Admin");
    const gone = readerProblem(new Error("invalid_grant: Invalid email or User ID"));
    expect(gone.kind).toBe("no_account");
    expect(gone.message).toContain("tried again tomorrow");
    expect(readerProblem(new Error("File not found"))).toEqual({ kind: "other", message: "File not found" });
  });
});

