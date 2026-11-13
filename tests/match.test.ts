import { describe, it, expect } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { pairAllowed, sureWithoutModel, whoTag, closedLine, confirmedLine, questionText, cardsNear, matchDailyCap, historyWindow, MADE_IN_PULP, MATCH_DAILY_CAP, CATCHUP_CALL_CAP, HISTORY_CALL_CAP } from "../src/lib/match";
import { MatchSchema, matchPrompt, cleanMatches, MATCH_MODEL } from "../src/lib/llm/match";
import { matchQuestionCard, matchUndoCard } from "../src/lib/gchat";
import { boardCardsFingerprint } from "../src/lib/idle";

/**
 * 2026-11-12: a card made outside the feed (by hand in Pulp, or by another tool) closes the ask the hub was still
 * waiting on. Cost is the design rule: free proofs first, one small call on the cheapest model otherwise, capped.
 */
const day = (s: string) => new Date(`${s}T10:00:00Z`);
const ask = (over: Partial<{ id: string; title: string; permalink: string | null; createdAt: Date; notSame: string[] }> = {}) =>
  ({ id: "3f968ad2-fe5b-43bc-ba95-92788b6c13e3", title: "Update injectables and Botox pricing on website", permalink: "https://hcmedspa.slack.com/archives/C09M76QPU3H/p1790767268001800", createdAt: day("2026-11-10"), notSame: [], ...over });
const card = (over: Partial<{ cardId: string; title: string; description: string; createdAt: Date }> = {}) =>
  ({ cardId: "c1", title: "HC >> price changes injectables page", description: "", createdAt: day("2026-11-11"), ...over });

describe("which card may be an ask's card at all", () => {
  it("a card made after the ask, or up to three days before it (made right after the call)", () => {
    expect(pairAllowed(ask(), card())).toBe(true);
    expect(pairAllowed(ask(), card({ createdAt: day("2026-11-08") }))).toBe(true);
    expect(pairAllowed(ask(), card({ createdAt: day("2026-11-01") }))).toBe(false);
  });
  it("never a card a person already said is a different task", () => {
    expect(pairAllowed(ask({ notSame: ["c1"] }), card())).toBe(false);
  });
});

describe("proof that needs no model, so it costs nothing", () => {
  it("the ask's id or its source link written on the card", () => {
    expect(sureWithoutModel(ask(), card({ description: "from the feed · Request: 3f968ad2-fe5b-43bc-ba95-92788b6c13e3" }))).toBe("link");
    expect(sureWithoutModel(ask(), card({ description: "see https://hcmedspa.slack.com/archives/C09M76QPU3H/p1790767268001800" }))).toBe("link");
  });
  it("the same title, however it is punctuated or cased", () => {
    expect(sureWithoutModel(ask(), card({ title: "update injectables & botox pricing on website!" }))).toBeNull(); // "&" is not "and": left to the model
    expect(sureWithoutModel(ask(), card({ title: "UPDATE injectables and Botox pricing — on website" }))).toBe("title");
  });
  it("different wording proves nothing here; a short generic title never matches by words alone", () => {
    expect(sureWithoutModel(ask(), card())).toBeNull();
    expect(sureWithoutModel(ask({ title: "Fix page" }), card({ title: "fix page" }))).toBeNull();
    expect(sureWithoutModel(ask({ permalink: null }), card({ description: "" }))).toBeNull();
  });
});

describe("the lines the hub writes say who they are for and what to do", () => {
  const c = { title: "HC >> price changes injectables page", listName: "In Progress", assignee: "Nishit", link: "https://pulp.mangoeyes.io/board/b?card=c1" };
  it("closed by the hub: named person, nothing to do, the card, and how to undo", () => {
    const l = closedLine({ who: "<users/123>", askTitle: "Update Botox pricing", card: c });
    expect(l).toContain("<users/123>: nothing to do here");
    expect(l).toContain('"HC >> price changes injectables page" · In Progress · Nishit · <https://pulp.mangoeyes.io/board/b?card=c1|open the card>');
    expect(l).toContain("Not the same task? Tap the button");
  });
  it("confirmed by a person, and the question when the hub is not certain", () => {
    expect(confirmedLine({ by: "Heena Ganotra", askTitle: "Update Botox pricing", card: { ...c, assignee: null } })).toContain("confirmed by Heena Ganotra");
    expect(confirmedLine({ by: "Heena Ganotra", askTitle: "x", card: { ...c, assignee: null } })).toContain("nobody assigned yet");
    expect(questionText({ who: "@Heena Ganotra", askTitle: "Update Botox pricing" })).toBe('@Heena Ganotra: is this card in Pulp the same task as "Update Botox pricing"? Tap one button.');
  });
  it("addresses the Chat account, else the name, else the PMs", () => {
    expect(whoTag({ askedName: "Heena", askedUser: "users/123" })).toBe("<users/123>");
    expect(whoTag({ askedName: "Heena", askedUser: "heena@mangoeyesagency.com" })).toBe("@Heena");
    expect(whoTag({ askedName: null, askedUser: null })).toBe("PMs");
  });
  it("the question card has the two buttons, the closed line one undo button", () => {
    const q = matchQuestionCard({ requestId: "r1", taskId: "t1", askTitle: "Update Botox pricing", card: c });
    expect(q.sections![0].widgets!.find((w) => w.buttonList)!.buttonList!.buttons!.map((b) => b.text)).toEqual(["Yes, same task", "No, different"]);
    expect(matchUndoCard({ requestId: "r1" }).sections![0].widgets![0].buttonList!.buttons!.map((b) => b.text)).toEqual(["Not the same task"]);
  });
});

describe("the model's answer", () => {
  it("an option outside the list becomes the careful one: a person is asked, nothing closes on its own", () => {
    const a = MatchSchema.parse({ matches: [{ ask: 1, card: 2, verdict: "identical" }, { ask: 2, card: 1, verdict: "same" }] });
    expect(a.matches.map((m) => m.verdict)).toEqual(["probably", "same"]);
  });
  it("only real rows, one card per ask and one ask per card, certain pairs first", () => {
    const out = cleanMatches({ matches: [{ ask: 1, card: 1, verdict: "probably" }, { ask: 2, card: 1, verdict: "same" }, { ask: 9, card: 1, verdict: "same" }, { ask: 3, card: 0, verdict: "same" }, { ask: 1, card: 2, verdict: "same" }] }, 3, 2);
    expect(out).toEqual([{ ask: 1, card: 0, verdict: "same" }, { ask: 0, card: 1, verdict: "same" }]);
  });
  it("reads two short numbered lists: the ask with the person's words, the card as the team wrote it", () => {
    const p = matchPrompt("HC MedSpa", [{ title: "Update Botox pricing", words: "can you change the botox prices please", day: "2026-11-10" }],
      [{ title: "HC >> price changes injectables page", list: "To Do", assignee: "Nishit", labels: ["HC Medspa", "Week 46"], day: "2026-11-11", description: "" }]);
    expect(p).toContain("Client: HC MedSpa");
    expect(p).toContain('1. Update Botox pricing (asked 2026-11-10)\n   Words: "can you change the botox prices please"');
    expect(p).toContain("1. HC >> price changes injectables page · list To Do · Nishit · labels: HC Medspa, Week 46 · made 2026-11-11");
  });
  it("the format sent to the model lists both verdicts", () => {
    expect(JSON.stringify(zodOutputFormat(MatchSchema))).toContain('enum: [\\"same\\",\\"probably\\"]');
  });
});

describe("cost guards", () => {
  it("runs on the cheapest current model unless told otherwise, and never as the system for a person", () => {
    delete process.env.LLM_MODEL_MATCH;
    expect(MATCH_MODEL()).toBe("claude-haiku-5-5");
    expect(MADE_IN_PULP).toBe("system:made_in_pulp");
  });
  it("has a daily ceiling and a ceiling for the one-time catch-up", () => {
    expect(MATCH_DAILY_CAP).toBeLessThanOrEqual(50);
    delete process.env.MATCH_DAILY_CAP; expect(matchDailyCap()).toBe(MATCH_DAILY_CAP);
    process.env.MATCH_DAILY_CAP = "0"; expect(matchDailyCap()).toBe(0); // the model part off, the free checks stay
    process.env.MATCH_DAILY_CAP = "abc"; expect(matchDailyCap()).toBe(MATCH_DAILY_CAP);
    delete process.env.MATCH_DAILY_CAP;
    expect(CATCHUP_CALL_CAP).toBeLessThanOrEqual(300);
  });
  it("the catch-up sends at most the cards nearest in time to a group of asks", () => {
    const asks = [{ createdAt: day("2026-10-10") }, { createdAt: day("2026-10-12") }];
    const cards = [day("2026-10-01"), day("2026-10-09"), day("2026-10-11"), day("2026-10-20"), day("2026-11-05")].map((createdAt, i) => ({ createdAt, i }));
    expect(cardsNear(asks, cards, 10).map((c) => c.i)).toEqual([2, 1, 3]);
    expect(cardsNear(asks, cards, 1).map((c) => c.i)).toEqual([2]);
    expect(cardsNear([], cards, 10)).toEqual([]);
  });
  it("a card's description is not part of the board fingerprint: editing it never wakes the database", () => {
    const base = { id: "c1", listId: "l1", title: "t", labels: ["HC Medspa"] };
    expect(boardCardsFingerprint([{ ...base, description: "one" } as typeof base], false)).toBe(boardCardsFingerprint([{ ...base, description: "two" } as typeof base], false));
  });
});

describe("the whole history, once (2026-11-13)", () => {
  it("compares a group of past asks with the cards made from three days before the first to two weeks after the last", () => {
    const w = historyWindow([{ createdAt: day("2026-10-10") }, { createdAt: day("2026-10-12") }]);
    expect(w.from.toISOString().slice(0, 10)).toBe("2026-10-07");
    expect(w.to.toISOString().slice(0, 10)).toBe("2026-10-26");
  });
  it("has its own ceiling, counted apart from the live path's daily one", () => {
    expect(HISTORY_CALL_CAP).toBeLessThanOrEqual(500);
  });
  it("the closed line fits a card made by hand and a card made through Claude alike", () => {
    expect(closedLine({ who: "PMs", askTitle: "x", card: { title: "t", listName: "To Do", assignee: null, link: "" } })).toContain("made outside this thread");
  });
});

