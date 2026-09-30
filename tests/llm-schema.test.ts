import { describe, it, expect } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ExtractSchema } from "../src/lib/llm/extract";
import { ClassifySchema } from "../src/lib/llm/classify";
import { MeetingSchema } from "../src/lib/llm/meeting";

/**
 * 2026-09-30: the model answered kind = "explanation" for a Slack question and the strict parse threw the message
 * away six times. An option the model invents falls back to the safe one; the rest of the answer is kept.
 */
const ask = { ask: "Do clients get notified when added to the pipeline?", quote: "do clients get notified", deadline: null, urgent: false, remind_at: null, owner: null, urls: [] };

describe("model answers with an option outside the list", () => {
  it("extract: an unknown kind is a note, an unknown tone is neutral, the rest is kept", () => {
    const out = ExtractSchema.parse({ summary: ["asks about notifications"], asks: [{ ...ask, kind: "explanation" }, { ...ask, kind: "task" }], is_request: false, tone: "curious", needs_reply: true });
    expect(out.asks.map((a) => a.kind)).toEqual(["note", "task"]);
    expect(out.tone).toBe("neutral");
    expect(out.needs_reply).toBe(true);
  });

  it("classify: unknown department is general, unknown priority is P3, unknown same_as_kind is null", () => {
    const out = ClassifySchema.parse({ request_type: "web_change", department: "marketing", priority_hint: "P0", priority_reason: null, confidence: 0.8, confidence_reason: "x", same_as_open: 0, same_as_kind: "related", title: "Fix the form", description: "d", labels: [] });
    expect(out.department).toBe("general");
    expect(out.priority_hint).toBe("P3");
    expect(out.same_as_kind).toBeNull();
  });

  it("meeting: an unknown item kind is discussion and an unknown side is agency (a person still confirms)", () => {
    const out = MeetingSchema.parse({ meeting_client: null, summary: ["s"], items: [{ kind: "question", text: "t", client: null, owner: null, work: false, side: "both", due: null }] });
    expect(out.items[0].kind).toBe("discussion");
    expect(out.items[0].side).toBe("agency");
  });

  it("the format sent to the model still lists every option and its description", () => {
    const schema = JSON.stringify(zodOutputFormat(ExtractSchema));
    expect(schema).toContain('enum: [\\"task\\",\\"reminder\\",\\"idea\\",\\"rule\\",\\"note\\"]');
    expect(schema).toContain("task: a MangoEyes person must produce something");
    expect(JSON.stringify(zodOutputFormat(MeetingSchema))).toContain('enum: [\\"agency\\",\\"client\\"]');
  });
});
