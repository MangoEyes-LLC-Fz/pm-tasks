import { sql } from "./db";
import { postFeed } from "./review";
import { collectBrief, renderBrief } from "./brief";
import { postMondayIdeas } from "./ideas";
import { teamParts } from "./when";

/**
 * The 10:00 India post, Monday to Friday: the Today brief (only when a named person has something to do) and, on
 * Mondays, the week's ideas. Vercel Cron calls /api/eod at 04:30 UTC; the minute loop checks from 10:05 India that
 * the run happened and runs it itself when it did not (2026-09-29: a Monday passed with nothing in the feed and no
 * record of whether the cron had run). Every run is recorded in settings `eod_last`, shown in hub status.
 */

export const MORNING_KEY = "eod_last";
const IDEAS_KEY = "ideas_last";
/** Minute of the India day after which a missing run is made up by the minute loop (10:05). */
export const CATCH_UP_MINUTE = 10 * 60 + 5;

export const teamDay = (now: Date): string => { const p = teamParts(now); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`; };

/** Pure: should the minute loop run the morning post now? Weekday, 10:05 India or later, no run recorded for today. */
export function morningDue(now: Date, lastAt: string | null): boolean {
  const p = teamParts(now);
  if (p.weekday === 0 || p.weekday === 6) return false;
  if (p.hour * 60 + p.minute < CATCH_UP_MINUTE) return false;
  return !lastAt || teamDay(new Date(lastAt)) !== teamDay(now);
}

/** Pure: post the ideas today? Every Monday, and on the first run after a Monday that was missed. */
export function ideasDue(now: Date, lastIdeasDay: string | null): boolean {
  if (teamParts(now).weekday === 1) return true;
  if (!lastIdeasDay) return true;
  return now.getTime() - new Date(lastIdeasDay + "T00:00:00Z").getTime() > 7 * 86_400_000;
}

export interface MorningReport { at: string; posted: boolean; headline: string | null; waiting: number; overdue: number; ideas: { posted: number; threadKey: string | null }; errors: string[]; by: string }

export async function runMorning(now = new Date(), opts: { by: string; forceIdeas?: boolean }): Promise<MorningReport> {
  const report: MorningReport = { at: now.toISOString(), posted: false, headline: null, waiting: 0, overdue: 0, ideas: { posted: 0, threadKey: null }, errors: [], by: opts.by };
  try {
    const data = await collectBrief(now);
    const brief = renderBrief(data);
    report.waiting = data.waiting.length; report.overdue = data.overdue.length; report.headline = brief?.headline ?? null;
    if (brief) { await postFeed({ headline: brief.headline, detail: brief.detail, threadKey: `brief-${teamDay(now)}` }); report.posted = true; }
  } catch (e) { report.errors.push(`brief: ${(e as Error).message.slice(0, 200)}`); }
  try {
    const last = await sql()`select value->>'day' as day from settings where key = ${IDEAS_KEY}`;
    if (opts.forceIdeas || ideasDue(now, last.length ? (last[0].day as string | null) : null)) {
      report.ideas = await postMondayIdeas(now);
      if (report.ideas.posted) await sql()`insert into settings (key, value) values (${IDEAS_KEY}, ${JSON.stringify({ day: teamDay(now), posted: report.ideas.posted })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
    }
  } catch (e) { report.errors.push(`ideas: ${(e as Error).message.slice(0, 200)}`); }
  try {
    await sql()`insert into settings (key, value) values (${MORNING_KEY}, ${JSON.stringify(report)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  } catch { /* ignore */ }
  return report;
}

/** For the minute loop: run the morning post when the cron has not, once per weekday. */
export async function catchUpMorning(now = new Date()): Promise<MorningReport | null> {
  const r = await sql()`select value->>'at' as at from settings where key = ${MORNING_KEY}`;
  if (!morningDue(now, r.length ? (r[0].at as string | null) : null)) return null;
  return runMorning(now, { by: "tick catch-up" });
}
