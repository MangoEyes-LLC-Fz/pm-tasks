import { describe, it, expect } from "vitest";
import { morningDue, ideasDue } from "../src/lib/morning";

describe("the 10:00 post never goes missing", () => {
  it("is due on a weekday from 10:05 India when no run is recorded for today", () => {
    expect(morningDue(new Date("2026-09-29T04:40:00Z"), null)).toBe(true);                         // Tue 10:10 IST, never ran
    expect(morningDue(new Date("2026-09-29T04:40:00Z"), "2026-09-28T04:30:10Z")).toBe(true);       // last run was Monday
    expect(morningDue(new Date("2026-09-29T04:40:00Z"), "2026-09-29T04:30:10Z")).toBe(false);      // ran today
    expect(morningDue(new Date("2026-09-29T04:20:00Z"), null)).toBe(false);                        // 09:50 IST: the cron's turn
    expect(morningDue(new Date("2026-09-27T06:00:00Z"), null)).toBe(false);                        // Sunday
  });
  it("posts the ideas every Monday, and catches up a missed Monday on the next run", () => {
    expect(ideasDue(new Date("2026-09-28T04:30:00Z"), "2026-09-21")).toBe(true);   // Monday
    expect(ideasDue(new Date("2026-09-29T04:35:00Z"), "2026-09-21")).toBe(true);   // Tuesday, last post 8 days ago
    expect(ideasDue(new Date("2026-09-29T04:35:00Z"), "2026-09-28")).toBe(false);  // Tuesday, Monday's post happened
    expect(ideasDue(new Date("2026-09-29T04:35:00Z"), null)).toBe(true);           // never posted
  });
});
