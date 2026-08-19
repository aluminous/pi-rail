import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilityStats } from "../src/capabilities.ts";
import {
  createRuntimeState,
  lastRailDecision,
  modelUsageRows,
  recentClassifications,
  recentEvents,
  recentJudgements,
  recordApprovalDenied,
  recordApprovalGranted,
  recordApprovalRequested,
  recordCapabilityDecision,
  recordClassifierError,
  recordJudgement,
  recordModelCall,
  recordPolicyBlock,
  resetSessionState,
  resetTurnStats,
  REVIEW_RING_LIMIT,
} from "../src/state.ts";

describe("decision recording", () => {
  it("counts policy blocks as rule hits", () => {
    const state = createRuntimeState();
    recordPolicyBlock(state, "read", "read denied by pattern .env");
    assert.equal(state.stats.ruleHits, 1);
    assert.equal(state.stats.turnRuleHits, 1);
    assert.equal(state.stats.blocked, 1);
    assert.equal(recentEvents(state)[0]?.decision, "block");
  });

  it("tracks the approval ask/deny flow", () => {
    const state = createRuntimeState();
    recordApprovalRequested(state, "write", "write", "/tmp/x");
    assert.equal(state.stats.asked, 1);
    assert.equal(state.stats.ruleHits, 1);
    recordApprovalDenied(state);
    assert.equal(state.stats.blocked, 1);
  });

  it("records approval grants as allow events without counter changes", () => {
    const state = createRuntimeState();
    recordApprovalGranted(state, "read", "read", "/tmp/x");
    assert.equal(recentEvents(state)[0]?.decision, "allow");
    assert.equal(state.stats.ruleHits, 0);
    assert.equal(state.stats.allowed, 0);
  });

  it("derives review counters from capability decisions", () => {
    const state = createRuntimeState();
    recordCapabilityDecision(state, "bash", { target: "", labels: ["run-dev-tools"], decision: "allow", disposition: "allow", reason: "ok", reviewed: true, tokenUsage: { input: 100, output: 20 } });
    recordCapabilityDecision(state, "bash", { target: "", labels: ["credentials"], decision: "deny", disposition: "judge", reason: "no", reviewed: true, tokenUsage: { input: 50, output: 10 } });
    recordCapabilityDecision(state, "bash", { target: "", labels: ["off-machine-effects"], decision: "ask", disposition: "ask", reason: "confirm", reviewed: true });
    assert.equal(state.stats.reviewed, 3);
    assert.equal(state.stats.classifierHits, 3);
    assert.equal(state.stats.turnClassifierHits, 3);
    assert.equal(state.stats.allowed, 1);
    assert.equal(state.stats.denied, 1);
    assert.equal(state.stats.classifierDenials, 1);
    assert.equal(state.stats.turnClassifierDenials, 1);
    assert.equal(state.stats.asked, 1);
    assert.equal(state.stats.classifierInputTokens, 150);
    assert.equal(state.stats.classifierOutputTokens, 30);
    assert.equal(capabilityStats(state.capabilities, "credentials").hits, 1);
    assert.equal(recentEvents(state)[0]?.capabilities?.[0], "off-machine-effects");
  });

  it("counts a deterministic table hit as a rule hit, not a review", () => {
    const state = createRuntimeState();
    recordCapabilityDecision(state, "read", { target: "", labels: ["read-project"], decision: "allow", disposition: "allow", reason: "in cwd", reviewed: false });
    assert.equal(state.stats.ruleHits, 1);
    assert.equal(state.stats.turnRuleHits, 1);
    assert.equal(state.stats.classifierHits, 0);
    assert.equal(state.stats.reviewed, 0);
    assert.equal(state.stats.allowed, 1);
  });

  it("records classifier errors and buckets them by kind", () => {
    const state = createRuntimeState();
    recordClassifierError(state, "bash", "boom", "timeout");
    assert.equal(state.stats.errors, 1);
    assert.equal(recentEvents(state)[0]?.decision, "error");
    assert.deepEqual(state.stats.errorsByKind, { timeout: 1 });
  });

  it("accumulates per-kind error counts and clears them on session reset", () => {
    const state = createRuntimeState();
    recordClassifierError(state, "bash", "a", "timeout");
    recordClassifierError(state, "bash", "b", "server error");
    recordClassifierError(state, "write", "c", "timeout");
    assert.equal(state.stats.errors, 3);
    assert.deepEqual(state.stats.errorsByKind, { timeout: 2, "server error": 1 });
    resetSessionState(state);
    assert.equal(state.stats.errors, 0);
    assert.deepEqual(state.stats.errorsByKind, {});
  });

  it("caps recent events at 8", () => {
    const state = createRuntimeState();
    for (let i = 0; i < 12; i++) recordPolicyBlock(state, "read", `block ${i}`);
    assert.equal(recentEvents(state).length, 8);
    assert.equal(recentEvents(state)[0]?.reason, "block 11");
  });

  it("resets turn counters without touching session totals", () => {
    const state = createRuntimeState();
    recordPolicyBlock(state, "read", "x");
    resetTurnStats(state);
    assert.equal(state.stats.turnRuleHits, 0);
    assert.equal(state.stats.turnBlocked, 0);
    assert.equal(state.stats.ruleHits, 1);
    assert.equal(state.stats.blocked, 1);
  });

  it("counts blocks and denied approvals in the per-turn blocked counter", () => {
    const state = createRuntimeState();
    recordPolicyBlock(state, "read", "x");
    recordApprovalDenied(state);
    assert.equal(state.stats.turnBlocked, 2);
    assert.equal(state.stats.blocked, 2);
  });

  it("resets session state in place, preserving object identity", () => {
    const state = createRuntimeState();
    recordPolicyBlock(state, "read", "x");
    state.approvals.read.push("/tmp/x");
    const identity = state;
    resetSessionState(state);
    assert.equal(state, identity);
    assert.equal(state.stats.ruleHits, 0);
    assert.deepEqual(state.approvals, { read: [], write: [] });
  });
});

describe("per-model accumulation", () => {
  it("accumulates tokens, dollars, and latency per model and role", () => {
    const state = createRuntimeState();
    recordModelCall(state, { role: "namer", model: "openrouter/haiku", latencyMs: 400, usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 50, costUsd: 0.0012 } });
    recordModelCall(state, { role: "namer", model: "openrouter/haiku", latencyMs: 800, usage: { input: 120, output: 25, cacheRead: 1000, costUsd: 0.0014 } });
    recordModelCall(state, { role: "judge", model: "anthropic/opus", latencyMs: 2500, usage: { input: 2000, output: 90, costUsd: 0.04 } });

    const rows = modelUsageRows(state.stats);
    assert.deepEqual(rows.map((row) => `${row.role} ${row.model}`), ["namer openrouter/haiku", "judge anthropic/opus"], "namer rows come before judge rows");
    const namer = rows[0]!;
    assert.equal(namer.calls, 2);
    assert.equal(namer.input, 220);
    assert.equal(namer.output, 45);
    assert.equal(namer.cacheRead, 1900);
    assert.equal(namer.cacheWrite, 50);
    assert.equal(namer.costUsd, 0.0026);
    assert.equal(namer.unpricedCalls, 0);
    assert.equal(namer.totalLatencyMs, 1200);
    assert.equal(namer.maxLatencyMs, 800);
    assert.equal(rows[1]!.calls, 1);
  });

  it("keeps the same model apart in its two roles", () => {
    const state = createRuntimeState();
    recordModelCall(state, { role: "namer", model: "anthropic/sonnet", latencyMs: 100, usage: { input: 10, output: 1 } });
    recordModelCall(state, { role: "judge", model: "anthropic/sonnet", latencyMs: 900, usage: { input: 20, output: 2 } });
    assert.deepEqual(modelUsageRows(state.stats).map((row) => [row.role, row.calls, row.maxLatencyMs]), [["namer", 1, 100], ["judge", 1, 900]]);
  });

  it("counts unpriced calls instead of totalling them as free", () => {
    const state = createRuntimeState();
    recordModelCall(state, { role: "namer", model: "local/llama", latencyMs: 50, usage: { input: 10, output: 2 } });
    recordModelCall(state, { role: "namer", model: "local/llama", latencyMs: 60, usage: { input: 10, output: 2, costUsd: 0.5 } });
    recordModelCall(state, { role: "namer", model: "local/llama", latencyMs: 70, usage: undefined });
    const row = modelUsageRows(state.stats)[0]!;
    assert.equal(row.calls, 3);
    assert.equal(row.costUsd, 0.5);
    assert.equal(row.unpricedCalls, 2);
  });

  it("files a call with no resolvable model under 'unknown' rather than dropping it", () => {
    const state = createRuntimeState();
    recordModelCall(state, { role: "namer", model: undefined, latencyMs: 30, usage: { input: 5, output: 1 } });
    assert.deepEqual(modelUsageRows(state.stats).map((row) => row.model), ["unknown"]);
  });

  it("clears on session reset", () => {
    const state = createRuntimeState();
    recordModelCall(state, { role: "namer", model: "openrouter/haiku", latencyMs: 10, usage: { input: 1, output: 1 } });
    resetSessionState(state);
    assert.deepEqual(modelUsageRows(state.stats), []);
  });
});

describe("recent review rings", () => {
  function classify(state: ReturnType<typeof createRuntimeState>, n: number) {
    recordCapabilityDecision(state, "bash", {
      target: "npm test",
      labels: ["run-dev-tools"],
      decision: "allow",
      disposition: "allow",
      decidedBy: "run-dev-tools",
      reason: `call ${n}`,
      reviewed: true,
      tokenUsage: { input: 10 * n, output: n },
      latencyMs: n,
      model: "openrouter/haiku",
    });
  }

  it("records a classification per capability decision, newest first", () => {
    const state = createRuntimeState();
    classify(state, 1);
    classify(state, 2);
    const [newest] = recentClassifications(state);
    assert.equal(recentClassifications(state).length, 2);
    assert.equal(newest?.inputTokens, 20);
    assert.equal(newest?.outputTokens, 2);
    assert.equal(newest?.latencyMs, 2);
    assert.equal(newest?.model, "openrouter/haiku");
    assert.equal(newest?.disposition, "allow");
    assert.equal(newest?.decision, "allow");
    assert.deepEqual(newest?.labels, ["run-dev-tools"]);
  });

  it("leaves the model and latency empty for a deterministic decision", () => {
    const state = createRuntimeState();
    recordCapabilityDecision(state, "read", { target: "", labels: ["read-project"], decision: "allow", disposition: "allow", reason: "in cwd", reviewed: false });
    assert.equal(recentClassifications(state)[0]?.model, undefined);
    assert.equal(recentClassifications(state)[0]?.latencyMs, 0);
  });

  it("caps both rings and drops them on session reset", () => {
    const state = createRuntimeState();
    for (let i = 0; i < REVIEW_RING_LIMIT + 5; i++) {
      classify(state, i);
      recordJudgement(state, { at: Date.now(), toolName: "bash", target: "", labels: ["credentials"], verdict: "ask", reason: `judge ${i}`, latencyMs: i, inputTokens: i, outputTokens: i });
    }
    assert.equal(recentClassifications(state).length, REVIEW_RING_LIMIT);
    assert.equal(recentJudgements(state).length, REVIEW_RING_LIMIT);
    assert.equal(recentJudgements(state)[0]?.reason, `judge ${REVIEW_RING_LIMIT + 4}`);
    resetSessionState(state);
    assert.deepEqual(recentClassifications(state), []);
    assert.deepEqual(recentJudgements(state), []);
    assert.deepEqual(state.decisions, []);
  });

  it("keeps each view's window independent: a judgement burst cannot evict the namer rows", () => {
    const state = createRuntimeState();
    for (let i = 0; i < 5; i++) classify(state, i);
    for (let i = 0; i < REVIEW_RING_LIMIT + 10; i++) {
      recordJudgement(state, { at: Date.now(), toolName: "bash", target: "", labels: ["credentials"], verdict: "ask", reason: `judge ${i}`, latencyMs: i, inputTokens: i, outputTokens: i });
    }
    assert.equal(recentClassifications(state).length, 5, "the old per-ring behavior: other kinds never crowd a view out");
    assert.equal(recentJudgements(state).length, REVIEW_RING_LIMIT);
    assert.equal(recentEvents(state).length, 5, "judgements are not event rows");
  });

  it("derives the last decision from the newest review entry, skipping later plain events", () => {
    const state = createRuntimeState();
    assert.equal(lastRailDecision(state), undefined);
    classify(state, 1);
    recordPolicyBlock(state, "write", "blocked after");
    const last = lastRailDecision(state);
    assert.equal(last?.decision, "allow");
    assert.equal(last?.reason, "call 1");
    assert.deepEqual(last?.labels, ["run-dev-tools"]);
  });
});

describe("decided-by counting", () => {
  it("credits only the label that produced the winning disposition", () => {
    const state = createRuntimeState();
    recordCapabilityDecision(state, "bash", {
      target: "git push origin main",
      labels: ["read-project", "off-machine-effects"],
      decision: "ask",
      disposition: "ask",
      decidedBy: "off-machine-effects",
      reason: "confirm the push",
      reviewed: true,
    });
    assert.equal(capabilityStats(state.capabilities, "read-project").hits, 1);
    assert.equal(capabilityStats(state.capabilities, "read-project").decided, 0, "an allow-set class along for the ride decided nothing");
    assert.equal(capabilityStats(state.capabilities, "off-machine-effects").hits, 1);
    assert.equal(capabilityStats(state.capabilities, "off-machine-effects").decided, 1);
  });

  it("leaves every class undecided when the caller resolved no winner", () => {
    const state = createRuntimeState();
    recordCapabilityDecision(state, "bash", { target: "", labels: ["read-project"], decision: "allow", disposition: "allow", reason: "ok", reviewed: false });
    assert.equal(capabilityStats(state.capabilities, "read-project").decided, 0);
  });
});
