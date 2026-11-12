/**
 * The minute Pulp poll, without Postgres when no card has moved.
 * The card ids live in the Runtime Cache. Pulp is still asked on the same rotation
 * (a card in Staging every minute, any other card every two). Only a move, a deletion,
 * or a sheet status that does not match opens the database, which is the path the
 * tick already had.
 */
import { sql } from "./db";
import { dropWatch, duePulpCards, idleOn, noteBeat, pulpWatch, savePulpWatch, watchStale, WATCH_MAX, type PulpWatchCard } from "./idle";
import { isDoneList, normList, pulp } from "./pulp";
import { fetchCards } from "./sheet-cards";
import { sheetConfig } from "./sheets";

const ARCHIVED = "Archived or deleted in Pulp";

function iso(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function text(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === "string" ? v : String(v);
}

type Row = PulpWatchCard & { pulp_card_id: string };

export async function reloadPulpWatch(): Promise<void> {
  if (!(await idleOn())) return;
  const rows = await sql()`select t.id, t.pulp_card_id, t.list_id, t.staging, t.title, t.board_id, t.sheet_row, c.name as client_name, tab.value as tab, st.value as sheet_stage, t.pulp_checked_at
    from tasks t
    left join clients c on c.id = t.client_id
    left join settings tab on tab.key = 'sheet_tab:' || t.id::text
    left join settings st on st.key = 'sheet_stage:' || t.id::text
    where t.pulp_card_id is not null and t.origin = 'hub'
      and (t.completed_at is null or t.completed_at > now() - interval '7 days')
      and t.notes is distinct from ${ARCHIVED}`;
  if (rows.length > WATCH_MAX) { await dropWatch("pulp"); return; }
  const cards: PulpWatchCard[] = rows.map((t) => ({
    id: String(t.id),
    cardId: String(t.pulp_card_id),
    listId: text(t.list_id),
    staging: Boolean(t.staging),
    title: String(t.title ?? ""),
    boardId: String(t.board_id ?? ""),
    sheetRow: t.sheet_row == null ? null : Number(t.sheet_row),
    clientName: text(t.client_name),
    tab: text(t.tab),
    sheetStage: text(t.sheet_stage),
    checkedAt: iso(t.pulp_checked_at),
  }));
  await savePulpWatch({ loadedAt: new Date().toISOString(), cards });
}

/**
 * A Pulp poll that does not open Postgres when every card still sits where the hub last saw it.
 * Returns null when the database path has to run (cache cold, a card moved, a card gone).
 */
export async function tryQuietPulp(outOfTime: () => boolean): Promise<Record<string, unknown> | null> {
  if (!(await idleOn()) || !pulp.configured()) return null;
  const watch = await pulpWatch();
  const now = new Date();
  if (!watch?.cards || watchStale(watch.loadedAt, now)) return null;
  const due = duePulpCards(watch.cards, now, 150).map((c): Row => ({ ...c, pulp_card_id: c.cardId }));
  if (!due.length) {
    await noteBeat("pulp", { checked: 0, synced: 0, sheetUpdates: 0, errors: [], skipped: "nothing due" });
    return { checked: 0, synced: 0, sheetUpdates: 0, errors: [], skipped: "nothing due" };
  }
  const errors: string[] = [];
  let checked = 0;
  const seen = new Set<string>();
  for await (const { row, card, error } of fetchCards(due, outOfTime)) {
    if (error === "timeout") { errors.push(`stopped after ${checked} cards: out of time this minute`); break; }
    if (!card || error) return null;
    if (card.closed || (card.listName && normList(card.listName) === "staging")) return null;
    if (card.listId !== row.listId || (card.boardId && row.boardId && card.boardId !== row.boardId)) return null;
    if (await pulp.cardArchived(card)) return null;
    if (row.tab) {
      if (!card.listName) return null;
      const wanted = isDoneList(card.listName) ? sheetConfig().stage_values.done : card.listName;
      if (row.sheetStage !== wanted) return null;
    }
    seen.add(row.id);
    checked++;
  }
  const at = now.toISOString();
  for (const c of watch.cards) if (seen.has(c.id)) c.checkedAt = at;
  await savePulpWatch(watch);
  await noteBeat("pulp", { checked, synced: 0, sheetUpdates: 0, errors, skipped: "unchanged" });
  return { checked, synced: 0, sheetUpdates: 0, errors, skipped: "unchanged" };
}
