import { z } from "zod";
import { structuredCall } from "./client";

/**
 * Is a card someone made in Pulp the same work as an ask the hub is still waiting on? (2026-11-12)
 *
 * The team sometimes makes the card by hand, or with another tool, instead of tapping Create card in the feed. The
 * wording of such a card rarely matches the hub's title, so this is a judgement of meaning, not of words. One small
 * call per client, only when there is both a new card and a waiting ask; the cheapest current model does it
 * (`LLM_MODEL_MATCH`, default below), with thinking kept low.
 */
export const MATCH_MODEL = () => process.env.LLM_MODEL_MATCH || "claude-haiku-5-5";

export const MatchSchema = z.object({
  matches: z.array(z.object({
    ask: z.number().describe("The number of the ask, as listed"),
    card: z.number().describe("The number of the card, as listed"),
    // An invented option falls back to the careful one: a person is asked, nothing is closed on its own.
    verdict: z.enum(["same", "probably"]).describe("same: certain this card is the work this ask describes; probably: likely the same work, a person should confirm").catch("probably"),
  })).describe("Only the pairs that match. An ask with no matching card is left out. At most one card per ask and one ask per card."),
});
export type MatchAnswer = z.infer<typeof MatchSchema>;

const INSTRUCTIONS = `You compare two lists for one client of a digital marketing agency (MangoEyes: websites, content, design, SEO, paid ads, CRM automations, video for clinics).
ASKS are pieces of work the client or the team asked for. Each has a title the system wrote and the person's own words.
CARDS are task cards a team member made by hand on the agency's task board. Their titles are written in the team's own shorthand and will rarely use the same words as an ask.
For each ask, decide whether one of the cards is that same piece of work, judging by what has to be produced, not by shared words.
- same: you are certain. The card is clearly this deliverable and this change for this client. A different wording, an abbreviation, a sprint or week prefix, or a narrower title for the same job are all fine.
- probably: the card looks like this work but you cannot be certain: the card is broader or vaguer than the ask ("website fixes"), covers only part of it, or could be a neighbouring task on the same page or campaign.
- no match: leave the ask out. Two different tasks about the same page, treatment or campaign are not a match. A recurring or weekly card (monthly blogs, weekly ads batch) matches only an ask for that very batch.
Never pair an ask with a card just because nothing else fits. Most asks have no card: an empty list is a normal answer.
Use each ask and each card at most once; if two cards fit one ask, pick the closer one.`;

export interface AskForMatch { title: string; words: string; day: string }
export interface CardForMatch { title: string; list: string; assignee: string | null; labels: string[]; day: string; description: string }

/** Pure: the two numbered lists the model reads. */
export function matchPrompt(clientName: string, asks: AskForMatch[], cards: CardForMatch[]): string {
  const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
  return [
    `Client: ${clientName}`,
    "",
    "ASKS",
    ...asks.map((a, i) => `${i + 1}. ${clip(a.title, 120)} (asked ${a.day})${a.words ? `\n   Words: "${clip(a.words, 240)}"` : ""}`),
    "",
    "CARDS",
    ...cards.map((c, i) => `${i + 1}. ${clip(c.title, 140)} · list ${c.list || "unknown"}${c.assignee ? ` · ${c.assignee}` : ""}${c.labels.length ? ` · labels: ${c.labels.slice(0, 6).join(", ")}` : ""} · made ${c.day}${c.description ? `\n   Description: ${clip(c.description, 240)}` : ""}`),
  ].join("\n");
}

/** Pure: keep only pairs that point at real rows, one card per ask and one ask per card ("same" before "probably"). */
export function cleanMatches(answer: MatchAnswer, asks: number, cards: number): Array<{ ask: number; card: number; verdict: "same" | "probably" }> {
  const out: Array<{ ask: number; card: number; verdict: "same" | "probably" }> = [];
  const usedAsk = new Set<number>(), usedCard = new Set<number>();
  const ordered = [...answer.matches].sort((a, b) => (a.verdict === "same" ? 0 : 1) - (b.verdict === "same" ? 0 : 1));
  for (const m of ordered) {
    const a = Math.round(m.ask) - 1, c = Math.round(m.card) - 1;
    if (!(a >= 0 && a < asks && c >= 0 && c < cards) || usedAsk.has(a) || usedCard.has(c)) continue;
    usedAsk.add(a); usedCard.add(c);
    out.push({ ask: a, card: c, verdict: m.verdict });
  }
  return out;
}

export async function judgeMatches(opts: { clientName: string; asks: AskForMatch[]; cards: CardForMatch[]; messageId: string | null; step?: "match" | "match_catchup" }): Promise<Array<{ ask: number; card: number; verdict: "same" | "probably" }>> {
  if (!opts.asks.length || !opts.cards.length) return [];
  const answer = await structuredCall({
    step: opts.step ?? "match", instructions: INSTRUCTIONS, userContent: matchPrompt(opts.clientName, opts.asks, opts.cards),
    schema: MatchSchema, maxTokens: 2000, messageId: opts.messageId, model: MATCH_MODEL(), routing: false,
  });
  return cleanMatches(answer, opts.asks.length, opts.cards.length);
}
