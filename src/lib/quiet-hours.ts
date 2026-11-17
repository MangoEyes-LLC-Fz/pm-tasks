/**
 * When the minute crons may return before touching Postgres, so Neon can suspend.
 *
 * Work hours are Monday to Friday, 11:00 to 22:30 IST (05:30 to 17:00 UTC).
 * Saturday and Sunday are outside hours all day. Outside hours, /api/tick,
 * /api/inbox-tick and /api/meet-tick do their work only on UTC minutes
 * :00, :15, :30 and :45. The 10:00 IST post's cron is separate. The Gmail
 * requeue (04:30 UTC) and the morning catch-up (from 10:05 IST, so 04:45 UTC)
 * still run, because those minutes are 15-minute marks.
 *
 * QUIET_START_UTC and QUIET_END_UTC are HH:MM in UTC. Quiet runs from start
 * inclusive until end exclusive, and wraps past midnight when start is later
 * than end. Default 17:00 to 05:30. Weekends stay quiet whatever those say.
 */
import { teamParts } from "./when";

const DEFAULT_QUIET_START = 17 * 60;
const DEFAULT_QUIET_END = 5 * 60 + 30;
/** A run every 15 minutes can leave a heartbeat this old. */
const QUIET_HEARTBEAT_SECONDS = 20 * 60;

function parseClock(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

function bounds(env: NodeJS.ProcessEnv): { start: number; end: number } {
  return {
    start: parseClock(env.QUIET_START_UTC, DEFAULT_QUIET_START),
    end: parseClock(env.QUIET_END_UTC, DEFAULT_QUIET_END),
  };
}

/** Saturday, Sunday, or outside the UTC clock window. The weekday is India's. */
export function outsideWork(now: Date, env: NodeJS.ProcessEnv = process.env): boolean {
  const wd = teamParts(now).weekday;
  if (wd === 0 || wd === 6) return true;
  const { start, end } = bounds(env);
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

/**
 * True when this cron run should return before any database or external call.
 * A UTC minute of :00, :15, :30 or :45 always continues, including 04:30 and 04:45.
 */
export function skipQuietCron(now: Date, env: NodeJS.ProcessEnv = process.env): boolean {
  if (now.getUTCMinutes() % 15 === 0) return false;
  return outsideWork(now, env);
}

/**
 * How old a heartbeat may be, in seconds, before health and the morning brief
 * call the reader stopped. Outside work hours the allowance is 20 minutes.
 * The first 15 minutes after work starts keep it too: the previous real run
 * can be a quarter-hour behind.
 */
export function heartbeatLimit(baseSeconds: number, now: Date, env: NodeJS.ProcessEnv = process.env): number {
  if (outsideWork(now, env)) return Math.max(baseSeconds, QUIET_HEARTBEAT_SECONDS);
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const into = (minute - bounds(env).end + 1440) % 1440;
  if (into < 15) return Math.max(baseSeconds, QUIET_HEARTBEAT_SECONDS);
  return baseSeconds;
}
