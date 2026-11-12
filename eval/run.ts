// Offline eval for the rail's capability pipeline. Runs the real production
// path — namer → disposition table (built-in defaults) → judge when the table
// escalates — against live models and scores decision agreement plus latency,
// so models can be compared for the quality/latency/cost tradeoff. This never
// runs inside pi and is not a unit test: nondeterministic model judgment is
// measured here, not asserted in CI.
//
// One model plays both seats here. In production the judge defaults to the
// session model (classifier.judgeModel = "current"), normally stronger than
// the namer's; using one model for both keeps model-to-model comparison
// honest, and the per-case `judged` column shows where it mattered.
//
// `/rail eval` runs the same per-case path (src/rail-eval.ts) with the
// session's namer and judge as two distinct seats; this CLI keeps one model in
// both, as above.
//
// Usage:
//   node eval/run.ts anthropic/claude-haiku-4-5 [more provider/model ...]
//   node eval/run.ts --filter exfil anthropic/claude-haiku-4-5
//   node eval/run.ts --json anthropic/claude-haiku-4-5
//   node eval/run.ts --quick anthropic/claude-haiku-4-5
//
// --quick runs only the cases tagged `quick` (the `/rail eval` suite), two at
// a time under the same wall clock, prints the eval report beside the usual
// table, and appends one record per model to the same history file
// `/rail eval` keeps (<agent dir>/rail-evals.jsonl).
//
// API keys come from the usual provider env vars (ANTHROPIC_API_KEY,
// OPENROUTER_API_KEY, etc), falling back to pi's own auth store (auth.json in
// the pi agent dir) for providers you logged into via pi with an API key.
// Exit code is 1 if any model allowed a critical case.
import { completeSimple, getModels, getProviders, type Api, type Model } from "@earendil-works/pi-ai/compat";
import type { CompleteFn } from "../src/classifier.ts";
import {
  DEFAULT_EVAL_CONCURRENCY,
  DEFAULT_EVAL_WALL_CLOCK_MS,
  evalConfig,
  median,
  piVersion,
  quickCases,
  railVersion,
  runErrors,
  runRailEval,
  suiteId,
  summarizeRun,
  type EvalRunError,
  type RailEvalCaseResult,
  type RailEvalRecord,
} from "../src/rail-eval.ts";
import { appendEvalRecord, defaultEvalHistoryPath, readEvalHistory } from "../src/rail-eval-history.ts";
import { renderEvalReport } from "../src/rail-eval-report.ts";
import { formatError } from "../src/util.ts";
import { resolveEvalApiKey } from "./auth.ts";
import { EVAL_CASES, type EvalCase } from "./cases.ts";

interface CaseResult {
  name: string;
  decision: string;
  expected: string;
  pass: boolean;
  criticalMiss: boolean;
  labels: string;
  disposition: string;
  judged: boolean;
  screenTripped: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reason: string;
  error?: string;
}

interface ModelReport {
  model: string;
  results: CaseResult[];
  score: number;
  criticalMisses: number;
  judgeRate: number;
  medianLatencyMs: number;
  maxLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

// Low reasoning effort via completeSimple, which maps the level to each
// provider's thinking format: some hosted models (gpt-oss, gpt-5 family)
// reject requests with reasoning disabled, and a security reviewer benefits
// from a small thinking budget without medium/high latency.
//
// maxTokens is capped well below model capacity: the reviewer returns a tiny
// JSON object, and OpenRouter pre-authorizes credits against max_tokens, so
// uncapped requests 402 on modest balances (64k-128k tokens pre-authed).
const completeWithReasoning: CompleteFn = ((model, context, options) =>
  completeSimple(model, context, { ...options, reasoning: "low", maxTokens: 4000 })) as CompleteFn;

/** The shared runner's result, in this CLI's long-standing JSON/table shape. */
function toCaseResult(result: RailEvalCaseResult): CaseResult {
  return {
    name: result.name,
    decision: result.decision,
    expected: result.expected,
    pass: result.pass,
    criticalMiss: result.criticalMiss,
    labels: result.labels,
    disposition: result.disposition,
    judged: result.judged,
    screenTripped: result.screenTripped,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    reason: result.reason,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

function resolveModel(spec: string): Model<Api> {
  const slash = spec.indexOf("/");
  if (slash <= 0) throw new Error(`Invalid model spec (expected provider/model): ${spec}`);
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  const providers = getProviders() as string[];
  if (!providers.includes(provider)) throw new Error(`Unknown provider: ${provider}. Known: ${providers.join(", ")}`);
  const models = getModels(provider as Parameters<typeof getModels>[0]) as Model<Api>[];
  let model = models.find((candidate) => candidate.id === id);
  if (!model && provider === "openrouter" && id.includes("/") && models[0]) {
    // OpenRouter serves every model through one OpenAI-compatible endpoint, so
    // ids missing from pi-ai's pinned catalog still work with a catalog entry
    // as the template. Its price would be the template's, so it is zeroed:
    // the report shows the cost as unknown rather than as someone else's.
    model = { ...models[0], id, name: `OpenRouter: ${id}`, cost: { ...models[0].cost, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    console.error(`Note: ${id} is not in the pinned catalog; using a synthesized openrouter model entry.`);
  }
  if (!model) throw new Error(`Model not found in pi-ai catalog: ${spec}. Available for ${provider}: ${models.map((m) => m.id).slice(0, 10).join(", ")}...`);
  return model;
}

async function runModel(spec: string, cases: EvalCase[], quick: boolean): Promise<{ report: ModelReport; record: RailEvalRecord; errors: EvalRunError[] }> {
  const model = resolveModel(spec);
  const lookup = resolveEvalApiKey(model.provider);
  if (!lookup.ok) throw new Error(lookup.reason);
  console.error(`Using ${model.provider} API key from ${lookup.source}.`);

  // One model in both seats (see the header). The full suite runs one case at
  // a time, as it always has; --quick runs like /rail eval so its history rows
  // are comparable with the command's.
  const run = await runRailEval({
    cases,
    namer: model,
    judge: model,
    complete: completeWithReasoning,
    getAuth: async () => ({ ok: true, apiKey: lookup.apiKey }),
    config: evalConfig(),
    concurrency: quick ? DEFAULT_EVAL_CONCURRENCY : 1,
    ...(quick ? { wallClockMs: DEFAULT_EVAL_WALL_CLOCK_MS } : {}),
  });
  const results = run.results.map(toCaseResult);
  const latencies = results.map((r) => r.latencyMs);
  const report: ModelReport = {
    model: spec,
    results,
    score: results.filter((r) => r.pass).length / results.length,
    criticalMisses: results.filter((r) => r.criticalMiss).length,
    judgeRate: results.filter((r) => r.judged).length / results.length,
    medianLatencyMs: median(latencies),
    maxLatencyMs: Math.max(...latencies),
    totalInputTokens: results.reduce((sum, r) => sum + r.inputTokens, 0),
    totalOutputTokens: results.reduce((sum, r) => sum + r.outputTokens, 0),
  };
  const record = summarizeRun(run, {
    suite: suiteId(cases),
    namer: model,
    judge: model,
    at: new Date(),
    ...(piVersion() ? { piVersion: piVersion() } : {}),
    ...(railVersion() ? { railVersion: railVersion() } : {}),
  });
  return { report, record, errors: runErrors(run) };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function printReport(report: ModelReport): void {
  console.log(`\n## ${report.model}\n`);
  const nameWidth = Math.max(...report.results.map((r) => r.name.length), 4);
  const labelWidth = Math.max(...report.results.map((r) => r.labels.length), 12);
  console.log(`${pad("case", nameWidth)}  ${pad("decision", 8)}  ${pad("expected", 10)}  ${pad("ok", 4)}  ${pad("judge", 5)}  ${pad("scr", 3)}  ${pad("capabilities", labelWidth)}  ${pad("ms", 6)}  detail`);
  for (const r of report.results) {
    const ok = r.criticalMiss ? "MISS" : r.pass ? "pass" : "FAIL";
    const detail = r.error ? `error: ${r.error}` : r.reason.slice(0, 70);
    console.log(
      `${pad(r.name, nameWidth)}  ${pad(r.decision, 8)}  ${pad(r.expected, 10)}  ${pad(ok, 4)}  ${pad(r.judged ? "y" : "-", 5)}  ${pad(r.screenTripped ? "y" : "-", 3)}  ${pad(r.labels, labelWidth)}  ${pad(String(r.latencyMs), 6)}  ${detail}`,
    );
  }
  console.log("");
  console.log(`score ${(report.score * 100).toFixed(0)}%  critical-misses ${report.criticalMisses}  judged ${(report.judgeRate * 100).toFixed(0)}%  latency p50 ${report.medianLatencyMs}ms max ${report.maxLatencyMs}ms  tokens ↑${report.totalInputTokens} ↓${report.totalOutputTokens}`);
}

function printComparison(reports: ModelReport[]): void {
  if (reports.length < 2) return;
  console.log("\n## Model comparison\n");
  const width = Math.max(...reports.map((r) => r.model.length), 5);
  console.log(`${pad("model", width)}  ${pad("score", 6)}  ${pad("crit", 5)}  ${pad("judge", 6)}  ${pad("p50ms", 6)}  ${pad("maxms", 6)}  tokens`);
  for (const r of reports) {
    console.log(
      `${pad(r.model, width)}  ${pad(`${(r.score * 100).toFixed(0)}%`, 6)}  ${pad(String(r.criticalMisses), 5)}  ${pad(`${(r.judgeRate * 100).toFixed(0)}%`, 6)}  ${pad(String(r.medianLatencyMs), 6)}  ${pad(String(r.maxLatencyMs), 6)}  ↑${r.totalInputTokens} ↓${r.totalOutputTokens}`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modelSpecs: string[] = [];
  let filter: string | undefined;
  let json = false;
  let quick = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--filter") filter = args[++i];
    else if (arg === "--json") json = true;
    else if (arg === "--quick") quick = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    else modelSpecs.push(arg);
  }
  if (modelSpecs.length === 0) {
    console.error("Usage: node eval/run.ts [--quick] [--filter substr] [--json] provider/model [provider/model ...]");
    process.exit(2);
  }

  const pool = quick ? quickCases(EVAL_CASES) : EVAL_CASES;
  const cases = filter ? pool.filter((c) => c.name.includes(filter)) : pool;
  if (cases.length === 0) throw new Error(`No cases match filter: ${filter}`);
  console.error(`Running ${cases.length} case(s) against ${modelSpecs.length} model(s)...`);

  const reports: ModelReport[] = [];
  const records: RailEvalRecord[] = [];
  const errorsByRun: EvalRunError[][] = [];
  for (const spec of modelSpecs) {
    const { report, record, errors } = await runModel(spec, cases, quick);
    reports.push(report);
    records.push(record);
    errorsByRun.push(errors);
  }

  // A filtered quick run hashes to its own suite id, so it never lands among
  // the full quick suite's comparisons.
  const historyFile = defaultEvalHistoryPath();
  const written = quick ? records.map((record) => appendEvalRecord(record, historyFile)) : [];

  if (json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const report of reports) printReport(report);
    printComparison(reports);
    if (quick) {
      const history = readEvalHistory(historyFile);
      records.forEach((record, index) => {
        console.log("");
        console.log(renderEvalReport({ run: record, errors: errorsByRun[index], history, suite: record.suite, now: Date.now() }).join("\n"));
      });
    }
  }
  if (quick) {
    console.error(written.every(Boolean) ? `\nHistory: appended ${records.length} run(s) to ${historyFile}` : `\nHistory: could not write ${historyFile}; runs not kept.`);
  }

  const criticalMisses = reports.reduce((sum, r) => sum + r.criticalMisses, 0);
  if (criticalMisses > 0) {
    console.error(`\n${criticalMisses} critical case(s) were ALLOWED. Investigate before trusting this model as a namer.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(formatError(error));
  process.exit(2);
});
