import { sql } from "./db";
import { pulp } from "./pulp";
import { boards as boardsConfig } from "./config";

/**
 * Who is on the MangoEyes team, and how to reach them in Chat. Names and emails come from the Pulp boards (every team
 * member is on at least one); the Chat account (users/<id>, needed for an @mention that notifies) comes from the
 * messages that person has sent in the Drop space or the DM. No table to maintain: the record fills itself.
 * 2026-09-29: lets a meeting's to-dos be addressed to the organiser by name, and a Slack proposal to the team member
 * the client tagged, instead of "the PMs".
 */

export interface TeamMember { name: string; email: string | null }

let _cache: { at: number; people: TeamMember[] } | null = null;

/** Everyone on the department boards: name and email, cached ten minutes. */
export async function teamMembers(): Promise<TeamMember[]> {
  if (_cache && Date.now() - _cache.at < 10 * 60_000) return _cache.people;
  const byName = new Map<string, TeamMember>();
  if (pulp.configured()) {
    for (const [dep, d] of Object.entries(boardsConfig().departments)) {
      if (dep === "scope") continue;
      try {
        const id = await pulp.resolveBoardId(d.board);
        if (!id) continue;
        for (const m of await pulp.membersOnBoard(id)) if (m.name && !byName.has(m.name)) byName.set(m.name, { name: m.name, email: m.email || null });
      } catch { /* a board that cannot be read leaves its members out this time */ }
    }
  }
  _cache = { at: Date.now(), people: [...byName.values()] };
  return _cache.people;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** "Heena", "@Heena Ganotra", "heena@mangoeyesagency.com" → the team member, loosely: exact, then first name. */
export async function teamMember(ref: string | null | undefined): Promise<TeamMember | null> {
  if (!ref) return null;
  const r = norm(ref.replace(/^@/, ""));
  if (!r) return null;
  const people = await teamMembers();
  const byEmail = people.find((p) => p.email && p.email.toLowerCase() === ref.trim().toLowerCase());
  if (byEmail) return byEmail;
  const local = ref.includes("@") ? norm(ref.split("@")[0]) : r;
  return people.find((p) => norm(p.name) === local)
    ?? people.find((p) => norm(p.name).startsWith(local) || local.startsWith(norm(p.name).split(" ")[0]))
    ?? null;
}

/** The Chat account (users/<id>) of a team member, from a message they sent the hub; null until they have sent one. */
export async function chatUserFor(name: string | null | undefined): Promise<string | null> {
  if (!name) return null;
  const first = norm(name).split(" ")[0];
  if (!first) return null;
  const rows = await sql()`select sender_user from messages where channel = 'intake' and sender_user like 'users/%' and lower(sender) like ${first + "%"} order by created_at desc limit 1`;
  return rows.length ? String(rows[0].sender_user) : null;
}

/** The first team member a message @mentions ("@Anuj Laddha …" in a client's Slack message), if any. */
export async function taggedTeamMember(m: { channel: string; senderIsStaff: boolean; raw: unknown; text: string }): Promise<TeamMember | null> {
  if (m.senderIsStaff) return null;
  const raw = (m.raw as { mentions?: string[] } | null) ?? null;
  const names = Array.isArray(raw?.mentions) ? raw!.mentions! : Array.from(m.text.matchAll(/@([\p{L}][\p{L}' -]{1,40})/gu), (x) => x[1].trim());
  for (const n of names) { const p = await teamMember(n); if (p) return p; }
  return null;
}
