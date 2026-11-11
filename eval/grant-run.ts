// Live eval for the grant configurator (src/grant-agent.ts). Each case in
// eval/grant-cases.ts runs through runGrantAgent with a real model — the same
// loop, tools and gates as `/rail grant <text>` — and its outcome is scored by
// code (eval/grant-score.ts). Not a unit test: model judgement is measured
// here, not asserted in CI.
//
// Usage:
//   npm run eval:grant -- anthropic/claude-haiku-4-5 [more provider/model ...]
//   npm run eval:grant -- --filter worktree anthropic/claude-sonnet-5
//   npm run eval:grant -- --json anthropic/claude-haiku-4-5
//
// Keys resolve exactly as in eval/run.ts (provider env var, then pi's auth
// store). Exit code 1 when any model passed the gates with a grant that
// violates a mustNotAllow, mustBeSensitive, forbidden or injection property —
// the exclusion rule for AUTO_GRANT_MODEL_PREFERENCES (eval/GRANT_RESULTS.md).
import { completeSimple, getModels, getProviders, type Api, type Model } from "@earendil-works/pi-ai/compat";
import type { CompleteFn } from "../src/classifier.ts";
import { runGrantAgent, type GrantAgentResult } from "../src/grant-agent.ts";
import { describeOp, probeSummaries } from "../src/grant-eval.ts";
import type { Grant } from "../src/policy-store.ts";
import { formatError } from "../src/util.ts";
import { resolveEvalApiKey } from "./auth.ts";
import { EVAL_CASES } from "./cases.ts";
import { GRANT_CASES, type GrantCase } from "./grant-cases.ts";
import { buildCaseContext, scoreGrantCase, type CaseScore } from "./grant-score.ts";

interface CaseRow extends CaseScore {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** What the agent proposed: the grant, its rationale, and the gate report in brief. */
  proposal?: {
    grant: Grant;
    rationale: string;
    gates: { ok: boolean; failures: string[]; sensitive: string[]; summary?: string; alsoAllows: string[] };
  };
  decline?: { kind: string; reason: string; alternative?: string };
  failure?: string;
  transcript: string[];
}

interface ModelReport {
  model: string;
  rows: CaseRow[];
  passed: number;
  excluded: number;
}

function resolveModel(spec: string): Model<Api> {
  const slash = spec.indexOf("/");
  if (slash <= 0) throw new Error(`Invalid model spec (expected provider/model): ${spec}`);
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  const providers = getProviders() as string[];
  if (!providers.includes(provider)) throw new Error(`Unknown provider: ${provider}. Known: ${providers.join(", ")}`);
  const models = getModels(provider as Parameters<typeof getModels>[0]) as Model<Api>[];
  const model = models.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`Model not found in pi-ai catalog: ${spec}. Available for ${provider}: ${models.map((m) => m.id).slice(0, 10).join(", ")}...`);
  return model;
}

async function runCase(entry: GrantCase, model: Model<Api>, apiKey: string): Promise<CaseRow> {
  const context = buildCaseContext(entry);
  // Low reasoning effort, as in eval/run.ts; maxTokens comes from the loop's own per-call cap.
  const complete: CompleteFn = ((m, ctx, options) => completeSimple(m, ctx, { ...options, reasoning: "low" })) as CompleteFn;
  const started = performance.now();
  let result: GrantAgentResult;
  try {
    result = await runGrantAgent({
      request: entry.request,
      ...(entry.seedAction ? { seedAction: entry.seedAction } : {}),
      config: context.config,
      session: context.session,
      corpusRecords: context.corpus,
      existingGrants: context.existingGrants,
      evalCases: EVAL_CASES,
      cwd: context.cwd,
      classifierEnabled: true,
      complete,
      model,
      auth: { apiKey },
    });
  } catch (error) {
    result = { kind: "failed", reason: formatError(error), transcriptSummary: [], usage: { calls: 0, input: 0, output: 0 }, turns: 0 };
  }
  const latencyMs = Math.round(performance.now() - started);
  const score = scoreGrantCase(entry, result, context);
  const detail: Partial<CaseRow> = {};
  if (result.kind === "proposed") {
    detail.proposal = {
      grant: result.grant,
      rationale: result.rationale,
      gates: {
        ok: result.report.ok,
        failures: result.report.failures,
        sensitive: result.report.sensitive.map((item) => `op ${item.opIndex + 1} [${item.kind}]: ${item.reason}`),
        ...(result.report.summary ? { summary: result.report.summary } : {}),
        alsoAllows: probeSummaries(result.report, 20).map((probe) => `op ${probe.opIndex + 1} ${probe.template}: ${probe.commands.join(" | ")}`),
      },
    };
  } else if (result.kind === "declined") {
    detail.decline = { kind: result.declineKind, reason: result.reason, ...(result.alternative ? { alternative: result.alternative } : {}) };
  } else {
    detail.failure = result.reason;
  }
  return { ...score, ...detail, turns: result.turns, inputTokens: result.usage.input, outputTokens: result.usage.output, latencyMs, transcript: result.transcriptSummary };
}

async function runModel(spec: string, cases: GrantCase[]): Promise<ModelReport> {
  const model = resolveModel(spec);
  const lookup = resolveEvalApiKey(model.provider);
  if (!lookup.ok) throw new Error(lookup.reason);
  console.error(`Using ${model.provider} API key from ${lookup.source}.`);
  const rows: CaseRow[] = [];
  for (const entry of cases) {
    console.error(`  ${spec} · ${entry.name}`);
    rows.push(await runCase(entry, model, lookup.apiKey));
  }
  return { model: spec, rows, passed: rows.filter((row) => row.pass).length, excluded: rows.filter((row) => row.excluded).length };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function printReport(report: ModelReport): void {
  console.log(`\n## ${report.model}\n`);
  const nameWidth = Math.max(...report.rows.map((row) => row.name.length), 4);
  console.log(`${pad("case", nameWidth)}  ${pad("ok", 4)}  ${pad("outcome", 22)}  ${pad("rung", 4)}  ${pad("gates", 5)}  ${pad("props", 5)}  ${pad("turns", 5)}  ${pad("tokens", 14)}  ${pad("ms", 6)}  failing`);
  for (const row of report.rows) {
    const ok = row.excluded ? "EXCL" : row.pass ? "pass" : "FAIL";
    const outcome = row.outcome === "proposed" ? "proposed" : `${row.outcome} (${row.outcomeDetail ?? ""})`.slice(0, 22);
    const props = `${row.properties.filter((p) => p.pass).length}/${row.properties.length}`;
    const failing = row.properties.filter((p) => !p.pass).map((p) => `${p.safety ? "!" : ""}${p.property}`).join("; ");
    console.log(
      `${pad(row.name, nameWidth)}  ${pad(ok, 4)}  ${pad(outcome, 22)}  ${pad(row.rung === undefined ? "-" : String(row.rung), 4)}  ${pad(row.gates ?? "-", 5)}  ${pad(props, 5)}  ${pad(String(row.turns), 5)}  ${pad(`↑${row.inputTokens} ↓${row.outputTokens}`, 14)}  ${pad(String(row.latencyMs), 6)}  ${failing}`,
    );
    if (row.pass) continue;
    // Under a non-passing row: what was proposed (or why not), so a failure reads without --json.
    if (row.proposal) {
      row.proposal.grant.ops.forEach((op, index) => console.log(`    op ${index + 1}: ${describeOp(op)}`));
      for (const line of row.proposal.gates.alsoAllows) console.log(`    also allows: ${line}`);
      for (const line of row.proposal.gates.sensitive) console.log(`    sensitive: ${line}`);
      if (!row.proposal.gates.ok) console.log(`    gates: ${row.proposal.gates.failures[0] ?? ""}`);
      console.log(`    rationale: ${row.proposal.rationale.replace(/\s+/g, " ").slice(0, 200)}`);
    } else if (row.decline) {
      console.log(`    declined (${row.decline.kind}): ${row.decline.reason.replace(/\s+/g, " ").slice(0, 200)}${row.decline.alternative ? ` — instead: ${row.decline.alternative}` : ""}`);
    } else if (row.failure) {
      console.log(`    failed: ${row.failure}`);
    }
  }
  console.log("");
  console.log(`cases passed ${report.passed}/${report.rows.length}  excluded-violations ${report.excluded}`);
}

function printComparison(reports: ModelReport[]): void {
  if (reports.length < 2) return;
  console.log("\n## Model comparison\n");
  const width = Math.max(...reports.map((r) => r.model.length), 5);
  console.log(`${pad("model", width)}  ${pad("passed", 7)}  ${pad("excl", 4)}  tokens`);
  for (const r of reports) {
    const input = r.rows.reduce((sum, row) => sum + row.inputTokens, 0);
    const output = r.rows.reduce((sum, row) => sum + row.outputTokens, 0);
    console.log(`${pad(r.model, width)}  ${pad(`${r.passed}/${r.rows.length}`, 7)}  ${pad(String(r.excluded), 4)}  ↑${input} ↓${output}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const specs: string[] = [];
  let filter: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--filter") filter = args[++i];
    else if (arg === "--json") json = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    else specs.push(arg);
  }
  if (specs.length === 0) {
    console.error("Usage: npm run eval:grant -- [--filter substr] [--json] provider/model [provider/model ...]");
    process.exit(2);
  }
  const cases = filter ? GRANT_CASES.filter((entry) => entry.name.includes(filter)) : GRANT_CASES;
  if (cases.length === 0) throw new Error(`No cases match filter: ${filter}`);
  console.error(`Running ${cases.length} configurator case(s) against ${specs.length} model(s)...`);
  const reports: ModelReport[] = [];
  for (const spec of specs) reports.push(await runModel(spec, cases));
  if (json) console.log(JSON.stringify(reports, null, 2));
  else {
    for (const report of reports) printReport(report);
    printComparison(reports);
  }
  const excluded = reports.filter((report) => report.excluded > 0);
  if (excluded.length > 0) {
    console.error(`\n${excluded.map((r) => r.model).join(", ")} passed the gates with a grant violating a safety property. Such a model is excluded from AUTO_GRANT_MODEL_PREFERENCES.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(formatError(error));
  process.exit(2);
});
