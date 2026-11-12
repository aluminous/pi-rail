// /rail eval, /rail eval history, /rail eval cancel (MODEL_TRIAL_PLAN.md): the
// quick suite through the namer and judge this session would use right now —
// unsaved picker choices included — next to past runs of the same suite.
//
// Same runner as `npm run eval` (src/rail-eval.ts); what differs is only where
// the models and keys come from (ctx.modelRegistry, as the live reviewers get
// them) and that the namer and judge are two seats here, as in production.
//
// A run is not a decision. Its calls are accounted under the "eval" role in the
// cost tab and nothing else: no telemetry entry, no corpus record, no decision
// trace or spine entry, no stats counter, no session guidance.
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EvalCase } from "../../eval/cases.ts";
import { classifierEnabled, type CompleteFn } from "../classifier.ts";
import { loadConfig, type ResolvedRailConfig } from "../config.ts";
import { showRailView } from "../live-view.ts";
import {
  DEFAULT_EVAL_CONCURRENCY,
  DEFAULT_EVAL_WALL_CLOCK_MS,
  evalConfig,
  modelId,
  piVersion,
  quickCases,
  railVersion,
  runErrors,
  runRailEval,
  spendLine,
  suiteId,
  summarizeRun,
  type EvalRunError,
  type RailEvalRecord,
} from "../rail-eval.ts";
import { appendEvalRecord, defaultEvalHistoryPath, readEvalHistory } from "../rail-eval-history.ts";
import { renderEvalProgress, renderEvalReport } from "../rail-eval-report.ts";
import { resolveSeatModel, seatSpec } from "../reviewer-seats.ts";
import { recordModelCall, type RuntimeState } from "../state.ts";
import { streamingComplete } from "../streaming-complete.ts";
import { formatError } from "../util.ts";

export interface EvalCommandDeps {
  state: RuntimeState;
  notify(ctx: ExtensionContext, message: string, level?: "info" | "warning" | "error"): void;
  /** The completion function; default pi-ai streaming with the live idle timeout. */
  complete?: CompleteFn;
  /** History file; default `<agentDir>/rail-evals.jsonl`. */
  historyPath?: () => string;
  /** The suite; default the cases tagged quick in eval/cases.ts. */
  cases?: readonly EvalCase[];
  wallClockMs?: number;
  concurrency?: number;
  now?: () => Date;
  /** Render width for the plain-text report (headless and the RPC widget have no terminal to measure). */
  width?: number;
}

interface Prepared {
  config: ResolvedRailConfig;
  namer: Model<Api>;
  judge: Model<Api>;
  namerSpec: string;
  judgeSpec: string;
}

export function createEvalCommands(deps: EvalCommandDeps) {
  const { state, notify } = deps;
  const historyPath = deps.historyPath ?? defaultEvalHistoryPath;
  const cases = () => deps.cases ?? quickCases();
  const now = deps.now ?? (() => new Date());
  const width = deps.width ?? 100;
  /** The latest run started from `/rail eval` (tests await it). */
  let inflight: Promise<void> = Promise.resolve();

  function effective(ctx: ExtensionContext): ResolvedRailConfig {
    if (!state.config) state.config = loadConfig(ctx);
    return state.config!;
  }

  function present(ctx: ExtensionContext, lines: string[]): void {
    if (!ctx.hasUI) {
      console.log(lines.join("\n"));
      return;
    }
    showRailView(ctx, state, "report", () => lines);
  }

  function showHistory(ctx: ExtensionContext): void {
    present(ctx, renderEvalReport({ history: readEvalHistory(historyPath()), suite: suiteId(cases()), now: now().getTime(), width }));
  }

  function cancel(ctx: ExtensionContext): void {
    if (!state.evalRun) {
      notify(ctx, "No rail eval in flight.");
      return;
    }
    state.evalRun.abort();
    notify(ctx, "Stopping the rail eval; finished cases are kept and the run is recorded as incomplete.");
  }

  /** The two seats as this session would use them, with keys — or a refusal, before anything is spent. */
  async function prepare(ctx: ExtensionContext): Promise<Prepared | undefined> {
    const config = effective(ctx);
    if (!classifierEnabled(config, state.classifier)) {
      notify(ctx, "Rail eval needs the namer on, and the classifier is off: pick a namer with /rail model, then run /rail eval again.", "warning");
      return undefined;
    }
    const namerSpec = seatSpec(config, state.classifier, "namer");
    const judgeSpec = seatSpec(config, state.classifier, "judge");
    const namer = resolveSeatModel(ctx, config, state.classifier, "namer");
    if (!namer) {
      notify(ctx, `Rail eval cannot resolve the namer ("${namerSpec}"): pick one with /rail model.`, "error");
      return undefined;
    }
    const judge = resolveSeatModel(ctx, config, state.classifier, "judge");
    if (!judge) {
      notify(ctx, `Rail eval cannot resolve the judge ("${judgeSpec}"${judgeSpec === "current" ? ": no pi model is selected" : ""}): pick one with /rail model judge <provider/id>.`, "error");
      return undefined;
    }
    for (const [seat, model] of [["namer", namer], ["judge", judge]] as const) {
      try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey) {
          notify(ctx, `Rail eval: no credentials for the ${seat} (${modelId(model)}): ${auth.ok ? `no API key for ${model.provider}` : auth.error}.`, "error");
          return undefined;
        }
      } catch (error) {
        notify(ctx, `Rail eval: could not get credentials for the ${seat} (${modelId(model)}): ${formatError(error)}.`, "error");
        return undefined;
      }
    }
    return { config, namer, judge, namerSpec, judgeSpec };
  }

  async function execute(ctx: ExtensionContext, prepared: Prepared, controller: AbortController, run: { abort(): void }): Promise<void> {
    const suite = cases();
    const id = suiteId(suite);
    const spend = spendLine(suite);
    const view = { started: 0, done: 0, total: suite.length, startedAt: Date.now() };
    let report: string[] | undefined;
    const lines = () => report ?? renderEvalProgress({
      suite: id,
      namer: modelId(prepared.namer),
      judge: modelId(prepared.judge),
      spend,
      started: view.started,
      done: view.done,
      total: view.total,
      elapsedMs: Date.now() - view.startedAt,
    });
    if (ctx.hasUI) showRailView(ctx, state, "report", lines);
    // The view this run opened; a refresh goes to it only while it is still up.
    const ours = state.liveView;
    const refresh = () => {
      if (ours && state.liveView === ours) ours.refresh();
    };

    // The live seats' transport: streaming with the configured idle timeout.
    // The policy is the built-in one; only the timeout is the user's, since a
    // reviewer that times out live should time out here too.
    const timeoutMs = prepared.config.classifier.timeoutMs;
    const complete = deps.complete ?? streamingComplete({ idleTimeoutMs: timeoutMs });
    let record: RailEvalRecord;
    let errors: EvalRunError[];
    try {
      const result = await runRailEval({
        cases: suite,
        namer: prepared.namer,
        judge: prepared.judge,
        complete,
        completeSelfTimes: deps.complete === undefined,
        getAuth: async (model) => {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
          return auth.ok ? { ok: true, apiKey: auth.apiKey, headers: auth.headers } : { ok: false, error: auth.error };
        },
        config: evalConfig(timeoutMs),
        concurrency: deps.concurrency ?? DEFAULT_EVAL_CONCURRENCY,
        wallClockMs: deps.wallClockMs ?? DEFAULT_EVAL_WALL_CLOCK_MS,
        signal: controller.signal,
        onProgress: (progress) => {
          view.started = progress.started;
          view.done = progress.done;
          refresh();
        },
        onCall: (call) => recordModelCall(state, { role: "eval", model: modelId(call.model), latencyMs: call.latencyMs, usage: call.usage }),
      });
      errors = runErrors(result);
      record = summarizeRun(result, {
        suite: id,
        namer: prepared.namer,
        judge: prepared.judge,
        namerSpec: prepared.namerSpec,
        judgeSpec: prepared.judgeSpec,
        at: now(),
        ...optional("piVersion", piVersion()),
        ...optional("railVersion", railVersion()),
      });
    } finally {
      if (state.evalRun === run) state.evalRun = undefined;
    }

    const file = historyPath();
    const written = appendEvalRecord(record, file);
    const history = readEvalHistory(file);
    report = [
      ...renderEvalReport({ run: record, errors, history: written ? history : [...history, record], suite: id, now: now().getTime(), width }),
      "",
      written ? `History: ${file}` : `! History not written (${file} is not writable); this run is shown but not kept.`,
    ];
    const summary = `Rail eval: ${record.passed}/${record.cases} correct · ${record.criticalMisses} critical miss${record.criticalMisses === 1 ? "" : "es"}${record.incomplete ? " · incomplete" : ""}.`;
    if (!ctx.hasUI) {
      console.log(report.join("\n"));
      return;
    }
    if (ours && state.liveView === ours) refresh();
    else showRailView(ctx, state, "report", () => report!);
    notify(ctx, summary, record.criticalMisses > 0 || record.incomplete ? "warning" : "info");
  }

  /** `/rail eval`, `/rail eval history`, `/rail eval cancel`. */
  async function runEval(args: string, ctx: ExtensionContext): Promise<void> {
    const sub = args.trim().toLowerCase();
    if (sub === "history") return showHistory(ctx);
    if (sub === "cancel") return cancel(ctx);
    if (sub) {
      notify(ctx, "Usage: /rail eval | /rail eval history | /rail eval cancel", "warning");
      return;
    }
    if (state.evalRun) {
      notify(ctx, "A rail eval is already running. /rail eval cancel stops it.", "warning");
      return;
    }
    // The slot is taken before the credential checks await, so a second
    // /rail eval typed meanwhile is refused rather than started twice.
    const controller = new AbortController();
    const run = { abort: () => controller.abort() };
    state.evalRun = run;
    let prepared: Prepared | undefined;
    try {
      prepared = await prepare(ctx);
    } finally {
      if (!prepared && state.evalRun === run) state.evalRun = undefined;
    }
    if (!prepared) return;
    notify(ctx, `Rail eval: ${spendLine(cases())} (namer ${modelId(prepared.namer)}, judge ${modelId(prepared.judge)}).`);
    if (!ctx.hasUI) {
      // Headless: nobody to show progress to; run to the end and print.
      await execute(ctx, prepared, controller, run);
      return;
    }
    // Not awaited: the command returns at once and the run reports through
    // its docked panel, so typing and the main agent are never held up.
    const ready = prepared;
    const pending = execute(ctx, ready, controller, run).catch((error: unknown) => {
      if (state.evalRun === run) state.evalRun = undefined;
      notify(ctx, `Rail eval failed: ${formatError(error)}`, "error");
    });
    inflight = Promise.all([inflight, pending]).then(() => undefined);
  }

  return { runEval, evalSettled: () => inflight };
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
