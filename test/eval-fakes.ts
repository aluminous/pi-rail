// A scripted reviewer for the eval runner and /rail eval: answers each call
// by which case it is about (found by the case's command or path inside the
// projection) and which seat is asking (the system prompt), so tests can say
// "the namer labels exfil-ssh-key as read-project" without ordering calls.
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { EvalCase } from "../eval/cases.ts";
import type { CompleteFn } from "../src/classifier.ts";

export type FakeSeat = "namer" | "judge";

export interface FakeAnswer {
  /** Namer labels; default the case's documented intent. */
  labels?: string[];
  /** Judge decision; default the case's first expected decision. */
  decision?: "allow" | "deny" | "ask";
  /** Simulated latency, applied to the fake clock (and, with realDelay, to real time). */
  namerMs?: number;
  judgeMs?: number;
  /** Never answers until the call is aborted. */
  hang?: FakeSeat;
  /** This seat's every call throws the error, or replies with this text instead of valid JSON. */
  fail?: { seat: FakeSeat; error?: Error; reply?: string };
}

export function fakeModel(provider: string, id: string, cost = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }): Model<Api> {
  return { provider, id, api: "anthropic-messages", name: id, cost } as unknown as Model<Api>;
}

function needle(evalCase: EvalCase): string {
  const value = (evalCase.input.command ?? evalCase.input.path) as string;
  return JSON.stringify(value).slice(1, -1);
}

export function scriptedReviewer(
  cases: readonly EvalCase[],
  answers: Record<string, FakeAnswer> = {},
  options: { clock?: { now: number }; realDelay?: boolean; usage?: { input: number; output: number; cacheRead: number } } = {},
) {
  const calls: Array<{ seat: FakeSeat; case: string; model: string }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const complete = (async (model: Model<Api>, context: { systemPrompt?: string; messages: Array<{ content: Array<{ type: string; text?: string }> }> }, opts?: { signal?: AbortSignal }) => {
    const seat: FakeSeat = context.systemPrompt?.startsWith("You are the capability namer") ? "namer" : "judge";
    const text = context.messages.map((message) => message.content.find((part) => part.type === "text")?.text ?? "").join("\n");
    const evalCase = cases.find((candidate) => text.includes(needle(candidate)));
    if (!evalCase) throw new Error(`fake reviewer: no case matches the ${seat} call`);
    calls.push({ seat, case: evalCase.name, model: `${model.provider}/${model.id}` });
    const answer = answers[evalCase.name] ?? {};
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (answer.hang === seat) {
        await new Promise((_resolve, reject) => {
          if (opts?.signal?.aborted) reject(new Error("aborted"));
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      const delay = (seat === "namer" ? answer.namerMs : answer.judgeMs) ?? 0;
      if (options.clock) options.clock.now += delay;
      if (options.realDelay && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      else await new Promise((resolve) => setImmediate(resolve));
      if (answer.fail?.seat === seat && answer.fail.error) throw answer.fail.error;
      const reply = answer.fail?.seat === seat && answer.fail.reply !== undefined ? answer.fail.reply : seat === "namer"
        ? JSON.stringify({ labels: answer.labels ?? evalCase.intent ?? ["unclassified"] })
        : (() => {
            const decision = answer.decision ?? evalCase.expect[0]!;
            return JSON.stringify(decision === "ask" ? { decision, action: "does a thing", risk: "might matter" } : { decision, reason: `judged ${decision}` });
          })();
      return {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: reply }],
        usage: { input: options.usage?.input ?? (seat === "namer" ? 1000 : 2000), output: options.usage?.output ?? 50, cacheRead: options.usage?.cacheRead ?? 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: seat === "namer" ? 0.001 : 0.004 } },
        timestamp: Date.now(),
      };
    } finally {
      inFlight--;
    }
  }) as unknown as CompleteFn;
  return { complete, calls, maxInFlight: () => maxInFlight };
}
