import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { addSessionGuidance, type ClassifierState } from "../src/classifier.ts";
import { createCapabilityStats } from "../src/capabilities.ts";
import { applyDerivedRailState, deriveRailState } from "../src/session-replay.ts";
import { createRuntimeState, lastRailDecision, recentClassifications, recentEvents, recentJudgements } from "../src/state.ts";
import type { RailApprovalTelemetry, RailReviewTelemetry, RailTelemetryRecord } from "../src/telemetry.ts";

let seq = 0;

/** A `custom` session entry as getBranch() returns it; `at` is the entry's own timestamp. */
function railEntry(data: unknown, at = "2026-08-19T10:00:00.000Z", customType = "rail"): SessionEntry {
  return { type: "custom", id: `e${++seq}`, parentId: null, timestamp: at, customType, data } as SessionEntry;
}

/** A memory-core review record, as the interceptor persists it with telemetry off. */
function review(overrides: Partial<RailReviewTelemetry> = {}): RailReviewTelemetry {
  return {
    kind: "review",
    tool: "bash",
    decision: "allow",
    labels: ["run-dev-tools"],
    resolvedDisposition: "allow",
    decidedBy: "run-dev-tools",
    target: "npm test",
    subject: "npm test",
    reviewed: true,
    reason: "routine dev tooling",
    ...overrides,
  };
}

function approval(overrides: Partial<RailApprovalTelemetry> = {}): RailApprovalTelemetry {
  return {
    kind: "approval",
    tool: "write",
    access: "write",
    path: "/tmp/out.txt",
    outcome: "approved",
    reason: "outside the configured roots",
    ...overrides,
  };
}

describe("deriveRailState", () => {
  it("rebuilds the recent ring in order, stamped with the entries' own timestamps", () => {
    const derived = deriveRailState([
      railEntry(review({ reason: "first" }), "2026-08-19T10:00:00.000Z"),
      railEntry(review({ decision: "deny", labels: ["credentials"], reason: "second" }), "2026-08-19T10:05:00.000Z"),
    ]);
    assert.equal(recentEvents(derived).length, 2);
    assert.equal(recentEvents(derived)[0]?.reason, "second", "newest first, like the live ring");
    assert.equal(recentEvents(derived)[0]?.decision, "deny");
    assert.deepEqual(recentEvents(derived)[0]?.capabilities, ["credentials"]);
    assert.equal(recentEvents(derived)[0]?.at, Date.parse("2026-08-19T10:05:00.000Z"));
    assert.equal(recentEvents(derived)[1]?.at, Date.parse("2026-08-19T10:00:00.000Z"));
  });

  it("caps the rebuilt recent ring at the live limit of 8", () => {
    const entries = Array.from({ length: 12 }, (_, i) => railEntry(review({ reason: `call ${i}` })));
    const derived = deriveRailState(entries);
    assert.equal(recentEvents(derived).length, 8);
    assert.equal(recentEvents(derived)[0]?.reason, "call 11");
  });

  it("folds review outcomes into the same counters the live path keeps", () => {
    const derived = deriveRailState([
      railEntry(review({ decision: "allow", usage: { input: 100, output: 20 } })),
      railEntry(review({ decision: "deny", resolvedDisposition: "deny", usage: { input: 50, output: 10 } })),
      railEntry(review({ decision: "ask", resolvedDisposition: "ask" })),
      railEntry(review({ decision: "stop", resolvedDisposition: "ask", userAnswer: "stopped" })),
      // A deterministic allow that consulted no model: an exemption, not a review.
      railEntry(review({ reviewed: false, labels: ["read-project"], decidedBy: "read-project" })),
    ]);
    assert.equal(derived.stats.reviewed, 4);
    assert.equal(derived.stats.classifierHits, 4);
    assert.equal(derived.stats.ruleHits, 1);
    assert.equal(derived.stats.classifierSkips, 1);
    assert.equal(derived.stats.allowed, 2);
    assert.equal(derived.stats.denied, 1);
    assert.equal(derived.stats.classifierDenials, 1);
    assert.equal(derived.stats.asked, 1);
    assert.equal(derived.stats.stopped, 1, "a stop is counted as stopped");
    assert.equal(derived.stats.blocked, 0, "…never as a denial or block");
    assert.equal(derived.stats.classifierInputTokens, 150);
    assert.equal(derived.stats.classifierOutputTokens, 30);
    assert.equal(derived.stats.turnClassifierHits, 0, "turn counters are per-live-turn, not per-branch");
  });

  it("replays blocks and classifier errors, bucketing errors by kind", () => {
    const derived = deriveRailState([
      railEntry({ kind: "block", tool: "write", reason: "write denied for .env" } satisfies RailTelemetryRecord),
      railEntry({ kind: "error", tool: "bash", reason: "timeout after 15000ms", failureKind: "timeout" } satisfies RailTelemetryRecord),
      railEntry({ kind: "error", tool: "bash", reason: "boom", failureKind: "timeout" } satisfies RailTelemetryRecord),
    ]);
    assert.equal(derived.stats.blocked, 1);
    assert.equal(derived.stats.ruleHits, 1);
    assert.equal(derived.stats.errors, 2);
    assert.deepEqual(derived.stats.errorsByKind, { timeout: 2 });
    assert.equal(recentEvents(derived)[2]?.decision, "block");
    assert.equal(recentEvents(derived)[0]?.decision, "error");
  });

  it("replays one approval record as the live request→answer helper sequence", () => {
    const granted = deriveRailState([railEntry(approval({ outcome: "approved" }))]);
    assert.equal(granted.stats.asked, 1);
    assert.equal(granted.stats.ruleHits, 1);
    assert.equal(granted.stats.blocked, 0);
    // Live pushes two ring events for a granted approval: the ask and the grant.
    assert.deepEqual(recentEvents(granted).map((event) => event.decision), ["allow", "ask"]);
    assert.equal(recentEvents(granted)[0]?.reason, "approved write path /tmp/out.txt");

    const denied = deriveRailState([railEntry(approval({ outcome: "denied" }))]);
    assert.equal(denied.stats.blocked, 1);
    assert.equal(denied.stats.stopped, 0);

    const stopped = deriveRailState([railEntry(approval({ outcome: "stopped" }))]);
    assert.equal(stopped.stats.stopped, 1, "a stopped ask is stopped");
    assert.equal(stopped.stats.blocked, 0, "…not a refusal");
    assert.equal(recentEvents(stopped)[0]?.decision, "stop");
  });

  it("rebuilds session guidance exactly as the live addSessionGuidance calls built it", () => {
    const derived = deriveRailState([
      railEntry(review({ decision: "allow", userAnswer: "approved", userComment: "deploys are fine here", subject: "git push origin main" })),
      railEntry(approval({ outcome: "denied", userComment: "never write there", path: "/etc/hosts" })),
      // Stops carry no verdict, so their comments (there are none) add nothing;
      // an answer without a comment adds nothing either.
      railEntry(review({ decision: "stop", userAnswer: "stopped" })),
      railEntry(review({ decision: "deny", userAnswer: "denied" })),
    ]);
    const expected: ClassifierState = {};
    addSessionGuidance(expected, "allowed", "bash", "git push origin main", "deploys are fine here");
    addSessionGuidance(expected, "denied", "write", "write /etc/hosts", "never write there");
    assert.deepEqual(derived.sessionGuidance, expected.sessionGuidance);
  });

  it("replays /rail guide adds and clears in branch order", () => {
    const derived = deriveRailState([
      railEntry({ kind: "guidance", tool: "rail", text: "wiped by the clear" } satisfies RailTelemetryRecord),
      railEntry({ kind: "guidance", tool: "rail", cleared: true } satisfies RailTelemetryRecord),
      railEntry({ kind: "guidance", tool: "rail", text: "this repo's deploy script is expected to push" } satisfies RailTelemetryRecord),
    ]);
    assert.equal(derived.sessionGuidance?.length, 1);
    assert.match(derived.sessionGuidance?.[0] ?? "", /deploy script is expected to push/);
    assert.doesNotMatch(derived.sessionGuidance?.[0] ?? "", /wiped/);
  });

  it("rebuilds the judgement ring from the judge's own verdict and reason", () => {
    const derived = deriveRailState([
      railEntry(
        review({
          decision: "deny",
          resolvedDisposition: "judge",
          labels: ["credentials"],
          latencyMs: 200,
          usage: { input: 100, output: 20 },
          judge: { verdict: "deny", reason: "reads a production secret", latencyMs: 900, model: "anthropic/opus", usage: { input: 60, output: 8 } },
        }),
      ),
    ]);
    const judgement = recentJudgements(derived)[0];
    assert.equal(judgement?.verdict, "deny");
    assert.equal(judgement?.reason, "reads a production secret");
    assert.equal(judgement?.latencyMs, 900);
    assert.equal(judgement?.inputTokens, 60);
    assert.equal(judgement?.model, "anthropic/opus");
    assert.deepEqual(judgement?.labels, ["credentials"]);
    // The classifications ring shows the whole review: namer plus judge latency, combined tokens.
    assert.equal(recentClassifications(derived)[0]?.latencyMs, 1100);
    assert.equal(recentClassifications(derived)[0]?.inputTokens, 100);
  });

  it("tracks the last decision for the status panel", () => {
    const derived = deriveRailState([
      railEntry(review({ reason: "older" }), "2026-08-19T10:00:00.000Z"),
      railEntry(review({ decision: "deny", reason: "newest" }), "2026-08-19T10:05:00.000Z"),
    ]);
    assert.equal(lastRailDecision(derived)?.decision, "deny");
    assert.equal(lastRailDecision(derived)?.reason, "newest");
    assert.equal(lastRailDecision(derived)?.at, Date.parse("2026-08-19T10:05:00.000Z"));
  });

  it("silently skips what it cannot parse — one bad record never poisons replay", () => {
    const entries: SessionEntry[] = [
      railEntry(review({ reason: "good" })),
      // Not ours / not current shape / not parseable, in every flavor:
      { type: "message", id: "m1", parentId: null, timestamp: "2026-08-19T10:00:00.000Z" } as unknown as SessionEntry,
      railEntry({ kind: "review", tool: "bash" }, undefined),
      railEntry("not an object"),
      railEntry(null),
      railEntry({ kind: "unheard-of", tool: "bash" }),
      railEntry(review({ reviewed: undefined as unknown as boolean }), undefined),
      railEntry(review({ judge: { verdict: "deny" } as never })),
      railEntry(approval({ access: "execute" as never })),
      railEntry(review({ reason: "also good" })),
    ];
    const derived = deriveRailState(entries);
    assert.equal(derived.stats.reviewed, 2);
    assert.deepEqual(recentEvents(derived).map((event) => event.reason), ["also good", "good"]);
  });

  it("ignores the legacy 'guard' customType outright — no compat shims by decision", () => {
    // An old-corpus record that would parse fine under the current shape still
    // does not replay: replay reads only what the current rail writes.
    const derived = deriveRailState([railEntry(review(), undefined, "guard")]);
    assert.equal(derived.stats.reviewed, 0);
    assert.deepEqual(recentEvents(derived), []);
  });

  it("rebuilds per-class hits, decided, and outcome buckets from review records", () => {
    const derived = deriveRailState([
      railEntry(review()),
      railEntry(review({ decision: "deny", resolvedDisposition: "deny", labels: ["credentials"], decidedBy: "credentials" })),
      railEntry(review({ decision: "allow", resolvedDisposition: "ask", labels: ["off-machine-effects"], decidedBy: "off-machine-effects", userAnswer: "approved" })),
      railEntry(review({ decision: "stop", resolvedDisposition: "ask", labels: ["off-machine-effects"], decidedBy: "off-machine-effects", userAnswer: "stopped" })),
    ]);
    assert.equal(derived.capabilityStats["run-dev-tools"]?.hits, 1);
    assert.equal(derived.capabilityStats["run-dev-tools"]?.decided, 1);
    assert.equal(derived.capabilityStats["run-dev-tools"]?.outcomes.allow, 1);
    assert.equal(derived.capabilityStats["credentials"]?.outcomes.deny, 1);
    assert.equal(derived.capabilityStats["off-machine-effects"]?.hits, 2);
    assert.equal(derived.capabilityStats["off-machine-effects"]?.outcomes["ask-approved"], 1);
    assert.equal(derived.capabilityStats["off-machine-effects"]?.outcomes["ask-stopped"], 1);
  });

  it("derives judge outcomes from the judge sub-object, which survives every redaction tier", () => {
    const judged = (verdict: "allow" | "deny" | "ask", overrides: Partial<RailReviewTelemetry>) =>
      review({ resolvedDisposition: "judge", labels: ["credentials"], decidedBy: "credentials", judge: { verdict, reason: "r" }, ...overrides });
    const derived = deriveRailState([
      railEntry(judged("allow", { decision: "allow" })),
      railEntry(judged("deny", { decision: "deny" })),
      railEntry(judged("ask", { decision: "allow", userAnswer: "approved" })),
      // The judge asked and nobody could answer: live files that as ask-denied, not judge-deny.
      railEntry(judged("ask", { decision: "deny" })),
      // Judge failure fell back to ask, then nobody could answer: no judge
      // object at all, resolvedDisposition still "judge" — also ask-denied.
      railEntry(review({ resolvedDisposition: "judge", labels: ["credentials"], decidedBy: "credentials", decision: "deny" })),
    ]);
    const stats = derived.capabilityStats["credentials"];
    assert.equal(stats?.outcomes["judge-allow"], 1);
    assert.equal(stats?.outcomes["judge-deny"], 1);
    assert.equal(stats?.outcomes["judge-ask"], 1);
    assert.equal(stats?.outcomes["ask-denied"], 2);
    assert.equal(stats?.hits, 5);
  });

  it("rebuilds the screen ✗/✓ columns from the promoted screenTripped field", () => {
    const derived = deriveRailState([
      railEntry(review({ tool: "write", labels: ["modify-project"], decidedBy: "modify-project", screenTripped: false })),
      railEntry(review({ tool: "write", labels: ["persistence"], decidedBy: "persistence", decision: "deny", resolvedDisposition: "deny", screenTripped: true })),
      // No screenTripped at all: the screen never looked, neither column moves.
      railEntry(review()),
    ]);
    assert.equal(derived.capabilityStats["modify-project"]?.screenClean, 1);
    assert.equal(derived.capabilityStats["modify-project"]?.screenTripped, 0);
    assert.equal(derived.capabilityStats["persistence"]?.screenTripped, 1);
    assert.equal(derived.capabilityStats["run-dev-tools"]?.screenClean, 0);
    assert.equal(derived.capabilityStats["run-dev-tools"]?.screenTripped, 0);
  });

  it("replays a labeled path-approval record into the per-class stats", () => {
    const routed = approval({ labels: ["modify-system"], decidedBy: "modify-system", screenTripped: false });
    const answered = deriveRailState([railEntry(routed)]);
    assert.equal(answered.capabilityStats["modify-system"]?.hits, 1);
    assert.equal(answered.capabilityStats["modify-system"]?.decided, 1);
    assert.equal(answered.capabilityStats["modify-system"]?.outcomes["ask-approved"], 1);
    assert.equal(answered.capabilityStats["modify-system"]?.screenClean, 1);
    assert.equal(answered.stats.asked, 1, "a routed dialog still counts as an ask");

    // A remembered record is session path memory answering: the per-class
    // stats move, but no dialog counters and no ring events fired live.
    const remembered = deriveRailState([railEntry({ ...routed, remembered: true })]);
    assert.equal(remembered.capabilityStats["modify-system"]?.hits, 1);
    assert.equal(remembered.capabilityStats["modify-system"]?.outcomes["ask-approved"], 1);
    assert.equal(remembered.stats.asked, 0, "no dialog was shown");
    assert.deepEqual(recentEvents(remembered), [], "and no ring events fired");

    // A plain stage-1 path ask carries no labels and moves no per-class stats.
    const plain = deriveRailState([railEntry(approval())]);
    assert.deepEqual(plain.capabilityStats, {});
  });

  it("rewinds a denied class's stats with the branch and restores them going forward", () => {
    const prefix = [railEntry(review(), "2026-08-19T09:00:00.000Z")];
    const full = [
      ...prefix,
      railEntry(review({ decision: "deny", resolvedDisposition: "deny", labels: ["credentials"], decidedBy: "credentials" }), "2026-08-19T09:05:00.000Z"),
    ];
    const atLeaf = deriveRailState(full);
    assert.equal(atLeaf.capabilityStats["credentials"]?.outcomes.deny, 1);
    const rewound = deriveRailState(prefix);
    assert.equal(rewound.capabilityStats["credentials"], undefined, "the denial's row rewound away with the branch");
    assert.equal(rewound.capabilityStats["run-dev-tools"]?.hits, 1, "the prefix's own stats stay");
    const forward = deriveRailState(full);
    assert.deepEqual(forward, atLeaf, "navigating forward restores the leaf exactly");
  });

  it("round-trips A→B→A navigation: deriving branch A again restores it exactly", () => {
    const prefix = [railEntry(review({ reason: "shared prefix" }), "2026-08-19T09:00:00.000Z")];
    const branchA = [
      ...prefix,
      railEntry(review({ decision: "deny", reason: "denied on A", userAnswer: "denied", userComment: "not on this branch" }), "2026-08-19T09:05:00.000Z"),
    ];
    const branchB = [
      ...prefix,
      railEntry(approval({ outcome: "stopped" }), "2026-08-19T09:06:00.000Z"),
      railEntry({ kind: "guidance", tool: "rail", text: "B-only guidance" } satisfies RailTelemetryRecord, "2026-08-19T09:07:00.000Z"),
    ];
    const first = deriveRailState(branchA);
    const away = deriveRailState(branchB);
    const back = deriveRailState(branchA);
    assert.deepEqual(back, first, "memory is a pure function of the branch");
    assert.notDeepEqual(recentEvents(away), recentEvents(first), "and B really was a different branch");
    assert.equal(away.stats.denied, 0, "the denial navigated away from stopped existing on B");
    assert.equal(back.stats.denied, 1, "and came back with A");
  });

  it("replays a fork/resume prefix instead of starting blank or over-remembering", () => {
    const full = [
      railEntry(review({ reason: "pre-fork" }), "2026-08-19T09:00:00.000Z"),
      railEntry(review({ decision: "deny", reason: "post-fork" }), "2026-08-19T09:10:00.000Z"),
    ];
    const derived = deriveRailState(full.slice(0, 1));
    assert.equal(derived.stats.reviewed, 1, "pre-fork history is remembered");
    assert.equal(derived.stats.denied, 0, "post-fork history is not");
    assert.equal(lastRailDecision(derived)?.reason, "pre-fork");
  });
});

describe("applyDerivedRailState", () => {
  it("installs the derived memory and clears the unreconstructable traces", () => {
    const state = createRuntimeState();
    state.traces.push({ at: 1, toolName: "bash", action: "bash: x", final: "allowed", stages: [] });
    applyDerivedRailState(state, [railEntry(review({ decision: "deny", userAnswer: "denied", userComment: "no" }))]);
    assert.equal(state.stats.denied, 1);
    assert.equal(recentEvents(state)[0]?.decision, "deny");
    assert.equal(state.classifier.sessionGuidance?.length, 1);
    assert.equal(lastRailDecision(state)?.decision, "deny");
    assert.equal(state.capabilities.stats["run-dev-tools"]?.outcomes["ask-denied"], 1, "the capabilities table follows the branch too");
    assert.deepEqual(state.traces, [], "traces carry never-persisted stage detail and must not describe a left branch");
  });

  it("leaves session infrastructure and non-branch session memory alone", () => {
    const state = createRuntimeState();
    state.warnings = ["keep me"];
    state.enabled = true;
    state.readOnly = true;
    state.approvals.write.push("/tmp/approved");
    state.classifier.modelOverride = "openrouter/haiku";
    state.classifier.enabledOverride = false;
    state.capabilities.overrides["local-destructive"] = "deny";
    // Stats from before navigation: branch memory, so replay replaces them.
    state.capabilities.stats["stale-class"] = createCapabilityStats();
    const capabilities = state.capabilities;
    const dialogQueue = state.dialogQueue;
    applyDerivedRailState(state, [railEntry(review())]);
    assert.deepEqual(state.warnings, ["keep me"]);
    assert.equal(state.enabled, true);
    assert.equal(state.readOnly, true);
    assert.deepEqual(state.approvals.write, ["/tmp/approved"], "path approvals are session-scoped, not branch-derived");
    assert.equal(state.classifier.modelOverride, "openrouter/haiku", "classifier settings are settings, not memory");
    assert.equal(state.classifier.enabledOverride, false);
    assert.equal(state.capabilities, capabilities, "the CapabilityState object keeps its identity");
    assert.equal(state.capabilities.overrides["local-destructive"], "deny", "disposition overrides are settings, not memory");
    assert.equal(state.capabilities.stats["stale-class"], undefined, "…but the stats half is branch memory and was rebuilt");
    assert.equal(state.capabilities.stats["run-dev-tools"]?.hits, 1);
    assert.equal(state.dialogQueue, dialogQueue);
  });
});
