import { sql, allClients } from "./db";
import * as gchat from "./gchat";
import { rememberThread, postText } from "./review";
import { teamParts, whenLabel } from "./when";
import type { Message } from "./types";

/**
 * Ideas wait for a decision, not for someone to remember them (Arun, 2026-09-22). Every Monday at 10:00 India the feed
 * gets one line addressed to the PMs and, in its thread, one card per open idea with two buttons: Make it a task
 * (the normal proposal follows in the same thread) or Not now. An idea nobody decides on comes back the next Monday,
 * with its age on it, until someone decides.
 */

export interface OpenIdea { id: string; clientId: string | null; client: string; text: string; saidBy: string | null; source: string | null; sourceLink: string | null; saidAt: Date }

export async function openIdeas(): Promise<OpenIdea[]> {
  const rows = await sql()`select i.id, i.client_id, coalesce(c.name, 'MangoEyes') as client, i.text, i.said_by, i.source, i.source_link, i.said_at
    from ideas i left join clients c on c.id = i.client_id where i.decided_at is null order by c.name nulls last, i.said_at`;
  return rows.map((r) => ({ id: String(r.id), clientId: (r.client_id as string | null) ?? null, client: String(r.client), text: String(r.text), saidBy: (r.said_by as string | null) ?? null, source: (r.source as string | null) ?? null, sourceLink: (r.source_link as string | null) ?? null, saidAt: new Date(String(r.said_at)) }));
}

/** The Monday line: to the PMs, what is waiting, what to do. Nothing clipped. */
export function ideasHeadline(ideas: OpenIdea[], now = new Date()): string {
  const older = ideas.filter((i) => now.getTime() - i.saidAt.getTime() > 7 * 86_400_000).length;
  const n = ideas.length;
  const byClient = new Map<string, number>();
  for (const i of ideas) byClient.set(i.client, (byClient.get(i.client) ?? 0) + 1);
  const per = [...byClient.entries()].map(([c, k]) => `${c} ${k}`).join(" · ");
  const lead = older ? `${n} idea${n === 1 ? "" : "s"} waiting, ${older} from earlier weeks` : `${n} idea${n === 1 ? "" : "s"} from last week`;
  return `💡 PMs: ${lead}. Decide which become tasks. · ${per}`;
}

/** Cards in one Monday post. Chat allows about one message a second in a space; the post must fit well inside that. */
export const IDEA_CARDS_MAX = 25;
/** An idea older than this is kept on record but no longer comes back as a card. */
export const IDEA_FRESH_DAYS = 28;

/**
 * Pure: which ideas get a card this Monday. The newest first, from the last four weeks, at most 25; the rest stay on
 * record. Until 2026-11-13 every undecided idea ever raised got a card every time: past sixty, Chat refused the rest
 * ("Quota limit exceeded"), the run failed, nothing was recorded, and it tried again every weekday morning.
 */
export function pickIdeaCards(ideas: OpenIdea[], now = new Date(), max = IDEA_CARDS_MAX): { cards: OpenIdea[]; rest: OpenIdea[] } {
  const fresh = ideas.filter((i) => now.getTime() - i.saidAt.getTime() <= IDEA_FRESH_DAYS * 86_400_000).sort((a, b) => b.saidAt.getTime() - a.saidAt.getTime());
  const chosen = new Set(fresh.slice(0, max).map((i) => i.id));
  // Cards keep the reading order of the full list (by client, then by day).
  return { cards: ideas.filter((i) => chosen.has(i.id)), rest: ideas.filter((i) => !chosen.has(i.id)) };
}

/** Pure: the closing line for the ideas that got no card: who it is for and what to do. */
export function restLine(rest: OpenIdea[]): string | null {
  if (!rest.length) return null;
  const byClient = new Map<string, number>();
  for (const i of rest) byClient.set(i.client, (byClient.get(i.client) ?? 0) + 1);
  const per = [...byClient.entries()].sort((a, b) => b[1] - a[1]).map(([c, k]) => `${c} ${k}`).join(" · ");
  return `PMs: ${rest.length} older idea${rest.length === 1 ? " is" : "s are"} kept on record and not shown as cards again (${per}). Nothing to do for them. If one matters now, send it to the Drop as a task.`;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function postMondayIdeas(now = new Date()): Promise<{ posted: number; threadKey: string | null; kept?: number; error?: string }> {
  const ideas = await openIdeas();
  if (!ideas.length) return { posted: 0, threadKey: null };
  const { cards, rest } = pickIdeaCards(ideas, now);
  const p = teamParts(now);
  const day = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const threadKey = `ideas-${day}`;
  if (!cards.length) return { posted: 0, threadKey: null, kept: rest.length };
  await postText(ideasHeadline(cards, now), { threadKey });
  if (!gchat.gchatConfigured()) return { posted: cards.length, threadKey, kept: rest.length };
  // Once the headline is up the post counts as made: a card that fails stops the run and is reported, and the
  // caller records the day, so a failure can never repeat the whole post every morning.
  let posted = 0, error: string | undefined;
  for (const i of cards) {
    try {
      const weeks = Math.floor((now.getTime() - i.saidAt.getTime()) / (7 * 86_400_000));
      const card = gchat.ideaCard({ ideaId: i.id, threadKey, clientName: i.client, text: i.text, saidBy: i.saidBy, source: i.source, sourceLink: i.sourceLink, since: whenLabel(i.saidAt), weeks });
      const sent = await gchat.sendCard(gchat.reviewSpace(), card, `${i.client}: ${i.text}`, `idea-${i.id}-${day}`, threadKey);
      await sql()`update ideas set card_name = ${sent.name} where id = ${i.id}`;
      await rememberThread(sent.thread, { kind: "ideas", day });
      posted++;
      await pause(300);
    } catch (e) { error = `stopped after ${posted} of ${cards.length} cards: ${(e as Error).message.slice(0, 160)}`; break; }
  }
  const tail = restLine(rest);
  if (tail && !error) { try { await postText(tail, { threadKey }); } catch (e) { error = `closing line: ${(e as Error).message.slice(0, 160)}`; } }
  return { posted, threadKey, kept: rest.length, ...(error ? { error } : {}) };
}

/** The tap on an idea card. Returns the line that replaces the card. */
export async function decideIdea(ideaId: string, decision: "task" | "not_now", who: string, whoUser: string | null, threadKey: string | null): Promise<string> {
  const r = (await sql()`select id, client_id, text, decided_at from ideas where id = ${ideaId}`)[0];
  if (!r) return "That idea no longer exists.";
  if (r.decided_at) return "Already decided.";
  if (decision === "not_now") {
    await sql()`update ideas set decided_at = now(), decision = 'not_now', decided_by = ${who} where id = ${ideaId}`;
    return `— Not now · ${who} · "${String(r.text)}"`;
  }
  const clients = await allClients();
  const client = clients.find((c) => c.id === r.client_id) ?? null;
  const m: Message = {
    channel: "task_cmd", externalId: `idea:${ideaId}:${Date.now()}`, teamId: null, clientId: client?.id ?? null, scope: client ? client.scope : "internal",
    sender: who, senderIsStaff: true, sentAt: new Date(), text: String(r.text), permalink: null, threadRef: null,
    raw: { idea: ideaId, senderUser: whoUser, ...(threadKey ? { feedThreadKey: threadKey } : {}) },
  };
  const { processMessage } = await import("./pipeline");
  const res = await processMessage(m, { skip: false, reason: null });
  await sql()`update ideas set decided_at = now(), decision = 'task', decided_by = ${who}, request_id = ${res.requestIds?.[0] ?? null} where id = ${ideaId}`;
  return res.requestIds?.length ? `✅ Made a task by ${who} · "${String(r.text)}" · confirm the card below` : `✅ ${who} said make it a task, but the hub read it as information: "${String(r.text)}". Add what should be done in the Drop and it will propose the card.`;
}
