import { sql, allClients, enqueue } from "./db";
import { pulp } from "./pulp";
import { judgeMatches, type AskForMatch, type CardForMatch } from "./llm/match";

/**
 * A card made outside the feed closes its waiting ask (Arun, 2026-11-12).
 *
 * The hub proposes a task in the feed and waits for a tap. People also make the card straight in Pulp, by hand or with
 * another tool. Until now the hub mirrored that card and gave it its row, but never connected it to the ask: the ask
 * stayed "waiting for a tap", stood in the 10:00 post, the repeat line said "no card yet", and a later tap made a
 * second card. This module connects the two.
 *
 * Cost is the design rule. Nothing here runs on a schedule and nothing opens Postgres on its own:
 *   - a new hand-made card is looked at only on the board read's changed path (it has just written that card), and
 *     only when its client has an ask waiting;
 *   - a new ask is looked at only while its message is being stored, and only when its client has a hand-made card
 *     from the last few days;
 *   - words that already prove the match (the ask's link or id on the card, an identical title) need no model;
 *   - everything else is one small call on the cheapest current model, capped per day.
 * Certain: the hub closes the ask itself and says so in the thread, with a button that undoes it. Likely: one
 * question in the thread, two buttons, and the hub never decides alone. Otherwise nothing changes.
 */

export const MADE_IN_PULP = "system:made_in_pulp";
/** Model calls a day on the live path. Past it only the free checks run that day. `MATCH_DAILY_CAP` in Vercel changes it; 0 switches the model part off. */
export const MATCH_DAILY_CAP = 40;
export const matchDailyCap = (): number => { const n = Number(process.env.MATCH_DAILY_CAP); return process.env.MATCH_DAILY_CAP && Number.isFinite(n) && n >= 0 ? Math.floor(n) : MATCH_DAILY_CAP; };
/** Model calls the one-time catch-up may make in total. */
export const CATCHUP_CALL_CAP = 300;
export const ASK_WINDOW_DAYS = 14;
/** A card made up to this long before the ask can be its card (made right after the call, before the notes were read). */
export const CARD_DAYS_BEFORE_ASK = 3;
/** A card first seen by the board read this long after it was made is not a "new" card (a capped board surfacing an old one). */
export const NEW_CARD_DAYS = 7;
/** The catch-up reaches back to the day proposals began. */
export const CATCHUP_SINCE = "2026-09-22T00:00:00Z";
const ARCHIVED = "Archived or deleted in Pulp";
const DAY = 86_400_000;

export interface Ask {
  id: string; status: string; title: string; words: string; createdAt: Date; /** created_at as Postgres prints it, for a cursor that loses no microseconds */ createdTxt: string; messageId: string; permalink: string | null;
  cardName: string | null; threadKey: string; askedName: string | null; askedUser: string | null; notSame: string[]; pending: boolean;
}
export interface Card {
  taskId: string; cardId: string; boardId: string; listId: string | null; title: string; assignee: string | null; labels: string[]; createdAt: Date; description: string;
}

// ---- pure ----

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Pure: may this card be this ask's card at all? Not one a person already said is different, and made no earlier than a few days before the ask. */
export function pairAllowed(ask: Pick<Ask, "createdAt" | "notSame">, card: Pick<Card, "cardId" | "createdAt">): boolean {
  if (ask.notSame.includes(card.cardId)) return false;
  return card.createdAt.getTime() >= ask.createdAt.getTime() - CARD_DAYS_BEFORE_ASK * DAY;
}

/** Pure: proof that needs no model. The card carries the ask's id or its source link, or the two titles are the same words. */
export function sureWithoutModel(ask: Pick<Ask, "id" | "title" | "permalink">, card: Pick<Card, "title" | "description">): "link" | "title" | null {
  const d = card.description ?? "";
  if (d.includes(ask.id) || (ask.permalink && ask.permalink.length > 20 && d.includes(ask.permalink))) return "link";
  const a = norm(ask.title), c = norm(card.title);
  return a.length >= 12 && a === c ? "title" : null;
}

/** Pure: who a line is for. */
export const whoTag = (a: Pick<Ask, "askedName" | "askedUser">) => a.askedUser && /^users\/\d+$/.test(a.askedUser) ? `<${a.askedUser}>` : a.askedName ? `@${a.askedName}` : "PMs";

const cardWords = (c: { title: string; listName: string; assignee: string | null; link: string }) =>
  `"${c.title}" · ${c.listName || "on the board"} · ${c.assignee ?? "nobody assigned yet"}${c.link ? ` · <${c.link}|open the card>` : ""}`;

/** Pure: the line that replaces the proposal card when the hub closed the ask itself. */
export function closedLine(p: { who: string; askTitle: string; card: { title: string; listName: string; assignee: string | null; link: string } }): string {
  return `✅ ${p.who}: nothing to do here. "${p.askTitle}" already has a card in Pulp, made outside the feed: ${cardWords(p.card)}\nNot the same task? Tap the button and the ask comes back.`;
}

/** Pure: the line when a person confirmed it. */
export function confirmedLine(p: { by: string; askTitle: string; card: { title: string; listName: string; assignee: string | null; link: string } }): string {
  return `✅ Already in Pulp · confirmed by ${p.by} · "${p.askTitle}" is this card: ${cardWords(p.card)}`;
}

/** Pure: the question when the hub is not certain. */
export function questionText(p: { who: string; askTitle: string }): string {
  return `${p.who}: is this card in Pulp the same task as "${p.askTitle}"? Tap one button.`;
}

/** Pure: the cards a group of asks could belong to, nearest in time first, at most `cap`. */
export function cardsNear<C extends Pick<Card, "createdAt">>(asks: Array<Pick<Ask, "createdAt">>, cards: C[], cap: number, daysAfter = 10): C[] {
  if (!asks.length) return [];
  const first = Math.min(...asks.map((a) => a.createdAt.getTime())), last = Math.max(...asks.map((a) => a.createdAt.getTime()));
  const mid = (first + last) / 2;
  return cards
    .filter((c) => c.createdAt.getTime() >= first - CARD_DAYS_BEFORE_ASK * DAY && c.createdAt.getTime() <= last + daysAfter * DAY)
    .sort((a, b) => Math.abs(a.createdAt.getTime() - mid) - Math.abs(b.createdAt.getTime() - mid))
    .slice(0, cap);
}

// ---- reads ----

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

async function asksFor(clientId: string, opts: { ids?: string[]; statuses: string[]; since: string; after?: { at: string; id: string } | null; limit: number }): Promise<Ask[]> {
  const rows = await sql()`
    select r.id, r.status, r.draft->>'title' as title, coalesce(r.quote, r.summary, '') as words, r.created_at, r.created_at::text as created_txt, r.message_id, m.permalink,
           r.proposal->>'cardName' as card_name, coalesce(m.raw->>'feedThreadKey', 'msg-' || m.id::text) as thread_key,
           r.proposal->>'askedName' as asked_name, r.asked_user, coalesce(r.proposal->'notSame', '[]'::jsonb) as not_same, (r.proposal->'matchAsk') is not null as pending
    from requests r join messages m on m.id = r.message_id
    where r.client_id = ${clientId} and r.kind = 'task' and r.status = any(${opts.statuses}::text[]) and r.created_at >= ${opts.since}::timestamptz
      and (${opts.ids ?? null}::uuid[] is null or r.id = any(${opts.ids ?? null}::uuid[]))
      and (${opts.after?.at ?? null}::text is null or r.created_at > ${opts.after?.at ?? null}::timestamptz or (r.created_at = ${opts.after?.at ?? null}::timestamptz and r.id > ${opts.after?.id ?? null}::uuid))
    order by r.created_at, r.id limit ${opts.limit}`;
  return rows.map((r) => ({
    id: String(r.id), status: String(r.status), title: String(r.title ?? ""), words: String(r.words ?? ""), createdAt: new Date(String(r.created_at)), createdTxt: String(r.created_txt),
    messageId: String(r.message_id), permalink: (r.permalink as string | null) ?? null, cardName: (r.card_name as string | null) ?? null, threadKey: String(r.thread_key),
    askedName: (r.asked_name as string | null) ?? null, askedUser: (r.asked_user as string | null) ?? null,
    notSame: Array.isArray(r.not_same) ? (r.not_same as unknown[]).map(String) : [], pending: !!r.pending,
  }));
}

/** Cards the team made themselves (never the hub's own), not yet tied to any ask, not archived. */
async function handMadeCards(clientId: string, opts: { cardIds?: string[]; since: Date; until?: Date; limit: number }): Promise<Card[]> {
  const rows = await sql()`
    select t.id, t.pulp_card_id, t.board_id, t.list_id, t.title, t.assignee, t.labels, t.created_at from tasks t
    where t.client_id = ${clientId} and t.origin <> 'hub' and t.request_id is null and t.pulp_card_id is not null and t.board_id is not null
      and t.notes is distinct from ${ARCHIVED} and t.created_at >= ${opts.since.toISOString()}::timestamptz
      and (${opts.until?.toISOString() ?? null}::timestamptz is null or t.created_at <= ${opts.until?.toISOString() ?? null}::timestamptz)
      and (${opts.cardIds ?? null}::text[] is null or t.pulp_card_id = any(${opts.cardIds ?? null}::text[]))
    order by t.created_at desc limit ${opts.limit}`;
  return rows.map((t) => ({
    taskId: String(t.id), cardId: String(t.pulp_card_id), boardId: String(t.board_id), listId: (t.list_id as string | null) ?? null, title: String(t.title),
    assignee: (t.assignee as string | null) ?? null, labels: Array.isArray(t.labels) ? (t.labels as unknown[]).map(String) : [], createdAt: new Date(String(t.created_at)), description: "",
  }));
}

const listNames = new Map<string, Map<string, string>>();
async function listName(card: Pick<Card, "boardId" | "listId">): Promise<string> {
  if (!card.listId || !pulp.configured()) return "";
  if (!listNames.has(card.boardId)) {
    try { listNames.set(card.boardId, new Map((await pulp.listsOnBoard(card.boardId)).map((l) => [l.id, l.name]))); }
    catch { return ""; }
  }
  return listNames.get(card.boardId)?.get(card.listId) ?? "";
}

const linkOf = (c: Pick<Card, "boardId" | "cardId">) => pulp.cardUrl(c.boardId, c.cardId);
async function cardFacts(c: Card) { return { title: c.title, listName: await listName(c), assignee: c.assignee, link: linkOf(c) }; }

async function callsToday(): Promise<number> {
  const r = await sql()`select count(*)::int as n from llm_calls where step = 'match' and created_at > now() - interval '1 day'`;
  return Number(r[0]?.n ?? 0);
}

// ---- writes ----

/**
 * Tie the card to the ask and close the ask. Returns false when the ask was decided meanwhile (a tap, a typed word).
 * `feed`: replace the proposal card in its thread with the outcome; off for an ask that had already expired.
 */
export async function closeAsk(ask: Ask, card: Card, opts: { by: string; how: "link" | "title" | "model" | "person"; feed: boolean; line?: string }): Promise<boolean> {
  const facts = await cardFacts(card);
  const record = { madeInPulp: { taskId: card.taskId, cardId: card.cardId, boardId: card.boardId, title: card.title, link: facts.link, how: opts.how, was: ask.status } };
  // The card first: a card that was tied to another ask a moment ago must not close this one.
  const tie = await sql()`update tasks set request_id = ${ask.id} where id = ${card.taskId} and request_id is null returning id`;
  if (!tie.length) return false;
  const upd = await sql()`update requests set status = 'created', decided_by = ${opts.by}, decided_at = now(),
      proposal = (coalesce(proposal, '{}'::jsonb) - 'matchAsk' - 'maybeCard') || ${JSON.stringify(record)}::jsonb
    where id = ${ask.id} and status in ('proposed', 'expired') returning id`;
  if (!upd.length) { await sql()`update tasks set request_id = null where id = ${card.taskId} and request_id = ${ask.id}`; return false; }
  if (!opts.feed || ask.status !== "proposed") return true;
  const bySystem = opts.by === MADE_IN_PULP;
  const text = opts.line ?? (bySystem ? closedLine({ who: whoTag(ask), askTitle: ask.title, card: facts }) : confirmedLine({ by: opts.by, askTitle: ask.title, card: facts }));
  try {
    const gchat = await import("./gchat");
    if (!gchat.gchatConfigured()) { const { postText } = await import("./review"); await postText(text, { threadKey: ask.threadKey }); return true; }
    const undo = bySystem ? gchat.matchUndoCard({ requestId: ask.id }) : null;
    if (ask.cardName) await gchat.updateMessageCard(ask.cardName, text, undo, `matchundo-${ask.id}`);
    else if (undo) await gchat.sendCard(gchat.reviewSpace(), undo, text, `matchundo-${ask.id}`, ask.threadKey);
    else { const { postText } = await import("./review"); await postText(text, { threadKey: ask.threadKey }); }
  } catch (e) { console.error("match: closed line failed", (e as Error).message); }
  return true;
}

/** Not certain: one question in the ask's thread, two buttons. One open question per ask. */
async function askPerson(ask: Ask, card: Card): Promise<boolean> {
  if (ask.pending || ask.status !== "proposed") return false;
  const facts = await cardFacts(card);
  const gchat = await import("./gchat");
  const text = questionText({ who: whoTag(ask), askTitle: ask.title });
  let message: string | null = null;
  if (gchat.gchatConfigured()) {
    const sent = await gchat.sendCard(gchat.reviewSpace(), gchat.matchQuestionCard({ requestId: ask.id, taskId: card.taskId, askTitle: ask.title, card: facts }), text, `matchq-${ask.id}-${card.cardId.slice(0, 8)}`, ask.threadKey);
    message = sent.name;
  } else {
    const { postText } = await import("./review");
    await postText(`${text} ${cardWords(facts)} · reply "same" or "different"`, { threadKey: ask.threadKey });
  }
  await sql()`update requests set proposal = coalesce(proposal, '{}'::jsonb) || ${JSON.stringify({ matchAsk: { taskId: card.taskId, cardId: card.cardId, message } })}::jsonb where id = ${ask.id} and status = 'proposed'`;
  return true;
}

/** Catch-up only: a likely card is noted on the ask; the next 10:00 post says so under the person's name. Nothing is posted. */
async function noteMaybe(ask: Ask, card: Card): Promise<void> {
  const facts = await cardFacts(card);
  await sql()`update requests set proposal = coalesce(proposal, '{}'::jsonb) || ${JSON.stringify({ maybeCard: { taskId: card.taskId, cardId: card.cardId, title: card.title, link: facts.link } })}::jsonb where id = ${ask.id} and status = 'proposed'`;
}

async function loadPair(requestId: string, taskId: string | null): Promise<{ ask: Ask; card: Card } | { ask: Ask | null; card: null }> {
  const r = await sql()`select client_id, coalesce(proposal->'matchAsk'->>'taskId', proposal->'maybeCard'->>'taskId') as task_id,
    coalesce(proposal->'matchAsk'->>'cardId', proposal->'maybeCard'->>'cardId') as card_id from requests where id = ${requestId}`;
  if (!r.length || !r[0].client_id) return { ask: null, card: null };
  const clientId = String(r[0].client_id);
  const ask = (await asksFor(clientId, { ids: [requestId], statuses: ["proposed", "expired"], since: CATCHUP_SINCE, limit: 1 }))[0] ?? null;
  const tid = taskId ?? (r[0].task_id as string | null);
  if (!ask) return { ask, card: null };
  // By the task the question named; a mirrored row can be replaced by its sheet row meanwhile, so the card's own id is the fallback.
  const t = tid ? await sql()`select pulp_card_id from tasks where id = ${tid} and request_id is null` : [];
  const cardId = t.length ? String(t[0].pulp_card_id) : (r[0].card_id as string | null);
  const card = cardId ? (await handMadeCards(clientId, { cardIds: [cardId], since: new Date(0), limit: 1 }))[0] ?? null : null;
  return card ? { ask, card } : { ask, card: null };
}

/** The tap on the question, or "same" / "different" typed in the thread. Returns the line that replaces the question. */
export async function answerMatch(requestId: string, taskId: string | null, same: boolean, who: string): Promise<string> {
  const pair = await loadPair(requestId, taskId);
  if (!pair.ask) return "That ask is already decided.";
  const pending = await sql()`select proposal->'matchAsk'->>'message' as message, proposal->'matchAsk'->>'cardId' as card_id, proposal->'maybeCard'->>'cardId' as maybe_id from requests where id = ${requestId}`;
  const questionMessage = (pending[0]?.message as string | null) ?? null;
  if (!same) {
    const cardId = pair.card?.cardId ?? (pending[0]?.card_id as string | null) ?? (pending[0]?.maybe_id as string | null);
    await sql()`update requests set proposal = (coalesce(proposal, '{}'::jsonb) - 'matchAsk' - 'maybeCard') || jsonb_build_object('notSame', coalesce(proposal->'notSame', '[]'::jsonb) || ${JSON.stringify(cardId ? [cardId] : [])}::jsonb) where id = ${requestId}`;
    return `— Different task · ${who} · "${pair.ask.title}" is still waiting in this thread: tap Create card, Remind me instead or No card.`;
  }
  if (!pair.card) return "That card is no longer on the board, or already belongs to another ask. The ask is still waiting: tap a button on it.";
  const facts = await cardFacts(pair.card);
  const line = confirmedLine({ by: who, askTitle: pair.ask.title, card: facts });
  const ok = await closeAsk(pair.ask, pair.card, { by: `${who} (card made in Pulp)`, how: "person", feed: true, line });
  if (!ok) return "That ask is already decided.";
  // The ask's own card now carries the full line; the question shrinks to one short line. A typed "same" leaves the
  // question card live, so it is replaced here as a tap would replace it.
  const short = `✅ Same task · confirmed by ${who}. The ask above is closed with the card's link.`;
  if (questionMessage) { try { const gchat = await import("./gchat"); await gchat.updateMessageText(questionMessage, short); } catch { /* the tap's own reply replaces it */ } }
  return short;
}

/** "Not the same task" on a line the hub closed by itself: the ask is open again, with a fresh card, and that pair is never matched again. */
export async function undoMatch(requestId: string, who: string): Promise<string> {
  const r = await sql()`select proposal->'madeInPulp'->>'cardId' as card_id, proposal->'madeInPulp'->>'taskId' as task_id from requests where id = ${requestId} and status = 'created' and decided_by = ${MADE_IN_PULP}`;
  if (!r.length) return "That ask was already changed by someone.";
  await sql()`update tasks set request_id = null where request_id = ${requestId} and origin <> 'hub'`;
  await sql()`update requests set status = 'proposed', decided_by = null, decided_at = null, proposal = coalesce(proposal, '{}'::jsonb) - 'madeInPulp' - 'cardName' where id = ${requestId}`;
  const { repostProposal } = await import("./proposal");
  try { await repostProposal(requestId); } catch (e) { await enqueue("post_proposal", { requestId }, 30); console.error("match: repost failed, queued", (e as Error).message); }
  // After the repost: storing a proposal rewrites its record.
  await sql()`update requests set proposal = coalesce(proposal, '{}'::jsonb) || jsonb_build_object('notSame', ${JSON.stringify(r[0].card_id ? [String(r[0].card_id)] : [])}::jsonb) where id = ${requestId}`;
  try { const { pokeExpire } = await import("./idle"); await pokeExpire(new Date()); } catch { /* the expiry sweep finds it at its next look */ }
  return `↩️ Not the same task (${who}). The ask is open again just below: tap Create card, Remind me instead or No card.`;
}

// ---- the judgement ----

export interface MatchResult { asks: number; cards: number; closed: number; asked: number; noted: number; calls: number; capped?: boolean; /** what was tied to what, for the catch-up's record */ pairs: Array<{ ask: string; card: string; link: string; how: string; was: string }> }

/**
 * Compare these asks with these cards. Free proofs first; one model call for the rest, when there is a rest.
 * live: certain closes with the undo line, likely asks the person. catchup: certain links (an expired ask in the
 * record only), likely is noted for the 10:00 post, nothing is posted.
 */
async function judge(clientName: string, asks: Ask[], cards: Card[], mode: "live" | "catchup", budget: { calls: number; cap: number }): Promise<MatchResult> {
  const out: MatchResult = { asks: asks.length, cards: cards.length, closed: 0, asked: 0, noted: 0, calls: 0, pairs: [] };
  const tied = (a: Ask, c: Card, how: string) => { out.closed++; out.pairs.push({ ask: a.title.slice(0, 90), card: c.title.slice(0, 90), link: linkOf(c), how, was: a.status }); };
  const openAsks = new Map(asks.map((a) => [a.id, a])), freeCards = new Map(cards.map((c) => [c.cardId, c]));
  for (const a of asks) {
    for (const c of freeCards.values()) {
      if (!pairAllowed(a, c)) continue;
      const how = sureWithoutModel(a, c);
      if (!how) continue;
      if (await closeAsk(a, c, { by: MADE_IN_PULP, how, feed: true })) { tied(a, c, how); freeCards.delete(c.cardId); }
      openAsks.delete(a.id);
      break;
    }
  }
  const restAsks = [...openAsks.values()].filter((a) => [...freeCards.values()].some((c) => pairAllowed(a, c)));
  const restCards = [...freeCards.values()].filter((c) => restAsks.some((a) => pairAllowed(a, c)));
  if (!restAsks.length || !restCards.length) return out;
  if (budget.calls >= budget.cap) { out.capped = true; return out; }
  const askRows: AskForMatch[] = restAsks.map((a) => ({ title: a.title, words: a.words, day: dayOf(a.createdAt) }));
  const cardRows: CardForMatch[] = [];
  for (const c of restCards) cardRows.push({ title: c.title, list: await listName(c), assignee: c.assignee, labels: c.labels, day: dayOf(c.createdAt), description: c.description });
  const matches = await judgeMatches({ clientName, asks: askRows, cards: cardRows, messageId: restAsks[0].messageId, step: mode === "catchup" ? "match_catchup" : "match" });
  out.calls++; budget.calls++;
  for (const m of matches) {
    const a = restAsks[m.ask], c = restCards[m.card];
    if (!a || !c || !pairAllowed(a, c)) continue;
    if (m.verdict === "same") { if (await closeAsk(a, c, { by: MADE_IN_PULP, how: "model", feed: true })) tied(a, c, "model"); }
    else if (a.status === "proposed") {
      if (mode === "live") { if (await askPerson(a, c)) out.asked++; }
      else { await noteMaybe(a, c); out.noted++; }
    }
  }
  return out;
}

// ---- triggers (each runs where Postgres is already open) ----

/** From the board read, after it stored new cards or gave a card its client: queue a look for clients that have an ask waiting. */
export async function queueCardMatch(found: Array<{ clientId: string; cardId: string; createdAt: string | null; description: string }>): Promise<number> {
  const fresh = found.filter((f) => f.clientId && f.createdAt && Date.now() - new Date(f.createdAt).getTime() < NEW_CARD_DAYS * DAY);
  if (!fresh.length) return 0;
  const clientIds = [...new Set(fresh.map((f) => f.clientId))];
  const waiting = await sql()`select distinct client_id from requests where status = 'proposed' and kind = 'task' and client_id = any(${clientIds}::text[]) and created_at > now() - (${ASK_WINDOW_DAYS} || ' days')::interval`;
  let queued = 0;
  for (const w of waiting) {
    const mine = fresh.filter((f) => f.clientId === String(w.client_id)).slice(0, 40);
    await enqueue("match_cards", { clientId: String(w.client_id), cards: mine.map((f) => ({ cardId: f.cardId, description: f.description.slice(0, 400) })) }, 0);
    queued++;
  }
  return queued;
}

/** From the pipeline, after a message's proposals were posted: queue a look when that client has a hand-made card from the last few days. */
export async function queueAskMatch(clientId: string | null, requestIds: string[]): Promise<boolean> {
  if (!clientId || !requestIds.length) return false;
  const any = await sql()`select 1 from tasks where client_id = ${clientId} and origin <> 'hub' and request_id is null and pulp_card_id is not null
    and notes is distinct from ${ARCHIVED} and created_at > now() - (${CARD_DAYS_BEFORE_ASK} || ' days')::interval limit 1`;
  if (!any.length) return false;
  await enqueue("match_asks", { clientId, requestIds }, 0);
  return true;
}

async function clientName(clientId: string): Promise<string> {
  return (await allClients()).find((c) => c.id === clientId)?.name ?? clientId;
}

/** Queue job: new cards of one client against that client's waiting asks. */
export async function runMatchCards(payload: { clientId: string; cards: Array<{ cardId: string; description?: string }> }): Promise<MatchResult> {
  const asks = (await asksFor(payload.clientId, { statuses: ["proposed"], since: new Date(Date.now() - ASK_WINDOW_DAYS * DAY).toISOString(), limit: 30 })).filter((a) => !a.pending);
  const cards = asks.length ? await handMadeCards(payload.clientId, { cardIds: payload.cards.map((c) => c.cardId), since: new Date(0), limit: 40 }) : [];
  const desc = new Map(payload.cards.map((c) => [c.cardId, c.description ?? ""]));
  for (const c of cards) c.description = desc.get(c.cardId) ?? "";
  return judge(await clientName(payload.clientId), asks, cards, "live", { calls: await callsToday(), cap: matchDailyCap() });
}

/** Queue job: a message's new asks against the cards the team made in the last few days. */
export async function runMatchAsks(payload: { clientId: string; requestIds: string[] }): Promise<MatchResult> {
  const asks = (await asksFor(payload.clientId, { ids: payload.requestIds, statuses: ["proposed"], since: CATCHUP_SINCE, limit: 15 })).filter((a) => !a.pending);
  if (!asks.length) return { asks: 0, cards: 0, closed: 0, asked: 0, noted: 0, calls: 0, pairs: [] };
  const since = new Date(Math.min(...asks.map((a) => a.createdAt.getTime())) - CARD_DAYS_BEFORE_ASK * DAY);
  const cards = await handMadeCards(payload.clientId, { since, limit: 40 });
  return judge(await clientName(payload.clientId), asks, cards, "live", { calls: await callsToday(), cap: matchDailyCap() });
}

// ---- the one-time catch-up ----

const CATCHUP_KEY = "match_catchup";
interface CatchUp { state: "running" | "done"; clients: string[] | null; cursor: { at: string; id: string } | null; calls: number; closed: number; noted: number; asks: number; startedAt: string; finishedAt?: string; /** what the catch-up tied to what (first 80), so the result can be read in hub_status and checked */ pairs?: MatchResult["pairs"] }

/** After a deploy whose schema changed (Postgres is open): start the catch-up if it never ran. */
export async function kickCatchUp(): Promise<boolean> {
  const fresh: CatchUp = { state: "running", clients: null, cursor: null, calls: 0, closed: 0, noted: 0, asks: 0, startedAt: new Date().toISOString(), pairs: [] };
  const ins = await sql()`insert into settings (key, value) values (${CATCHUP_KEY}, ${JSON.stringify(fresh)}::jsonb) on conflict (key) do nothing returning key`;
  if (!ins.length) return false;
  await enqueue("match_catchup", {}, 30);
  return true;
}

/**
 * Queue job: asks that already have a card. Every ask still waiting, and every ask that expired since proposals
 * began, is compared once with that client's hand-made cards. Small batches; the job queues itself until it is done.
 */
export async function runCatchUp(maxCalls = 5, maxMs = 25_000): Promise<CatchUp | null> {
  const row = await sql()`select value from settings where key = ${CATCHUP_KEY}`;
  if (!row.length) return null;
  const st = row[0].value as CatchUp;
  if (st.state === "done") return st;
  const started = Date.now();
  if (st.clients === null) {
    const c = await sql()`select distinct client_id from requests where kind = 'task' and status in ('proposed', 'expired') and client_id is not null and created_at >= ${CATCHUP_SINCE}::timestamptz order by client_id`;
    st.clients = c.map((x) => String(x.client_id));
  }
  const save = async () => { await sql()`update settings set value = ${JSON.stringify(st)}::jsonb, updated_at = now() where key = ${CATCHUP_KEY}`; };
  let callsNow = 0;
  while (st.clients.length && callsNow < maxCalls && Date.now() - started < maxMs && st.calls < CATCHUP_CALL_CAP) {
    const clientId = st.clients[0];
    const asks = await asksFor(clientId, { statuses: ["proposed", "expired"], since: CATCHUP_SINCE, after: st.cursor, limit: 8 });
    if (!asks.length) { st.clients.shift(); st.cursor = null; await save(); continue; }
    const first = new Date(Math.min(...asks.map((a) => a.createdAt.getTime())) - CARD_DAYS_BEFORE_ASK * DAY);
    const last = new Date(Math.max(...asks.map((a) => a.createdAt.getTime())) + 10 * DAY);
    const cards = cardsNear(asks, await handMadeCards(clientId, { since: first, until: last, limit: 300 }), 50);
    const budget = { calls: st.calls, cap: CATCHUP_CALL_CAP };
    const r = await judge(await clientName(clientId), asks, cards, "catchup", budget);
    st.calls = budget.calls; callsNow += r.calls; st.closed += r.closed; st.noted += r.noted; st.asks += asks.length;
    st.pairs = [...(st.pairs ?? []), ...r.pairs].slice(0, 80);
    const tail = asks[asks.length - 1];
    st.cursor = { at: tail.createdTxt, id: tail.id };
    await save();
  }
  if (!st.clients.length || st.calls >= CATCHUP_CALL_CAP) { st.state = "done"; st.finishedAt = new Date().toISOString(); await save(); }
  else await enqueue("match_catchup", {}, 20);
  return st;
}
