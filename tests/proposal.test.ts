import { describe, it, expect } from "vitest";
import { departmentOptions, dueOptions, matchPerson, DEPT_LABEL } from "../src/lib/proposal";
import { cardDescription } from "../src/lib/tasks";
import { proposalCard, ideaCard, doneCard } from "../src/lib/gchat";
import { mention } from "../src/lib/reminders-util";
import { reminderLine } from "../src/lib/reminders";
import { ideasHeadline } from "../src/lib/ideas";

const now = new Date("2026-09-22T08:35:00Z");

describe("the proposal card", () => {
  it("offers every department board, never the scope entry", () => {
    const d = departmentOptions();
    expect(d.map((x) => x.value)).toContain("dev");
    expect(d.map((x) => x.value)).toContain("general");
    expect(d.map((x) => x.value)).not.toContain("scope");
    expect(d.find((x) => x.value === "general")?.text).toBe(DEPT_LABEL.general);
  });
  it("puts the hub's due date first and pre-selects it", () => {
    const due = new Date("2026-09-24T04:30:00Z");
    const o = dueOptions(due, now);
    expect(o.due).toBe(due.toISOString());
    expect(o.dues[0].value).toBe(due.toISOString());
    expect(o.dues.length).toBeGreaterThan(5);
    expect(new Set(o.dues.map((x) => x.value)).size).toBe(o.dues.length);
  });
  it("matches a named person to someone on the boards, loosely", () => {
    const people = ["Anuj Laddha", "Heena Ganotra", "Renu Dahiya"];
    expect(matchPerson("@Anuj", people)).toBe("Anuj Laddha");
    expect(matchPerson("heena", people)).toBe("Heena Ganotra");
    expect(matchPerson("Renu Dahiya", people)).toBe("Renu Dahiya");
    expect(matchPerson("Shanur", people)).toBeNull();
    expect(matchPerson(null, people)).toBeNull();
  });
  it("has five visible dropdowns and three buttons, addressed to the person", () => {
    const card = proposalCard({
      requestId: "r1", askedName: "Heena Ganotra", askedUser: "users/123", clientName: "The SKIN Firm", title: "Update pricing for Hair Treatment", description: "Change the hair treatment prices on the pricing page.", quote: "MOST URGENT task is to get the pricing changed",
      departments: departmentOptions(), department: "content", people: ["Anuj Laddha"], assignee: null, priority: "P1", dues: dueOptions(null, now).dues, due: dueOptions(null, now).due, remindOn: "2026-09-23T04:30:00.000Z", urgentReason: "the sender said it is urgent",
    });
    const widgets = card.sections![0].widgets!;
    const dropdowns = widgets.filter((w) => w.selectionInput?.type === "DROPDOWN").map((w) => w.selectionInput!.name);
    expect(dropdowns).toEqual(["department", "assignee", "priority", "due", "remind_on"]);
    const buttons = widgets.find((w) => w.buttonList)!.buttonList!.buttons!.map((b) => b.text);
    expect(buttons).toEqual(["Create card", "Remind me instead", "No card"]);
    expect(JSON.stringify(widgets[0])).toContain("<users/123>: this needs your decision");
    expect(JSON.stringify(widgets)).not.toContain("rules");
    expect(JSON.stringify(widgets)).toContain("P1");
    expect(card.header?.title).toBe("The SKIN Firm · task to confirm");
  });
  it("idea and done cards say the action in full", () => {
    const idea = ideaCard({ ideaId: "i1", threadKey: "ideas-2026-09-28", clientName: "HOH", text: "CryoPen video", saidBy: "Anita", source: "Slack, Anita", sourceLink: null, since: "Sun 21 Sept", weeks: 1 });
    expect(JSON.stringify(idea)).toContain("Make it a task");
    expect(JSON.stringify(idea)).toContain("Not now");
    expect(JSON.stringify(idea)).toContain("still waiting for a decision since");
    expect(JSON.stringify(doneCard({ reminderId: "x" }))).toContain('"text":"Done"');
  });
});

describe("reminders and Monday's ideas speak to a named person", () => {
  it("@mentions by Chat account when known, by name otherwise", () => {
    expect(mention({ ownerName: "Heena", ownerUser: "users/123" })).toBe("<users/123>");
    expect(mention({ ownerName: "Heena Ganotra <heena@mangoeyesagency.com>", ownerUser: "heena@mangoeyesagency.com" })).toBe("@Heena Ganotra");
    expect(mention({ ownerName: "Heena", ownerUser: null })).toBe("@Heena");
  });
  it("the reminder line says who, what and what to do", () => {
    expect(reminderLine({ ownerName: "Heena", ownerUser: "users/1", text: "chase the GP for a date", dueAt: now, clientName: "Leicester MediSpa" }))
      .toBe("⏰ <users/1>: reminder you asked for · *Leicester MediSpa* · chase the GP for a date · press Done when handled");
    expect(reminderLine({ ownerName: "Heena", ownerUser: null, text: "x", dueAt: now, repeat: true })).toContain("still open");
  });
  it("the Monday line is to the PMs and says what to do, with the count per client", () => {
    const ideas = [
      { id: "1", clientId: "hoh", client: "House Of Health", text: "a", saidBy: null, source: null, sourceLink: null, saidAt: new Date("2026-09-24T10:00:00Z") },
      { id: "2", clientId: "hoh", client: "House Of Health", text: "b", saidBy: null, source: null, sourceLink: null, saidAt: new Date("2026-09-25T10:00:00Z") },
      { id: "3", clientId: "tsf", client: "The SKIN Firm", text: "c", saidBy: null, source: null, sourceLink: null, saidAt: new Date("2026-09-10T10:00:00Z") },
    ];
    expect(ideasHeadline(ideas, new Date("2026-09-28T04:30:00Z"))).toBe("💡 PMs: 3 ideas waiting, 1 from earlier weeks. Decide which become tasks. · House Of Health 2 · The SKIN Firm 1");
    expect(ideasHeadline(ideas.slice(0, 1), new Date("2026-09-28T04:30:00Z"))).toBe("💡 PMs: 1 idea from last week. Decide which become tasks. · House Of Health 1");
  });

  it("the Pulp card keeps the client's standing rules apart, at the bottom under their own heading", () => {
    const d = cardDescription({ draft: { title: "Update pricing", description: "Change the prices on the pricing page.", labels: [] }, quote: "please update the prices", channel: "slack", sender: "Fatima", permalink: null, requestId: "r1", rules: ["Ask before changing durations"], clientName: "HC MedSpa" });
    const lines = d.split("\n");
    expect(lines[0]).toBe("Change the prices on the pricing page.");
    expect(d.indexOf("Request: r1")).toBeLessThan(d.indexOf("HOW HC MEDSPA WANTS US TO WORK (standing rules, not part of this task):"));
    expect(lines[lines.length - 1]).toBe("- Ask before changing durations");
    expect(cardDescription({ draft: { title: "t", description: "d", labels: [] }, quote: "q", channel: "slack", sender: "s", permalink: null, requestId: "r2", rules: [], clientName: "HC MedSpa" })).not.toContain("WANTS US TO WORK");
  });
});
