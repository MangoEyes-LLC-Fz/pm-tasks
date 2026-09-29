import { describe, it, expect } from "vitest";
import { workingHoursFrom, workingDaysAgo, inWorkingHours } from "../src/lib/when";

describe("a P1 due lands in working hours (India)", () => {
  it("four hours later inside the day, else four hours into the next working day", () => {
    expect(workingHoursFrom(new Date("2026-09-29T05:30:00Z"), 4).toISOString()).toBe("2026-09-29T09:30:00.000Z"); // Tue 11:00 → 15:00 IST
    expect(workingHoursFrom(new Date("2026-09-27T13:01:00Z"), 4).toISOString()).toBe("2026-09-28T07:30:00.000Z"); // Sun 18:31 → Mon 13:00 IST
    expect(workingHoursFrom(new Date("2026-09-29T15:00:00Z"), 4).toISOString()).toBe("2026-09-30T07:30:00.000Z"); // Tue 20:30 → Wed 13:00 IST
    expect(workingHoursFrom(new Date("2026-09-29T01:00:00Z"), 4).toISOString()).toBe("2026-09-29T07:30:00.000Z"); // Tue 06:30 → 13:00 IST
    expect(inWorkingHours(new Date("2026-09-26T06:00:00Z"))).toBe(false); // Saturday
  });
  it("counts working days back for the proposal expiry", () => {
    expect(workingDaysAgo(new Date("2026-09-29T04:30:00Z"), 5).toISOString()).toBe("2026-09-22T04:30:00.000Z"); // Tue → previous Tue
    expect(workingDaysAgo(new Date("2026-09-28T04:30:00Z"), 1).toISOString()).toBe("2026-09-25T04:30:00.000Z"); // Mon → Fri
  });
});
