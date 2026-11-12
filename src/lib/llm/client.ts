import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { env, routingForPrompt } from "../config";
import { sql } from "../db";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

// First-party per-MTok prices for the cost line in the EOD summary. Cache read 0.1×, cache write 1.25×.
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

function cost(model: string, u: Anthropic.Usage): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5"];
  const cr = u.cache_read_input_tokens ?? 0;
  const cw = u.cache_creation_input_tokens ?? 0;
  return (u.input_tokens * p.in + cr * p.in * 0.1 + cw * p.in * 1.25 + u.output_tokens * p.out) / 1_000_000;
}

/**
 * Shared request layout (PLAN §4e):
 *   system[0] static instructions        ← cache 1h
 *   system[1] routing table + client list ← cache 1h
 *   messages[0] the per-message context, after the breakpoint
 * Nothing volatile above the breakpoint. Config is rendered in fixed key order.
 */
export async function structuredCall<T extends z.ZodType>(opts: {
  step: "extract" | "classify" | "meeting" | "match" | "match_catchup";
  instructions: string;
  userContent: string;
  schema: T;
  maxTokens: number;
  messageId: string | null;
  /** A cheaper model for a small judgement (the card match). When the API will not serve it, the call runs once on the hub's own model. */
  model?: string;
  /** false: a short prompt that needs neither the routing table nor a cache entry of its own. */
  routing?: boolean;
}): Promise<z.infer<T>> {
  let model = opts.model || env.model();
  const started = Date.now();
  const system = opts.routing === false
    ? [{ type: "text" as const, text: opts.instructions }]
    : [
      { type: "text" as const, text: opts.instructions, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } },
      { type: "text" as const, text: `Request types:\n${routingForPrompt()}`, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } },
    ];
  const send = (maxTokens: number) => client().messages.parse({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: opts.userContent }],
    output_config: { format: zodOutputFormat(opts.schema), effort: "low" },
  });
  // The cheaper model is asked first. A request the API rejects for that model (not known to this account, a
  // parameter it does not take) runs on the hub's own model instead, so the step never stops over a model name.
  const call = async (maxTokens: number) => {
    try { return await send(maxTokens); }
    catch (e) {
      const rejected = e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.PermissionDeniedError;
      if (!rejected || model === env.model()) throw e;
      console.error(`model ${model} rejected for ${opts.step}, using ${env.model()}:`, (e as Error).message.slice(0, 200));
      model = env.model();
      return send(maxTokens);
    }
  };
  // A long answer (a meeting with many action items) can run past the budget and arrive as cut-off JSON. One retry
  // with four times the room; the budget is an upper bound, so a short answer costs the same either way.
  let res: Awaited<ReturnType<typeof call>>;
  try { res = await call(opts.maxTokens); }
  catch (e) {
    if (!/parse structured output|Unterminated|Unexpected end of JSON/i.test((e as Error).message)) throw e;
    res = await call(opts.maxTokens * 4);
  }
  if (res.stop_reason === "max_tokens") res = await call(opts.maxTokens * 4);
  const latency = Date.now() - started;

  await sql()`
    insert into llm_calls (step, model, message_id, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, latency_ms)
    values (${opts.step}, ${model}, ${opts.messageId}, ${res.usage.input_tokens},
            ${res.usage.cache_read_input_tokens ?? 0}, ${res.usage.cache_creation_input_tokens ?? 0},
            ${res.usage.output_tokens}, ${cost(model, res.usage)}, ${latency})`;

  if (res.stop_reason === "refusal") throw new Error(`model refused (${opts.step})`);
  if (!res.parsed_output) throw new Error(`model output did not match schema (${opts.step})`);
  return res.parsed_output;
}
