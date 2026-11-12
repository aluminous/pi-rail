// The shared eval runner (src/rail-eval.ts), its history store and its one
// renderer: the quick suite's mix, the suite id, seat attribution, latency per
// seat, deterministic cases, errors, the wall clock, concurrency, cost, the
// capped private history file, and the report's layout. Every model here is
// scripted (test/eval-fakes.ts); nothing calls a provider.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { EVAL_CASES, type EvalCase } from "../eval/cases.ts";
import { createCapabilityState, resolveCapabilities } from "../src/capabilities.ts";
import {
  callCostUsd,
  deterministicLabel,
  runErrors,
  evalConfig,
  quickCases,
  runRailEval,
  spendEstimate,
  spendLine,
  suiteId,
  summarizeRun,
  type RailEvalRecord,
} from "../src/rail-eval.ts";
import { appendEvalRecord, readEvalHistory } from "../src/rail-eval-history.ts";
import { formatAgo, renderEvalReport } from "../src/rail-eval-report.ts";
import { fakeModel, scriptedReviewer } from "./eval-fakes.ts";
import { makeFixtureDir } from "./helpers.ts";

const NAMER = fakeModel("anthropic", "claude-haiku-5-5");
const JUDGE = fakeModel("openai", "gpt-5.6-luna");
const auth = async () => ({ ok: true, apiKey: "test-key" });

function intentDisposition(evalCase: EvalCase) {
  return resolveCapabilities(evalConfig(), createCapabilityState(), evalCase.intent ?? []).disposition;
}

describe("the quick suite", () => {
  const quick = quickCases();

  it("is about eight tagged cases with the plan's mix", () => {
    assert.equal(quick.length, 8);
    assert.deepEqual(quick.map((evalCase) => evalCase.name), [
      "run-tests",
      "git-status",
      "npm-publish-unrequested",
      "worktree-remove-forced",
      "exfil-ssh-key",
      "prompt-injection-write",
      "obfuscated-bypass",
      "subtle-authority-in-docs",
    ]);
    // Two routine allows.
    const allows = quick.filter((evalCase) => evalCase.expect.length === 1 && evalCase.expect[0] === "allow");
    assert.equal(allows.length, 2);
    for (const evalCase of allows) assert.equal(intentDisposition(evalCase), "allow", evalCase.name);
    // Two critical exfiltration/injection cases. The exfil one is decided by
    // the namer: credentials + off-machine-effects is ask under the table.
    for (const name of ["exfil-ssh-key", "prompt-injection-write"]) assert.ok(quick.find((evalCase) => evalCase.name === name)?.critical, name);
    assert.equal(intentDisposition(quick.find((evalCase) => evalCase.name === "exfil-ssh-key")!), "ask");
    // Every expected set is reachable: the documented intent resolves to an
    // expected decision, or to the judge, which can return one.
    for (const evalCase of quick) {
      const disposition = intentDisposition(evalCase);
      assert.ok(disposition === "judge" || (evalCase.expect as string[]).includes(disposition), `${evalCase.name}: ${disposition}`);
    }
    // One off-machine, one destructive, one authorization-planting, one unanticipated.
    const byIntent = (id: string) => quick.filter((evalCase) => evalCase.intent?.length === 1 && evalCase.intent[0] === id);
    assert.deepEqual(byIntent("off-machine-effects").map((evalCase) => evalCase.name), ["npm-publish-unrequested"]);
    assert.deepEqual(byIntent("local-destructive").map((evalCase) => evalCase.name), ["worktree-remove-forced"]);
    assert.deepEqual(byIntent("unclassified").map((evalCase) => evalCase.name), ["obfuscated-bypass"]);
    assert.ok(quick.some((evalCase) => evalCase.name === "subtle-authority-in-docs" && evalCase.critical && evalCase.intent?.includes("persistence")));
    // Every quick case documents its intent; nothing else does.
    for (const evalCase of quick) assert.ok(evalCase.intent && evalCase.intent.length > 0, evalCase.name);
    assert.deepEqual(EVAL_CASES.filter((evalCase) => !evalCase.quick && evalCase.intent), []);
  });

  it("never expects only deny of a critical case: ask is the table's safe outcome too", () => {
    // Under the default table deny comes only from the judge, while a correct
    // namer can land a critical action on ask; the miss `critical` measures is allow.
    for (const evalCase of EVAL_CASES.filter((candidate) => candidate.critical)) {
      assert.ok(!evalCase.expect.includes("allow"), evalCase.name);
      if (evalCase.expect.includes("deny")) assert.ok(evalCase.expect.includes("ask"), evalCase.name);
    }
  });

  it("sends at least three cases to the judge under the default table", () => {
    // Bash and tripped writes reach the namer, so their labels are the
    // documented intent; a deterministic case would carry its screen label.
    const judged = quick.filter((evalCase) => {
      const fixed = deterministicLabel(evalCase);
      const labels = fixed ? [fixed] : evalCase.intent ?? [];
      return resolveCapabilities(evalConfig(), createCapabilityState(), labels).disposition === "judge";
    });
    assert.ok(judged.length >= 3, `only ${judged.map((evalCase) => evalCase.name).join(", ")} reach the judge`);
    // The writes in the suite trip the screen: their content is the point.
    for (const evalCase of quick.filter((candidate) => candidate.toolName !== "bash")) assert.equal(deterministicLabel(evalCase), undefined, evalCase.name);
  });

  it("states what a run will spend", () => {
    const estimate = spendEstimate(quick);
    const judged = quick.filter((evalCase) => intentDisposition(evalCase) === "judge").length;
    assert.deepEqual(estimate, { cases: 8, calls: 8 + judged });
    assert.equal(spendLine(quick), `8 cases, about ${8 + judged} model calls on your accounts`);
  });
});

describe("suiteId", () => {
  const quick = quickCases();

  it("is a stable six-hex hash", () => {
    assert.match(suiteId(quick), /^[0-9a-f]{6}$/);
    assert.equal(suiteId(quick), suiteId(structuredClone(quick)));
  });

  it("changes when an expectation, input, name or criticality changes", () => {
    const base = suiteId(quick);
    const edit = (change: (cases: EvalCase[]) => void) => {
      const copy = structuredClone(quick);
      change(copy);
      return suiteId(copy);
    };
    assert.notEqual(edit((cases) => { cases[0]!.expect = ["allow", "ask"]; }), base);
    assert.notEqual(edit((cases) => { cases[0]!.input = { command: "npm test -- --watch" }; }), base);
    assert.notEqual(edit((cases) => { cases[0]!.name = "run-the-tests"; }), base);
    assert.notEqual(edit((cases) => { cases[0]!.critical = true; }), base);
    assert.notEqual(edit((cases) => { cases.pop(); }), base);
  });

  it("does not change for notes, intent, expect order, or key order", () => {
    const base = suiteId(quick);
    const copy = structuredClone(quick);
    copy[0]!.notes = "edited";
    copy[0]!.intent = ["read-project"];
    copy.find((evalCase) => evalCase.expect.length > 1)!.expect.reverse();
    copy[0]!.input = Object.fromEntries(Object.entries(copy[0]!.input).reverse());
    assert.equal(suiteId(copy), base);
  });
});

describe("runRailEval", () => {
  const quick = quickCases();

  it("attributes each case to the seat that decided it and times each seat's calls only", async () => {
    const clock = { now: 0 };
    const answers = Object.fromEntries(quick.map((evalCase) => [evalCase.name, { namerMs: 100, judgeMs: 1000 }]));
    answers["run-tests"] = { namerMs: 300, judgeMs: 0 };
    const reviewer = scriptedReviewer(quick, answers, { clock });
    const run = await runRailEval({ cases: quick, namer: NAMER, judge: JUDGE, complete: reviewer.complete, getAuth: auth, clock: () => clock.now });
    assert.equal(run.incomplete, undefined);
    const byName = Object.fromEntries(run.results.map((result) => [result.name, result]));
    for (const evalCase of quick) {
      const expected = intentDisposition(evalCase) === "judge" ? "judge" : "namer";
      assert.equal(byName[evalCase.name]!.decidedBy, expected, evalCase.name);
      assert.ok(byName[evalCase.name]!.pass, evalCase.name);
    }
    // The namer was asked every case, the judge only the escalated ones, each on its own model.
    assert.equal(reviewer.calls.filter((call) => call.seat === "namer").length, 8);
    assert.ok(reviewer.calls.filter((call) => call.seat === "namer").every((call) => call.model === "anthropic/claude-haiku-5-5"));
    assert.ok(reviewer.calls.filter((call) => call.seat === "judge").every((call) => call.model === "openai/gpt-5.6-luna"));

    const record = summarizeRun(run, { suite: suiteId(quick), namer: NAMER, judge: JUDGE, at: new Date("2026-11-12T10:00:00Z") });
    const judged = quick.filter((evalCase) => intentDisposition(evalCase) === "judge").length;
    assert.equal(record.passed, 8);
    assert.equal(record.criticalMisses, 0);
    assert.equal(record.deterministic, 0);
    assert.deepEqual(
      { decided: record.namerStats.decided, correct: record.namerStats.correct, calls: record.namerStats.calls, medianMs: record.namerStats.medianMs, maxMs: record.namerStats.maxMs },
      { decided: 8 - judged, correct: 8 - judged, calls: 8, medianMs: 100, maxMs: 300 },
    );
    assert.deepEqual(
      { decided: record.judgeStats.decided, calls: record.judgeStats.calls, medianMs: record.judgeStats.medianMs, maxMs: record.judgeStats.maxMs },
      { decided: judged, calls: judged, medianMs: 1000, maxMs: 1000 },
    );
    assert.equal(record.namerStats.tokensIn, 8000);
    assert.equal(record.judgeStats.tokensIn, judged * 2000);
    // pi-ai's own per-call cost wins over the registry rates.
    assert.ok(Math.abs(record.cost! - (8 * 0.001 + judged * 0.004)) < 1e-9);
    assert.equal(record.namer, "anthropic/claude-haiku-5-5");
    assert.equal(record.judge, "openai/gpt-5.6-luna");
    assert.equal(record.failing, undefined);
  });

  it("names the seat behind a critical miss", async () => {
    const reviewer = scriptedReviewer(quick, {
      // The namer calls exfiltration a read: the table allows it, the namer let it through.
      "exfil-ssh-key": { labels: ["read-project"] },
      // The judge waves through planted authorization.
      "subtle-authority-in-docs": { decision: "allow" },
      // An ordinary wrong answer, not critical.
      "npm-publish-unrequested": { labels: ["run-dev-tools"] },
    });
    const run = await runRailEval({ cases: quick, namer: NAMER, judge: JUDGE, complete: reviewer.complete, getAuth: auth });
    const record = summarizeRun(run, { suite: "x", namer: NAMER, judge: JUDGE, at: new Date() });
    assert.equal(record.criticalMisses, 2);
    assert.deepEqual(record.failing, [
      { name: "npm-publish-unrequested", seat: "namer" },
      { name: "exfil-ssh-key", seat: "namer", critical: true },
      { name: "subtle-authority-in-docs", seat: "judge", critical: true },
    ]);
    assert.equal(record.passed, 5);
  });

  it("counts a screen-clean write as deterministic: no model call, neither seat", async () => {
    const writeSource = EVAL_CASES.find((evalCase) => evalCase.name === "write-source")!;
    const cases = [writeSource, quick[0]!];
    const reviewer = scriptedReviewer(cases);
    const run = await runRailEval({ cases, namer: NAMER, judge: JUDGE, complete: reviewer.complete, getAuth: auth });
    assert.deepEqual(reviewer.calls.map((call) => call.case), ["run-tests"]);
    assert.equal(run.results[0]!.decidedBy, "deterministic");
    assert.equal(run.results[0]!.labels, "modify-project");
    assert.equal(run.results[0]!.namerMs, undefined);
    const record = summarizeRun(run, { suite: "x", namer: NAMER, judge: JUDGE, at: new Date() });
    assert.equal(record.deterministic, 1);
    assert.equal(record.namerStats.decided, 1);
    assert.equal(record.namerStats.calls, 1);
    assert.equal(record.judgeStats.decided, 0);
  });

  it("records a failed seat call as an error against that seat, with its failure kind", async () => {
    const reviewer = scriptedReviewer(quick);
    const run = await runRailEval({
      cases: quick,
      namer: NAMER,
      judge: JUDGE,
      complete: reviewer.complete,
      // The judge's provider has no key: every escalated case errors, terminally.
      getAuth: async (model) => (model === JUDGE ? { ok: false, error: "no key for openai" } : { ok: true, apiKey: "k" }),
    });
    const record = summarizeRun(run, { suite: "x", namer: NAMER, judge: JUDGE, at: new Date() });
    const judged = quick.filter((evalCase) => intentDisposition(evalCase) === "judge").length;
    assert.equal(record.errors, judged);
    assert.deepEqual(record.errorKinds, { unavailable: judged });
    assert.equal(record.judgeStats.decided, judged);
    assert.equal(record.judgeStats.correct, 0);
    assert.ok(record.failing!.every((entry) => entry.seat === "judge"));
    // The calls that completed are counted; a failed one may have been billed
    // too, so the sum is a lower bound and marked as one.
    assert.ok(Math.abs(record.cost! - 8 * 0.001) < 1e-9);
    assert.equal(record.costPartial, true);
    const lines = renderEvalReport({ run: record, errors: runErrors(run), history: [record], suite: "x", now: Date.now() });
    assert.match(lines[0]!, / · ≥\$0\.0080$/);
    assert.ok(lines.includes("! judge error on worktree-remove-forced: unavailable (no key for openai)"), lines.join("\n"));
    assert.equal(record.incomplete, undefined, "errors are results, not an incomplete run");
  });

  it("buckets each failure kind and reports a one-line reason per case", async () => {
    const overloaded = Object.assign(new Error('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), { status: 529 });
    const kinds: Array<[string, { seat: "namer" | "judge"; error?: Error; reply?: string }, string]> = [
      ["run-tests", { seat: "namer", error: new Error("connect ETIMEDOUT 10.0.0.1:443") }, "namer error on run-tests: timeout (connect ETIMEDOUT 10.0.0.1:443)"],
      ["git-status", { seat: "namer", error: new Error("terminated") }, "namer error on git-status: connection (terminated)"],
      ["npm-publish-unrequested", { seat: "namer", reply: "sure, that looks fine" }, "namer error on npm-publish-unrequested: invalid response (reviewer did not return JSON)"],
      ["worktree-remove-forced", { seat: "judge", error: overloaded }, "judge error on worktree-remove-forced: server error (529 Overloaded)"],
      ["exfil-ssh-key", { seat: "namer", error: new Error("401 invalid x-api-key") }, "namer error on exfil-ssh-key: unavailable (401 invalid x-api-key)"],
      ["prompt-injection-write", { seat: "judge", error: new Error("429 Too Many Requests") }, "judge error on prompt-injection-write: rate limit (429 Too Many Requests)"],
      ["obfuscated-bypass", { seat: "judge", error: new Error("400 bad request: max_tokens too large") }, "judge error on obfuscated-bypass: client error (400 bad request: max_tokens too large)"],
      ["subtle-authority-in-docs", { seat: "judge", error: new Error("boom") }, "judge error on subtle-authority-in-docs: unrecognized error (boom)"],
    ];
    const reviewer = scriptedReviewer(quick, Object.fromEntries(kinds.map(([name, fail]) => [name, { fail }])));
    const run = await runRailEval({ cases: quick, namer: NAMER, judge: JUDGE, complete: reviewer.complete, getAuth: auth, sleep: async () => {} });
    const record = summarizeRun(run, { suite: "x", namer: NAMER, judge: JUDGE, at: new Date() });
    assert.deepEqual(record.errorKinds, {
      timeout: 1,
      connection: 1,
      "invalid response": 1,
      "server error": 1,
      unavailable: 1,
      "rate limit": 1,
      "client error": 1,
      "unrecognized error": 1,
    });
    const lines = renderEvalReport({ run: record, errors: runErrors(run), history: [record], suite: "x", now: Date.now() });
    for (const [, , line] of kinds) assert.ok(lines.includes(`! ${line}`), `missing: ${line}\n${lines.join("\n")}`);
    // The history keeps the buckets, never the reasons.
    assert.doesNotMatch(JSON.stringify(record), /Overloaded|x-api-key|max_tokens/);
  });

  it("counts input as sent, cached reads included, and shows the cache only when there is one", async () => {
    const reviewer = scriptedReviewer(quick, {}, { usage: { input: 250, output: 75, cacheRead: 2125 } });
    const run = await runRailEval({ cases: quick, namer: NAMER, judge: JUDGE, complete: reviewer.complete, getAuth: auth });
    const record = summarizeRun(run, { suite: "x", namer: NAMER, judge: JUDGE, at: new Date() });
    assert.equal(record.namerStats.tokensIn, 8 * 2375);
    assert.equal(record.namerStats.cacheRead, 8 * 2125);
    const lines = renderEvalReport({ run: record, history: [record], suite: "x", now: Date.now(), width: 140 });
    assert.ok(lines.some((line) => line.includes("· 19k in (17k cached) / 0.6k out")), lines.join("\n"));
  });

  it("stops at the wall clock: finished cases kept, the rest skipped, the run incomplete", async () => {
    const reviewer = scriptedReviewer(quick, { "obfuscated-bypass": { hang: "namer" } });
    const run = await runRailEval({ cases: quick, namer: NAMER, judge: JUDGE, complete: reviewer.complete, getAuth: auth, concurrency: 2, wallClockMs: 200 });
    assert.equal(run.incomplete, "wall-clock");
    const skipped = run.results.filter((result) => result.decision === "skipped");
    assert.ok(skipped.some((result) => result.name === "obfuscated-bypass"));
    assert.ok(skipped.every((result) => result.decidedBy === undefined));
    const record = summarizeRun(run, { suite: "x", namer: NAMER, judge: JUDGE, at: new Date() });
    assert.equal(record.incomplete, true);
    assert.equal(record.errors, 0, "a call cut off by the clock is not held against the seat");
    assert.ok(renderEvalReport({ run: record, history: [record], suite: "x", now: Date.now() }).some((line) => /incomplete: \d of 8 cases did not run/.test(line)));
  });

  it("stops on the abort signal as cancelled", async () => {
    const controller = new AbortController();
    const reviewer = scriptedReviewer(quick, { "run-tests": { hang: "namer" } });
    const pending = runRailEval({ cases: quick, namer: NAMER, judge: JUDGE, complete: reviewer.complete, getAuth: auth, signal: controller.signal, concurrency: 2 });
    setTimeout(() => controller.abort(), 20);
    const run = await pending;
    assert.equal(run.incomplete, "cancelled");
  });

  it("runs at most `concurrency` cases at once", async () => {
    const answers = Object.fromEntries(quick.map((evalCase) => [evalCase.name, { namerMs: 5, judgeMs: 5 }]));
    const reviewer = scriptedReviewer(quick, answers, { realDelay: true });
    const progress: string[] = [];
    await runRailEval({ cases: quick, namer: NAMER, judge: JUDGE, complete: reviewer.complete, getAuth: auth, concurrency: 2, onProgress: (p) => progress.push(`${p.started}/${p.done}/${p.total}`) });
    assert.equal(reviewer.maxInFlight(), 2);
    assert.equal(progress.at(-1), "8/8/8");
  });

  it("reports every seat call through onCall", async () => {
    const reviewer = scriptedReviewer(quick);
    const calls: string[] = [];
    await runRailEval({ cases: quick, namer: NAMER, judge: JUDGE, complete: reviewer.complete, getAuth: auth, onCall: (call) => calls.push(`${call.seat}:${call.model.id}`) });
    const judged = quick.filter((evalCase) => intentDisposition(evalCase) === "judge").length;
    assert.equal(calls.filter((call) => call === "namer:claude-haiku-5-5").length, 8);
    assert.equal(calls.filter((call) => call === "judge:gpt-5.6-luna").length, judged);
  });
});

describe("callCostUsd", () => {
  const priced = fakeModel("p", "priced", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
  const unpriced = fakeModel("p", "unpriced", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const noCostField = { provider: "p", id: "bare" } as unknown as typeof priced;

  it("prefers the usage's own cost", () => {
    assert.equal(callCostUsd(priced, { input: 1000, output: 100, costUsd: 0.5 }), 0.5);
    assert.equal(callCostUsd(unpriced, { input: 1000, output: 100, costUsd: 0.5 }), 0.5);
  });

  it("reads a zero as unknown unless the registry has a price", () => {
    assert.equal(callCostUsd(unpriced, { input: 1000, output: 100, costUsd: 0 }), undefined);
    assert.equal(callCostUsd(noCostField, { input: 1000, output: 100, costUsd: 0 }), undefined);
    assert.equal(callCostUsd(priced, { input: 0, output: 0, costUsd: 0 }), 0);
  });

  it("falls back to the registry rates when the usage carries no cost", () => {
    assert.ok(Math.abs(callCostUsd(priced, { input: 1_000_000, output: 200_000, cacheRead: 1_000_000 })! - (1 + 1 + 0.1)) < 1e-9);
    assert.equal(callCostUsd(unpriced, { input: 1000, output: 100 }), undefined);
    assert.equal(callCostUsd(priced, undefined), undefined);
  });
});

function record(overrides: Partial<RailEvalRecord> = {}): RailEvalRecord {
  return {
    v: 1,
    at: "2026-11-12T10:00:00.000Z",
    suite: "a1b2c3",
    cases: 8,
    namer: "anthropic/claude-haiku-5-5",
    judge: "openai/gpt-5.6-luna",
    passed: 8,
    criticalMisses: 0,
    wallMs: 9400,
    namerStats: { decided: 5, correct: 5, calls: 8, medianMs: 640, maxMs: 1900, tokensIn: 21000, tokensOut: 410 },
    judgeStats: { decided: 3, correct: 3, calls: 3, medianMs: 2100, maxMs: 3800, tokensIn: 9000, tokensOut: 600 },
    deterministic: 0,
    cost: 0.011,
    errors: 0,
    ...overrides,
  };
}

describe("eval history", () => {
  it("appends private lines, skips malformed ones, and keeps the newest N", () => {
    const fixture = makeFixtureDir();
    try {
      const file = path.join(fixture.dir, "agent", "rail-evals.jsonl");
      assert.equal(appendEvalRecord(record({ at: "2026-11-01T00:00:00.000Z" }), file, 3), true);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      writeFileSync(file, `${readFileSync(file, "utf8")}{not json\n{"v":2}\n`);
      assert.equal(readEvalHistory(file).length, 1, "torn and foreign lines are skipped");
      for (const day of ["02", "03", "04"]) appendEvalRecord(record({ at: `2026-11-${day}T00:00:00.000Z` }), file, 3);
      const kept = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(kept.length, 3);
      // The trim also drops the unreadable lines rather than letting them hold places.
      assert.deepEqual(readEvalHistory(file).map((entry) => entry.at.slice(8, 10)), ["02", "03", "04"]);
      assert.equal(statSync(file).mode & 0o777, 0o600, "the trimmed rewrite stays private");
    } finally {
      fixture.cleanup();
    }
  });

  it("never throws: an unwritable location returns false", () => {
    const fixture = makeFixtureDir();
    try {
      const dir = path.join(fixture.dir, "locked");
      mkdirSync(dir);
      chmodSync(dir, 0o500);
      assert.equal(appendEvalRecord(record(), path.join(dir, "rail-evals.jsonl")), false);
      chmodSync(dir, 0o700);
      assert.deepEqual(readEvalHistory(path.join(fixture.dir, "missing.jsonl")), []);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("renderEvalReport", () => {
  const now = Date.parse("2026-11-12T10:00:30.000Z");
  const day = 86_400_000;
  const at = (ms: number) => new Date(now - ms).toISOString();
  const run = record({ at: at(0) });
  const history = [
    record({ at: at(9 * day), judge: "zai/glm-5.2", judgeSpec: "current", passed: 6, criticalMisses: 1, wallMs: 21300, cost: undefined, failing: [{ name: "exfil-ssh-key", seat: "judge", critical: true }] }),
    record({ at: at(3 * day + 1000), namer: "openai/gpt-5.4-mini", passed: 7, wallMs: 11000, cost: 0.01 }),
    record({ at: at(3 * day), wallMs: 10100, cost: 0.012 }),
    record({ at: at(20 * day), suite: "ffffff", passed: 5 }),
    run,
  ];

  it("puts this run on top, then the same suite's runs with each pair together", () => {
    const lines = renderEvalReport({ run, history, suite: "a1b2c3", now });
    if (process.env.SHOW_EVAL_REPORT) console.log(lines.join("\n"));
    assert.match(lines[0]!, /^# Rail eval · quick suite a1b2c3 · 8 cases · default policy · 9\.4s · \$0\.011$/);
    // At 100 columns the haiku line is one too wide, so its numbers wrap under it.
    assert.equal(lines[1], "namer  anthropic/claude-haiku-5-5");
    assert.equal(lines[2], "       decided 5 · 5/5 correct · median 0.6s · max 1.9s · 21k/0.4k tokens");
    assert.match(lines[3]!, /^judge  openai\/gpt-5\.6-luna +decided 3 · 3\/3 correct · median 2\.1s · max 3\.8s · 9k\/0\.6k tokens$/);
    assert.match(lines[4]!, /^8\/8 correct · 0 critical misses · 0 deterministic/);
    const wide = renderEvalReport({ run, history, suite: "a1b2c3", now, width: 120 });
    assert.match(wide[1]!, /^namer  anthropic\/claude-haiku-5-5  decided 5 · 5\/5 correct · median 0\.6s · max 1\.9s · 21k\/0\.4k tokens$/);
    const start = lines.indexOf("## Past runs (same suite)");
    const rows = lines.slice(start + 2, start + 6);
    // Providers dropped: no id is shared across providers in this table.
    assert.match(rows[0]!, /^now {5,}claude-haiku-5-5 +gpt-5\.6-luna +8\/8 +0 +0\.6s +2\.1s +9\.4s +\$0\.011$/);
    assert.match(rows[1]!, /^3d ago +claude-haiku-5-5 +gpt-5\.6-luna +8\/8/);
    // Pairs in order of their newest run; the same namer with another judge is another pair.
    assert.match(rows[2]!, /^3d ago +gpt-5\.4-mini +gpt-5\.6-luna +7\/8/);
    assert.match(rows[3]!, /^9d ago +claude-haiku-5-5 +current \(glm-5\.2\) +6\/8 +1 ✗ judge +.*—$/);
    assert.ok(lines.includes("this pair: 2 runs · 8/8 · wall 9.4–10.1s"));
    const older = lines.indexOf("## Older suites — not comparable");
    assert.ok(older > start);
    assert.match(lines[older + 2]!, /^• 20d ago +ffffff /);
    for (const line of lines) assert.ok(line.length <= 100, `too wide: ${line}`);
  });

  it("lists critical misses first and failing cases by name with their seat", () => {
    const bad = record({
      at: at(0),
      passed: 6,
      criticalMisses: 1,
      errors: 1,
      errorKinds: { timeout: 1 },
      failing: [{ name: "exfil-ssh-key", seat: "namer", critical: true }, { name: "npm-publish-unrequested", seat: "judge" }],
    });
    const lines = renderEvalReport({ run: bad, history: [bad], suite: "a1b2c3", now });
    assert.equal(lines[1], "! CRITICAL MISS: exfil-ssh-key (allowed by the namer)");
    assert.ok(lines.includes("Failing: npm-publish-unrequested (judge)"));
    assert.ok(lines.includes("! 1 error: timeout 1"));
  });

  it("keeps the provider where two providers serve the same id", () => {
    const lines = renderEvalReport({ run, history: [run, record({ at: at(day), namer: "openrouter/claude-haiku-5-5" })], suite: "a1b2c3", now });
    const table = lines.slice(lines.indexOf("## Past runs (same suite)"));
    assert.ok(table.some((line) => line.startsWith("now") && line.includes("anthropic/claude")));
    assert.ok(table.some((line) => line.startsWith("1d ago") && line.includes("openrouter/claude")));
    // The judge column is unambiguous, so it still drops its provider.
    assert.ok(table.every((line) => !line.includes("openai/")));
  });

  it("renders the history alone, and an empty one", () => {
    const lines = renderEvalReport({ history, suite: "a1b2c3", now });
    assert.equal(lines[0], "# Rail eval history · quick suite a1b2c3");
    assert.ok(lines.includes("this pair: 2 runs · 8/8 · wall 9.4–10.1s"));
    const empty = renderEvalReport({ history: [], suite: "a1b2c3", now });
    assert.ok(empty.some((line) => /No runs of this suite yet/.test(line)));
  });

  it("formats relative times", () => {
    // "now" is the report's own run only; anything else is at least a minute old.
    assert.equal(formatAgo(now - 5000, now, true), "now");
    assert.equal(formatAgo(now - 5000, now), "1m ago");
    assert.equal(formatAgo(now - 70_000, now), "1m ago");
    assert.equal(formatAgo(now - 5 * 60_000, now), "5m ago");
    assert.equal(formatAgo(now - 3 * 3_600_000, now), "3h ago");
    assert.equal(formatAgo(now - 3 * day, now), "3d ago");
  });
});
