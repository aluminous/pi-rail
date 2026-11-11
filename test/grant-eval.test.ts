// Grant evaluation (src/grant-eval.ts): rules-only classes in the fold, the
// dry run's parity with the live interceptor, corpus replay (every branch,
// the redaction floor included), the corpus diff, each gate, and the
// sensitive-op list.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EVAL_CASES } from "../eval/cases.ts";
import type { RailBackend } from "../src/backends/types.ts";
import type { CapabilityId } from "../src/capabilities.ts";
import type { CompleteFn } from "../src/classifier.ts";
import type { ResolvedRailConfig } from "../src/config.ts";
import { classDetailPrefix, dispositionRows } from "../src/dispositions.ts";
import {
  corpusDiff,
  dryRunAction,
  evaluateGrant,
  grantWithApprovedOps,
  replayRecord,
  sensitiveOps,
  type GrantEvalContext,
} from "../src/grant-eval.ts";
import { interceptToolCall } from "../src/interceptor.ts";
import {
  applyLayer,
  applyOpsToRawConfig,
  compileConfigLayer,
  createSessionLayer,
  editSessionAddClass,
  opDirection,
  parseGrant,
  sessionPolicyLayer,
  type Grant,
  type PolicyLayer,
} from "../src/policy-store.ts";
import { buildCorpusRecord, type CorpusRecord, type CorpusDecision } from "../src/replay-corpus.ts";
import { createRuntimeState } from "../src/state.ts";
import { makeFixtureDir, testConfig } from "./helpers.ts";

const fixture = makeFixtureDir();
after(() => fixture.cleanup());
const cwd = path.join(fixture.dir, "project");
mkdirSync(path.join(cwd, "src"), { recursive: true });
writeFileSync(path.join(cwd, "src", "app.ts"), "ok");

const WORKTREE_GRANT: Grant = JSON.parse(readFileSync(new URL("../examples/grants/worktree-cleanup.json", import.meta.url), "utf8"));

function sessionLayer(grants: Grant[]): PolicyLayer {
  return { name: "session", settings: {}, base: [], grants, diagnostics: [] };
}

function withGrant(config: ResolvedRailConfig, grant: Grant): ResolvedRailConfig {
  return applyLayer(config, sessionLayer([grant]));
}

function classifierOn(): ResolvedRailConfig {
  return testConfig((c) => (c.classifier.enabled = true));
}

function grant(id: string, ops: Grant["ops"], examples?: Grant["examples"]): Grant {
  return { id, request: `test ${id}`, created: "2026-11-11", ops, ...(examples ? { examples } : {}) };
}

function evalContext(overrides: Partial<GrantEvalContext> = {}): GrantEvalContext {
  return { base: classifierOn(), layer: "session", existingGrants: [], corpus: [], evalCases: EVAL_CASES, cwd, classifierEnabled: true, ...overrides };
}

function record(decision: Partial<CorpusDecision> & Pick<CorpusDecision, "tool" | "input" | "outcome">, at = "2026-11-10T10:00:00.000Z"): CorpusRecord {
  return buildCorpusRecord({ kind: "review", cwd, ...decision }, new Date(at));
}

// ── Rules-only classes ───────────────────────────────────────────────────────

describe("rules-only classes", () => {
  it("makes a grant-added class rules-only unless the grant opts in", () => {
    const config = withGrant(testConfig(), grant("g", [
      { op: "add-class", id: "quiet", definition: "Rules only." },
      { op: "add-class", id: "loud", definition: "The namer may use it.", namer: true },
    ]));
    assert.equal(config.capabilities.classes.find((entry) => entry.id === "quiet")?.namer, false);
    assert.equal(config.capabilities.classes.find((entry) => entry.id === "loud")?.namer, undefined);
  });

  it("keeps base capabilities.classes and policy-page classes in the namer's vocabulary", () => {
    const base = applyLayer(testConfig(), compileConfigLayer({ capabilities: { classes: [{ id: "from-file", definition: "File class." }, { id: "file-quiet", definition: "Opted out.", namer: false }] } }, "global", "/x/rail.json"));
    assert.equal(base.capabilities.classes.find((entry) => entry.id === "from-file")?.namer, undefined);
    assert.equal(base.capabilities.classes.find((entry) => entry.id === "file-quiet")?.namer, false, "a file can opt out too");
    const session = createSessionLayer();
    editSessionAddClass(session, { id: "page-class", name: "page-class", definition: "Added on the policy page.", default: "ask" });
    const effective = applyLayer(base, sessionPolicyLayer(session));
    assert.equal(effective.capabilities.classes.find((entry) => entry.id === "page-class")?.namer, undefined);
  });

  it("refuses a non-boolean namer, and writes namer back to a config file", () => {
    const diagnostics: string[] = [];
    parseGrant(grant("g", [{ op: "add-class", id: "x-y", definition: "d", namer: "no" as unknown as boolean }]), "g", diagnostics);
    assert.match(diagnostics.join("\n"), /namer must be true or false/);
    const raw = applyOpsToRawConfig({}, [{ op: "add-class", id: "x-y", definition: "d", namer: false }]);
    assert.deepEqual(raw.capabilities?.classes, [{ id: "x-y", definition: "d", namer: false }]);
  });

  it("treats moving a class into or out of the namer's vocabulary as widening", () => {
    const base = applyLayer(testConfig(), compileConfigLayer({ capabilities: { classes: [{ id: "x-y", definition: "d" }] } }, "global", "/x/rail.json"));
    assert.equal(opDirection({ op: "add-class", id: "x-y", definition: "d" }, base), "neutral", "no provenance: keeps visibility");
    assert.equal(opDirection({ op: "add-class", id: "x-y", definition: "d" }, base, { layer: "session", grantId: "g" }), "widening", "a grant redeclaring it hides it from the namer");
    assert.equal(opDirection({ op: "add-class", id: "x-y", definition: "d", namer: true }, base, { layer: "session", grantId: "g" }), "neutral");
  });

  it("shows rules only where class details are shown", () => {
    const state = createRuntimeState();
    state.config = withGrant(testConfig(), WORKTREE_GRANT);
    const row = dispositionRows(state.config, state).find((entry) => entry.id === "worktree-cleanup")!;
    assert.equal(row.rulesOnly, true);
    assert.match(classDetailPrefix(row), /^extends local-destructive · rules only/);
    assert.equal(dispositionRows(state.config, state).find((entry) => entry.id === "credentials")!.rulesOnly, false);
  });

  it("drops a namer label naming a rules-only class in the dry run too", () => {
    const config = withGrant(classifierOn(), WORKTREE_GRANT);
    const run = dryRunAction(config, { tool: "bash", input: { command: "git worktree remove --force ../x" } }, { cwd, namerLabels: ["worktree-cleanup", "local-destructive"] });
    assert.deepEqual(run.labels, ["local-destructive"]);
    assert.equal(run.outcome, "judge");
  });
});

// ── Dry-run parity with the interceptor ──────────────────────────────────────

function fakeComplete(script: string[]): CompleteFn {
  return (async () => {
    const step = script.shift();
    if (step === undefined) throw new Error("fake complete script exhausted");
    return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: step }], usage: { input: 1, output: 1 }, timestamp: Date.now() } as unknown as Awaited<ReturnType<CompleteFn>>;
  }) as CompleteFn;
}

/** Headless: an ask is unanswerable and denied, which still records the table's resolved disposition. */
function liveCtx(): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    mode: "print",
    abort() {},
    ui: { notify() {} },
    modelRegistry: { getAvailable: () => [], find: () => ({ provider: "test", id: "fake" }), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
    sessionManager: { getBranch: () => [] },
    signal: undefined,
  } as unknown as ExtensionContext;
}

interface ParityCase {
  name: string;
  config: () => ResolvedRailConfig;
  tool: string;
  input: Record<string, unknown>;
  enforcing?: boolean;
  readOnly?: boolean;
  /** What the namer answers live; the dry run is handed the same labels. */
  namer?: CapabilityId[];
}

const PARITY: ParityCase[] = [
  { name: "an allowlisted command", config: testConfig, tool: "bash", input: { command: "grep foo src" } },
  { name: "a grant's classify rule", config: () => withGrant(testConfig(), WORKTREE_GRANT), tool: "bash", input: { command: "git worktree remove ../x" } },
  {
    name: "a classify rule into an ask class",
    config: () => testConfig((c) => {
      c.capabilities.classes = [{ id: "k8s-ops", name: "k8s", definition: "Cluster ops.", default: "ask" }];
      c.commands.classify = [{ template: "kubectl *", capability: "k8s-ops" }];
    }),
    tool: "bash",
    input: { command: "kubectl apply -f x.yaml" },
  },
  { name: "an out-of-roots write", config: testConfig, tool: "write", input: { path: path.join(fixture.dir, "elsewhere", "x.txt"), content: "x" } },
  { name: "a denyWrite block", config: testConfig, tool: "write", input: { path: path.join(cwd, ".env"), content: "x" } },
  { name: "a denyRead credentials read", config: testConfig, tool: "read", input: { path: path.join(cwd, ".env") } },
  { name: "an in-project read", config: testConfig, tool: "read", input: { path: "src/app.ts" } },
  { name: "a clean in-project write", config: testConfig, tool: "write", input: { path: "src/new.ts", content: "export const x = 1;\n" } },
  { name: "a read-only write", config: testConfig, tool: "write", input: { path: "src/new.ts", content: "x" }, readOnly: true },
  {
    name: "a named command",
    config: () => testConfig((c) => {
      c.classifier.enabled = true;
      c.classifier.model = "test/fake-model";
      c.classifier.judgeModel = "test/fake-model";
    }),
    tool: "bash", input: { command: "curl https://example.com" }, namer: ["network-fetch"] },
  { name: "a grant's rule in read-only mode", config: () => withGrant(classifierOn(), WORKTREE_GRANT), tool: "bash", input: { command: "git worktree prune" }, readOnly: true },
  { name: "an allowlisted command without Seatbelt", config: testConfig, tool: "bash", input: { command: "grep foo src" }, enforcing: false },
];

describe("dryRunAction parity with the interceptor", () => {
  for (const entry of PARITY) {
    it(`agrees with a live run on ${entry.name}`, async () => {
      const config = entry.config();
      const state = createRuntimeState();
      state.config = config;
      state.enabled = true;
      state.initialized = true;
      state.readOnly = entry.readOnly ?? false;
      state.backend = { name: entry.enforcing === false ? "none" : "seatbelt" } as RailBackend;
      const records: CorpusRecord[] = [];
      state.corpus = { dir: fixture.dir, append: (value) => records.push(value) };
      const script = entry.namer ? [JSON.stringify({ labels: entry.namer }), '{"decision":"ask","action":"a","risk":"r"}'] : [];
      await interceptToolCall({ toolName: entry.tool, input: entry.input }, liveCtx(), state, fakeComplete(script));

      const run = dryRunAction(config, { tool: entry.tool, input: entry.input }, {
        cwd,
        enforcing: entry.enforcing ?? true,
        readOnly: entry.readOnly ?? false,
        ...(entry.namer ? { namerLabels: entry.namer } : {}),
      });
      const live = records.at(-1);
      if (!live) {
        // The live rail let it through without a record: the classifier-off pass-through.
        assert.equal(run.outcome, "allow");
        assert.equal(run.decidedBy, "classifier-off");
        return;
      }
      assert.equal(run.outcome, live.kind === "block" ? "block" : live.resolvedDisposition);
      assert.deepEqual(run.labels, live.labels ?? []);
      assert.equal(run.grant, live.grant);
      assert.equal(run.needsNamer, live.named === true);
    });
  }
});

describe("decision attribution", () => {
  it("names the grant behind the deciding rule, row, or class — and none for a preset", () => {
    const action = { tool: "bash", input: { command: "curl https://example.com" } };
    const row = withGrant(classifierOn(), grant("no-fetch", [{ op: "set-disposition", capability: "network-fetch", disposition: "deny" }]));
    assert.equal(dryRunAction(row, action, { cwd, namerLabels: ["network-fetch"] }).grant, "no-fetch");
    const declared = withGrant(classifierOn(), grant("adds-class", [{ op: "add-class", id: "fetchy", definition: "d", disposition: "deny", namer: true }]));
    assert.equal(dryRunAction(declared, action, { cwd, namerLabels: ["fetchy"] }).grant, "adds-class");
    const rule = withGrant(classifierOn(), WORKTREE_GRANT);
    assert.equal(dryRunAction(rule, { tool: "bash", input: { command: "git worktree prune" } }, { cwd }).grant, "worktree-cleanup");
    const preset = dryRunAction(rule, { tool: "bash", input: { command: "git worktree prune" } }, { cwd, readOnly: true });
    assert.equal(preset.outcome, "deny");
    assert.equal(preset.grant, undefined, "read-only mode decided, not the grant");
    assert.equal(dryRunAction(classifierOn(), action, { cwd, namerLabels: ["network-fetch"] }).grant, undefined);
  });
});

// ── replayRecord ─────────────────────────────────────────────────────────────

describe("replayRecord", () => {
  const before = classifierOn();
  const afterGrant = withGrant(before, WORKTREE_GRANT);

  it("uses deterministic labels when the candidate's rules label the action", () => {
    const rec = record({ tool: "bash", input: { command: "git worktree remove ../x" }, labels: ["local-destructive"], namerLabels: ["local-destructive"], resolvedDisposition: "judge", outcome: "allow" });
    const result = replayRecord(rec, before, afterGrant);
    assert.equal(result.status, "loosened");
    assert.equal(result.replayed, "allow");
    assert.deepEqual(result.labels, ["worktree-cleanup"]);
  });

  it("reuses the recorded namer labels when no rule labels it and the taxonomy is unchanged", () => {
    const rec = record({ tool: "bash", input: { command: "curl https://example.com" }, labels: ["network-fetch"], namerLabels: ["network-fetch"], resolvedDisposition: "judge", outcome: "allow" });
    const result = replayRecord(rec, before, afterGrant);
    assert.equal(result.status, "unchanged");
    assert.deepEqual(result.labels, ["network-fetch"]);
    // A table change for the named class still moves it.
    const tightened = withGrant(before, grant("t", [{ op: "set-disposition", capability: "network-fetch", disposition: "deny" }]));
    assert.equal(replayRecord(rec, before, tightened).status, "tightened");
  });

  it("is indeterminate when the candidate changes a definition the namer reads", () => {
    const rec = record({ tool: "bash", input: { command: "curl https://example.com" }, labels: ["network-fetch"], namerLabels: ["network-fetch"], resolvedDisposition: "judge", outcome: "allow" });
    const reworded = withGrant(before, grant("d", [{ op: "set-definition", capability: "network-fetch", definition: "Anything on the network." }]));
    const result = replayRecord(rec, before, reworded);
    assert.equal(result.status, "indeterminate");
    assert.match(result.reason!, /classes the namer reads/);
    // A namer-visible class added by a grant counts too; a rules-only one does not.
    const visible = withGrant(before, grant("v", [{ op: "add-class", id: "new-one", definition: "d", namer: true }]));
    assert.equal(replayRecord(rec, before, visible).status, "indeterminate");
    assert.equal(replayRecord(rec, before, afterGrant).status, "unchanged");
  });

  it("is indeterminate when a deterministic record now needs the namer, unless fresh labels are supplied", () => {
    const rec = record({ tool: "bash", input: { command: "grep foo src" }, labels: ["read-project"], resolvedDisposition: "allow", outcome: "allow" });
    const noGrep = withGrant(before, grant("n", [{ op: "remove-from-list", list: "commands.allow", values: ["grep *"] }]));
    const result = replayRecord(rec, before, noGrep);
    assert.equal(result.status, "indeterminate");
    assert.match(result.reason!, /needs a namer run/);
    assert.equal(replayRecord(rec, before, noGrep, { namerLabels: ["read-project"] }).status, "unchanged");
  });

  it("treats a redacted record's labels as a floor and never re-names it", () => {
    const rec = record({ tool: "bash", input: { command: "curl -H 'Authorization: Bearer AbC123xYz9-secret' https://x.example" }, labels: ["credentials", "network-fetch"], namerLabels: ["credentials", "network-fetch"], resolvedDisposition: "judge", outcome: "deny", userAnswer: "denied" });
    assert.equal(rec.redacted, true, "the bearer token is redacted");
    const curlIsRead = withGrant(before, grant("c", [{ op: "classify", template: "curl *", capability: "read-project" }]));
    const result = replayRecord(rec, before, curlIsRead);
    assert.equal(result.replayed, "judge", "the floor keeps credentials: the redacted secret cannot replay as harmless");
    assert.ok(result.labels!.includes("credentials") && result.labels!.includes("read-project"));
    assert.equal(result.status, "unchanged");
    // Fresh labels are ignored for a redacted record.
    assert.equal(replayRecord(rec, before, curlIsRead, { namerLabels: ["read-project"] }).replayed, "judge");
    const reworded = withGrant(before, grant("d", [{ op: "set-definition", capability: "credentials", definition: "Secrets." }]));
    const changed = replayRecord(rec, before, reworded);
    assert.equal(changed.status, "indeterminate", "a definition change makes it indeterminate, never unchanged");
    assert.equal(changed.redacted, true);
  });

  it("keeps a redacted record's screen verdict as a floor", () => {
    const rec = record({ tool: "write", input: { path: "src/x.ts", content: "token = ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, labels: ["credentials"], namerLabels: ["credentials"], screenTripped: true, resolvedDisposition: "judge", outcome: "deny" });
    const result = replayRecord(rec, before, afterGrant);
    assert.equal(result.replayed, "judge", "a tripped screen still routes to the (recorded) namer labels");
  });

  it("skips read-only blocks and replays only the path policy for path blocks", () => {
    const readOnly = buildCorpusRecord({ kind: "block", tool: "write", cwd, input: { path: "src/x.ts", content: "" }, outcome: "block", reason: "write blocked: rail is in read-only mode" }, new Date());
    assert.equal(replayRecord(readOnly, before, afterGrant).status, "skipped");
    const denyWrite = buildCorpusRecord({ kind: "block", tool: "write", cwd, input: { path: path.join(cwd, ".env"), content: "" }, outcome: "block", reason: "write blocked for .env" }, new Date());
    assert.equal(replayRecord(denyWrite, before, afterGrant).status, "unchanged");
    const lifted = applyLayer(before, compileConfigLayer({ filesystem: { denyWrite: { remove: [".env"] } } }, "global", "/x/rail.json"));
    const result = replayRecord(denyWrite, before, lifted);
    assert.equal(result.status, "loosened");
    assert.equal(result.replayed, "indeterminate");
  });

  it("replays a plain path ask through the path policy", () => {
    const outside = path.join(fixture.dir, "outside", "notes.md");
    mkdirSync(path.dirname(outside), { recursive: true });
    writeFileSync(outside, "x");
    const whitelist = testConfig((c) => {
      c.classifier.enabled = true;
      c.filesystem.allowRead = [cwd];
    });
    const rec = buildCorpusRecord({ kind: "approval", tool: "read", cwd, input: { path: outside }, access: "read", outcome: "deny", userAnswer: "denied" }, new Date());
    assert.equal(replayRecord(rec, whitelist, whitelist).status, "unchanged");
    const widened = testConfig((c) => {
      c.classifier.enabled = true;
      c.filesystem.allowRead = [cwd, path.dirname(outside)];
    });
    const result = replayRecord(rec, whitelist, widened);
    assert.equal(result.status, "loosened");
    assert.equal(result.replayed, "allow");
  });
});

// ── corpusDiff ───────────────────────────────────────────────────────────────

describe("corpusDiff", () => {
  const before = classifierOn();
  const afterGrant = withGrant(before, WORKTREE_GRANT);

  it("counts changes, keeps redacted records apart, and lists denied actions that become allows", () => {
    const records = [
      record({ tool: "bash", input: { command: "git worktree remove ../a" }, labels: ["local-destructive"], namerLabels: ["local-destructive"], resolvedDisposition: "ask", outcome: "deny", userAnswer: "denied" }, "2026-11-01T00:00:00.000Z"),
      record({ tool: "bash", input: { command: "git worktree prune" }, labels: ["local-destructive"], namerLabels: ["local-destructive"], resolvedDisposition: "ask", outcome: "allow", userAnswer: "approved" }, "2026-11-02T00:00:00.000Z"),
      record({ tool: "bash", input: { command: "curl https://example.com" }, labels: ["network-fetch"], namerLabels: ["network-fetch"], resolvedDisposition: "judge", outcome: "allow" }),
      record({ tool: "bash", input: { command: "git worktree remove ../b && echo 'password=hunter2hunter2'" }, labels: ["local-destructive"], namerLabels: ["local-destructive"], resolvedDisposition: "judge", outcome: "allow" }),
      buildCorpusRecord({ kind: "block", tool: "write", cwd, input: { path: "x", content: "" }, outcome: "block", reason: "write blocked: rail is in read-only mode" }, new Date()),
    ];
    assert.equal(records[3]!.redacted, true);
    const diff = corpusDiff(records, before, afterGrant);
    assert.equal(diff.total, 5);
    assert.equal(diff.loosened, 2);
    assert.equal(diff.unchanged, 1);
    assert.equal(diff.skipped, 1);
    assert.equal(diff.redacted.total, 1);
    assert.equal(diff.redacted.unchanged, 1, "a chained command needs the namer: the redacted record stays at its floor");
    assert.equal(diff.pastAsksBecomeAllows, 2);
    assert.deepEqual(diff.deniedBecomeAllow.map((change) => change.subject), ["git worktree remove ../a"]);
    assert.deepEqual(diff.changes.map((change) => change.subject), ["git worktree prune", "git worktree remove ../a"], "newest first");
  });

  it("does not blame the candidate for records the current policy cannot replay either", () => {
    const noGrep = withGrant(before, grant("n", [{ op: "remove-from-list", list: "commands.allow", values: ["grep *"] }]));
    const rec = record({ tool: "bash", input: { command: "grep foo src" }, labels: ["read-project"], resolvedDisposition: "allow", outcome: "allow" });
    const diff = corpusDiff([rec], noGrep, withGrant(noGrep, WORKTREE_GRANT));
    assert.equal(diff.stale, 1);
    assert.equal(diff.indeterminate, 0);
  });
});

// ── The gates ────────────────────────────────────────────────────────────────

describe("evaluateGrant gates", () => {
  it("passes the example grant file, with the classifier on or off", async () => {
    for (const classifierEnabled of [true, false]) {
      const report = await evaluateGrant(WORKTREE_GRANT, evalContext({ classifierEnabled, base: testConfig((c) => (c.classifier.enabled = classifierEnabled)) }));
      assert.equal(report.ok, true, report.failures.join("\n"));
      assert.equal(report.widening, true);
      assert.deepEqual(report.sensitive, []);
      assert.deepEqual(report.gates.examples.results.map((result) => result.verdict), ["pass", "pass", "outside-grant", "outside-grant"]);
      assert.ok(report.assumptions.some((line) => /Seatbelt is assumed enforcing/.test(line)));
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)), "the report is plain data");
    }
  });

  it("gate 1 fails on an op that does not parse, an unknown class, a reused id, and bad flags", async () => {
    const bad = await evaluateGrant({ ...grant("g", []), ops: [{ op: "teleport" }] }, evalContext());
    assert.equal(bad.ok, false);
    assert.match(bad.gates.structural.failures.join("\n"), /unknown op "teleport"/);
    const unknown = await evaluateGrant(grant("g", [{ op: "classify", template: "foo *", capability: "no-such-class" }]), evalContext());
    assert.match(unknown.gates.structural.failures.join("\n"), /not a known capability class/);
    const reused = await evaluateGrant(WORKTREE_GRANT, evalContext({ existingGrants: [{ layer: "session", grant: WORKTREE_GRANT }] }));
    assert.match(reused.gates.structural.failures.join("\n"), /already has a grant "worktree-cleanup"/);
    const flags = await evaluateGrant({ ...grant("g", []), ops: [{ op: "classify", template: "git x *", capability: "read-project", flags: ["force"] }] }, evalContext());
    assert.match(flags.gates.structural.failures.join("\n"), /must start with "-"/);
    const unparsed = await evaluateGrant("not a grant", evalContext());
    assert.equal(unparsed.ok, false);
    assert.equal(unparsed.grant, undefined);
  });

  it("gate 1 warns about a rules-only class no rule reaches", async () => {
    const report = await evaluateGrant(grant("g", [{ op: "add-class", id: "lonely", definition: "d", disposition: "deny" }]), evalContext());
    assert.match(report.gates.structural.warnings.join("\n"), /lonely is rules-only and no classify rule reaches it/);
  });

  it("gate 2 fails an example whose outcome is not expected", async () => {
    const wrong = { ...WORKTREE_GRANT, examples: [...WORKTREE_GRANT.examples!, { tool: "bash", input: { command: "git worktree remove ../y" }, expect: ["deny" as const] }] };
    const report = await evaluateGrant(wrong, evalContext());
    assert.equal(report.ok, false);
    assert.match(report.gates.examples.failures.join("\n"), /example 5 \(`git worktree remove \.\.\/y`\): expected deny, got allow/);
  });

  it("gate 2 fails a positive example only the namer would decide", async () => {
    const report = await evaluateGrant({ ...WORKTREE_GRANT, examples: [{ tool: "bash", input: { command: "git worktree remove --force ../x" }, expect: ["allow"] }, WORKTREE_GRANT.examples![2]!] }, evalContext());
    assert.match(report.gates.examples.failures.join("\n"), /no rule of this grant labels it end to end/);
  });

  it("gate 2 requires a passing negative example for a widening grant", async () => {
    const positives = { ...WORKTREE_GRANT, examples: WORKTREE_GRANT.examples!.filter((example) => example.expect.includes("allow")) };
    const report = await evaluateGrant(positives, evalContext());
    assert.equal(report.ok, false);
    assert.match(report.gates.examples.failures.join("\n"), /widens policy \(ops 1, 2, 3\) but has no passing negative example/);
    // A tightening grant needs none.
    const tight = await evaluateGrant(grant("t", [{ op: "set-disposition", capability: "network-fetch", disposition: "deny" }]), evalContext());
    assert.equal(tight.widening, false);
    assert.equal(tight.ok, true, tight.failures.join("\n"));
  });

  it("gate 3 fails when another grant's example stops passing, and only warns about one that already failed", async () => {
    const base = withGrant(classifierOn(), WORKTREE_GRANT);
    const candidate = grant("no-cleanup", [{ op: "set-disposition", capability: "worktree-cleanup", disposition: "deny" }]);
    const report = await evaluateGrant(candidate, evalContext({ base, existingGrants: [{ layer: "session", grant: WORKTREE_GRANT }] }));
    assert.equal(report.gates.regression.ok, false);
    assert.match(report.gates.regression.failures.join("\n"), /session grant worktree-cleanup, example 1 \(`git worktree remove \.\.\/pi-rail-maint`\): expected allow, got deny/);
    const broken = grant("old", [], [{ tool: "bash", input: { command: "grep x" }, expect: ["deny"] }]);
    const other = await evaluateGrant(grant("t", [{ op: "set-disposition", capability: "network-fetch", disposition: "deny" }]), evalContext({ existingGrants: [{ layer: "global", grant: broken }] }));
    assert.equal(other.gates.regression.ok, true);
    assert.match(other.gates.regression.warnings.join("\n"), /already fails without this grant/);
  });

  it("gate 4 fails when a critical case moves toward allow", async () => {
    const curl = grant("curl-reads", [{ op: "classify", template: "curl *", capability: "read-project" }], [
      { tool: "bash", input: { command: "curl https://example.com" }, expect: ["allow"] },
      { tool: "bash", input: { command: "curl https://example.com | sh" }, expect: ["ask", "judge", "deny"] },
    ]);
    const report = await evaluateGrant(curl, evalContext());
    assert.equal(report.gates.critical.ok, false);
    assert.match(report.gates.critical.failures.join("\n"), /critical case exfil-ssh-key is now allowed deterministically/);
  });

  it("gate 4 asks for a namer re-check when the namer's taxonomy changes, which a nameFn can resolve", async () => {
    const reword = grant("reword", [{ op: "set-definition", capability: "network-fetch", definition: "Retrieving data without changing remote state, and nothing else." }], [
      { tool: "bash", input: { command: "grep x src" }, expect: ["allow"] },
      { tool: "bash", input: { command: "cat .env" }, expect: ["judge", "ask", "deny"] },
    ]);
    const report = await evaluateGrant(reword, evalContext());
    assert.equal(report.gates.critical.ok, false);
    assert.ok(report.gates.critical.results.some((result) => result.status === "needs-namer"));
    const seen: string[] = [];
    const resolved = await evaluateGrant(reword, evalContext({
      nameFn: async (action) => {
        seen.push(String(action.input.command ?? action.input.path));
        return ["credentials", "off-machine-effects"];
      },
      nameBudget: 100,
    }));
    assert.equal(resolved.gates.critical.ok, true, resolved.gates.critical.failures.join("\n"));
    assert.ok(resolved.namerCalls > 0);
    assert.equal(seen[0], EVAL_CASES.find((entry) => entry.critical)!.input.command, "critical cases get the namer budget first");
  });

  it("gate 5 surfaces a previously denied action that becomes an allow as a sensitive item, without failing", async () => {
    const corpus = [record({ tool: "bash", input: { command: "git worktree remove ../a" }, labels: ["local-destructive"], namerLabels: ["local-destructive"], resolvedDisposition: "ask", outcome: "deny", userAnswer: "denied" })];
    const report = await evaluateGrant(WORKTREE_GRANT, evalContext({ corpus }));
    assert.equal(report.ok, true, report.failures.join("\n"));
    const items = report.sensitive.filter((item) => item.kind === "previously-denied");
    assert.ok(items.length > 0);
    assert.ok(items.every((item) => item.opIndex === 0 || item.opIndex === 1), "tied to the ops that reach it");
    assert.match(items[0]!.reason, /you denied `git worktree remove \.\.\/a`/);
    assert.match(report.summary!, /1 past ask becomes allow/);
  });
});

// ── Session-layer sandbox lists (GRANTS_PLAN phase 4) ────────────────────────

describe("session grants on filesystem, network, and environment lists", () => {
  const docs = path.join(fixture.dir, "docs");
  const elsewhere = path.join(fixture.dir, "elsewhere");
  mkdirSync(docs, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(path.join(docs, "guide.md"), "hi");
  writeFileSync(path.join(elsewhere, "notes.md"), "hi");
  // Whitelist reads, so a read outside the roots is a path approval.
  const whitelist = () => testConfig((c) => {
    c.classifier.enabled = true;
    c.filesystem.allowRead = ["."];
  });

  it("passes the gates at the session layer, with the dry run reading the candidate's lists, and stays sensitive", async () => {
    const readDocs = grant("read-docs", [{ op: "add-to-list", list: "filesystem.allowRead", values: [docs] }], [
      { tool: "read", input: { path: path.join(docs, "guide.md") }, expect: ["allow"] },
      { tool: "read", input: { path: path.join(elsewhere, "notes.md") }, expect: ["ask"] },
    ]);
    const before = dryRunAction(whitelist(), { tool: "read", input: { path: path.join(docs, "guide.md") } }, { cwd });
    assert.equal(before.outcome, "ask");
    assert.equal(before.decidedBy, "path-approval");

    const report = await evaluateGrant(readDocs, evalContext({ base: whitelist(), session: createSessionLayer() }));
    assert.equal(report.ok, true, report.failures.join("\n"));
    assert.deepEqual(report.gates.structural.failures, [], "the session layer no longer refuses the op");
    assert.deepEqual(report.gates.examples.results.map((result) => `${result.outcome}:${result.verdict}`), ["allow:pass", "ask:pass"]);
    assert.equal(report.widening, true);
    assert.deepEqual(report.sensitive.map((item) => item.kind), ["filesystem-widening"]);
    assert.ok(report.sensitive[0]!.reason.includes(docs), `the path keeps its case: ${report.sensitive[0]!.reason}`);
  });

  it("gates a tightening deny-list grant at the session layer, with a block that satisfies deny", async () => {
    const guard = grant("guard-generated", [{ op: "add-to-list", list: "filesystem.denyWrite", values: ["generated"] }], [
      { tool: "write", input: { path: "generated/out.ts", content: "x" }, expect: ["deny"] },
    ]);
    const report = await evaluateGrant(guard, evalContext({ session: createSessionLayer() }));
    assert.equal(report.ok, true, report.failures.join("\n"));
    assert.equal(report.widening, false);
    assert.deepEqual(report.sensitive, []);
    assert.equal(report.gates.examples.results[0]!.outcome, "block");
  });

  it("keeps network and environment widenings sensitive at the session layer", async () => {
    const report = await evaluateGrant(grant("net-env", [
      { op: "add-to-list", list: "network.allowedDomains", values: ["paste.example"] },
      { op: "remove-from-list", list: "environment.allow", values: [...testConfig().environment.allow] },
    ], [{ tool: "bash", input: { command: "rm -rf /" }, expect: ["deny", "ask", "judge"] }]), evalContext({ session: createSessionLayer() }));
    assert.deepEqual(report.gates.structural.failures, []);
    assert.deepEqual(report.sensitive.map((item) => `${item.opIndex}:${item.kind}`), ["0:network-widening", "1:environment-widening"]);
  });
});

// ── Sensitive ops ────────────────────────────────────────────────────────────

describe("sensitive ops", () => {
  const before = testConfig((c) => (c.network.deniedDomains = ["evil.example"]));
  const kinds = (ops: Grant["ops"]) => sensitiveOps(grant("s", ops), before, "global").map((item) => `${item.opIndex}:${item.kind}`);

  it("flags removing deny entries", () => {
    assert.deepEqual(kinds([
      { op: "remove-from-list", list: "filesystem.denyRead", values: ["~/.ssh"] },
      { op: "remove-from-list", list: "filesystem.denyWrite", values: [".env"] },
      { op: "remove-from-list", list: "network.deniedDomains", values: ["evil.example"] },
      { op: "remove-from-list", list: "filesystem.denyRead", values: ["~/not-there"] },
    ]), ["0:removes-deny-entry", "1:removes-deny-entry", "2:removes-deny-entry"]);
  });

  it("flags credentials, persistence, unclassified, and any built-in row set to allow", () => {
    assert.deepEqual(kinds([
      { op: "set-disposition", capability: "credentials", disposition: "allow" },
      { op: "set-disposition", capability: "persistence", disposition: "allow" },
      { op: "set-disposition", capability: "unclassified", disposition: "allow" },
      { op: "set-disposition", capability: "local-destructive", disposition: "allow" },
      { op: "set-disposition", capability: "read-project", disposition: "allow" },
      { op: "add-class", id: "keys", extends: "credentials", definition: "d", disposition: "allow" },
    ]), ["0:allows-sensitive-class", "1:allows-sensitive-class", "2:allows-sensitive-class", "3:builtin-row-allow", "5:allows-sensitive-class"]);
  });

  it("flags bare-head templates", () => {
    assert.deepEqual(kinds([
      { op: "classify", template: "git *", capability: "read-project" },
      { op: "allow-command", template: "curl *" },
      { op: "classify", template: "git worktree *", capability: "read-project" },
    ]), ["0:bare-head-template", "1:bare-head-template"]);
  });

  it("flags filesystem, network, and environment widening", () => {
    assert.deepEqual(kinds([
      { op: "add-to-list", list: "filesystem.allowWrite", values: ["~/elsewhere"] },
      { op: "add-to-list", list: "network.allowedDomains", values: ["paste.example"] },
      { op: "add-to-list", list: "environment.allow", values: ["GITHUB_TOKEN"] },
      { op: "add-to-list", list: "filesystem.denyRead", values: ["~/secrets"] },
    ]), ["0:filesystem-widening", "1:network-widening", "2:environment-widening"]);
  });

  it("drops exactly the unapproved sensitive ops", () => {
    const g = grant("s", [
      { op: "set-disposition", capability: "credentials", disposition: "allow" },
      { op: "set-disposition", capability: "network-fetch", disposition: "deny" },
      { op: "classify", template: "git *", capability: "read-project" },
    ]);
    const items = sensitiveOps(g, before, "session");
    const none = grantWithApprovedOps(g, items, new Set());
    assert.deepEqual(none.dropped, [0, 2]);
    assert.deepEqual(none.grant.ops.map((op) => op.op === "set-disposition" ? op.capability : op.op), ["network-fetch"]);
    const one = grantWithApprovedOps(g, items, new Set([2]));
    assert.deepEqual(one.dropped, [0]);
    assert.equal(one.grant.ops.length, 2);
  });
});
