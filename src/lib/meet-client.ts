import { sql } from "./db";
import { resolveClientFromText } from "./resolve";
import type { Client } from "./types";

/**
 * Which client a meeting is for: set only with certainty, never from a guess (Vishnu, 2026-10-05).
 *
 * Until 2026-10-05 a meeting whose title and attendees named no client took the sorter's own answer as the client,
 * so "Swathi / Vishnu" (The SKIN Firm's Swathi and Dr Naren giving notice) was filed under HC MedSpa: the meeting,
 * its decisions and its idea all went into HC MedSpa's record. Now a meeting's client comes from one of four facts,
 * and from nothing else:
 *   1. a client's name or alias in the call's title;
 *   2. a client's email domain, or a known client person's address, among the people the notes are shared with;
 *   3. a client person the hub already knows (from the client's Slack workspace, or as the sender of a client's
 *      Slack messages) named in the title, in the "Invited" line, or as a speaker in the transcript;
 *   4. an internal call: only team members spoke and the sorter calls it MangoEyes' own business.
 * Anything else is "client unclear": the meeting is stored with no client, a "which client?" card with the sorter's
 * guess goes into the meeting's thread, the action items wait, and one tap files everything under the chosen client.
 */

export interface KnownPerson { name: string; email: string | null; client: Client }
export type Certainty = { client: Client; how: "title" | "attendee" | "person" | "speakers"; detail: string };

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const tokens = (s: string) => norm(s).split(" ").filter(Boolean);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWord = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}(?=$|[^\\p{L}\\p{N}])`, "iu");

/**
 * The client people the hub knows: every non-staff member of a client's Slack workspace (cached by `slackUser`) and
 * every non-staff sender of a client's Slack messages. Names as Slack shows them ("Swathi TSF", "Dr Naren").
 */
export async function knownClientPeople(clients: Client[]): Promise<KnownPerson[]> {
  const byTeam = new Map(clients.filter((c) => c.slackTeamId && c.scope === "client").map((c) => [c.slackTeamId as string, c]));
  const out: KnownPerson[] = [];
  const seen = new Set<string>();
  const add = (name: string | null | undefined, email: string | null | undefined, client: Client) => {
    const n = (name ?? "").trim();
    if (!n) return;
    const k = `${client.id}|${n.toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ name: n, email: email?.toLowerCase() ?? null, client });
  };
  try {
    const rows = await sql()`select key, value from settings where key like 'slack_user:%'`;
    for (const r of rows) {
      const c = byTeam.get(String(r.key).split(":")[1] ?? "");
      if (!c) continue;
      const v = r.value as { name?: string | null; email?: string | null; isStaff?: boolean; isBot?: boolean };
      if (v.isStaff || v.isBot) continue;
      add(v.name, v.email, c);
    }
  } catch (e) { console.error("known people (Slack users) unavailable", (e as Error).message); }
  try {
    const rows = await sql()`select distinct sender, client_id from messages where channel = 'slack' and not sender_is_staff and client_id is not null and sender is not null`;
    for (const r of rows) {
      const c = clients.find((x) => x.id === String(r.client_id) && x.scope === "client");
      if (c) add(String(r.sender), null, c);
    }
  } catch (e) { console.error("known people (senders) unavailable", (e as Error).message); }
  return out;
}

/** Slack display names that are a desk, not a person: they can never place a meeting. */
const GENERIC_NAMES = new Set(["reception", "clinic", "admin", "team", "info", "front", "desk", "marketing", "office", "support", "hello", "contact", "bookings", "booking", "enquiries", "sales", "accounts", "manager", "director", "owner", "client", "guest", "user", "test"]);
const NOT_A_SPEAKER = new Set(["summary", "decisions", "details", "tip", "attachments", "invited", "note", "notes", "meeting records", "next steps", "aligned", "transcript", "warning", "important", "action items", "action", "quick notes", "full notes"]);
const SPEAKER_LINE = /^([\p{Lu}][\p{L}'.-]*(?: [\p{Lu}][\p{L}'.-]*){0,4}): \S/u;

/** Who spoke, from Gemini's transcript lines ("Vishnu Swaroop Lal: Yeah."); a name that speaks once is kept, headings are not. */
export function speakerNames(notes: string): string[] {
  const counts = new Map<string, number>();
  for (const line of notes.split("\n")) {
    const m = line.match(SPEAKER_LINE);
    if (!m) continue;
    const name = m[1].trim();
    if (NOT_A_SPEAKER.has(name.toLowerCase()) || name.length < 3) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

/** Gemini's header: the title, the date and the "Invited …" line sit in the first lines of the notes. */
export function invitedLine(notes: string): string {
  const head = notes.slice(0, 2500);
  const m = head.match(/^\s*(?:Invited|Attendees?|Participants?)\s+(.+)$/im);
  return m ? m[1] : "";
}

/** Does a person's name appear in the text: the full name as a phrase, or a first name of four letters or more as a word. */
export function nameAppears(name: string, text: string, firstNameOk: boolean): "full" | "first" | null {
  const t = norm(text);
  const toks = tokens(name).filter((x) => !/^(dr|mr|mrs|ms|miss|prof)$/.test(x));
  if (!toks.length) return null;
  if (toks.length >= 2 && wholeWord(toks.join(" ")).test(t)) return "full";
  const first = toks[0];
  if (firstNameOk && first.length >= 4 && wholeWord(first).test(t)) return "first";
  return null;
}

/** Is this speaker on the team: the same name, or the same first name as a team member. */
export function isTeamName(name: string, team: string[]): boolean {
  const toks = tokens(name);
  if (!toks.length) return false;
  return team.some((m) => {
    const mt = tokens(m);
    return mt.length > 0 && (mt.join(" ") === toks.join(" ") || (mt[0] === toks[0] && toks[0].length >= 3));
  });
}

/**
 * The meeting's client, or null when the hub cannot be sure. `sorterClient` is the sorter's own answer: it is never
 * taken as the client, but it confirms an internal call when nobody from outside spoke.
 */
export function certainMeetingClient(o: { title: string; attendees: string[]; notes: string; clients: Client[]; people: KnownPerson[]; team: string[]; sorterClient?: Client | null }): Certainty | null {
  const internal = o.clients.find((c) => c.scope === "internal") ?? null;

  // 1. The call's own name says it ("HC MedSpa / Rabbia — Monday catch-up", "Strategy Call Prep: Leicester Medispa").
  const byTitle = resolveClientFromText(o.title, o.clients);
  if (byTitle && (byTitle.how === "name" || byTitle.how === "prefix")) return { client: byTitle.client, how: "title", detail: `${byTitle.client.name} is named in the call's title` };
  if (internal && /(^|[^\p{L}])(internal|team)(?=$|[^\p{L}])/iu.test(o.title)) return { client: internal, how: "title", detail: "the call's title says internal" };

  // 2. Someone the notes are shared with writes from the client's domain, or is a client person the hub knows.
  for (const e of o.attendees) {
    const hit = resolveClientFromText(e, o.clients);
    if (hit?.how === "email_domain") return { client: hit.client, how: "attendee", detail: `${e} is ${hit.client.name}'s address` };
    const p = o.people.find((x) => x.email && x.email === e.toLowerCase());
    if (p) return { client: p.client, how: "attendee", detail: `${p.name} (${e}) is ${p.client.name}'s` };
  }

  // 3. A client person the hub knows is in the title, the invited line, or spoke. A first name counts only when it is
  //    nobody else's: not a team member's, not another client's person's.
  const speakers = speakerNames(o.notes);
  const where = [o.title, invitedLine(o.notes), ...speakers].join("\n");
  // A Slack name is the person's words only: "Swathi TSF" is Swathi, "Dr Naren" is Naren, "Reception" is nobody.
  const clientWords = new Set(o.clients.flatMap((c) => [c.name, ...(c.aliases ?? [])].flatMap(tokens)));
  const personWords = (name: string) => tokens(name).filter((x) => !GENERIC_NAMES.has(x) && !clientWords.has(x) && !/^(dr|mr|mrs|ms|miss|prof)$/.test(x));
  const firstOwners = new Map<string, Set<string>>();
  for (const p of o.people) {
    const first = personWords(p.name)[0];
    if (!first) continue;
    if (!firstOwners.has(first)) firstOwners.set(first, new Set());
    firstOwners.get(first)!.add(p.client.id);
  }
  const matched = new Map<string, { client: Client; who: string }>();
  for (const p of o.people) {
    if (isTeamName(p.name, o.team)) continue; // a team member seen in a client's workspace is not that client's person
    const words = personWords(p.name);
    if (!words.length) continue;
    const first = words[0];
    const firstOk = (firstOwners.get(first)?.size ?? 0) === 1 && !o.team.some((m) => tokens(m)[0] === first);
    const hit = nameAppears(words.join(" "), where, firstOk);
    if (hit && !matched.has(p.client.id)) matched.set(p.client.id, { client: p.client, who: p.name });
  }
  if (matched.size === 1) {
    const [{ client, who }] = [...matched.values()];
    return { client, how: "person", detail: `${who} is ${client.name}'s` };
  }
  if (matched.size > 1) return null; // people of two clients named: a person decides

  // 4. Internal: only the team spoke, and the sorter calls it the agency's own business.
  if (internal && o.sorterClient?.scope === "internal" && speakers.length > 0 && speakers.every((s) => isTeamName(s, o.team))) {
    return { client: internal, how: "speakers", detail: "only the team spoke" };
  }
  return null;
}
