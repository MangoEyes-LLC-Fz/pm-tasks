import { describe, it, expect } from "vitest";
import { certainMeetingClient, speakerNames, invitedLine, nameAppears, isTeamName, type KnownPerson } from "../src/lib/meet-client";
import type { Client } from "../src/lib/types";

const client = (id: string, name: string, extra: Partial<Client> = {}): Client => ({
  id, name, scope: "client", slackChannels: [], emailDomains: [], whatsappNumbers: [], boards: {}, clientFacingAck: false, aliases: [], ...extra,
});
const hc = client("hc", "HC MedSpa", { aliases: ["HC", "MedSpa"], emailDomains: ["hcmedspa.com"] });
const tsf = client("tsf", "The SKIN Firm", { aliases: ["TSF", "Skin Firm"], slackTeamId: "T1" });
const lms = client("lms", "Leicester MediSpa", { aliases: ["LMS"] });
const mango = client("mangoeyes", "MangoEyes", { scope: "internal" });
const clients = [hc, tsf, lms, mango];
const people: KnownPerson[] = [
  { name: "Swathi TSF", email: null, client: tsf },
  { name: "Dr Naren", email: "naren@theskinfirm.co.uk", client: tsf },
  { name: "Rabbia Aslam", email: null, client: hc },
];
const team = ["Vishnu Swaroop Lal", "Heena Ganotra", "Amit Kumar", "Nehal"];

const swathiNotes = `✍️ Quick notes
Swathi / Vishnu

Oct 4, 2026
Swathi Vishnu Swaroop Lal

📝 Full notes
Oct 4, 2026
Swathi / Vishnu
Invited Swathi Vishnu Swaroop Lal
Summary
Financial strain and personal stress driving business termination

📖 Transcript
Vishnu Swaroop Lal: Yeah. It's a good time or no time.
Naren Senthil Nathan: Should we come together?
Vishnu Swaroop Lal: Hi. Like tell me what happened.
Naren Senthil Nathan: So, going through the numbers.`;

describe("who spoke", () => {
  it("reads the speakers from the transcript lines and ignores headings", () => {
    expect(speakerNames(swathiNotes)).toEqual(["Vishnu Swaroop Lal", "Naren Senthil Nathan"]);
    expect(speakerNames("Summary: nothing\nNote: x")).toEqual([]);
  });
  it("reads the invited line", () => expect(invitedLine(swathiNotes)).toBe("Swathi Vishnu Swaroop Lal"));
  it("tells a team name by full name or first name", () => {
    expect(isTeamName("Vishnu Swaroop Lal", team)).toBe(true);
    expect(isTeamName("Nehal Shah", team)).toBe(true);
    expect(isTeamName("Naren Senthil Nathan", team)).toBe(false);
  });
  it("finds a person by full name, or by a first name of four letters when allowed", () => {
    expect(nameAppears("Swathi TSF", "Swathi / Vishnu", true)).toBe("first");
    expect(nameAppears("Swathi TSF", "Swathi / Vishnu", false)).toBeNull();
    expect(nameAppears("Naren Senthil Nathan", "Naren Senthil Nathan: hello", false)).toBe("full");
    expect(nameAppears("Dr Naren", "Dr. Naren spoke", true)).toBe("first");
    expect(nameAppears("Kim", "Kim spoke", true)).toBeNull(); // too short to be anyone in particular
  });
});

describe("a meeting's client is set only with certainty (2026-10-05)", () => {
  const base = { attendees: ["vishnu@mangoeyesagency.com"], clients, people, team };
  it("the title names the client", () => {
    const r = certainMeetingClient({ ...base, title: "HC MedSpa / Rabbia — Monday catch-up", notes: "" });
    expect(r?.client.id).toBe("hc"); expect(r?.how).toBe("title");
  });
  it("an attendee's address names the client", () => {
    const r = certainMeetingClient({ ...base, title: "Catch-up", notes: "", attendees: ["vishnu@mangoeyesagency.com", "fatima@hcmedspa.com"] });
    expect(r?.client.id).toBe("hc"); expect(r?.how).toBe("attendee");
    const k = certainMeetingClient({ ...base, title: "Catch-up", notes: "", attendees: ["naren@theskinfirm.co.uk"] });
    expect(k?.client.id).toBe("tsf"); expect(k?.how).toBe("attendee");
  });
  it("Swathi / Vishnu is The SKIN Firm's, whatever the sorter guessed", () => {
    const r = certainMeetingClient({ ...base, title: "Swathi / Vishnu – 2026/10/04 21:18 CEST", notes: swathiNotes, sorterClient: hc });
    expect(r?.client.id).toBe("tsf"); expect(r?.how).toBe("person"); expect(r?.detail).toContain("Swathi");
  });
  it("a sorter guess alone sets nothing", () => {
    expect(certainMeetingClient({ ...base, title: "Meeting started 2026/09/29 16:51 IST", notes: "Amit Kumar: hello\nNehal: hi", sorterClient: lms })).toBeNull();
  });
  it("people of two clients named: nothing", () => {
    expect(certainMeetingClient({ ...base, title: "Swathi and Rabbia", notes: "", sorterClient: hc })).toBeNull();
  });
  it("an internal title is certain; a desk's Slack name places nobody", () => {
    expect(certainMeetingClient({ ...base, title: "Pre-Production Team Sync", notes: "" })?.client.id).toBe("mangoeyes");
    expect(certainMeetingClient({ ...base, title: "Daily Ops | Internal Meeting", notes: "" })?.client.id).toBe("mangoeyes");
    const desk: KnownPerson[] = [{ name: "Reception", email: null, client: lms }, { name: "Skin Firm Admin", email: null, client: tsf }];
    expect(certainMeetingClient({ ...base, people: desk, title: "Reception walkthrough", notes: "" })).toBeNull();
    expect(certainMeetingClient({ ...base, people: desk, title: "Admin call", notes: "Skin Firm Admin: hi" })).toBeNull();
  });
  it("a first name shared by a team member never counts", () => {
    const shared: KnownPerson[] = [{ name: "Heena Patel", email: null, client: lms }];
    expect(certainMeetingClient({ ...base, people: shared, title: "Heena / Nitin", notes: "" })).toBeNull();
  });
  it("internal when only the team spoke and the sorter says MangoEyes; not when an outsider spoke", () => {
    const r = certainMeetingClient({ ...base, title: "Daily Ops", notes: "Heena Ganotra: morning\nAmit Kumar: hi", sorterClient: mango });
    expect(r?.client.id).toBe("mangoeyes"); expect(r?.how).toBe("speakers");
    expect(certainMeetingClient({ ...base, title: "Pre-Production", notes: "Heena Ganotra: morning\nAmit Kumar: hi", sorterClient: lms })).toBeNull();
    expect(certainMeetingClient({ ...base, title: "Catch-up", notes: "Heena Ganotra: morning\nKevin Affleck: hi", sorterClient: mango })).toBeNull();
    expect(certainMeetingClient({ ...base, title: "Catch-up", notes: "no transcript", sorterClient: mango })).toBeNull();
  });
});
