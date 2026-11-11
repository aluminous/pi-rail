// Gate 2's per-rule examples (a rule decides one of its own examples; an
// allowing wildcard rule has a near-miss negative), and the code-generated
// probes: what each widening wildcard rule would also allow, shown to the
// agent and in the confirmation, and a destructive one making its op sensitive.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { EVAL_CASES } from "../eval/cases.ts";
import { isNearMiss } from "../src/command-allowlist.ts";
import { confirmationLines, evaluateGrant, formatGrantReport, type GrantEvalContext } from "../src/grant-eval.ts";
import type { Grant } from "../src/policy-store.ts";
import { testConfig } from "./helpers.ts";

const WORKTREE: Grant = JSON.parse(readFileSync(new URL("../examples/grants/worktree-cleanup.json", import.meta.url), "utf8"));
const CWD = "/Users/dev/projects/acme-app";

function context(): GrantEvalContext {
  return { base: testConfig((c) => (c.classifier.enabled = true)), layer: "session", existingGrants: [], corpus: [], evalCases: EVAL_CASES, cwd: CWD, classifierEnabled: true };
}

const negative = (command: string) => ({ tool: "bash", input: { command }, expect: ["ask" as const, "judge" as const, "deny" as const] });
const positive = (command: string) => ({ tool: "bash", input: { command }, expect: ["allow" as const] });

describe("isNearMiss", () => {
  it("is one command with the rule's literal prefix and something more", () => {
    assert.equal(isNearMiss("git worktree remove --force ../x", ["git", "worktree", "remove"]), true);
    assert.equal(isNearMiss("git worktree remove $DIR", ["git", "worktree", "remove"]), true);
    assert.equal(isNearMiss("git worktree remove ../x && rm -rf ~", ["git", "worktree", "remove"]), false, "a chain is not a near miss");
    assert.equal(isNearMiss("rm -rf ../x", ["git", "worktree", "remove"]), false);
    assert.equal(isNearMiss("git worktree remove", ["git", "worktree", "remove"]), false, "nothing different");
  });
});

describe("gate 2: examples per rule", () => {
  it("passes the plan's worktree grant, which has a near miss for each rule", async () => {
    const report = await evaluateGrant(WORKTREE, context());
    assert.equal(report.ok, true, report.failures.join("; "));
  });

  it("names the rule with no near miss, and does not count a chain or another command", async () => {
    const examples = WORKTREE.examples!.filter((example) => !String(example.input.command).includes("--force"));
    const report = await evaluateGrant({ ...WORKTREE, examples: [...examples, negative("rm -rf ../x")] }, context());
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((failure) => /op 2 \(`git worktree remove \*` flags none\) has no near-miss negative example/.test(failure)), report.failures.join("\n"));
    assert.ok(!report.failures.some((failure) => /op 3 .* near-miss/.test(failure)), "prune has its own");
  });

  it("names a rule that decides none of the examples", async () => {
    const grant: Grant = { ...WORKTREE, ops: [...WORKTREE.ops, { op: "classify", template: "git worktree lock *", capability: "worktree-cleanup", flags: [] }] };
    const report = await evaluateGrant(grant, context());
    assert.ok(report.failures.some((failure) => /op 4 \(`git worktree lock \*` flags none\) has no example it decides/.test(failure)), report.failures.join("\n"));
  });

  it("asks a rule into an ask class for an example it decides, but no near miss", async () => {
    const grant: Grant = {
      id: "docker-ask",
      request: "always ask before docker run",
      created: "2026-11-12",
      ops: [
        { op: "add-class", id: "docker-run", extends: "modify-system", definition: "docker run.", disposition: "ask" },
        { op: "classify", template: "docker run *", capability: "docker-run" },
      ],
      examples: [{ tool: "bash", input: { command: "docker run --rm alpine" }, expect: ["ask"] }],
    };
    const report = await evaluateGrant(grant, context());
    assert.equal(report.ok, true, report.failures.join("; "));
    assert.deepEqual(report.sensitive, [], "probes come out ask, not allow");
  });
});

describe("rule probes", () => {
  it("lists what a flags-[] rule still allows (positionals) without making it sensitive", async () => {
    const report = await evaluateGrant(WORKTREE, context());
    const allowed = report.probes.filter((probe) => probe.opIndex === 1 && probe.newlyAllowed).map((probe) => probe.command);
    assert.ok(allowed.includes("git worktree remove ~"));
    assert.ok(allowed.includes("git worktree remove :main"));
    assert.ok(!allowed.includes("git worktree remove --force"));
    assert.ok(!allowed.includes("git worktree remove *"), "an unquoted glob never matches a rule with a flags list");
    assert.ok(!allowed.includes("git worktree remove x && rm -rf ~"));
    assert.deepEqual(report.sensitive, []);
    assert.ok(confirmationLines(report).some((line) => /op 2 also allows: .*`git worktree remove ~`/.test(line)));
    assert.ok(formatGrantReport(report).some((line) => line.startsWith("## Probes")));
  });

  it("makes an any-flags rule sensitive when a destructive probe is allowed", async () => {
    const grant: Grant = {
      ...WORKTREE,
      ops: WORKTREE.ops.map((op) => (op.op === "classify" && op.template === "git worktree remove *" ? { op: "classify", template: op.template, capability: op.capability } : op)),
      examples: [...WORKTREE.examples!.filter((example) => !String(example.input.command).includes("--force")), negative("git worktree remove $DIR")],
    };
    const report = await evaluateGrant(grant, context());
    assert.equal(report.ok, true, report.failures.join("; "));
    const item = report.sensitive.find((entry) => entry.kind === "allows-destructive-flag");
    assert.equal(item?.opIndex, 1);
    assert.match(item!.reason, /would also allow `git worktree remove --force`/);
    assert.ok(report.ops[1]!.sensitive);
  });

  it("makes an op sensitive when its flags list names a destructive flag", async () => {
    const grant: Grant = {
      ...WORKTREE,
      ops: WORKTREE.ops.map((op) => (op.op === "classify" && op.template === "git worktree remove *" ? { ...op, flags: ["--force"] } : op)),
      examples: [...WORKTREE.examples!.filter((example) => !String(example.input.command).includes("--force")), negative("git worktree remove -q ../x")],
    };
    const report = await evaluateGrant(grant, context());
    assert.ok(report.sensitive.some((entry) => entry.kind === "allows-destructive-flag" && entry.opIndex === 1), JSON.stringify(report.sensitive));
  });

  it("probes only widening wildcard rules", async () => {
    const grant: Grant = { id: "exact", request: "r", created: "2026-11-12", ops: [{ op: "classify", template: "npm run lint", capability: "run-dev-tools" }], examples: [positive("npm run lint"), negative("npm run lint && rm -rf ~")] };
    const report = await evaluateGrant(grant, context());
    assert.equal(report.ok, true, report.failures.join("; "));
    assert.deepEqual(report.probes, []);
  });
});
