import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";
import { collectBrief, renderBrief } from "@/lib/brief";
import { runMorning } from "@/lib/morning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 10:00 India, Monday to Friday (Vercel Cron 04:30 UTC): the day's list. One headline, the detail in its thread,
 * and nothing at all when nobody has anything to do. On Mondays the week's ideas follow as their own line.
 * The run is recorded in settings `eod_last`; the minute loop runs it itself from 10:05 India if this cron did not.
 * ?dry=1 shows the brief without posting; ?ideas=1 forces the ideas post on any day.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const url = new URL(req.url);
  if (url.searchParams.get("dry") === "1") {
    const brief = renderBrief(await collectBrief());
    return new NextResponse(brief ? `${brief.headline}\n\n${brief.detail}` : "(nothing waiting: no post)", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const report = await runMorning(new Date(), { by: "cron", forceIdeas: url.searchParams.get("ideas") === "1" });
  return NextResponse.json({ ok: report.errors.length === 0, ...report });
}
