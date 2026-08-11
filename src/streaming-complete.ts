import { stream, type Api, type Context, type Model, type ProviderStreamOptions } from "@earendil-works/pi-ai/compat";
import type { CompleteFn } from "./classifier.ts";

export type StreamFn = typeof stream;

/**
 * Rejected by a streamingComplete-wrapped call when the provider goes quiet
 * for longer than the idle budget. Distinct from a plain abort so callers can
 * tell "the request stalled" apart from "the user cancelled".
 */
export class IdleTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`no stream activity for ${timeoutMs}ms`);
    this.name = "IdleTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A CompleteFn built on the streaming API with an idle (stall) timeout
 * instead of a total deadline. The timer arms before the request goes out and
 * resets on every stream event, so a slow-but-progressing response may take
 * as long as it needs while a hung connection still fails after
 * `idleTimeoutMs` of silence.
 *
 * The result is shaped like an ordinary `complete()` call, so request flows
 * that are happy with the normal completion API never touch streaming: a
 * stall rejects with IdleTimeoutError, a parent-signal abort resolves to the
 * stream's aborted AssistantMessage, and provider errors arrive the same way
 * `complete()` surfaces them.
 */
export function streamingComplete(params: { idleTimeoutMs: number; streamFn?: StreamFn }): CompleteFn {
  const streamFn = params.streamFn ?? stream;
  return (async (
    model: Model<Api>,
    context: Context,
    options?: ProviderStreamOptions,
  ): Promise<Awaited<ReturnType<CompleteFn>>> => {
    const controller = new AbortController();
    let didIdleTimeout = false;
    const onIdle = () => {
      didIdleTimeout = true;
      controller.abort();
    };
    let timer: ReturnType<typeof setTimeout> = setTimeout(onIdle, params.idleTimeoutMs);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(onIdle, params.idleTimeoutMs);
    };
    const onParentAbort = () => controller.abort();
    options?.signal?.addEventListener("abort", onParentAbort, { once: true });
    try {
      const events = streamFn(model, context, { ...options, signal: controller.signal });
      for await (const _event of events) {
        reset();
      }
      const message = await events.result();
      if (didIdleTimeout) throw new IdleTimeoutError(params.idleTimeoutMs);
      return message;
    } catch (error) {
      // The abort also reaches us as a thrown error or an aborted final
      // message depending on the provider; either way a stall is a stall.
      if (didIdleTimeout && !(error instanceof IdleTimeoutError)) throw new IdleTimeoutError(params.idleTimeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onParentAbort);
    }
  }) as CompleteFn;
}
