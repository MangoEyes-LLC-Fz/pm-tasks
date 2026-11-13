import { describe, it, expect } from "vitest";
import { morningDue, ideasDue } from "../src/lib/morning";

describe("the 10:00 post never goes missing", () => {
  it("is due on a weekday from 10:05 India when no run is recorded for today", () => {
    expect(morningDue(new Date("2026-09-29T04:40:00Z"), null)).toBe(true);                         // Tue 10:10 IST, never ran
    expect(morningDue(new Date("2026-09-29T04:40:00Z"), "2026-09-28T04:30:10Z")).toBe(true);       // last run was Monday
    expect(morningDue(new Date("2026-09-29T04:40:00Z"), "2026-09-29T04:30:10Z")).toBe(false);      // ran today
    expect(morningDue(new Date("2026-09-29T04:20:00Z"), null)).toBe(false);                        // 09:50 IST: the cron's turn
    expect(morningDue(new Date("2026-09-27T06:00:00Z"), null)).toBe(false);                        // Sunday
  });
  it("posts the ideas every Monday, and catches up a missed Monday on the next run", () => {
    expect(ideasDue(new Date("2026-09-28T04:30:00Z"), "2026-09-21")).toBe(true);   // Monday
    expect(ideasDue(new Date("2026-09-29T04:35:00Z"), "2026-09-21")).toBe(true);   // Tuesday, last post 8 days ago
    expect(ideasDue(new Date("2026-09-29T04:35:00Z"), "2026-09-28")).toBe(false);  // Tuesday, Monday's post happened
    expect(ideasDue(new Date("2026-09-29T04:35:00Z"), null)).toBe(true);           // never posted
  });
});

describe("Monday's ideas fit in one post (2026-11-13)", () => {
  const now = new Date("2026-11-16T04:30:00Z");
  const idea = (id: string, client: string, daysAgo: number) => ({ id, clientId: client, client, text: `idea ${id}`, saidBy: null, source: null, sourceLink: null, saidAt: new Date(now.getTime() - daysAgo * 86_400_000) });
  it("gives a card to the newest ideas of the last four weeks and keeps the rest on record", async () => {
    const { pickIdeaCards, IDEA_CARDS_MAX } = await import("../src/lib/ideas");
    const many = [...Array.from({ length: 40 }, (_, k) => idea(`n${k}`, "HOH", k % 20)), ...Array.from({ length: 30 }, (_, k) => idea(`o${k}`, "Abela", 40 + k))];
    const { cards, rest } = pickIdeaCards(many, now);
    expect(cards.length).toBe(IDEA_CARDS_MAX);
    expect(cards.every((i) => i.client === "HOH")).toBe(true);
    expect(rest.length).toBe(45);
    // The newest win, and the cards keep the order of the list they came from.
    expect(cards.map((i) => i.id)).toEqual(many.filter((i) => cards.includes(i)).map((i) => i.id));
    expect(Math.max(...cards.map((i) => now.getTime() - i.saidAt.getTime()))).toBeLessThanOrEqual(Math.min(...rest.filter((i) => i.client === "HOH").map((i) => now.getTime() - i.saidAt.getTime())));
  });
  it("a short list is posted whole, and nothing is said about a rest that does not exist", async () => {
    const { pickIdeaCards, restLine } = await import("../src/lib/ideas");
    const few = [idea("a", "HOH", 2), idea("b", "Abela", 10)];
    expect(pickIdeaCards(few, now)).toEqual({ cards: few, rest: [] });
    expect(restLine([])).toBeNull();
  });
  it("the closing line says who it is for and what to do", async () => {
    const { restLine } = await import("../src/lib/ideas");
    const line = restLine([idea("a", "HOH", 50), idea("b", "HOH", 60), idea("c", "Abela", 70)])!;
    expect(line.startsWith("PMs: 3 older ideas are kept on record")).toBe(true);
    expect(line).toContain("HOH 2 · Abela 1");
    expect(line).toContain("send it to the Drop as a task");
    expect(restLine([idea("a", "HOH", 50)])).toContain("1 older idea is kept");
  });
});
