// streamingComplete wraps the streaming API in a CompleteFn shape with an
// idle (stall) timeout: the clock resets on every event, so only a silent
// stream times out, never a slow one. Faked with a real
// AssistantMessageEventStream fed on a schedule.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai/compat";
import { IdleTimeoutError, streamingComplete, type StreamFn } from "../src/streaming-complete.ts";

const model = { provider: "test", id: "fake-model" } as Model<Api>;
const context = { messages: [] } as unknown as Parameters<StreamFn>[1];

function finalMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text }],
    usage: { input: 1, output: 1 },
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/**
 * A streamFn that emits `events` on the given delays (ms after the previous
 * event) and then ends with `final`. Any event may be "waitForAbort" to go
 * silent until the call's signal aborts, simulating a stalled request.
 */
function fakeStreamFn(schedule: Array<{ delayMs: number } | "waitForAbort">, final: AssistantMessage): { streamFn: StreamFn; sawSignal: () => AbortSignal | undefined } {
  let signal: AbortSignal | undefined;
  const streamFn: StreamFn = ((_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
    signal = options?.signal;
    const events = createAssistantMessageEventStream();
    (async () => {
      for (const step of schedule) {
        if (step === "waitForAbort") {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, step.delayMs));
        if (signal?.aborted) break;
        events.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: final });
      }
      events.push({ type: "done", reason: "stop", message: final });
    })();
    return events;
  }) as unknown as StreamFn;
  return { streamFn, sawSignal: () => signal };
}

describe("streamingComplete", () => {
  it("resolves with the final message when the stream keeps making progress, however long it takes overall", async () => {
    // Total runtime ~90ms with a 30ms idle budget: a total deadline would
    // abort this, the idle timeout must not.
    const { streamFn } = fakeStreamFn([{ delayMs: 25 }, { delayMs: 25 }, { delayMs: 25 }, { delayMs: 15 }], finalMessage("done"));
    const complete = streamingComplete({ idleTimeoutMs: 30, streamFn });
    const message = await complete(model, context, { apiKey: "k" });
    assert.equal(message.stopReason, "stop");
    assert.equal(message.content[0]?.type, "text");
  });

  it("rejects with IdleTimeoutError when the stream goes silent", async () => {
    const { streamFn, sawSignal } = fakeStreamFn([{ delayMs: 5 }, "waitForAbort"], finalMessage("never"));
    const complete = streamingComplete({ idleTimeoutMs: 30, streamFn });
    await assert.rejects(
      () => complete(model, context, { apiKey: "k" }),
      (error: unknown) => {
        assert.ok(error instanceof IdleTimeoutError);
        assert.equal(error.timeoutMs, 30);
        return true;
      },
    );
    assert.ok(sawSignal()?.aborted, "the stall must abort the provider call");
  });

  it("times out before the first token too, covering connect + TTFT", async () => {
    const { streamFn } = fakeStreamFn(["waitForAbort"], finalMessage("never"));
    const complete = streamingComplete({ idleTimeoutMs: 20, streamFn });
    await assert.rejects(() => complete(model, context, { apiKey: "k" }), IdleTimeoutError);
  });

  it("a parent abort surfaces as the aborted message, not as an idle timeout", async () => {
    const aborted = {
      role: "assistant",
      stopReason: "aborted",
      content: [],
      timestamp: Date.now(),
    } as unknown as AssistantMessage;
    const streamFn: StreamFn = ((_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
      const events = createAssistantMessageEventStream();
      options?.signal?.addEventListener(
        "abort",
        () => events.push({ type: "error", reason: "aborted", error: aborted }),
        { once: true },
      );
      return events;
    }) as unknown as StreamFn;
    const complete = streamingComplete({ idleTimeoutMs: 10_000, streamFn });
    const parent = new AbortController();
    const pending = complete(model, context, { apiKey: "k", signal: parent.signal });
    parent.abort();
    const message = await pending;
    assert.equal(message.stopReason, "aborted");
  });
});
