import { afterEach, describe, expect, it } from "vitest";
import {
  applyPoke, applyRemember, boardCardsFingerprint, duePulpCards, dueSheetCards, expireMust, expirePoked,
  hashJson, mirrorDue, mustQuery, nextMorningAfter, nextReminderInstant, overlayPolls, staleReaders,
  useIdleStore, watchdogMust, EMPTY_CONFIRM_MS, type Gate, type PulpWatchCard,
} from "../src/lib/idle";
import { databaseUrl } from "../src/lib/db";
import { morningCouldBeDue } from "../src/lib/morning";

afterEach(() => useIdleStore("auto"));

const gate = (p: Partial<Gate> = {}): Gate => ({ next: null, known: true, poke: null, asof: "2026-11-12T00:00:00.000Z", ...p });

describe("a quiet minute does not need the database", () => {
  it("trusts a future queue time and re-reads when a job is poked in afterwards", () => {
    const now = new Date("2026-11-12T03:00:00.000Z");
    expect(mustQuery(null, now)).toBe(true);
    expect(mustQuery(gate({ next: "2026-11-12T04:00:00.000Z" }), now)).toBe(false);
    expect(mustQuery(gate({ next: "2026-11-12T02:00:00.000Z" }), now)).toBe(true);
    const poked = applyPoke(gate({ next: "2026-11-12T04:00:00.000Z", asof: "2026-11-12T02:00:00.000Z" }), "2026-11-12T03:30:00.000Z", "2026-11-12T03:10:00.000Z");
    expect(poked.next).toBe("2026-11-12T03:30:00.000Z");
    expect(mustQuery(poked, now)).toBe(true);
    const seen = applyRemember(poked, "2026-11-12T03:30:00.000Z", "2026-11-12T03:11:00.000Z", "2026-11-12T03:11:01.000Z");
    expect(mustQuery(seen, now)).toBe(false);
  });

  it("confirms an empty queue again after six hours, not every minute", () => {
    const asof = "2026-11-12T00:00:00.000Z";
    const empty = gate({ next: null, asof });
    expect(mustQuery(empty, new Date("2026-11-12T01:00:00.000Z"))).toBe(false);
    expect(mustQuery(empty, new Date(Date.parse(asof) + EMPTY_CONFIRM_MS))).toBe(true);
  });

  it("does not let a poke that arrived during the read be forgotten", () => {
    const prev = gate({ poke: "2026-11-12T03:00:05.000Z", asof: "2026-11-12T02:00:00.000Z", next: "2026-11-12T03:00:00.000Z" });
    const folded = applyRemember(prev, null, "2026-11-12T03:00:00.000Z", "2026-11-12T03:00:06.000Z");
    expect(folded.asof).toBe("2026-11-12T03:00:00.000Z");
    expect(mustQuery(folded, new Date("2026-11-12T03:00:07.000Z"))).toBe(true);
  });

  it("posts a reminder at its time, and again the next morning, and not in between", () => {
    const posted = new Date("2026-11-10T04:30:00.000Z"); // 10:00 IST
    const next = nextMorningAfter(posted);
    expect(next.toISOString()).toBe("2026-11-11T04:30:00.000Z");
    const due = nextReminderInstant([
      { dueAt: "2026-11-12T09:00:00.000Z", lastPostedAt: null },
      { dueAt: "2026-11-01T00:00:00.000Z", lastPostedAt: posted.toISOString() },
    ]);
    expect(due).toBe("2026-11-11T04:30:00.000Z");
    expect(mustQuery(gate({ next: due }), new Date("2026-11-11T04:00:00.000Z"))).toBe(false);
    expect(mustQuery(gate({ next: due }), new Date("2026-11-11T04:30:00.000Z"))).toBe(true);
  });

  it("runs the watchdog on the same minute marks, and skips it when nothing was stored", () => {
    const at = (iso: string) => new Date(iso);
    expect(watchdogMust(at("2026-11-12T03:07:00.000Z"), null)).toBe(false);
    expect(watchdogMust(at("2026-11-12T03:05:00.000Z"), null)).toBe(true);
    expect(watchdogMust(at("2026-11-12T03:05:00.000Z"), { known: true, after: null, poke: null, asof: "2026-11-12T03:00:00.000Z" })).toBe(false);
    expect(watchdogMust(at("2026-11-12T03:15:00.000Z"), { known: true, after: "2026-11-12T03:10:00.000Z", poke: "2026-11-12T03:06:00.000Z", asof: "2026-11-12T03:00:00.000Z" })).toBe(true);
  });

  it("expires proposals when the oldest one is due, and keeps the sooner of two", () => {
    expect(expireMust(new Date("2026-11-12T00:00:00.000Z"), null)).toBe(true);
    expect(expireMust(new Date("2026-11-12T00:00:00.000Z"), { known: true, next: null })).toBe(false);
    expect(expireMust(new Date("2026-11-12T12:00:00.000Z"), { known: true, next: "2026-11-12T11:00:00.000Z" })).toBe(true);
    expect(expirePoked({ known: true, next: "2026-11-20T00:00:00.000Z" }, "2026-11-18T00:00:00.000Z").next).toBe("2026-11-18T00:00:00.000Z");
    expect(expirePoked({ known: true, next: "2026-11-18T00:00:00.000Z" }, "2026-11-20T00:00:00.000Z").next).toBe("2026-11-18T00:00:00.000Z");
  });

  it("does not ask the morning loop at night or at the weekend", () => {
    expect(morningCouldBeDue(new Date("2026-11-12T20:00:00.000Z"))).toBe(false); // 01:30 IST Friday
    expect(morningCouldBeDue(new Date("2026-11-14T06:00:00.000Z"))).toBe(false); // Saturday
    expect(morningCouldBeDue(new Date("2026-11-12T04:40:00.000Z"))).toBe(true);  // 10:10 IST Thursday
  });

  it("rotates Pulp cards the way the minute poll did: staging every time, others every two minutes", () => {
    const card = (p: Partial<PulpWatchCard>): PulpWatchCard => ({ id: "1", cardId: "c", listId: "l", staging: false, title: "t", boardId: "b", sheetRow: null, clientName: null, tab: null, sheetStage: null, checkedAt: "2026-11-12T03:00:00.000Z", ...p });
    const now = new Date("2026-11-12T03:01:00.000Z");
    const cards = [card({ id: "fresh" }), card({ id: "old", checkedAt: "2026-11-12T02:00:00.000Z" }), card({ id: "hold", staging: true })];
    expect(duePulpCards(cards, now).map((c) => c.id)).toEqual(["old", "hold"]);
    expect(dueSheetCards([{ ...card({ id: "fresh" }), sheetTab: "HOH", sheetStatus: null }], now)).toEqual([]);
  });

  it("treats an unchanged board as the same fingerprint", () => {
    const a = [{ id: "2", listId: "l", title: "B", labels: ["P1", "HOH"] }, { id: "1", listId: "l", title: "A", labels: ["HOH"] }];
    const b = [{ id: "1", listId: "l", title: "A", labels: ["HOH"] }, { id: "2", listId: "l", title: "B", labels: ["HOH", "P1"] }];
    expect(boardCardsFingerprint(a, false)).toBe(boardCardsFingerprint(b, false));
    expect(boardCardsFingerprint(a, false)).not.toBe(boardCardsFingerprint([{ ...a[0], listId: "moved" }, a[1]], false));
    expect(mirrorDue(new Date("2026-11-12T03:04:00.000Z"), { at: "2026-11-12T03:00:00.000Z", fps: { b: "x" }, dirty: false }, 5)).toBe(false);
    expect(mirrorDue(new Date("2026-11-12T03:06:00.000Z"), { at: "2026-11-12T03:00:00.000Z", fps: { b: "x" }, dirty: false }, 5)).toBe(true);
    expect(mirrorDue(new Date("2026-11-12T03:01:00.000Z"), { at: "2026-11-12T03:00:00.000Z", fps: {}, dirty: true }, 5)).toBe(true);
  });

  it("overlays a fresh heartbeat onto a stale database row", () => {
    const rows = overlayPolls(
      [{ key: "gmail_poll_last", value: { at: "2026-11-12T00:00:00.000Z", errors: ["old"] } }, { key: "tick_last", value: "2026-11-12T00:00:00.000Z" }],
      { gmail: { at: "2026-11-12T03:00:00.000Z", detail: { errors: [], read: 0 } }, tick: { at: "2026-11-12T03:00:00.000Z" } },
    );
    expect(rows.find((r) => r.key === "gmail_poll_last")?.value).toMatchObject({ at: "2026-11-12T03:00:00.000Z", read: 0, errors: [] });
    expect(rows.find((r) => r.key === "tick_last")?.value).toBe("2026-11-12T03:00:00.000Z");
    expect(staleReaders({ gmail: { at: "2026-11-12T00:00:00.000Z" } }, new Date("2026-11-12T03:00:00.000Z"))).toContain("mailbox: 180 min ago");
  });

  it("hashes a client list stably and prefers the pooled Neon host", () => {
    expect(hashJson([{ b: 1, a: 2 }])).toBe(hashJson([{ a: 2, b: 1 }]));
    const saved = { DATABASE_URL: process.env.DATABASE_URL, POSTGRES_URL: process.env.POSTGRES_URL };
    process.env.DATABASE_URL = "postgres://u:p@ep-example.eu-west-2.aws.neon.tech/db";
    process.env.POSTGRES_URL = "postgres://u:p@ep-example-pooler.eu-west-2.aws.neon.tech/db";
    expect(databaseUrl()).toContain("-pooler");
    delete process.env.POSTGRES_URL;
    expect(databaseUrl()).toBe("postgres://u:p@ep-example.eu-west-2.aws.neon.tech/db");
    if (saved.DATABASE_URL === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.DATABASE_URL;
    if (saved.POSTGRES_URL === undefined) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = saved.POSTGRES_URL;
  });
});
