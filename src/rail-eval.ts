// The shared eval runner (MODEL_TRIAL_PLAN.md): one path for `npm run eval`
// (eval/run.ts) and `/rail eval` (src/commands/eval.ts), so the CLI benchmark
// and the in-session quick check cannot measure two different pipelines.
//
// The pipeline is the live one, minus everything that is the user's: content
// screen → namer → built-in disposition table → judge when the table escalates.
// A write/edit whose content screens clean takes the screen's deterministic
// label without a namer call, exactly as the interceptor does; that case is
// "deterministic" and belongs to neither seat. The other deterministic stages
// of the live rail (path policy, read exemption, command allowlist) are left
// out on purpose: they depend on the user's filesystem config and sandbox,
// which would make runs incomparable across machines — and they never call a
// model, which is all this measures.
//
// Seat attribution: a case is *decided by the namer* when the table resolves
// its labels without `judge`, and *decided by the judge* otherwise. A case
// whose seat call failed is decided (wrongly) by that seat, so an outage shows
// up against the model that had it. Latency and tokens are per seat call: the
// namer's numbers include its calls on cases the judge went on to decide.
//
// Nothing here touches RuntimeState: telemetry, the replay corpus, the
// decision spine and session guidance are for decisions, and these are not.
// The caller gets each model call through onCall and decides what to record.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { EVAL_CASES, type EvalCase } from "../eval/cases.ts";
import { createCapabilityState, resolveCapabilities, type CapabilityId } from "./capabilities.ts";
import { defaultSleep, runJudging, runNaming, type ClassifierAuthResult, type ClassifierIO, type CompleteFn, type RailDecision } from "./classifier.ts";
import { classifyClassifierFailure, type ClassifierTokenUsage } from "./classifier-protocol.ts";
import { DEFAULT_CONFIG, type ResolvedRailConfig } from "./config.ts";
import { screenToolCall } from "./content-screen.ts";
import { errorChain, formatError } from "./util.ts";

export type EvalSeat = "namer" | "judge";
export type EvalDecidedBy = EvalSeat | "deterministic";

/** A fixed, plausible project path: the namer sees a cwd, and a real one would leak the user's layout into nothing useful. */
export const EVAL_CWD = "/Users/dev/projects/acme-app";

/** Cases run at once in `/rail eval`: enough to halve the wall time, few enough not to trip a provider's rate limit. */
export const DEFAULT_EVAL_CONCURRENCY = 2;
/** Wall-clock limit for one `/rail eval` run; the quick suite targets well under half of this. */
export const DEFAULT_EVAL_WALL_CLOCK_MS = 90_000;

/**
 * The built-in policy with the classifier on: runs measure the shipped table,
 * never the user's, so they stay comparable over time and across machines.
 */
export function evalConfig(timeoutMs = 30_000): ResolvedRailConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.classifier.enabled = true;
  config.classifier.timeoutMs = timeoutMs;
  return config;
}

// ── The quick suite ─────────────────────────────────────────────────────────

/** The quick suite: cases tagged `quick: true` in eval/cases.ts, in file order. */
export function quickCases(cases: readonly EvalCase[] = EVAL_CASES): EvalCase[] {
  return cases.filter((evalCase) => evalCase.quick === true);
}

/** JSON with object keys sorted, so the suite id does not move when a literal is reformatted. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A short, stable hash of what makes two runs the same test: each case's name,
 * tool, input, expected set and criticality. Notes and intent are left out —
 * editing documentation must not orphan a history — and `expect` is sorted
 * because its order means nothing.
 */
export function suiteId(cases: readonly EvalCase[]): string {
  const material = cases.map((evalCase) => ({
    name: evalCase.name,
    toolName: evalCase.toolName,
    input: evalCase.input,
    expect: [...evalCase.expect].sort(),
    critical: evalCase.critical === true,
  }));
  return crypto.createHash("sha256").update(canonicalJson(material)).digest("hex").slice(0, 6);
}

/** The label a clean write/edit takes from the screen without a namer call, or undefined when the namer must run. */
export function deterministicLabel(evalCase: EvalCase, cwd = EVAL_CWD): CapabilityId | undefined {
  // Bash gets the screen's text layer only and always reaches the namer; the
  // deterministic label is a write/edit property (see interceptor stage 3).
  if (evalCase.toolName === "bash") return undefined;
  return screenToolCall(evalCase.toolName, evalCase.input, cwd).label;
}

/**
 * "8 cases, about 12 model calls on your accounts": one namer call per case the
 * screen does not decide, plus a judge call per case whose documented intent
 * (or deterministic label) resolves to judge. "About" because retries and a
 * namer that disagrees with the intent move it either way.
 */
export function spendEstimate(cases: readonly EvalCase[]): { cases: number; calls: number } {
  const config = evalConfig();
  let calls = 0;
  for (const evalCase of cases) {
    const fixed = deterministicLabel(evalCase);
    if (!fixed) calls++;
    const labels = fixed ? [fixed] : evalCase.intent;
    if (labels && resolveCapabilities(config, createCapabilityState(), labels).disposition === "judge") calls++;
  }
  return { cases: cases.length, calls };
}

export function spendLine(cases: readonly EvalCase[]): string {
  const estimate = spendEstimate(cases);
  return `${estimate.cases} case${estimate.cases === 1 ? "" : "s"}, about ${estimate.calls} model call${estimate.calls === 1 ? "" : "s"} on your accounts`;
}

// ── Cost ────────────────────────────────────────────────────────────────────

interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The model's registry price in $/million tokens, or undefined when it has
 * none. Read structurally: `cost` is a required field in pi-ai 0.84 but a
 * catalog entry (or a synthesized one) can carry zeros, and zeros mean
 * "unknown" here, never "free".
 */
function registryRates(model: Model<Api>): Rates | undefined {
  const raw = (model as { cost?: unknown }).cost;
  if (!raw || typeof raw !== "object") return undefined;
  const cost = raw as Record<string, unknown>;
  const rate = (key: string) => (typeof cost[key] === "number" && Number.isFinite(cost[key]) ? (cost[key] as number) : 0);
  const rates = { input: rate("input"), output: rate("output"), cacheRead: rate("cacheRead"), cacheWrite: rate("cacheWrite") };
  return rates.input > 0 || rates.output > 0 ? rates : undefined;
}

/**
 * Dollars for one seat call, or undefined when nothing prices it. pi-ai already
 * computes `usage.cost` from the registry price on every completion, so the
 * usage's own figure wins; it is only trusted at zero when the registry really
 * has a price (otherwise a zero is the absence of one). The rates are the
 * fallback for a completion function that reports tokens but no cost.
 */
export function callCostUsd(model: Model<Api>, usage: ClassifierTokenUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const rates = registryRates(model);
  if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && (usage.costUsd > 0 || rates)) return usage.costUsd;
  if (!rates) return undefined;
  return (
    (rates.input * usage.input + rates.output * usage.output + rates.cacheRead * (usage.cacheRead ?? 0) + rates.cacheWrite * (usage.cacheWrite ?? 0)) / 1_000_000
  );
}

// ── Running ─────────────────────────────────────────────────────────────────

export interface RailEvalCaseResult {
  name: string;
  /** The final decision; "error" when a seat call failed, "skipped" when the run stopped before this case finished. */
  decision: RailDecision | "error" | "skipped";
  expected: string;
  pass: boolean;
  critical: boolean;
  criticalMiss: boolean;
  labels: string;
  disposition: string;
  judged: boolean;
  screenTripped: boolean;
  /** Absent for a skipped case. */
  decidedBy?: EvalDecidedBy;
  /** Whole case, screen included. */
  latencyMs: number;
  /** Time spent in each seat's call (retries included); absent when that seat was not called. */
  namerMs?: number;
  judgeMs?: number;
  namerUsage?: ClassifierTokenUsage;
  judgeUsage?: ClassifierTokenUsage;
  /** Everything sent: fresh input plus cache reads and writes (pi-ai counts cached tokens out of `input`). */
  inputTokens: number;
  outputTokens: number;
  /** Dollars for the calls that completed and were priced. */
  costUsd: number;
  /** Completed calls with no price: any one makes the run's cost unknown. */
  unpricedCalls: number;
  /** The run stopped while one of this case's calls was in flight (it may have been billed). */
  cutOff?: true;
  reason: string;
  error?: string;
  /** For an error: the classifier protocol's failure bucket ("timeout", "server error", "invalid response", …). */
  errorKind?: string;
  /** For an error: the bucket plus a one-line reason, "server error (529 Overloaded)". Shown, never stored. */
  errorDetail?: string;
}

export interface RailEvalCall {
  seat: EvalSeat;
  model: Model<Api>;
  latencyMs: number;
  usage: ClassifierTokenUsage | undefined;
}

export interface RailEvalParams {
  cases: readonly EvalCase[];
  namer: Model<Api>;
  judge: Model<Api>;
  complete: CompleteFn;
  /** The complete fn bounds its own calls (the streaming idle timeout); see ClassifierIO.completeSelfTimes. */
  completeSelfTimes?: boolean;
  getAuth(model: Model<Api>): Promise<ClassifierAuthResult>;
  /** Default evalConfig(): the built-in policy. */
  config?: ResolvedRailConfig;
  cwd?: string;
  /** Default 1 (one case at a time). */
  concurrency?: number;
  /** Whole-run limit; default none. `/rail eval` passes DEFAULT_EVAL_WALL_CLOCK_MS. */
  wallClockMs?: number;
  signal?: AbortSignal;
  /** Retry notices from the classifier's loop; default dropped. */
  notify?: ClassifierIO["notify"];
  onProgress?(progress: { started: number; done: number; total: number }): void;
  /** Every completed seat call (one per runNaming/runJudging), for the caller's cost accounting. */
  onCall?(call: RailEvalCall): void;
  /** Test seam: the monotonic clock latencies are measured on. */
  clock?: () => number;
  /** Test seam: the retry backoff sleep (default the classifier's own). */
  sleep?: ClassifierIO["sleep"];
}

export interface RailEvalRun {
  /** In case order. */
  results: RailEvalCaseResult[];
  wallMs: number;
  /** Set when some case did not finish: cancelled, out of wall clock, or the runner failed. */
  incomplete?: "cancelled" | "wall-clock" | "failed";
  /** For "failed": what broke. */
  failure?: string;
}

/**
 * Tokens as sent. pi-ai normalizes cache reads and writes out of `input`, so a
 * well-cached namer would otherwise show a dozen input tokens for a prompt of
 * twenty thousand; `cacheRead` is kept apart so the saving stays visible.
 */
function sumTokens(...parts: Array<ClassifierTokenUsage | undefined>): { input: number; output: number; cacheRead: number } {
  const total = { input: 0, output: 0, cacheRead: 0 };
  for (const part of parts) {
    total.input += (part?.input ?? 0) + (part?.cacheRead ?? 0) + (part?.cacheWrite ?? 0);
    total.output += part?.output ?? 0;
    total.cacheRead += part?.cacheRead ?? 0;
  }
  return total;
}

/** The completed calls' cost (a call completed when it returned usage) and how many had no price. */
function completedCost(params: RailEvalParams, namerUsage: ClassifierTokenUsage | undefined, judgeUsage: ClassifierTokenUsage | undefined): { cost: number; unpriced: number } {
  let cost = 0;
  let unpriced = 0;
  for (const [model, usage] of [[params.namer, namerUsage], [params.judge, judgeUsage]] as const) {
    if (!usage) continue;
    const priced = callCostUsd(model, usage);
    if (priced === undefined) unpriced++;
    else cost += priced;
  }
  return { cost, unpriced };
}

/** The provider's own words, when an error body carries them: `"message":"Overloaded"`. */
function providerMessage(error: unknown): string {
  const chain = errorChain(error);
  const text = chain.map((node) => node.message).join(" ");
  const quoted = /"message"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1];
  const raw = quoted ?? chain.find((node) => node.message.trim())?.message ?? "";
  return raw.split("\n")[0]!.replace(/\s+/g, " ").trim();
}

/**
 * The failure bucket and a one-line reason for an errored seat call. The
 * protocol's catch-all category is split here, because "error" names nothing:
 * a 4xx is a client error, anything else it could not place says so.
 */
export function evalErrorKind(error: unknown): { kind: string; detail: string } {
  const failure = classifyClassifierFailure(error);
  const kind = failure.category !== "error"
    ? failure.category
    : failure.status !== undefined && failure.status >= 400 && failure.status < 500
      ? "client error"
      : "unrecognized error";
  let message = providerMessage(error);
  const status = failure.status !== undefined ? String(failure.status) : undefined;
  if (status && message.startsWith(status)) message = message.slice(status.length).replace(/^[\s:-]+/, "");
  if (message.length > 60) message = `${message.slice(0, 59)}…`;
  const reason = [status, message].filter((part) => part).join(" ");
  return { kind, detail: reason ? `${kind} (${reason})` : kind };
}

async function runCase(params: RailEvalParams, evalCase: EvalCase, config: ResolvedRailConfig, signal: AbortSignal): Promise<RailEvalCaseResult> {
  const clock = params.clock ?? (() => performance.now());
  const cwd = params.cwd ?? EVAL_CWD;
  const io: ClassifierIO = {
    cwd,
    signal,
    complete: params.complete,
    ...(params.completeSelfTimes ? { completeSelfTimes: true } : {}),
    getAuth: params.getAuth,
    notify: params.notify ?? (() => {}),
    recentUserMessages: () => evalCase.userMessages ?? [],
    sleep: params.sleep ?? defaultSleep,
  };
  const started = clock();
  const screen = screenToolCall(evalCase.toolName, evalCase.input, cwd);
  const critical = evalCase.critical === true;
  const base = { name: evalCase.name, expected: evalCase.expect.join("|"), critical, screenTripped: screen.tripped };

  let labels: CapabilityId[] = [];
  let disposition = "-";
  let namerMs: number | undefined;
  let judgeMs: number | undefined;
  let namerUsage: ClassifierTokenUsage | undefined;
  let judgeUsage: ClassifierTokenUsage | undefined;
  let seat: EvalSeat = "namer";
  const finish = (fields: Partial<RailEvalCaseResult> & Pick<RailEvalCaseResult, "decision" | "reason">): RailEvalCaseResult => {
    const tokens = sumTokens(namerUsage, judgeUsage);
    const cost = completedCost(params, namerUsage, judgeUsage);
    return {
      ...base,
      pass: (evalCase.expect as string[]).includes(fields.decision),
      criticalMiss: critical && fields.decision === "allow",
      labels: labels.length > 0 ? labels.join("+") : "-",
      disposition,
      judged: judgeMs !== undefined,
      latencyMs: Math.round(clock() - started),
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      ...(namerMs !== undefined ? { namerMs } : {}),
      ...(judgeMs !== undefined ? { judgeMs } : {}),
      ...(namerUsage ? { namerUsage } : {}),
      ...(judgeUsage ? { judgeUsage } : {}),
      costUsd: cost.cost,
      unpricedCalls: cost.unpriced,
      ...fields,
    };
  };

  if (signal.aborted) return finish({ decision: "skipped", reason: "run stopped before this case" });
  try {
    const fixed = evalCase.toolName === "bash" ? undefined : screen.label;
    let authorizationEvidence: string | undefined;
    if (fixed) {
      labels = [fixed];
    } else {
      const namerStarted = clock();
      try {
        const named = await runNaming({ io, model: params.namer, config, toolName: evalCase.toolName, input: evalCase.input, sessionGuidance: evalCase.sessionGuidance });
        labels = named.labels;
        authorizationEvidence = named.authorizationEvidence;
        namerUsage = named.tokenUsage;
      } finally {
        namerMs = Math.round(clock() - namerStarted);
      }
      params.onCall?.({ seat: "namer", model: params.namer, latencyMs: namerMs, usage: namerUsage });
    }
    // Built-in defaults only: the eval measures the shipped table, not a user's.
    const resolution = resolveCapabilities(config, createCapabilityState(), labels);
    labels = resolution.labels;
    disposition = resolution.disposition;
    if (resolution.disposition !== "judge") {
      return finish({ decision: resolution.disposition, decidedBy: fixed ? "deterministic" : "namer", reason: `table: ${resolution.decidedBy.id} → ${resolution.disposition}` });
    }
    seat = "judge";
    const judgeStarted = clock();
    let judge: Awaited<ReturnType<typeof runJudging>>;
    try {
      judge = await runJudging({
        io,
        model: params.judge,
        config,
        toolName: evalCase.toolName,
        input: evalCase.input,
        labels: resolution.labels,
        authorizationEvidence,
        sessionGuidance: evalCase.sessionGuidance,
        recentGuardDecisions: [],
      });
      judgeUsage = judge.tokenUsage;
    } finally {
      judgeMs = Math.round(clock() - judgeStarted);
    }
    params.onCall?.({ seat: "judge", model: params.judge, latencyMs: judgeMs, usage: judgeUsage });
    return finish({ decision: judge.decision, decidedBy: "judge", reason: judge.reason });
  } catch (error) {
    // A call cut off by cancel or the wall clock did not fail on its merits:
    // it is not run, not an error against the seat.
    if (signal.aborted) return finish({ decision: "skipped", reason: "run stopped during this case", cutOff: true });
    const failure = evalErrorKind(error);
    return finish({ decision: "error", decidedBy: seat, reason: "", error: formatError(error), errorKind: failure.kind, errorDetail: failure.detail });
  }
}

/**
 * Runs the cases `concurrency` at a time under the wall clock and the abort
 * signal. Never throws: a stop or a runner failure comes back as an
 * incomplete run with whatever finished, so it can still be shown and kept.
 */
export async function runRailEval(params: RailEvalParams): Promise<RailEvalRun> {
  const clock = params.clock ?? (() => performance.now());
  const config = params.config ?? evalConfig();
  const cases = params.cases;
  const controller = new AbortController();
  let stopReason: RailEvalRun["incomplete"];
  const onParentAbort = () => {
    stopReason ??= "cancelled";
    controller.abort();
  };
  if (params.signal?.aborted) onParentAbort();
  params.signal?.addEventListener("abort", onParentAbort, { once: true });
  const wall = params.wallClockMs;
  const timer = wall !== undefined && Number.isFinite(wall)
    ? setTimeout(() => {
        stopReason ??= "wall-clock";
        controller.abort();
      }, wall)
    : undefined;

  const started = clock();
  const results: Array<RailEvalCaseResult | undefined> = new Array(cases.length).fill(undefined);
  let next = 0;
  let begun = 0;
  let done = 0;
  let failure: string | undefined;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= cases.length) return;
      begun++;
      params.onProgress?.({ started: begun, done, total: cases.length });
      results[index] = await runCase(params, cases[index]!, config, controller.signal);
      done++;
      params.onProgress?.({ started: begun, done, total: cases.length });
    }
  };
  try {
    const width = Math.max(1, Math.min(params.concurrency ?? 1, cases.length));
    await Promise.all(Array.from({ length: width }, worker));
  } catch (error) {
    failure = formatError(error);
    stopReason ??= "failed";
    controller.abort();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    params.signal?.removeEventListener("abort", onParentAbort);
  }

  const filled = results.map((result, index) => result ?? {
    name: cases[index]!.name,
    decision: "skipped" as const,
    expected: cases[index]!.expect.join("|"),
    pass: false,
    critical: cases[index]!.critical === true,
    criticalMiss: false,
    labels: "-",
    disposition: "-",
    judged: false,
    screenTripped: false,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
    reason: "not run",
  });
  const skipped = filled.some((result) => result.decision === "skipped");
  return {
    results: filled,
    wallMs: Math.round(clock() - started),
    ...(skipped || failure ? { incomplete: stopReason ?? "failed" } : {}),
    ...(failure ? { failure } : {}),
  };
}

// ── The record ──────────────────────────────────────────────────────────────

export interface RailEvalSeatStats {
  /** Cases this seat decided (the attribution above), errors included. */
  decided: number;
  correct: number;
  /** Over this seat's calls, not its decided cases. */
  calls: number;
  medianMs: number;
  maxMs: number;
  /** Input as sent: fresh plus cache reads and writes. */
  tokensIn: number;
  tokensOut: number;
  /** The part of tokensIn served from the provider's prompt cache. Absent in records written before it existed. */
  cacheRead?: number;
}

/**
 * One run, as kept in `<agentDir>/rail-evals.jsonl`. Numbers, model ids and the
 * suite's own case names — never a command, prompt, or model output.
 */
export interface RailEvalRecord {
  v: 1;
  at: string;
  suite: string;
  cases: number;
  /** provider/id of the model each seat resolved to. */
  namer: string;
  judge: string;
  /** The seat's spec when it was a word ("auto", "current"), for the "current (glm-5.2)" label. */
  namerSpec?: string;
  judgeSpec?: string;
  passed: number;
  criticalMisses: number;
  wallMs: number;
  namerStats: RailEvalSeatStats;
  judgeStats: RailEvalSeatStats;
  /** Cases the screen decided with no model call, attributed to neither seat. */
  deterministic: number;
  /** Dollars for the completed calls; absent when any completed call was unpriced (never guessed). */
  cost?: number;
  /** Some call failed or was cut off, so `cost` is a lower bound (it may have been billed but reports nothing). */
  costPartial?: true;
  errors: number;
  /** Errors by failure bucket ("timeout", "server error", "invalid response", "unavailable", …). */
  errorKinds?: Record<string, number>;
  /** Cases that did not pass, with the seat that decided them; `critical` marks a critical miss. */
  failing?: Array<{ name: string; seat: EvalDecidedBy; critical?: true }>;
  /** Some cases did not run (cancelled, wall clock, runner failure). */
  incomplete?: true;
  piVersion?: string;
  railVersion?: string;
}

/** The run's errored cases, for the report only: the history keeps buckets, not reasons. */
export function runErrors(run: RailEvalRun): EvalRunError[] {
  return run.results
    .filter((result) => result.decision === "error")
    .map((result) => ({ name: result.name, seat: result.decidedBy === "judge" ? "judge" : "namer", detail: result.errorDetail ?? result.errorKind ?? "unrecognized error" }));
}

export interface EvalRunError {
  name: string;
  seat: EvalSeat;
  detail: string;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function seatStats(results: readonly RailEvalCaseResult[], seat: EvalSeat): RailEvalSeatStats {
  const decided = results.filter((result) => result.decidedBy === seat);
  const latencies = results.map((result) => (seat === "namer" ? result.namerMs : result.judgeMs)).filter((ms): ms is number => typeof ms === "number");
  const usages = results.map((result) => (seat === "namer" ? result.namerUsage : result.judgeUsage));
  const tokens = sumTokens(...usages);
  return {
    decided: decided.length,
    correct: decided.filter((result) => result.pass).length,
    calls: latencies.length,
    medianMs: median(latencies),
    maxMs: latencies.length > 0 ? Math.max(...latencies) : 0,
    tokensIn: tokens.input,
    tokensOut: tokens.output,
    cacheRead: tokens.cacheRead,
  };
}

/** Pi's own version, read from its package.json; undefined when that cannot be read. */
export function piVersion(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(getPackageDir(), "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export function railVersion(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export function modelId(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function summarizeRun(
  run: RailEvalRun,
  meta: { suite: string; namer: Model<Api>; judge: Model<Api>; namerSpec?: string; judgeSpec?: string; at: Date; piVersion?: string; railVersion?: string },
): RailEvalRecord {
  const results = run.results;
  const errors = results.filter((result) => result.decision === "error");
  const errorKinds: Record<string, number> = {};
  for (const result of errors) errorKinds[result.errorKind ?? "unknown"] = (errorKinds[result.errorKind ?? "unknown"] ?? 0) + 1;
  // Unknown the moment a completed call has no price. A failed or cut-off
  // call was possibly billed but reports nothing, so with one the sum is a
  // lower bound and says so rather than passing for the total.
  const ran = results.filter((result) => result.decision !== "skipped");
  const unpriced = results.reduce((sum, result) => sum + result.unpricedCalls, 0);
  const cost = unpriced === 0 ? results.reduce((sum, result) => sum + result.costUsd, 0) : undefined;
  const costPartial = errors.length > 0 || results.some((result) => result.cutOff);
  const failing = ran
    .filter((result) => !result.pass && result.decidedBy !== undefined)
    .map((result) => ({ name: result.name, seat: result.decidedBy!, ...(result.criticalMiss ? { critical: true as const } : {}) }));
  const word = (spec: string | undefined) => (spec === "auto" || spec === "current" ? spec : undefined);
  const namerSpec = word(meta.namerSpec);
  const judgeSpec = word(meta.judgeSpec);
  return {
    v: 1,
    at: meta.at.toISOString(),
    suite: meta.suite,
    cases: results.length,
    namer: modelId(meta.namer),
    judge: modelId(meta.judge),
    ...(namerSpec ? { namerSpec } : {}),
    ...(judgeSpec ? { judgeSpec } : {}),
    passed: results.filter((result) => result.pass).length,
    criticalMisses: results.filter((result) => result.criticalMiss).length,
    wallMs: run.wallMs,
    namerStats: seatStats(results, "namer"),
    judgeStats: seatStats(results, "judge"),
    deterministic: results.filter((result) => result.decidedBy === "deterministic").length,
    ...(cost !== undefined ? { cost } : {}),
    ...(cost !== undefined && costPartial ? { costPartial: true as const } : {}),
    errors: errors.length,
    ...(errors.length > 0 ? { errorKinds } : {}),
    ...(failing.length > 0 ? { failing } : {}),
    ...(run.incomplete ? { incomplete: true as const } : {}),
    ...(meta.piVersion ? { piVersion: meta.piVersion } : {}),
    ...(meta.railVersion ? { railVersion: meta.railVersion } : {}),
  };
}
