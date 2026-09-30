import { describe, it, expect } from "vitest";
import { parseMail, intakeAddresses, toIntakeQuery } from "../src/lib/gmail";

const b64 = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
const mail = (subject: string, from: string, text: string) => ({
  id: "m1", threadId: "t1", internalDate: "1757400000000",
  payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: subject }, { name: "From", value: from }, { name: "To", value: "intake@mangoeyesagency.com" }], body: { data: b64(text) } },
});

describe("email parsing", () => {
  it("reads a forwarded client mail from the inside", () => {
    const p = parseMail(mail("Fwd: price list", "Priya <priya@mangoeyesagency.com>",
      "FYI, HOH wants this by Friday.\n\n---------- Forwarded message ---------\nFrom: Dr Mehta <dr@houseofhealth.co.uk>\nDate: Tue, 9 Sep 2026\nSubject: price list\nTo: priya@mangoeyesagency.com\n\nHi Priya, can we get the new price list up this week?\n\nOn Mon, Dr Mehta wrote:\n> older stuff"));
    expect(p.isForward).toBe(true);
    expect(p.originalFromEmail).toBe("dr@houseofhealth.co.uk");
    expect(p.note).toBe("FYI, HOH wants this by Friday.");
    expect(p.body).toBe("Hi Priya, can we get the new price list up this week?");
  });
  it("plain mail keeps sender and drops quoted history", () => {
    const p = parseMail(mail("Book Now button", "Dr Mehta <dr@houseofhealth.co.uk>", "The Book Now button is broken on mobile.\n\nOn Tue, Priya wrote:\n> hello"));
    expect(p.isForward).toBe(false);
    expect(p.fromEmail).toBe("dr@houseofhealth.co.uk");
    expect(p.body).toBe("The Book Now button is broken on mobile.");
  });
});

describe("signatures", () => {
  it("cuts the signature and image placeholders", async () => {
    const { stripSignature } = await import("../src/lib/gmail");
    expect(stripSignature("Please update the price list.\n\nKind regards,\nArun\n[image: logo]")).toBe("Please update the price list.");
    expect(stripSignature("[image: Kind regards,\nArun Chandel\nMangoEyes")).toBe("");
    expect(stripSignature("Thanks, can you update the price list by Friday?")).toBe("Thanks, can you update the price list by Friday?");
  });

  it("counts the hub's group as the hub and asks Gmail for To, Cc and delivered-to (2026-09-30)", () => {
    process.env.GMAIL_INTAKE_ADDRESS = "taskhub@mangoeyesagency.com";
    expect(intakeAddresses()).toEqual(["taskhub@mangoeyesagency.com", "clientsuccess.team@mangoeyesagency.com"]);
    const q = toIntakeQuery();
    for (const a of intakeAddresses()) for (const op of ["to", "cc", "deliveredto"]) expect(q).toContain(`${op}:${a}`);
    expect(q.startsWith("{") && q.trimEnd().endsWith("}")).toBe(true);
  });
});
