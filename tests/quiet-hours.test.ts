import { describe, it, expect } from "vitest";
import { heartbeatLimit, outsideWork, skipQuietCron } from "../src/lib/quiet-hours";

const env = {} as unknown as NodeJS.ProcessEnv;
const quiet = (start: string, end: string) => ({ QUIET_START_UTC: start, QUIET_END_UTC: end }) as unknown as NodeJS.ProcessEnv;

describe("quiet hours let Neon suspend", () => {
  // 2026-09-28 is a Monday, 2026-09-25 a Friday, 2026-09-26 a Saturday, 2026-09-27 a Sunday.
  it("runs every minute Monday to Friday from 11:00 to 22:30 IST", () => {
    expect(skipQuietCron(new Date("2026-09-28T05:30:00Z"), env)).toBe(false); // 11:00
    expect(skipQuietCron(new Date("2026-09-28T05:31:00Z"), env)).toBe(false); // 11:01, not a quarter
    expect(skipQuietCron(new Date("2026-09-28T12:07:00Z"), env)).toBe(false); // 17:37
    expect(skipQuietCron(new Date("2026-09-25T16:59:00Z"), env)).toBe(false); // Fri 22:29
    expect(outsideWork(new Date("2026-09-28T05:30:00Z"), env)).toBe(false);
    expect(outsideWork(new Date("2026-09-25T16:59:00Z"), env)).toBe(false);
  });

  it("skips other minutes at night, and all weekend except the 15-minute marks", () => {
    expect(skipQuietCron(new Date("2026-09-28T05:29:00Z"), env)).toBe(true);  // Mon 10:59
    expect(skipQuietCron(new Date("2026-09-28T17:01:00Z"), env)).toBe(true);  // Mon 22:31
    expect(skipQuietCron(new Date("2026-09-28T17:00:00Z"), env)).toBe(false); // 22:30 is :00
    expect(skipQuietCron(new Date("2026-09-26T06:07:00Z"), env)).toBe(true);  // Sat 11:37
    expect(skipQuietCron(new Date("2026-09-26T06:00:00Z"), env)).toBe(false); // Sat 11:30
    expect(skipQuietCron(new Date("2026-09-27T04:37:00Z"), env)).toBe(true);  // Sun 10:07
    expect(skipQuietCron(new Date("2026-09-27T04:30:00Z"), env)).toBe(false); // Sun 10:00
    expect(outsideWork(new Date("2026-09-26T06:00:00Z"), env)).toBe(true);
    expect(outsideWork(new Date("2026-09-27T12:00:00Z"), env)).toBe(true);
  });

  it("still enters the tick at 04:30 and 04:45 UTC, when the requeue and the catch-up are due", () => {
    // 04:30 UTC is 10:00 IST, before work hours, and it is the eod cron's minute.
    // 04:45 UTC is 10:15 IST, the first 15-minute mark after the 10:05 catch-up.
    expect(outsideWork(new Date("2026-09-28T04:30:00Z"), env)).toBe(true);
    expect(skipQuietCron(new Date("2026-09-28T04:30:00Z"), env)).toBe(false);
    expect(skipQuietCron(new Date("2026-09-28T04:35:00Z"), env)).toBe(true);
    expect(skipQuietCron(new Date("2026-09-28T04:45:00Z"), env)).toBe(false);
    expect(skipQuietCron(new Date("2026-09-25T04:30:00Z"), env)).toBe(false); // Friday
  });

  it("reads QUIET_START_UTC and QUIET_END_UTC, and ignores a bad value", () => {
    const moved = quiet("12:00", "04:00");
    expect(skipQuietCron(new Date("2026-09-28T05:07:00Z"), moved)).toBe(false); // inside the override
    expect(skipQuietCron(new Date("2026-09-28T12:07:00Z"), moved)).toBe(true);
    expect(skipQuietCron(new Date("2026-09-27T05:07:00Z"), moved)).toBe(true); // Sunday stays quiet
    const bad = quiet("noon", "05:30");
    expect(skipQuietCron(new Date("2026-09-28T16:07:00Z"), bad)).toBe(false); // default start 17:00
    expect(skipQuietCron(new Date("2026-09-28T17:07:00Z"), bad)).toBe(true);
    const off = quiet("10:00", "10:00");
    expect(skipQuietCron(new Date("2026-09-28T17:07:00Z"), off)).toBe(false);
    expect(skipQuietCron(new Date("2026-09-26T12:07:00Z"), off)).toBe(true);
  });

  it("allows a 20 minute heartbeat outside work hours, and for the first 15 minutes after 11:00", () => {
    expect(heartbeatLimit(300, new Date("2026-09-28T12:00:00Z"), env)).toBe(300);
    expect(heartbeatLimit(300, new Date("2026-09-28T04:30:00Z"), env)).toBe(1200);
    expect(heartbeatLimit(300, new Date("2026-09-28T05:44:00Z"), env)).toBe(1200); // 11:14 IST
    expect(heartbeatLimit(300, new Date("2026-09-28T05:45:00Z"), env)).toBe(300);  // 11:15 IST
    expect(heartbeatLimit(300, new Date("2026-09-26T12:00:00Z"), env)).toBe(1200);
    expect(heartbeatLimit(1200, new Date("2026-09-28T04:30:00Z"), env)).toBe(1200);
  });
});
