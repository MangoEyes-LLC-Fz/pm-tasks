import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";
import { driveAs, findNoteDocs, meetConfigured, pollMeetings, readers, readerError, rereadNoteDoc, forgetMeetingCards } from "@/lib/meet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Whose Drives the hub reads (every team member with a work address, through domain-wide delegation), whether each can
 * be read, and the notes docs of the last 14 days. Nobody shares a folder (2026-09-30). Add ?run=1 to read any new
 * docs now instead of waiting for the 5-minute tick; ?reread=<doc id> forgets one meeting and reads its doc again.
 *   curl -H "Authorization: Bearer $CRON_SECRET" "https://pm-tasks.vercel.app/api/meet-check?run=1"
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  if (!meetConfigured()) return NextResponse.json({ ok: false, error: "GOOGLE_SERVICE_ACCOUNT_B64 not set" }, { status: 500 });
  try {
    const people = await readers();
    const coverage: Array<{ as: string; ok: boolean; error?: string }> = [];
    for (const as of people) {
      try { await driveAs(as).files.list({ q: "trashed = false", fields: "files(id)", pageSize: 1 }); coverage.push({ as, ok: true }); }
      catch (e) { coverage.push({ as, ok: false, error: readerError(e) }); }
    }
    const errors: Array<{ as: string; error: string }> = [];
    let docs: Awaited<ReturnType<typeof findNoteDocs>> = [];
    try { docs = await findNoteDocs(14, { errors }); } catch (e) { errors.push({ as: "*", error: (e as Error).message.slice(0, 200) }); }
    const out: Record<string, unknown> = {
      ok: coverage.some((c) => c.ok),
      readsDriveAs: coverage,
      notesDocsLast14Days: docs.map((d) => ({ name: d.name, modified: d.modifiedTime, owner: d.owner, folder: d.folder, seenAs: d.as })),
      ...(errors.length ? { errors } : {}),
    };
    const params = new URL(req.url).searchParams;
    // ?since=now (or an ISO time): only notes docs changed after this moment are read on their own. Use it when older
    // meetings should stay unread; ?reread=<doc> still reads any one doc.
    const since = params.get("since");
    if (since) {
      const at = since === "now" ? new Date() : new Date(since);
      if (isNaN(at.getTime())) return NextResponse.json({ ok: false, error: "since must be 'now' or an ISO time" }, { status: 400 });
      const { sql } = await import("@/lib/db");
      await sql()`insert into settings (key, value) values ('meet_since', ${JSON.stringify(at.toISOString())}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
      out.since = at.toISOString();
    }
    const docId = (v: string) => v.replace(/^.*\/d\/([^/]+).*$/, "$1");
    const forget = params.get("forget_cards");
    if (forget) out.forget_cards = await forgetMeetingCards(docId(forget));
    const reread = params.get("reread");
    if (reread) out.reread = await rereadNoteDoc(docId(reread));
    if (params.get("run") === "1") out.run = await pollMeetings();
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message.slice(0, 300) }, { status: 500 });
  }
}
