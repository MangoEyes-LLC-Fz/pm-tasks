/**
 * What the schedulers remember outside Postgres, so a quiet minute does not wake Neon.
 *
 * Neon suspends about five minutes after the last query. The crons still run on their
 * existing schedules (mail and Drop stay prompt, reminders fire at the minute they are
 * due). On Vercel the memory is the Runtime Cache, shared by every function in the
 * region and not a database. Where that cache is not available, every check falls
 * through to Postgres, which is the previous behaviour.
 *
 * A queue or reminder time learned from the database is trusted until that time, or
 * until a later write pokes it. An empty queue is confirmed again after six hours, so
 * a cache write that failed cannot hide a job for longer than that. Six hours is long
 * enough for the compute to suspend in between.
 */
import { createHash } from "node:crypto";
import { MORNING_HOUR, teamParts, teamTime } from "./when";

const TTL_SECONDS = 7 * 24 * 60 * 60;
/** How long an "nothing queued" answer is trusted before the tick looks again. */
export const EMPTY_CONFIRM_MS = 6 * 60 * 60 * 1000;
/** A cached card list is re-read after this, in case a writer forgot to drop it. */
export const WATCH_REFRESH_MS = 12 * 60 * 60 * 1000;
export const WATCH_MAX = 2000;

export const POLL_KEYS = {
  tick: "tick_last",
  gmail: "gmail_poll_last",
  inbox: "chat_inbox_last",
  meet: "meet_poll_last",
  pulp: "pulp_poll_last",
  sheet_cards: "sheet_cards_last",
  board_mirror: "board_mirror_last",
  sheet_sync: "sheet_sync_last",
} as const;

export type BeatName = keyof typeof POLL_KEYS;
export type Beat = { at: string; detail?: Record<string, unknown> };

/** Earliest future work the tick knows about, plus a poke so a write during a read is not lost. */
export interface Gate {
  next: string | null;
  known: boolean;
  poke: string | null;
  asof: string | null;
}

export interface WatchState {
  known: boolean;
  after: string | null;
  poke: string | null;
  asof: string | null;
}

export interface ExpireState { known: boolean; next: string | null }

export interface BoardMemory { at: string | null; fps: Record<string, string>; dirty: boolean }

export interface PulpWatchCard {
  id: string;
  cardId: string;
  listId: string | null;
  staging: boolean;
  title: string;
  boardId: string;
  sheetRow: number | null;
  clientName: string | null;
  tab: string | null;
  sheetStage: string | null;
  checkedAt: string | null;
}

export interface SheetWatchCard {
  id: string;
  cardId: string;
  boardId: string;
  listId: string | null;
  title: string;
  sheetTab: string;
  sheetRow: number | null;
  sheetStatus: string | null;
  checkedAt: string | null;
}

export interface WatchList<T> { loadedAt: string; cards: T[] }

const emptyGate = (): Gate => ({ next: null, known: false, poke: null, asof: null });

/**
 * True when the tick must open the queue (or the reminder table).
 * A future `next` is trusted. A poke newer than `asof` means a row was added after the last read.
 * An empty queue is trusted only until `emptyConfirmMs` has passed.
 */
export function mustQuery(s: Gate | null, now: Date, emptyConfirmMs = EMPTY_CONFIRM_MS): boolean {
  if (!s?.known) return true;
  if (s.poke && (!s.asof || s.poke > s.asof)) return true;
  if (!s.next) {
    if (!s.asof) return true;
    return now.getTime() - Date.parse(s.asof) >= emptyConfirmMs;
  }
  return Date.parse(s.next) <= now.getTime();
}

/** Fold a database answer back onto the gate. A poke that landed during the read forces another look. */
export function applyRemember(prev: Gate | null, next: string | null, queryStarted: string, nowIso: string): Gate {
  const poke = prev?.poke ?? null;
  if (poke && poke > queryStarted) {
    const sooner = prev?.next && (!next || prev.next < next) ? prev.next : next;
    return { next: sooner, known: true, poke, asof: queryStarted };
  }
  return { next, known: true, poke, asof: nowIso };
}

/** A new row is due at `dueIso`. The poke is "now", so the next tick re-reads until it has seen this write. */
export function applyPoke(prev: Gate | null, dueIso: string, pokeIso: string): Gate {
  const cur = prev ?? emptyGate();
  const next = !cur.next || dueIso < cur.next ? dueIso : cur.next;
  return { ...cur, next, poke: pokeIso };
}

/** The next 10:00 India that is at least 20 hours after the reminder was last posted. */
export function nextMorningAfter(lastPosted: Date): Date {
  const earliest = lastPosted.getTime() + 20 * 3_600_000;
  const p = teamParts(new Date(earliest));
  let candidate = teamTime(p.y, p.m, p.day, MORNING_HOUR, 0);
  if (candidate.getTime() < earliest) candidate = teamTime(p.y, p.m, p.day + 1, MORNING_HOUR, 0);
  return candidate;
}

/** When the reminder table must next be opened. Null when nothing is open. */
export function nextReminderInstant(rows: Array<{ dueAt: string; lastPostedAt: string | null }>): string | null {
  let best: number | null = null;
  for (const r of rows) {
    const t = r.lastPostedAt ? nextMorningAfter(new Date(r.lastPostedAt)).getTime() : Date.parse(r.dueAt);
    if (best === null || t < best) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

/**
 * Watchdog runs on the same minute marks as before (:05, :15, ...).
 * It also runs then when a message was stored since the last sweep, and at least every six hours,
 * so a crashed run that never recorded itself is still found.
 */
export function watchdogMust(now: Date, s: WatchState | null, emptyConfirmMs = EMPTY_CONFIRM_MS): boolean {
  if (now.getMinutes() % 10 !== 5) return false;
  if (!s?.known) return true;
  if (s.asof && now.getTime() - Date.parse(s.asof) >= emptyConfirmMs) return true;
  if (s.poke && (!s.asof || s.poke > s.asof)) return !s.after || Date.parse(s.after) <= now.getTime();
  if (!s.after) return false;
  return Date.parse(s.after) <= now.getTime();
}

export function expireMust(now: Date, s: ExpireState | null): boolean {
  if (!s?.known) return true;
  if (!s.next) return false;
  return Date.parse(s.next) <= now.getTime();
}

export function expirePoked(prev: ExpireState | null, dueIso: string): ExpireState {
  const next = !prev?.next || dueIso < prev.next ? dueIso : prev.next;
  return { known: prev?.known ?? false, next };
}

export function mirrorDue(now: Date, s: BoardMemory | null, everyMin: number): boolean {
  if (!s?.at || s.dirty) return true;
  return now.getTime() - Date.parse(s.at) >= everyMin * 60_000 - 5_000;
}

export function watchStale(loadedAt: string | null, now: Date, refreshMs = WATCH_REFRESH_MS): boolean {
  if (!loadedAt) return true;
  return now.getTime() - Date.parse(loadedAt) >= refreshMs;
}

/** Cards the Pulp poll would have selected: staging every time, anything else not checked in the last two minutes. */
export function duePulpCards(cards: PulpWatchCard[], now: Date, limit = 150): PulpWatchCard[] {
  return cards
    .filter((c) => c.staging || !c.checkedAt || now.getTime() - Date.parse(c.checkedAt) >= 2 * 60_000)
    .sort((a, b) => Date.parse(a.checkedAt ?? "1970-01-01") - Date.parse(b.checkedAt ?? "1970-01-01"))
    .slice(0, limit);
}

export function dueSheetCards(cards: SheetWatchCard[], now: Date, limit = 60): SheetWatchCard[] {
  return cards
    .filter((c) => !c.checkedAt || now.getTime() - Date.parse(c.checkedAt) >= 2 * 60_000)
    .sort((a, b) => Date.parse(a.checkedAt ?? "1970-01-01") - Date.parse(b.checkedAt ?? "1970-01-01"))
    .slice(0, limit);
}

export function boardCardsFingerprint(cards: Array<{ id: string; listId: string; title: string; labels: string[] }>, capped: boolean): string {
  const lines = cards.map((c) => [c.id, c.listId, c.title, [...c.labels].sort().join(",")].join("\t")).sort();
  return createHash("sha256").update((capped ? "1" : "0") + "\n" + lines.join("\n")).digest("hex").slice(0, 24);
}

export function hashJson(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, stable(o[k])]));
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex").slice(0, 24);
}

export const READER_LIMITS: Array<[BeatName, number, string]> = [
  ["gmail", 300, "mailbox"],
  ["inbox", 300, "Task Hub Drop"],
  ["meet", 1200, "Meet notes"],
  ["pulp", 300, "Pulp"],
  ["sheet_cards", 300, "sheet cards"],
  ["board_mirror", 1200, "board mirror"],
];

/** Same staleness rules the health page and the morning brief use, read from heartbeats rather than Postgres. */
export function staleReaders(beats: Partial<Record<BeatName, Beat>>, now: Date): string[] {
  const stale: string[] = [];
  for (const [name, limit, label] of READER_LIMITS) {
    const at = beats[name]?.at;
    if (!at) { stale.push(`${label}: never ran`); continue; }
    const age = Math.round((now.getTime() - Date.parse(at)) / 1000);
    if (age > limit) stale.push(`${label}: ${Math.round(age / 60)} min ago`);
  }
  return stale;
}

export function overlayPolls(rows: ReadonlyArray<{ key?: unknown; value?: unknown }>, beats: Partial<Record<BeatName, Beat>>): Array<{ key: string; value: unknown }> {
  const map = new Map(rows.map((r) => [String(r.key), r.value]));
  for (const name of Object.keys(POLL_KEYS) as BeatName[]) {
    const beat = beats[name];
    if (!beat) continue;
    const key = POLL_KEYS[name];
    const value = name === "tick" ? beat.at : { ...(beat.detail ?? {}), at: beat.at };
    const prev = map.get(key);
    const prevAt = typeof prev === "string" ? prev : (prev as { at?: string } | undefined)?.at;
    if (!prevAt || Date.parse(beat.at) >= Date.parse(prevAt)) map.set(key, value);
  }
  return [...map.entries()].map(([key, value]) => ({ key, value }));
}

// ---- storage: Runtime Cache on Vercel, an explicit map in tests, Postgres otherwise ----

type Mode = "auto" | "memory" | "off";
let mode: Mode = "auto";
let memory: Map<string, unknown> | null = null;

/** Tests inject a shared map. Production uses the Vercel Runtime Cache when the platform provides one. */
export function useIdleStore(next: Mode) {
  mode = next;
  memory = next === "memory" ? new Map() : null;
}

function platform(): boolean {
  if (mode === "memory") return true;
  if (mode === "off") return false;
  const bag = globalThis as unknown as Record<symbol, { get?: () => { cache?: unknown } } | undefined>;
  const ctx = bag[Symbol.for("@vercel/request-context")]?.get?.();
  if (ctx?.cache) return true;
  return !!(process.env.RUNTIME_CACHE_ENDPOINT && process.env.RUNTIME_CACHE_HEADERS);
}

type Cache = { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown, opts?: { ttl?: number; name?: string }) => Promise<unknown> };
let runtime: Cache | null | undefined;

async function cache(): Promise<Cache | null> {
  if (mode === "memory") return null;
  if (!platform()) return null;
  if (runtime !== undefined) return runtime;
  try {
    const mod = await import("@vercel/functions");
    runtime = mod.getCache({ namespace: "task-hub" });
  } catch {
    runtime = null;
  }
  return runtime;
}

/** True when a quiet minute may skip Postgres. False outside Vercel, and the schedulers then hit the database as before. */
export async function idleOn(): Promise<boolean> {
  if (mode === "memory") return true;
  if (!platform()) return false;
  return !!(await cache());
}

async function read<T>(key: string): Promise<{ shared: boolean; value: T | null }> {
  if (mode === "memory" && memory) return { shared: true, value: (memory.get(key) as T) ?? null };
  if (!(await idleOn())) return { shared: false, value: null };
  try {
    const c = await cache();
    if (!c) return { shared: false, value: null };
    const value = (await c.get(key)) as T | null;
    return { shared: true, value: value ?? null };
  } catch {
    return { shared: false, value: null };
  }
}

async function write(key: string, value: unknown): Promise<boolean> {
  if (mode === "memory" && memory) { memory.set(key, value); return true; }
  if (!(await idleOn())) return false;
  try {
    const c = await cache();
    if (!c) return false;
    await c.set(key, value, { ttl: TTL_SECONDS, name: key });
    return true;
  } catch (e) {
    console.error("idle cache write failed", key, (e as Error).message);
    return false;
  }
}

export async function noteBeat(name: BeatName, detail?: Record<string, unknown>): Promise<void> {
  const beat: Beat = { at: new Date().toISOString(), ...(detail ? { detail } : {}) };
  await write(`beat:${name}`, beat);
}

export async function allBeats(): Promise<Partial<Record<BeatName, Beat>>> {
  const out: Partial<Record<BeatName, Beat>> = {};
  for (const name of Object.keys(POLL_KEYS) as BeatName[]) {
    const r = await read<Beat>(`beat:${name}`);
    if (r.shared && r.value?.at) out[name] = r.value;
  }
  return out;
}

export async function cachedPolls(): Promise<Array<{ key: string; value: unknown }>> {
  return overlayPolls([], await allBeats());
}

async function gate(key: string): Promise<{ shared: boolean; value: Gate | null }> {
  return read<Gate>(key);
}

async function remember(key: string, next: string | null, queryStarted: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const cur = await gate(key);
    if (!cur.shared) return;
    const nowIso = new Date().toISOString();
    await write(key, applyRemember(cur.value, next, queryStarted, nowIso));
    const again = await gate(key);
    if (!again.shared || (again.value?.poke ?? null) === (cur.value?.poke ?? null)) return;
  }
}

async function poke(key: string, due: Date): Promise<void> {
  const cur = await gate(key);
  if (!cur.shared) return;
  const pokeIso = new Date().toISOString();
  const next = applyPoke(cur.value, due.toISOString(), pokeIso);
  await write(key, next);
  const again = await gate(key);
  if (again.shared && again.value?.poke !== pokeIso) console.error("idle cache did not keep a queue poke", key);
}

export const queueGate = () => gate("queue");
export const rememberQueue = (next: string | null, queryStarted: string) => remember("queue", next, queryStarted);
export const pokeQueue = (due: Date) => poke("queue", due);

export const reminderGate = () => gate("reminder");
export const rememberReminders = (next: string | null, queryStarted: string) => remember("reminder", next, queryStarted);
export const pokeReminder = (due: Date) => poke("reminder", due);

export async function watchdogState(): Promise<{ shared: boolean; value: WatchState | null }> {
  return read<WatchState>("watchdog");
}

export async function pokeWatchdog(after: Date): Promise<void> {
  const cur = await read<WatchState>("watchdog");
  if (!cur.shared) return;
  const prev = cur.value;
  const afterIso = after.toISOString();
  const sooner = prev?.after && prev.after < afterIso ? prev.after : afterIso;
  await write("watchdog", { known: prev?.known ?? false, after: sooner, poke: new Date().toISOString(), asof: prev?.asof ?? null });
}

export async function clearWatchdog(): Promise<void> {
  const cur = await read<WatchState>("watchdog");
  if (!cur.shared) return;
  await write("watchdog", { known: true, after: null, poke: cur.value?.poke ?? null, asof: new Date().toISOString() });
}

export async function expireState(): Promise<{ shared: boolean; value: ExpireState | null }> {
  return read<ExpireState>("expire");
}

export async function pokeExpire(due: Date): Promise<void> {
  const cur = await expireState();
  if (!cur.shared) return;
  await write("expire", expirePoked(cur.value, due.toISOString()));
}

export async function rememberExpire(next: string | null): Promise<void> {
  await write("expire", { known: true, next });
}

export async function schemaFresh(hash: string): Promise<boolean> {
  const r = await read<string>("schema");
  return r.shared && r.value === hash;
}

export const rememberSchema = (hash: string) => write("schema", hash);

export async function configFresh(hash: string): Promise<boolean> {
  const r = await read<string>("config");
  return r.shared && r.value === hash;
}

export const rememberConfig = (hash: string) => write("config", hash);

export async function gmailDayDue(day: string): Promise<boolean> {
  const r = await read<string>("gmail-day");
  if (!r.shared) return true;
  return r.value !== day;
}

export const rememberGmailDay = (day: string) => write("gmail-day", day);

export async function inboxCursor(): Promise<{ space: string; since: string } | null> {
  const r = await read<{ space: string; since: string }>("inbox");
  if (!r.shared || !r.value?.space || !r.value.since) return null;
  return r.value;
}

export const rememberInbox = (space: string, since: string) => write("inbox", { space, since });

export async function meetSinceCached(): Promise<string | null> {
  const r = await read<string>("meet-since");
  return r.shared ? r.value : null;
}

export const rememberMeetSince = (iso: string) => write("meet-since", iso);

export async function meetRepairDone(): Promise<boolean> {
  const r = await read<boolean>("meet-repair");
  return r.shared && r.value === true;
}

export const markMeetRepairDone = () => write("meet-repair", true);

export async function meetReadersCached(): Promise<{ off: Record<string, string>; since: Record<string, string> } | null> {
  const r = await read<{ off: Record<string, string>; since: Record<string, string> }>("meet-readers");
  return r.shared ? r.value : null;
}

export const saveMeetReaders = (off: Record<string, string>, since: Record<string, string>) => write("meet-readers", { off, since });

export async function knownMeetFiles(): Promise<string[] | null> {
  const r = await read<string[]>("meet-files");
  return r.shared ? r.value : null;
}

export const saveKnownMeetFiles = (ids: string[]) => write("meet-files", ids);

export async function forgetMeetFile(id: string): Promise<void> {
  const ids = await knownMeetFiles();
  if (!ids) return;
  await saveKnownMeetFiles(ids.filter((x) => x !== id));
}

export async function addMeetFile(id: string): Promise<void> {
  const ids = await knownMeetFiles();
  if (!ids) return;
  if (!ids.includes(id)) await saveKnownMeetFiles([...ids, id]);
}

export async function morningCached(): Promise<{ shared: boolean; at: string | null }> {
  const r = await read<string | null>("morning");
  return { shared: r.shared, at: r.value };
}

export const rememberMorning = (at: string | null) => write("morning", at);

export async function boardMemory(): Promise<{ shared: boolean; value: BoardMemory | null }> {
  return read<BoardMemory>("boards");
}

export const writeBoards = (s: BoardMemory) => write("boards", s);

export async function markBoardsDirty(): Promise<void> {
  const cur = await boardMemory();
  if (!cur.shared) return;
  await writeBoards({ at: cur.value?.at ?? null, fps: cur.value?.fps ?? {}, dirty: true });
}

export async function sheetDigestCached(): Promise<{ shared: boolean; value: string | null }> {
  const r = await read<string>("sheet-digest");
  return { shared: r.shared, value: r.value };
}

export const rememberSheetDigest = (digest: string) => write("sheet-digest", digest);

export async function pulpWatch(): Promise<WatchList<PulpWatchCard> | null> {
  const r = await read<WatchList<PulpWatchCard>>("pulp-watch");
  return r.shared ? r.value : null;
}

export const savePulpWatch = (w: WatchList<PulpWatchCard>) => write("pulp-watch", w);

export async function sheetWatch(): Promise<WatchList<SheetWatchCard> | null> {
  const r = await read<WatchList<SheetWatchCard>>("sheet-watch");
  return r.shared ? r.value : null;
}

export const saveSheetWatch = (w: WatchList<SheetWatchCard>) => write("sheet-watch", w);

export async function dropWatch(which: "pulp" | "sheet"): Promise<void> {
  await write(which === "pulp" ? "pulp-watch" : "sheet-watch", null);
}

export async function queueErrorsCached(): Promise<unknown[] | null> {
  const r = await read<unknown[]>("queue-errors");
  return r.shared ? r.value : null;
}

export const saveQueueErrors = (rows: unknown[]) => write("queue-errors", rows);
