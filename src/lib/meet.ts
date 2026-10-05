import { google, type drive_v3 } from "googleapis";
import { sql, allClients, enqueue } from "./db";
import { resolveClientFromText } from "./resolve";
import { sortMeeting } from "./llm/meeting";
import { processMessage } from "./pipeline";
import { postHeadline, editHeadline, postDetail, rememberThread, closeNeedsHumanCard } from "./review";
import { pulp } from "./pulp";
import * as gchat from "./gchat";
import { certainMeetingClient, knownClientPeople, type KnownPerson } from "./meet-client";
import type { Client, Message } from "./types";

/**
 * Meeting notes. Google Meet writes "<title> - Notes by Gemini" docs into the organiser's Drive, under "Meet
 * Recordings" or "Google Meet/<meeting>/", a new folder whenever it likes. Nobody shares anything (2026-09-30): the
 * hub reads Drive as each team member through domain-wide delegation (scope drive.readonly, read only), so every notes
 * doc in anyone's Drive is found at any depth the moment it exists. The same doc seen through several people (Meet
 * shares notes with attendees) is one doc: file ids dedupe, and a meeting read before is never read again.
 * New docs are read every 5 minutes.
 *
 * Every meeting is sorted into four buckets (one model call): actions go through the normal pipeline per client
 * (dedupe against open tasks, Staging card, feed line); ideas and decisions are stored and get one line each;
 * discussion stays in the stored notes. Internal meetings use the MangoEyes client.
 */

function credentials() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("GOOGLE_NOT_CONFIGURED");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}
const _drives = new Map<string, drive_v3.Drive>();
/** Drive as one team member (domain-wide delegation, read only). */
export function driveAs(email: string): drive_v3.Drive {
  let d = _drives.get(email);
  if (!d) {
    const creds = credentials() as { client_email: string; private_key: string };
    d = google.drive({ version: "v3", auth: new google.auth.JWT({ email: creds.client_email, key: creds.private_key, subject: email, scopes: ["https://www.googleapis.com/auth/drive.readonly"] }) });
    _drives.set(email, d);
  }
  return d;
}
export const meetConfigured = () => !!process.env.GOOGLE_SERVICE_ACCOUNT_B64;

const staffDomains = () => (process.env.STAFF_EMAIL_DOMAINS || "mangoeyesagency.com").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

/** Pure: whose Drives the hub reads. Team members with a work address on a staff domain, plus the hub's mailbox owner; each once. */
export function readerEmails(members: Array<{ email: string | null }>, mailbox: string | null, domains = staffDomains()): string[] {
  const out: string[] = [];
  for (const e of [mailbox, ...members.map((m) => m.email)]) {
    const a = (e ?? "").trim().toLowerCase();
    if (a && domains.some((d) => a.endsWith("@" + d)) && !out.includes(a)) out.push(a);
  }
  return out;
}

/** The team members whose Drives are read: the team record (Pulp board members) plus the mailbox owner. */
export async function readers(): Promise<string[]> {
  const { teamMembers } = await import("./team");
  return readerEmails(await teamMembers(), process.env.GMAIL_MAILBOX ?? null);
}

/**
 * Why the hub could not read as a person. "scope": the Drive read-only scope is missing in Google Admin (fix there).
 * "no_account": the address is not a Google Workspace account (a Pulp board member with a different or former
 * address): set aside for a day, not an issue. Anything else is reported as it is.
 */
export function readerProblem(e: unknown): { kind: "scope" | "no_account" | "other"; message: string } {
  const m = (e as Error).message ?? String(e);
  if (/Invalid email or User ID|user does not exist|Not a valid email/i.test(m)) return { kind: "no_account", message: `no such Google account on the domain (a board member's address that is not a Workspace user); tried again tomorrow (${m.slice(0, 80)})` };
  if (/unauthorized_client|not authorized|Not authorized|delegation|invalid_grant/i.test(m)) return { kind: "scope", message: `not authorised: add the Drive read-only scope for the hub's service account in Google Admin (Domain Wide Delegation) (${m.slice(0, 120)})` };
  return { kind: "other", message: m.slice(0, 200) };
}
export const readerError = (e: unknown): string => readerProblem(e).message;

const READER_OFF_HOURS = 24;
const readerOffKey = (as: string) => `meet_reader_off:${as}`;
const readerSinceKey = (as: string) => `meet_reader_since:${as}`;

/**
 * Pure: the moment a Drive view starts counting. A view read for the first time starts now, so the meetings that were
 * already in that Drive are never a backlog (2026-09-30: reading as every team member surfaced 27 old meetings in the
 * feed). Otherwise the window is the last `days` days, never earlier than the first read.
 */
export function viewWindowStart(now: Date, days: number, firstRead: Date | null): Date {
  const window = new Date(now.getTime() - days * 86_400_000);
  if (!firstRead) return now;
  return firstRead > window ? firstRead : window;
}

const NOTES_TITLE = /\s*[-–—]\s*(Notes by Gemini|Gemini notes|notes)\s*$/i;
const TRANSCRIPT_TITLE = /\s*[-–—]\s*transcript\s*$/i;

export interface NoteDoc { id: string; name: string; modifiedTime: string; owner: string | null; folder: string | null; /** whose Drive view it was found through; the doc is read through the same */ as: string }

/**
 * Every Gemini notes doc in any team member's Drive, at any depth. Google files them differently over time: directly
 * in "Meet Recordings", or under "Google Meet/<meeting> - <date>/", sometimes as a shortcut in a recurring meeting's
 * folder. So this does not walk folders at all: per person, one Drive query for anything named "… Notes by Gemini"
 * (documents and shortcuts to documents) modified since the watermark, wherever it sits. Shortcuts resolve to their
 * target; the same doc through several people is one doc. A person the hub cannot read as is reported, never fatal;
 * only when nobody can be read is the poll a failure.
 */
export async function findNoteDocs(days = 3, opts: { errors?: Array<{ as: string; error: string }>; skipped?: Array<{ as: string; why: string }>; readers?: string[]; /** meet-check: the whole window, not only since each view's first read */ wholeWindow?: boolean } = {}): Promise<NoteDoc[]> {
  const people = opts.readers ?? await readers();
  if (!people.length) throw new Error("no team member with a work address to read Drive as");
  const out = new Map<string, NoteDoc>();
  let okCount = 0;
  // Addresses that are not Google accounts are set aside for a day (settings `meet_reader_off:<email>` holds until when).
  const off = new Map((await sql()`select key, value from settings where key like 'meet_reader_off:%'`).map((r) => [String(r.key).slice("meet_reader_off:".length), new Date(String(r.value))]));
  // Each view counts from its first read (settings `meet_reader_since:<email>`): a Drive that becomes readable brings no backlog.
  const firstRead = new Map((await sql()`select key, value from settings where key like 'meet_reader_since:%'`).map((r) => [String(r.key).slice("meet_reader_since:".length), new Date(String(r.value))]));
  const now = new Date();
  for (const as of people) {
    const until = off.get(as);
    if (until && until > now) { opts.skipped?.push({ as, why: `no such Google account on the domain; tried again after ${until.toISOString().slice(0, 16)}Z` }); continue; }
    const start = opts.wholeWindow ? new Date(now.getTime() - days * 86_400_000) : viewWindowStart(now, days, firstRead.get(as) ?? null);
    try {
      for (const doc of await findNoteDocsAs(as, start)) if (!out.has(doc.id)) out.set(doc.id, doc);
      okCount++;
      if (!firstRead.has(as)) await sql()`insert into settings (key, value) values (${readerSinceKey(as)}, ${JSON.stringify(now.toISOString())}::jsonb) on conflict (key) do nothing`;
    }
    catch (e) {
      const p = readerProblem(e);
      if (p.kind === "no_account") {
        opts.skipped?.push({ as, why: p.message });
        try { await sql()`insert into settings (key, value) values (${readerOffKey(as)}, ${JSON.stringify(new Date(Date.now() + READER_OFF_HOURS * 3_600_000).toISOString())}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`; } catch { /* next run tries again */ }
      } else opts.errors?.push({ as, error: p.message });
    }
  }
  if (!okCount && !out.size) throw new Error(`Drive could not be read as anyone: ${opts.errors?.[0]?.error ?? opts.skipped?.[0]?.why ?? "unknown"}`);
  return [...out.values()].sort((a, b) => a.modifiedTime.localeCompare(b.modifiedTime));
}

async function findNoteDocsAs(as: string, start: Date): Promise<NoteDoc[]> {
  const d = driveAs(as);
  const since = start.toISOString();
  const out = new Map<string, NoteDoc>();
  const parentNames = new Map<string, string>();
  const folderName = async (id: string | undefined): Promise<string | null> => {
    if (!id) return null;
    if (!parentNames.has(id)) {
      try { const r = await d.files.get({ fileId: id, fields: "name", supportsAllDrives: true }); parentNames.set(id, r.data.name ?? id); }
      catch { parentNames.set(id, id); }
    }
    return parentNames.get(id) ?? null;
  };
  let pageToken: string | undefined;
  do {
    const res = await d.files.list({
      q: `name contains 'Notes by Gemini' and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.shortcut') and modifiedTime > '${since}' and trashed = false`,
      fields: "nextPageToken, files(id,name,mimeType,modifiedTime,owners(emailAddress),parents,shortcutDetails(targetId,targetMimeType))",
      pageSize: 100, orderBy: "modifiedTime", supportsAllDrives: true, includeItemsFromAllDrives: true, pageToken,
    });
    for (const f of res.data.files ?? []) {
      if (!f.id || !f.name || TRANSCRIPT_TITLE.test(f.name) || !NOTES_TITLE.test(f.name)) continue;
      let id = f.id;
      if (f.mimeType === "application/vnd.google-apps.shortcut") {
        if (f.shortcutDetails?.targetMimeType !== "application/vnd.google-apps.document" || !f.shortcutDetails.targetId) continue;
        id = f.shortcutDetails.targetId;
      }
      if (out.has(id)) continue;
      out.set(id, { id, name: f.name, modifiedTime: f.modifiedTime ?? since, owner: f.owners?.[0]?.emailAddress ?? null, folder: await folderName(f.parents?.[0]), as });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return [...out.values()];
}

async function docText(doc: NoteDoc): Promise<string> {
  const res = await driveAs(doc.as).files.export({ fileId: doc.id, mimeType: "text/plain" }, { responseType: "text" });
  return String(res.data ?? "").replace(/\r\n/g, "\n").trim();
}

/** People the doc is shared with (Meet shares the notes with attendees). Best effort; viewers may not see this. */
async function attendeesOf(doc: NoteDoc): Promise<string[]> {
  try {
    const res = await driveAs(doc.as).permissions.list({ fileId: doc.id, fields: "permissions(emailAddress,type)", supportsAllDrives: true });
    return (res.data.permissions ?? []).map((p) => p.emailAddress ?? "").filter((e) => e && !e.endsWith("gserviceaccount.com"));
  } catch { return []; }
}

/** "HOH monthly review - Notes by Gemini" → "HOH monthly review". Gemini also puts the date in the doc body. */
export const meetingTitle = (name: string) => name.replace(NOTES_TITLE, "").trim();

/**
 * The feed headline: the call's own name, then whose it was. Gemini's date-time tail goes ("Introduction Call –
 * 2026/09/15 15:22 CEST" → "Introduction Call"); a generic "Meeting started …" title says nothing, so it reads "Meeting".
 */
export function headlineTitle(title: string): string {
  const t = title.replace(/\s*[-–—]?\s*\d{4}[/-]\d{2}[/-]\d{2}(\s+\d{1,2}:\d{2}(\s*[AP]M)?)?(\s+[A-Z]{2,5})?\s*$/i, "").trim();
  if (!t || /^meeting( started)?$/i.test(t)) return "Meeting";
  return t.length > 60 ? t.slice(0, 59).trimEnd() + "…" : t;
}
export const meetingHeadline = (h: { title: string; who: string; day: string }) => `📝 *${headlineTitle(h.title)}* · ${h.who} · ${h.day}`;
/** The first reply in the meeting's thread: the tally (edited as the action jobs finish) and the notes link. */
export const meetingTallyLine = (tally: string, docUrl: string) => `${tally} · <${docUrl}|notes>`;

/** Gemini notes start with a line like "Sep 9, 2026" or "Tue, 9 Sep 2026 · 3:00 PM". Fall back to the file time. */
export function heldAtFrom(notes: string, fallback: string): Date {
  const head = notes.slice(0, 400);
  const m = head.match(/\b(\d{1,2})\s+([A-Z][a-z]{2,8})\s+(\d{4})\b/) ?? head.match(/\b([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m) {
    const d = new Date(`${m[0]} 12:00 UTC`);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date(fallback);
}

function clientByName(name: string | null | undefined, clients: Client[]): Client | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return clients.find((c) => c.name.toLowerCase() === n || c.id.toLowerCase() === n || (c.aliases ?? []).some((a) => a.toLowerCase() === n))
    ?? clients.find((c) => c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase()))
    ?? (/mango\s*eyes|internal/i.test(n) ? clients.find((c) => c.scope === "internal") ?? null : null);
}

/**
 * Gemini creates the notes doc when the call ends and fills it in over the next minutes; the transcript can lag
 * further. A doc read too early looks empty or says the notes are still being generated. Such a doc is not recorded:
 * it is tried again (every 30 minutes, for up to 6 hours after its last change) until it has real content, so a
 * meeting is never written off as "nothing to act on" because the hub was quicker than Gemini.
 */
const NOT_READY = /\b(still (being )?(generat|process|transcrib|prepar)|will (be|appear) (available|here|shortly)|notes? (are|is) (being|not yet)|transcript(ion)? (is )?(in progress|pending|not (yet )?available|failed|unavailable)|transcription (issue|problem|error)|no usable|no (content|transcript|notes)\b|not captured|could not be (captured|transcribed))/i;
export function notesNotReady(notes: string, summary: string[] = [], items = 0): boolean {
  const t = notes.trim();
  if (t.length < 400) return true;
  if (NOT_READY.test(t.slice(0, 1500))) return true;
  return items === 0 && summary.some((s) => NOT_READY.test(s));
}
const RETRY_MINUTES = 30, GIVE_UP_HOURS = 6;

export async function processNoteDoc(doc: NoteDoc): Promise<string> {
  const exists = await sql()`select id from meetings where drive_file_id = ${doc.id}`;
  if (exists.length) return `${doc.name}: already read`;
  // Not before the retry gap, so a doc that is still being written is not exported every five minutes.
  const retryKey = `meet_retry:${doc.id}`;
  const last = await sql()`select value from settings where key = ${retryKey}`;
  if (last.length && Date.now() - new Date(String(last[0].value)).getTime() < RETRY_MINUTES * 60_000) return `${doc.name}: waiting for Gemini to finish`;
  const notes = await docText(doc);
  const clients = await allClients();
  const title = meetingTitle(doc.name);
  const attendees = await attendeesOf(doc);
  const heldAt = heldAtFrom(notes, doc.modifiedTime);
  const docUrl = `https://docs.google.com/document/d/${doc.id}/edit`;
  const ageHours = (Date.now() - new Date(doc.modifiedTime).getTime()) / 3_600_000;
  const notReady = async (why: string) => {
    if (ageHours < GIVE_UP_HOURS) {
      await sql()`insert into settings (key, value) values (${retryKey}, ${JSON.stringify(new Date().toISOString())}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
      return `${doc.name}: ${why}, will read again later`;
    }
    await sql()`insert into meetings (drive_file_id, title, held_at, organiser, attendees, client_id, scope, doc_url, notes, summary)
      values (${doc.id}, ${title}, ${heldAt.toISOString()}, ${doc.owner}, ${JSON.stringify(attendees)}::jsonb, null, 'unknown', ${docUrl}, ${notes}, ${JSON.stringify([`No notes were produced for this meeting (${why}).`])}::jsonb) on conflict (drive_file_id) do nothing`;
    await sql()`delete from settings where key = ${retryKey}`;
    return `${doc.name}: ${why} after ${GIVE_UP_HOURS} hours, recorded as no notes`;
  };
  if (notesNotReady(notes)) return notReady(notes.trim().length < 400 ? "notes not written yet" : "Gemini still writing");

  const team = await teamNames(attendees);
  const sorted = await sortMeeting({ title, notes, attendees, team, clients: clients.map((c) => `${c.name}${c.aliases?.length ? `; ${c.aliases.join(", ")}` : ""}`) });
  if (notesNotReady(notes, sorted.summary ?? [], sorted.items.length)) return notReady("no usable content yet");
  await sql()`delete from settings where key = ${retryKey}`;
  // Meeting-level client, with certainty only (2026-10-05, src/lib/meet-client.ts): the title, an attendee's address, a
  // client person the hub knows, or an internal call where only the team spoke. The sorter's answer is a suggestion
  // for the "which client?" card, never the client: a guess filed "Swathi / Vishnu" under the wrong clinic.
  const sorterClient = clientByName(sorted.meeting_client, clients);
  const certain = certainMeetingClient({ title, attendees, notes, clients, people: await knownClientPeople(clients), team, sorterClient });
  const meetingClient = certain?.client ?? null;

  const ins = await sql()`insert into meetings (drive_file_id, title, held_at, organiser, attendees, client_id, scope, doc_url, notes, summary)
    values (${doc.id}, ${title}, ${heldAt.toISOString()}, ${doc.owner}, ${JSON.stringify(attendees)}::jsonb, ${meetingClient?.id ?? null}, ${meetingClient ? meetingClient.scope : "unknown"}, ${docUrl}, ${notes}, ${JSON.stringify(sorted.summary)}::jsonb)
    returning id`;
  const meetingId = String(ins[0].id);

  // Ideas, decisions and discussion are stored now. Actions are grouped per client and handed to the queue: one job
  // per client, each in its own time budget, so a call with many action items can never outrun one web request
  // (that left a meeting stuck at "reading the notes…" on 2026-09-15). The headline tally follows as jobs finish.
  const groups = new Map<string, { client: Client | null; items: typeof sorted.items }>();
  const ideaLines: string[] = [];
  const decidedLines: string[] = [];
  const clientTodo: string[] = [];
  const followUps: string[] = [];
  for (const it of sorted.items) {
    // An item names its own client only when its words do ("Dr Tanov's videos as reference"); otherwise it is the
    // meeting's. In an unclear meeting every item waits for the tap, like the meeting itself.
    const c = resolveClientFromText(it.text, clients)?.client ?? meetingClient;
    if (it.kind === "action" && it.side === "client" && c?.scope !== "internal") {
      // The client's own homework (sign, grant access, send photos) is not the team's task: listed in the thread, no card.
      await sql()`insert into meeting_items (meeting_id, kind, client_id, text, owner, due_text, outcome) values (${meetingId}, 'action', ${c?.id ?? null}, ${it.text}, ${it.owner}, ${it.due}, 'client')`;
      if (clientTodo.length < 8) clientTodo.push(`• ${it.text}${it.owner ? ` (${it.owner})` : ""}${it.due ? ` — ${it.due}` : ""}`);
      continue;
    }
    if (it.kind === "action" && it.work === false) {
      // Coordination and follow-ups (a call to schedule, a sync, something to look into) are the team's to remember,
      // not cards: listed in the thread, on record for Claude, never proposed (2026-09-29: they were most of the
      // proposals nobody answered).
      await sql()`insert into meeting_items (meeting_id, kind, client_id, text, owner, due_text, outcome) values (${meetingId}, 'action', ${c?.id ?? null}, ${it.text}, ${it.owner}, ${it.due}, 'noted')`;
      followUps.push(`• *${c?.name ?? "MangoEyes"}* · ${it.text}${it.owner ? ` (${it.owner})` : ""}${it.due ? ` — ${it.due}` : ""}`);
      continue;
    }
    if (it.kind === "action") {
      const key = c?.id ?? "?";
      if (!groups.has(key)) groups.set(key, { client: c, items: [] });
      groups.get(key)!.items.push(it);
      // Recorded now as pending; the group job sets the outcome once the pipeline has run.
      await sql()`insert into meeting_items (meeting_id, kind, client_id, text, owner, due_text, outcome) values (${meetingId}, 'action', ${c?.id ?? null}, ${it.text}, ${it.owner}, ${it.due}, 'pending')`;
      continue;
    }
    const outcome = it.kind === "idea" ? "idea" : it.kind === "decision" ? "decision" : "noted";
    await sql()`insert into meeting_items (meeting_id, kind, client_id, text, owner, due_text, outcome) values (${meetingId}, ${it.kind}, ${c?.id ?? null}, ${it.text}, ${it.owner}, ${it.due}, ${outcome})`;
    if (it.kind === "idea") {
      // Ideas wait for Monday's decision, like an idea said in Slack.
      await sql()`insert into ideas (client_id, meeting_id, text, said_by, source, source_link, said_at) values (${c?.id ?? null}, ${meetingId}, ${it.text}, ${it.owner}, ${"Meeting · " + headlineTitle(title)}, ${docUrl}, ${heldAt.toISOString()})`;
      ideaLines.push(`💡 *${c?.name ?? "MangoEyes"}* · ${it.text}`);
    }
    if (it.kind === "decision") {
      // A decision about work that already has a card is written on that card, so the person doing it sees it.
      const onCard = await noteDecisionOnCard(c?.id ?? null, it.text, headlineTitle(title), heldAt);
      decidedLines.push(`📌 *${c?.name ?? "MangoEyes"}* · ${it.text}${onCard ? ` · <${onCard.link}|on the card "${onCard.title.slice(0, 40)}"> ` : ""}`);
    }
  }

  // One headline in the feed per meeting; the cards, ideas, decisions and summary all go inside its thread.
  const threadKey = `meet-${meetingId}`;
  const who = meetingClient ? meetingClient.name : "client unclear";
  const day = heldAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  const headName = await postHeadline(meetingHeadline({ title, who, day }), threadKey);
  const tallyName = await postHeadline(meetingTallyLine(groups.size && meetingClient ? "reading the notes…" : await tallyText(meetingId), docUrl), threadKey);
  await sql()`insert into settings (key, value) values (${"meet_head:" + meetingId}, ${JSON.stringify({ name: headName, tallyName, title, who, day, docUrl })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  // The thread, in reading order (2026-09-22): In short · Decided · To do (the proposal cards follow from the jobs) · Also raised.
  const summary = (sorted.summary ?? []).slice(0, 5).map((x) => `• ${x}`).join("\n");
  const todoNote = groups.size ? (meetingClient ? `*To do*\nThe team's action items follow below, one card each. Tap Create card, Remind me instead or No card on each.` : `*To do*\nThe team's action items wait until the client is set below; then they follow here, one card each.`) : "";
  const raised = [...ideaLines.map((l) => `${l} · up for a decision on Monday`), ...clientTodo.map((l) => `${l} · the client's to-do, no card`)];
  const followNote = followUps.length ? `*Follow-ups, no card* (calls, syncs, things to look into: on record, yours to remember)\n${followUps.join("\n")}` : "";
  await postDetail([summary ? `*In short*\n${summary}` : "", decidedLines.length ? `*Decided*\n${decidedLines.join("\n")}` : "", todoNote, followNote, raised.length ? `*Also raised*\n${raised.join("\n")}` : ""].filter(Boolean).join("\n\n"), threadKey);

  const job = { meetingId, docId: doc.id, docUrl, title, owner: doc.owner, heldAt: heldAt.toISOString(), threadKey };
  if (!meetingClient) {
    // Unclear: the action items are kept, not run; the card in the thread sets the client and releases them.
    const pending = [...groups.values()].map((g) => ({ clientId: g.client?.id ?? null, items: g.items.map((it) => ({ text: it.text, owner: it.owner, due: it.due })) }));
    if (pending.length) await sql()`insert into settings (key, value) values (${"meet_pending:" + meetingId}, ${JSON.stringify({ ...job, groups: pending })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
    await askMeetingClient(meetingId, threadKey, title, sorterClient);
    return `${title}: client unclear${sorterClient ? ` (the sorter guessed ${sorterClient.name})` : ""}, asked in the thread`;
  }
  const jobs = await queueActionGroups(job, [...groups.values()].map((g) => ({ clientId: g.client?.id ?? null, items: g.items })));
  return `${title}: ${jobs ? `${jobs} action job${jobs > 1 ? "s" : ""} queued` : await tallyText(meetingId)}`;
}
const ACTIONS_PER_JOB = 5;

type ActionItem = { text: string; owner: string | null; due: string | null };
type GroupJob = { meetingId: string; docId: string; docUrl: string; title: string; owner: string | null; heldAt: string; threadKey: string };

/** Five action items per job: each ask costs a model call and a card, and a job must finish well inside a minute. */
async function queueActionGroups(job: GroupJob, groups: Array<{ clientId: string | null; items: ActionItem[] }>): Promise<number> {
  let jobs = 0;
  for (const g of groups) {
    const parts: ActionItem[][] = [];
    for (let i = 0; i < g.items.length; i += ACTIONS_PER_JOB) parts.push(g.items.slice(i, i + ACTIONS_PER_JOB));
    for (let p = 0; p < parts.length; p++) {
      const text = parts[p].map((it) => `- ${it.text}${it.owner ? ` (${it.owner})` : ""}${it.due ? ` — ${it.due}` : ""}`).join("\n");
      await enqueue("meet_group", { ...job, clientId: g.clientId, text, part: parts.length > 1 ? p + 1 : 0, items: parts[p].map((it) => it.text) });
      jobs++;
    }
  }
  return jobs;
}

/** The "which client?" card in the meeting's thread: a dropdown with the sorter's guess named, or a typed name in the thread. */
async function askMeetingClient(meetingId: string, threadKey: string, title: string, suggestion: Client | null): Promise<void> {
  const rows = await sql()`select id, name from clients where scope in ('client', 'internal') order by (scope = 'internal'), name limit 100`;
  const ask = suggestion ? `The hub's guess is ${suggestion.name}, but nothing in the call proves it. Pick the client below, or reply here with the name.` : "Nothing in the call names the client. Pick it below, or reply here with the name.";
  if (!gchat.gchatConfigured()) { await postDetail(`*Which client?*\n${ask}`, threadKey); return; }
  const card = gchat.meetingClientCard({ meetingId, title: headlineTitle(title), ask, clients: rows.map((r) => ({ id: String(r.id), name: String(r.name) })) });
  const sent = await gchat.sendCard(gchat.reviewSpace(), card, ask, `meet-client-${meetingId}`, threadKey);
  await rememberThread(sent.thread, { kind: "meeting_client", meetingId });
  await sql()`insert into settings (key, value) values (${"meet_client_card:" + meetingId}, ${JSON.stringify({ card: sent.name, suggestion: suggestion?.name ?? null })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

/**
 * File a meeting under a client: from the card's dropdown, a typed name in the thread, or the hub itself when a
 * certain fact turns up (the repair of 2026-10-05). The meeting, its items, its ideas and its unprocessed action
 * messages move; the headline is rewritten; the held action items are queued. Cards already made keep their label in
 * Pulp (the hub cannot relabel), and the thread says so.
 */
export async function refileMeeting(meetingId: string, client: Client, by: string, reason?: string, opts: { quiet?: boolean } = {}): Promise<string> {
  // quiet (the repair, Vishnu 2026-10-05: "no feed message for the corrections"): the records and the existing
  // headline change, nothing is posted, no message is re-run, no card is touched.
  const quiet = !!opts.quiet;
  const rows = await sql()`select id, drive_file_id, title, held_at, client_id from meetings where id = ${meetingId}`;
  if (!rows.length) return "That meeting is not on record any more.";
  const m = rows[0];
  const old = (m.client_id as string | null) ?? null;
  const oldName = old ? String((await sql()`select name from clients where id = ${old}`)[0]?.name ?? old) : null;
  await sql()`update meetings set client_id = ${client.id}, scope = ${client.scope} where id = ${meetingId}`;
  await sql()`update meeting_items set client_id = ${client.id} where meeting_id = ${meetingId} and client_id is not distinct from ${old}`;
  await sql()`update ideas set client_id = ${client.id} where meeting_id = ${meetingId} and client_id is not distinct from ${old}`;
  // Action messages that still wait for a client run now under it; the "which client?" cards of those groups close.
  const msgs = await sql()`select id, skip_reason from messages where channel = 'meet' and external_id like ${"meet:" + String(m.drive_file_id) + ":%"} and client_id is not distinct from ${old}`;
  for (const r of msgs) {
    await sql()`update messages set client_id = ${client.id}, scope = ${client.scope} where id = ${r.id}`;
    await sql()`update requests set client_id = ${client.id} where message_id = ${r.id} and client_id is not distinct from ${old} and not exists (select 1 from tasks t where t.request_id = requests.id)`;
    if (r.skip_reason === "unknown_client" && !quiet) {
      await sql()`update messages set skip_reason = null where id = ${r.id}`;
      await closeNeedsHumanCard(String(r.id), `👤 Client set to ${client.name} by ${by}; processing.`);
      await enqueue("process_message", { messageId: String(r.id) });
    }
  }
  const cards = await sql()`select count(*)::int as n from tasks t join requests r on r.id = t.request_id where r.message_id in (select id from messages where channel = 'meet' and external_id like ${"meet:" + String(m.drive_file_id) + ":%"}) and t.pulp_card_id is not null`;
  // Held action items (an unclear meeting) go to the queue now.
  const pend = await sql()`select value from settings where key = ${"meet_pending:" + meetingId}`;
  let jobs = 0;
  if (pend.length) {
    const p = pend[0].value as GroupJob & { groups: Array<{ clientId: string | null; items: ActionItem[] }> };
    jobs = await queueActionGroups({ meetingId: p.meetingId, docId: p.docId, docUrl: p.docUrl, title: p.title, owner: p.owner, heldAt: p.heldAt, threadKey: p.threadKey }, p.groups.map((g) => ({ clientId: g.clientId ?? client.id, items: g.items })));
    await sql()`delete from settings where key = ${"meet_pending:" + meetingId}`;
  }
  // The headline names the client now; the tally follows; the card becomes the outcome line.
  const head = await sql()`select value from settings where key = ${"meet_head:" + meetingId}`;
  const h = (head[0]?.value as { name?: string | null; tallyName?: string | null; title?: string; who?: string; day?: string; docUrl?: string } | undefined) ?? null;
  const threadKey = `meet-${meetingId}`;
  const line = `👤 Client set to ${client.name}${oldName && oldName !== client.name ? ` (was ${oldName})` : ""} by ${by}${reason ? `: ${reason}` : ""}${jobs ? `; the action items follow below` : ""}${Number(cards[0]?.n) ? `; ${cards[0].n} card${Number(cards[0].n) > 1 ? "s" : ""} made earlier keep${Number(cards[0].n) > 1 ? "" : "s"} the old label in Pulp` : ""}.`;
  if (h) {
    await editHeadline(h.name ?? null, meetingHeadline({ title: h.title ?? String(m.title), who: client.name, day: h.day ?? "" }));
    await sql()`update settings set value = value || ${JSON.stringify({ who: client.name })}::jsonb, updated_at = now() where key = ${"meet_head:" + meetingId}`;
  }
  if (quiet) return line;
  const card = await sql()`select value from settings where key = ${"meet_client_card:" + meetingId}`;
  const cardName = (card[0]?.value as { card?: string | null } | undefined)?.card ?? null;
  if (cardName) {
    try { await gchat.updateMessageText(cardName, line); } catch (e) { console.error("meeting client card update failed", (e as Error).message); }
    await sql()`delete from settings where key = ${"meet_client_card:" + meetingId}`;
  } else if (h) {
    await postHeadline(line, threadKey);
  }
  if (!jobs) await refreshMeetingHeadline(meetingId);
  return line;
}

/**
 * The one-time repair (2026-10-05): every meeting read before this rule is looked at again with the same four facts.
 * A certain fact that names a different client re-files the meeting in the records and on its existing headline
 * (Swathi / Vishnu → The SKIN Firm); nothing is posted in the feed (Vishnu: "no feed message for the corrections").
 * A meeting whose client was only a guess is left as it is and noted in its check row (`guess: true`): asking would
 * be a feed message. Runs inside the Meet poll a dozen meetings at a time, each checked once, until none is left.
 * Nothing is deleted.
 */
export async function repairMeetingClients(budgetMs = 25_000): Promise<string | null> {
  const started = Date.now();
  const state = await sql()`select value from settings where key = 'meet_client_repair'`;
  const st = (state[0]?.value as { startedAt?: string; done?: boolean; checked?: number; corrected?: number; asked?: number } | undefined) ?? {};
  if (st.done) return null;
  if (!st.startedAt) {
    st.startedAt = new Date().toISOString(); st.checked = 0; st.corrected = 0; st.asked = 0;
    await sql()`insert into settings (key, value) values ('meet_client_repair', ${JSON.stringify(st)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }
  const save = () => sql()`update settings set value = ${JSON.stringify(st)}::jsonb, updated_at = now() where key = 'meet_client_repair'`;
  const rows = await sql()`select m.id, m.title, m.attendees, m.notes, m.client_id, m.scope, m.held_at,
      exists (select 1 from settings s where s.key = 'meet_head:' || m.id::text) as has_thread,
      exists (select 1 from meeting_items i where i.meeting_id = m.id) as has_items
    from meetings m where m.created_at < ${st.startedAt} and m.notes <> ''
      and not exists (select 1 from settings s where s.key = 'meet_client_check:' || m.id::text)
    order by m.held_at desc limit 12`;
  if (!rows.length) { st.done = true; await save(); return `client repair done: ${st.checked} meetings checked, ${st.corrected} corrected, ${st.asked} asked`; }
  const clients = await allClients();
  const internal = clients.find((c) => c.scope === "internal") ?? null;
  const people: KnownPerson[] = await knownClientPeople(clients);
  const team = await teamNames([]);
  const out: string[] = [];
  for (const m of rows) {
    if (Date.now() - started > budgetMs) break;
    const id = String(m.id);
    const stored = (m.client_id as string | null) ?? null;
    const storedClient = stored ? clients.find((c) => c.id === stored) ?? null : null;
    const attendees = Array.isArray(m.attendees) ? (m.attendees as string[]) : [];
    const certain = certainMeetingClient({ title: String(m.title), attendees, notes: String(m.notes), clients, people, team, sorterClient: storedClient });
    const short = headlineTitle(String(m.title));
    try {
      const guess = !certain && !!stored && !!m.has_thread;
      if (certain && certain.client.id !== stored) {
        await refileMeeting(id, certain.client, "the hub", certain.detail, { quiet: true });
        st.corrected = (st.corrected ?? 0) + 1;
        out.push(`${short}: ${storedClient?.name ?? "no client"} → ${certain.client.name} (${certain.detail})`);
      } else if (guess) {
        st.asked = (st.asked ?? 0) + 1; // counted as "unproven", left as it is: asking would be a feed message
        out.push(`${short}: ${storedClient!.name} is unproven, left as it is`);
      }
      st.checked = (st.checked ?? 0) + 1;
      await sql()`insert into settings (key, value) values (${"meet_client_check:" + id}, ${JSON.stringify({ at: new Date().toISOString(), was: stored, now: certain?.client.id ?? stored, how: certain?.how ?? null, guess })}::jsonb) on conflict (key) do nothing`;
    } catch (e) {
      out.push(`${short}: repair failed (${(e as Error).message.slice(0, 120)})`);
      await sql()`insert into settings (key, value) values (${"meet_client_check:" + id}, ${JSON.stringify({ at: new Date().toISOString(), error: (e as Error).message.slice(0, 200) })}::jsonb) on conflict (key) do nothing`;
    }
    await save();
  }
  return `client repair: ${out.length ? out.join("; ") : "nothing to change in this batch"}`;
}

/**
 * Who the MangoEyes team is, by name: the members of the Task Hub Drop space (the whole team is in it), plus anyone
 * in the meeting with an agency address. Handed to the sorter so "Shanur" is never mistaken for a team member: a name
 * not on this list is the client's side.
 */
export async function teamNames(attendees: string[]): Promise<string[]> {
  const names = new Set<string>();
  try {
    const { inboxSpace, memberNames } = await import("./chat-inbox");
    const space = await inboxSpace();
    if (space) for (const n of (await memberNames(space)).values()) if (n && !/task hub/i.test(n)) names.add(n);
  } catch (e) { console.error("team names unavailable", (e as Error).message); }
  const domains = (process.env.STAFF_EMAIL_DOMAINS || "mangoeyesagency.com").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  for (const e of attendees) {
    const at = e.toLowerCase().indexOf("@");
    if (at > 0 && domains.includes(e.toLowerCase().slice(at + 1))) names.add(e.slice(0, at).replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
  }
  return [...names];
}

/**
 * A decision about work that already has a card: find that card by title similarity among the client's open tasks and
 * write the decision on it. Returns the card, or null when nothing matches well enough.
 */
async function noteDecisionOnCard(clientId: string | null, text: string, meeting: string, heldAt: Date): Promise<{ title: string; link: string } | null> {
  if (!clientId || !pulp.configured()) return null;
  try {
    const hit = await sql()`select id, title, board_id, pulp_card_id, similarity(title, ${text}) as sim from tasks
      where client_id = ${clientId} and completed_at is null and pulp_card_id is not null and similarity(title, ${text}) > 0.3 order by sim desc limit 1`;
    if (!hit.length) return null;
    const day = heldAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
    await pulp.addComment(String(hit[0].pulp_card_id), `Decided in "${meeting}" (${day}): ${text}`);
    return { title: String(hit[0].title), link: pulp.cardUrl(String(hit[0].board_id ?? ""), String(hit[0].pulp_card_id)) };
  } catch (e) { console.error("decision on card failed", (e as Error).message); return null; }
}

/** The headline tally from what is recorded: tasks proposed, on existing cards, ideas, decisions, actions without a client. */
export async function tallyText(meetingId: string): Promise<string> {
  const r = (await sql()`
    select count(*) filter (where kind = 'action' and outcome = 'task')::int as tasks,
           count(*) filter (where kind = 'action' and outcome = 'on_existing_card')::int as on_card,
           count(*) filter (where kind = 'idea')::int as ideas,
           count(*) filter (where kind = 'decision')::int as decisions,
           count(*) filter (where kind = 'action' and client_id is null and outcome <> 'client')::int as unclear,
           count(*) filter (where kind = 'action' and outcome = 'pending')::int as pending,
           count(*) filter (where kind = 'action' and outcome = 'client')::int as with_client
    from meeting_items where meeting_id = ${meetingId}`)[0];
  const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
  return [
    Number(r.tasks) ? `${r.tasks} to confirm` : null, Number(r.on_card) ? `${r.on_card} on existing cards` : null,
    Number(r.ideas) ? n(Number(r.ideas), "idea") : null, Number(r.decisions) ? n(Number(r.decisions), "decision") : null,
    Number(r.with_client) ? `${r.with_client} with the client` : null,
    Number(r.unclear) ? `${r.unclear} with no clear client` : null, Number(r.pending) ? `${r.pending} still reading` : null,
  ].filter(Boolean).join(" · ") || "nothing to act on";
}

/** Rewrite the meeting's tally reply with the current counts (a meeting from before 2026-09-18 gets the reply posted now). */
export async function refreshMeetingHeadline(meetingId: string): Promise<void> {
  const r = await sql()`select value from settings where key = ${"meet_head:" + meetingId}`;
  if (!r.length) return;
  const h = r[0].value as { name: string | null; tallyName?: string | null; title?: string; who: string; day: string; docUrl: string };
  const line = meetingTallyLine(await tallyText(meetingId), h.docUrl);
  if (h.tallyName) return editHeadline(h.tallyName, line);
  if (h.tallyName === null) return; // no message to edit on this surface
  const tallyName = await postHeadline(line, `meet-${meetingId}`);
  await sql()`update settings set value = value || ${JSON.stringify({ tallyName })}::jsonb, updated_at = now() where key = ${"meet_head:" + meetingId}`;
}

/**
 * The `meet_group` queue job: one client's action items from one meeting through the normal pipeline (dedupe, Staging
 * cards, feed lines inside the meeting's thread). Re-run safe: the message is upserted, so a retry never doubles cards.
 */
export async function runMeetGroup(p: { meetingId: string; docId: string; docUrl: string; title: string; owner: string | null; heldAt: string; clientId: string | null; text: string; threadKey: string; part?: number; items?: string[] }): Promise<string> {
  const clients = await allClients();
  const client = p.clientId ? clients.find((c) => c.id === p.clientId) ?? null : null;
  // The organiser owns the meeting's to-dos: each proposal is addressed to them by name and Chat account, not to
  // "the PMs" (2026-09-29). The owner is the notes doc's owner, an email; the team record turns it into a person.
  const { teamMember, chatUserFor } = await import("./team");
  const organiser = await teamMember(p.owner);
  const senderUser = organiser ? await chatUserFor(organiser.name) : null;
  const m: Message = {
    channel: "meet", externalId: `meet:${p.docId}:${client?.id ?? "unassigned"}${p.part ? `:${p.part}` : ""}`, teamId: null, clientId: client?.id ?? null, scope: client ? client.scope : "unknown",
    sender: organiser?.name ?? p.owner ?? "meeting", senderIsStaff: true, sentAt: new Date(p.heldAt), text: `Action items from the meeting "${p.title}":\n${p.text}`, permalink: p.docUrl, threadRef: null,
    raw: { meeting: { id: p.meetingId, driveFileId: p.docId, title: p.title }, feedThreadKey: p.threadKey, senderUser },
  };
  const r = await processMessage(m, { skip: false, reason: null }, { rerun: true });
  const made = r.outcome === "review" ? (r.requestIds?.length ?? 0) : 0;
  const outcome = made ? "task" : r.outcome === "attached" ? "on_existing_card" : "noted";
  if (p.items?.length) await sql()`update meeting_items set outcome = ${outcome} where meeting_id = ${p.meetingId} and kind = 'action' and outcome = 'pending' and client_id is not distinct from ${client?.id ?? null} and text = any(${p.items}::text[])`;
  else await sql()`update meeting_items set outcome = ${outcome} where meeting_id = ${p.meetingId} and kind = 'action' and outcome = 'pending' and client_id is not distinct from ${client?.id ?? null}`;
  await refreshMeetingHeadline(p.meetingId);
  return `${client?.name ?? "unassigned"}: ${outcome}`;
}

/** Forget one meeting and read its notes doc again now (a doc read before Gemini finished, or notes edited by hand). */
export async function rereadNoteDoc(fileId: string): Promise<string> {
  // Whoever can see the doc reads it: the organiser or any attendee on the team.
  let doc: NoteDoc | null = null, lastError = "no team member can see this doc";
  for (const as of await readers()) {
    try {
      const meta = await driveAs(as).files.get({ fileId, fields: "id,name,modifiedTime,owners(emailAddress),parents", supportsAllDrives: true });
      doc = { id: fileId, name: meta.data.name ?? fileId, modifiedTime: meta.data.modifiedTime ?? new Date().toISOString(), owner: meta.data.owners?.[0]?.emailAddress ?? null, folder: null, as };
      break;
    } catch (e) { lastError = readerError(e); }
  }
  if (!doc) throw new Error(lastError);
  const old = await sql()`select id from meetings where drive_file_id = ${fileId}`;
  for (const m of old) {
    await sql()`delete from meeting_items where meeting_id = ${m.id}`;
    await sql()`delete from meetings where id = ${m.id}`;
    // The old headline goes, so the feed shows one line for the meeting, not a stale one beside the new one.
    const head = await sql()`select value from settings where key = ${"meet_head:" + m.id}`;
    const v = (head[0]?.value as { name?: string | null; tallyName?: string | null } | undefined) ?? {};
    for (const name of [v.name, v.tallyName]) {
      if (name) { try { const { deleteMessage } = await import("./gchat"); await deleteMessage(name); } catch (e) { console.error("old headline not deleted", (e as Error).message); } }
    }
    await sql()`delete from settings where key = ${"meet_head:" + m.id}`;
    await sql()`delete from queue where done_at is null and kind = 'meet_group' and payload->>'meetingId' = ${String(m.id)}`;
  }
  // Retries of this doc's action messages from the earlier attempt would double the work: the new group jobs replace them.
  await sql()`delete from queue where done_at is null and kind = 'process_message'
    and payload->>'messageId' in (select id::text from messages where channel = 'meet' and external_id like ${"meet:" + fileId + ":%"})`;
  await sql()`delete from settings where key = ${"meet_retry:" + fileId}`;
  return processNoteDoc(doc);
}

/**
 * Keep a meeting's summary, ideas and decisions but forget every card and request the hub made from it (the person
 * deletes the cards in Pulp). The actions stay on record as "noted", the headline tally is rewritten, pending jobs go.
 */
export async function forgetMeetingCards(fileId: string): Promise<string> {
  const meetings = await sql()`select id from meetings where drive_file_id = ${fileId}`;
  const msgs = await sql()`select id from messages where channel = 'meet' and external_id like ${"meet:" + fileId + ":%"}`;
  const mids = msgs.map((r) => String(r.id));
  const tasks = await sql()`select t.id from tasks t join requests r on r.id = t.request_id where r.message_id = any(${mids}::uuid[])`;
  const tids = tasks.map((r) => String(r.id));
  await sql()`delete from status_events where task_id = any(${tids}::uuid[])`;
  await sql()`delete from settings where key = any(${tids.flatMap((id) => [`sheet_stage:${id}`, `sheet_tab:${id}`])}::text[])`;
  await sql()`delete from tasks where id = any(${tids}::uuid[])`;
  await sql()`update llm_calls set message_id = null where message_id = any(${mids}::uuid[])`;
  await sql()`update requests set merged_into = null where merged_into in (select id from requests where message_id = any(${mids}::uuid[]))`;
  await sql()`delete from requests where message_id = any(${mids}::uuid[])`;
  await sql()`delete from queue where done_at is null and ((kind = 'process_message' and payload->>'messageId' = any(${mids})) or (kind = 'meet_group' and payload->>'docId' = ${fileId}))`;
  await sql()`delete from messages where id = any(${mids}::uuid[])`;
  for (const m of meetings) {
    await sql()`update meeting_items set outcome = 'noted' where meeting_id = ${m.id} and kind = 'action' and outcome in ('task', 'on_existing_card', 'pending')`;
    await refreshMeetingHeadline(String(m.id));
  }
  return `${meetings.length} meeting kept, ${tids.length} cards and ${mids.length} action messages forgotten; delete the cards in Pulp by hand`;
}

/** Meetings are read from the moment the hub first looked (settings `meet_since`), never the backlog before that. */
async function meetSince(): Promise<Date> {
  const r = await sql()`select value from settings where key = 'meet_since'`;
  if (r.length) return new Date(String(r[0].value));
  const since = new Date(Date.now() - 60 * 60 * 1000);
  await sql()`insert into settings (key, value) values ('meet_since', ${JSON.stringify(since.toISOString())}::jsonb) on conflict (key) do nothing`;
  return since;
}

export async function pollMeetings(): Promise<{ found: number; processed: string[]; errors: string[] }> {
  const processed: string[] = [], errors: string[] = [];
  const started = Date.now();
  const skipped: Array<{ as: string; why: string }> = [];
  const save = async (extra: Record<string, unknown>) => {
    try { await sql()`insert into settings (key, value) values ('meet_poll_last', ${JSON.stringify({ at: new Date().toISOString(), found: 0, processed, errors, skipped: skipped.map((x) => `${x.as}: ${x.why}`), ...extra })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`; } catch { /* ignore */ }
  };
  // A trace before any slow step, so a run that is cut short still shows where it was.
  await save({ phase: "repair" });
  // The one-time look at every meeting read before the certainty rule (2026-10-05); a no-op once done.
  try { const rep = await repairMeetingClients(); if (rep) processed.push(rep); } catch (e) { errors.push(`client repair: ${(e as Error).message.slice(0, 200)}`); }
  await save({ phase: "listing" });
  let docs: NoteDoc[] = [];
  const readerErrors: Array<{ as: string; error: string }> = [];
  try {
    const since = await meetSince();
    docs = (await findNoteDocs(3, { errors: readerErrors, skipped })).filter((d) => new Date(d.modifiedTime) > since);
    // A person the hub could not read as shows on health and in the brief, even when the others were fine. An address
    // that is no Google account is listed under `skipped`, not as an issue.
    for (const r of readerErrors) errors.push(`as ${r.as}: ${r.error}`);
  } catch (e) {
    // A failed Drive query must show on health and in the brief, not vanish.
    errors.push(`drive: ${(e as Error).message.slice(0, 200)}`);
    await save({ phase: "failed" });
    return { found: 0, processed, errors };
  }
  const known = new Set((await sql()`select drive_file_id from meetings where drive_file_id = any(${docs.map((d) => d.id)}::text[])`).map((r) => String(r.drive_file_id)));
  const todo = docs.filter((d) => !known.has(d.id));
  await save({ found: docs.length, phase: "reading", todo: todo.map((d) => d.name.slice(0, 50)) });
  let done = 0;
  for (const doc of todo) {
    // One meeting can take a minute (model call, feed posts); stop while there is still budget and finish next time.
    // A second meeting starts only with most of the budget left: one can take a minute, and a run cut short records nothing.
    if (done >= 2 || Date.now() - started > 40_000) { processed.push(`${todo.length - done} left for the next run`); break; }
    // A doc that was started three times and never finished (a run cut short each time) is set aside with a note, so it
    // can never block the meetings behind it. It can still be read by hand with ?reread=.
    const attemptKey = `meet_attempt:${doc.id}`;
    const prior = Number((await sql()`select value from settings where key = ${attemptKey}`)[0]?.value ?? 0);
    if (prior >= 3) {
      await sql()`insert into meetings (drive_file_id, title, held_at, organiser, attendees, client_id, scope, doc_url, notes, summary)
        values (${doc.id}, ${meetingTitle(doc.name)}, ${doc.modifiedTime}, ${doc.owner}, '{}', null, 'unknown', ${"https://docs.google.com/document/d/" + doc.id + "/edit"}, '', ${JSON.stringify(["Could not be read: three attempts ran out of time. Ask for a re-read."])}::jsonb) on conflict (drive_file_id) do nothing`;
      await sql()`delete from settings where key = ${attemptKey}`;
      processed.push(`${doc.name.slice(0, 40)}: set aside after 3 cut-short attempts`);
      errors.push(`${doc.name.slice(0, 40)}: could not be read in time, set aside (reread to retry)`);
      continue;
    }
    await sql()`insert into settings (key, value) values (${attemptKey}, ${JSON.stringify(prior + 1)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
    await save({ found: docs.length, phase: "reading", current: doc.name.slice(0, 50), attempt: prior + 1 });
    const t0 = Date.now();
    try {
      processed.push(`${await processNoteDoc(doc)} (${Math.round((Date.now() - t0) / 1000)} s)`); done++;
      await sql()`delete from settings where key = ${attemptKey}`;
    }
    catch (e) {
      const msg = (e as Error).message;
      if (/File not found|"code":\s*404/.test(msg)) {
        // Deleted, or a shortcut to a doc the hub cannot open: remember it so it is not tried every five minutes.
        await sql()`insert into meetings (drive_file_id, title, held_at, organiser, attendees, client_id, scope, doc_url, notes, summary)
          values (${doc.id}, ${doc.name}, ${doc.modifiedTime}, null, '{}', null, 'unknown', null, '', 'not readable: deleted or a dead shortcut') on conflict (drive_file_id) do nothing`;
        processed.push(`${doc.name.slice(0, 40)}: not readable, skipped`);
        continue;
      }
      errors.push(`${doc.name.slice(0, 40)}: ${msg.slice(0, 160)}`);
    }
    await save({ found: docs.length, phase: "reading" });
  }
  await save({ found: docs.length, phase: "done", seconds: Math.round((Date.now() - started) / 1000) });
  return { found: docs.length, processed, errors };
}
