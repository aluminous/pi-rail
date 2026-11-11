// Most-specific-rule-wins matching, flags allowlists, and the policy plumbing
// that carries both (config files, grants, session ops, write-back), plus
// class inheritance for presets. The ranking steps are each tested in
// isolation: two rules that differ in exactly one property.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyReadOnlyPreset, createCapabilityState, getEffectiveDisposition, presetDenies, READ_ONLY_PRESET_DENY, type Disposition } from "../src/capabilities.ts";
import {
  commandFlagsProblem,
  DEFAULT_COMMAND_ALLOW_RULES,
  defaultDispositionOf,
  describeSegmentMatch,
  explainCommandMatch,
  flagRejection,
  matchedCapabilities,
  outrankedRules,
  type CommandRule,
  type CommandRuleSet,
} from "../src/command-allowlist.ts";
import { DEFAULT_CONFIG, mergeConfig, type RailConfig } from "../src/config.ts";
import {
  addSessionGrant,
  applyOpsToRawConfig,
  commandRulesOf,
  compileConfigLayer,
  createSessionLayer,
  editSessionAddClass,
  foldPolicy,
  opDirection,
  parseGrant,
  parseOp,
  provenanceRank,
  serializeGrant,
  withSessionLayer,
  type Grant,
  type PolicyOp,
} from "../src/policy-store.ts";
import { PLAIN_THEME, statusTabLines } from "../src/status-tabs.ts";
import { createRuntimeState } from "../src/state.ts";
import { testConfig } from "./helpers.ts";

const G = "/home/u/.pi/agent/extensions/rail.json";
const P = "/repo/.pi/rail.json";

function rule(template: string, capability: string, extra: Partial<CommandRule> = {}): CommandRule {
  return { template, capability, source: "classify", rank: [1, 0], ...extra };
}

function set(rules: CommandRule[], dispositions: Record<string, Disposition> = {}): CommandRuleSet {
  return { rules, disposition: (id) => dispositions[id] ?? defaultDispositionOf(id) };
}

function winner(command: string, rules: CommandRuleSet) {
  const match = explainCommandMatch(command, rules);
  assert.equal(match.matched, true, `${command} should match`);
  return match.matched ? match.segments[0]! : undefined!;
}

function labels(command: string, rules: CommandRuleSet) {
  return matchedCapabilities(explainCommandMatch(command, rules));
}

describe("most specific rule wins", () => {
  it("(a) more literal words win, whichever is declared first", () => {
    const broad = rule("kubectl *", "k8s-ops");
    const narrow = rule("kubectl get *", "read-system");
    for (const order of [[broad, narrow], [narrow, broad]]) {
      const segment = winner("kubectl get pods", set(order));
      assert.equal(segment.capability, "read-system");
      assert.equal(segment.outranked?.[0]?.reason, "more literal words");
    }
  });

  it("(b) at equal literal count an exact template beats a trailing *", () => {
    const star = rule("git stash *", "local-destructive");
    const exact = rule("git stash", "modify-project");
    for (const order of [[star, exact], [exact, star]]) {
      const segment = winner("git stash", set(order));
      assert.equal(segment.capability, "modify-project");
      assert.match(segment.outranked?.[0]?.reason ?? "", /exact template/);
    }
    assert.deepEqual(labels("git stash drop", set([star, exact])), ["local-destructive"], "the exact rule only covers the bare command");
  });

  it("(c) a rule with a flags allowlist beats one without at equal specificity", () => {
    const any = rule("git worktree remove *", "local-destructive");
    const narrow = rule("git worktree remove *", "worktree-cleanup", { flags: [] });
    for (const order of [[any, narrow], [narrow, any]]) {
      const segment = winner("git worktree remove ../x", set(order));
      assert.equal(segment.capability, "worktree-cleanup");
      assert.match(segment.outranked?.[0]?.reason ?? "", /flags allowlist/);
      assert.deepEqual(labels("git worktree remove --force ../x", set(order)), ["local-destructive"], "a flag it does not list hands the command to the next rule");
    }
  });

  it("(d) the later layer wins at equal specificity, and beats a stricter disposition", () => {
    const earlier = rule("mytool *", "local-destructive", { rank: [1, 0], origin: "global" });
    const later = rule("mytool *", "read-project", { rank: [2, 0], origin: "project" });
    for (const order of [[earlier, later], [later, earlier]]) {
      const segment = winner("mytool run", set(order));
      assert.equal(segment.capability, "read-project", "layer is ranked before strictness");
      assert.equal(segment.outranked?.[0]?.reason, "a later layer (project over global)");
    }
    // Within a layer, a grant applies after base keys and later grants after earlier ones.
    const base = rule("mytool *", "local-destructive", { rank: [1, 0] });
    const grant = rule("mytool *", "read-project", { rank: [1, 2] });
    assert.equal(winner("mytool run", set([grant, base])).capability, "read-project");
  });

  it("(e) the stricter resolved disposition wins when everything else ties", () => {
    const loose = rule("mytool *", "read-project");
    const strict = rule("mytool *", "credentials");
    for (const order of [[loose, strict], [strict, loose]]) {
      const segment = winner("mytool run", set(order));
      assert.equal(segment.capability, "credentials");
      assert.match(segment.outranked?.[0]?.reason ?? "", /stricter disposition \(judge\)/);
    }
    // "Resolved" means the resolver the caller passes: a preset or table edit flips it.
    assert.equal(winner("mytool run", set([loose, strict], { "read-project": "deny" })).capability, "read-project");
  });

  it("narrow allow inside broad strict, and narrow strict inside broad allow, in any order", () => {
    const pairs: Array<[CommandRule, CommandRule, string, string, string]> = [
      // [broad, narrow, command hitting narrow, its class, command hitting only broad]
      [rule("kubectl *", "off-machine-effects"), rule("kubectl get *", "read-system"), "kubectl get pods", "read-system", "kubectl delete pod x"],
      [rule("docker *", "run-dev-tools"), rule("docker system prune *", "local-destructive"), "docker system prune -a", "local-destructive", "docker ps"],
    ];
    for (const [broad, narrow, hit, hitClass, miss] of pairs) {
      for (const order of [[broad, narrow], [narrow, broad]]) {
        assert.deepEqual(labels(hit, set(order)), [hitClass], hit);
        assert.deepEqual(labels(miss, set(order)), [broad.capability], miss);
      }
    }
  });

  it("keeps a user classify rule on a built-in template winning over the built-in tag", () => {
    const config = mergeConfig(testConfig(), { commands: { classify: [{ template: "git log *", capability: "off-machine-effects" }] } }, G);
    const segment = winner("git log --oneline", commandRulesOf(config));
    assert.equal(segment.capability, "off-machine-effects");
    assert.equal(segment.outranked?.[0]?.reason, "built-in default, a user rule matches");
  });

  // Built-in defaults are all allow-tagged, so a more specific default beating
  // a broad user rule could only loosen what the user wrote.
  it("a broad user strict rule beats a more specific built-in allow", () => {
    const config = mergeConfig(testConfig(), { commands: { classify: [{ template: "git *", capability: "local-destructive" }] } }, G);
    const segment = winner("git status --short", commandRulesOf(config));
    assert.equal(segment.capability, "local-destructive");
    assert.equal(segment.outranked?.[0]?.rule, "git status *");
    assert.equal(segment.outranked?.[0]?.reason, "built-in default, a user rule matches");
    assert.match(describeSegmentMatch(segment), /outranks rule `git status \*` \(read-project\) — built-in default, a user rule matches/);
    assert.deepEqual(labels("git push", commandRulesOf(config)), ["local-destructive"]);
  });

  it("a restated built-in under a broad user rule is a user rule and wins by specificity", () => {
    const config = mergeConfig(testConfig(), { commands: { allow: ["git status *"], classify: [{ template: "git *", capability: "local-destructive" }] } }, G);
    const segment = winner("git status", commandRulesOf(config));
    assert.equal(segment.capability, "read-project");
    assert.equal(segment.outranked?.[0]?.reason, "more literal words");
    assert.deepEqual(labels("git log", commandRulesOf(config)), ["local-destructive"], "unrestated built-ins stay outranked");
  });

  it("user narrow allow vs user broad strict still resolves by specificity across layers, in both orders", () => {
    for (const [narrowFile, broadFile] of [[G, P], [P, G]] as const) {
      const narrow: RailConfig = { commands: { allow: ["kubectl get *"] } };
      const broad: RailConfig = { commands: { classify: [{ template: "kubectl *", capability: "off-machine-effects" }] } };
      const first = narrowFile === G ? narrow : broad;
      const second = narrowFile === G ? broad : narrow;
      const config = mergeConfig(mergeConfig(testConfig(), first, G), second, P);
      assert.deepEqual(labels("kubectl get pods", commandRulesOf(config)), ["read-project"], `narrow in ${narrowFile}`);
      assert.deepEqual(labels("kubectl delete pod x", commandRulesOf(config)), ["off-machine-effects"]);
      void broadFile;
    }
  });

  it("a session-layer rule beats a built-in default", () => {
    const session = createSessionLayer();
    addSessionGrant(session, { id: "no-git", request: "r", created: "c", ops: [{ op: "classify", template: "git *", capability: "local-destructive" }] });
    const effective = withSessionLayer(testConfig(), session);
    const segment = winner("git log --oneline", commandRulesOf(effective));
    assert.equal(segment.capability, "local-destructive");
    assert.equal(segment.outranked?.[0]?.reason, "built-in default, a user rule matches");
  });

  it("explains the winner, what it outranked and why, and flag misses", () => {
    const rules = set([rule("git worktree remove *", "worktree-cleanup", { flags: [] }), rule("git worktree *", "local-destructive")]);
    const text = describeSegmentMatch(winner("git worktree remove --forc ../x", rules));
    assert.equal(text, "`git worktree remove --forc ../x` → classify rule `git worktree *` (local-destructive); skipped `git worktree remove *` does not list `--forc`");
    const outranks = describeSegmentMatch(winner("git worktree remove ../x", rules));
    assert.equal(outranks, "`git worktree remove ../x` → classify rule `git worktree remove *` [flags: none] (worktree-cleanup); outranks classify rule `git worktree *` (local-destructive) — more literal words");
    const none = explainCommandMatch("git worktree remove -f x", set([rule("git worktree remove *", "worktree-cleanup", { flags: [] })]));
    assert.equal(none.matched, false);
    assert.match(none.matched === false ? none.reason : "", /no classify or allowlist rule matches \(`git worktree remove \*` does not list `-f`\)/);
  });
});

describe("flags allowlists", () => {
  const remove = (flags: string[]) => set([rule("git worktree remove *", "worktree-cleanup", { flags })]);
  const matches = (command: string, flags: string[]) => explainCommandMatch(command, remove(flags)).matched;

  it("flags: [] accepts no flags at all — not --force, not its abbreviation", () => {
    assert.equal(matches("git worktree remove ../x", []), true);
    assert.equal(matches("git worktree remove --force ../x", []), false);
    assert.equal(matches("git worktree remove --forc ../x", []), false);
    assert.equal(matches("git worktree remove -f ../x", []), false);
  });

  it("long flags match exactly, never by prefix", () => {
    assert.equal(matches("git worktree remove --force x", ["--force"]), true);
    assert.equal(matches("git worktree remove --forc x", ["--force"]), false, "git would read --forc as --force; the allowlist does not");
    assert.equal(matches("git worktree remove --force x", ["--forc"]), false);
    assert.equal(matches("git worktree remove --force-all x", ["--force"]), false);
  });

  it("--name=value needs --name= listed, and --name= accepts only the = form", () => {
    assert.equal(matches("git worktree remove --reason=done x", ["--reason"]), false);
    assert.equal(matches("git worktree remove --reason=done x", ["--reason="]), true);
    assert.equal(matches("git worktree remove --reason= x", ["--reason="]), true);
    assert.equal(matches("git worktree remove --reason done", ["--reason="]), false);
    assert.equal(matches("git worktree remove --reason done", ["--reason", "--reason="]), true, "a separate value word is positional");
  });

  it("short flags are clusters whose every letter must be listed", () => {
    const prune = (command: string, flags: string[]) => explainCommandMatch(command, set([rule("git worktree prune *", "c", { flags })])).matched;
    assert.equal(prune("git worktree prune -n", ["-n", "-v"]), true);
    assert.equal(prune("git worktree prune -nv", ["-n", "-v"]), true);
    assert.equal(prune("git worktree prune -vn", ["-n", "-v"]), true);
    assert.equal(prune("git worktree prune -nf", ["-n", "-v"]), false);
    assert.equal(prune("git worktree prune -n5", ["-n"]), false, "no attached values for short flags");
    assert.equal(prune("find-like -name x", ["-name"]), false, "a different head never matches");
    assert.equal(explainCommandMatch("tool -name x", set([rule("tool *", "c", { flags: ["-name"] })])).matched, true, "a longer single-dash entry accepts that exact word");
  });

  it("-- ends flag checking, a lone - is positional, -1 is a flag", () => {
    assert.equal(matches("git worktree remove -- --force", []), true, "words after -- are positional");
    assert.equal(matches("git worktree remove - x", []), true);
    assert.equal(matches("git worktree remove -1", []), false);
    assert.equal(matches("git worktree remove -1", ["-1"]), true);
  });

  it("refuses glob and brace words before --, since the shell may expand them into flags", () => {
    assert.equal(matches("git worktree remove *", []), false, "a file named --force would expand into the flag");
    assert.equal(matches("git worktree remove {--force,x}", []), false);
    assert.equal(matches("git worktree remove wt?", []), false);
    assert.equal(matches("git worktree remove -- *", []), true, "after -- an expansion is only positionals");
    assert.equal(explainCommandMatch("git worktree remove *", set([rule("git worktree remove *", "c")])).matched, true, "without a flags list nothing changes");
  });

  it("never checks the template's own literal words", () => {
    const rules = set([rule("git remote -v", "read-project"), rule("git tag -l *", "read-project", { flags: [] })]);
    assert.equal(explainCommandMatch("git remote -v", rules).matched, true);
    assert.equal(explainCommandMatch("git tag -l v1", rules).matched, true);
    assert.equal(explainCommandMatch("git tag -l -n v1", rules).matched, false);
  });

  it("flagRejection names the first refused word", () => {
    const flags = new Set(["-n", "--dry-run"]);
    assert.equal(flagRejection(["-n", "x", "--dry-run"], flags), undefined);
    assert.equal(flagRejection(["-n", "--force", "-x"], flags), "--force");
    assert.equal(flagRejection(["--", "--force"], flags), undefined);
  });

  it("validates entries at parse time", () => {
    assert.equal(commandFlagsProblem("x *", ["-n", "--dry-run", "--depth=", "-name"]), undefined);
    assert.equal(commandFlagsProblem("x *", []), undefined);
    assert.match(commandFlagsProblem("x *", "-n")!, /array of strings/);
    assert.match(commandFlagsProblem("x *", [3])!, /array of strings/);
    assert.match(commandFlagsProblem("x *", ["n"])!, /must start with "-"/);
    assert.match(commandFlagsProblem("x *", ["-n v"])!, /whitespace/);
    assert.match(commandFlagsProblem("x *", ["-"])!, /not a flag/);
    assert.match(commandFlagsProblem("x *", ["--"])!, /not a flag/);
    assert.match(commandFlagsProblem("x *", ["--depth=1"])!, /list "--depth="/);
    assert.match(commandFlagsProblem("x *", ["-C="])!, /attached values for short flags/);
    assert.match(commandFlagsProblem("x", ["-n"])!, /ending in `\*`/);
  });
});

describe("flags through config files, grants, and session ops", () => {
  const bareCommand = (config: ReturnType<typeof testConfig>, command: string) => labels(command, commandRulesOf(config));

  it("parses flags on classify and allow-command ops and refuses bad ones", () => {
    const diagnostics: string[] = [];
    assert.deepEqual(parseOp({ op: "classify", template: "git worktree prune *", capability: "modify-project", flags: ["-n", "-n", "-v"] }, "op", diagnostics), {
      op: "classify",
      template: "git worktree prune *",
      capability: "modify-project",
      flags: ["-n", "-v"],
    });
    assert.deepEqual(parseOp({ op: "allow-command", template: "git cat-file *", flags: [] }, "op", diagnostics), { op: "allow-command", template: "git cat-file *", flags: [] });
    assert.deepEqual(diagnostics, []);
    assert.equal(parseOp({ op: "classify", template: "x *", capability: "read-project", flags: ["--x=1"] }, "op", diagnostics), undefined);
    assert.equal(parseOp({ op: "allow-command", template: "x", flags: ["-n"] }, "op", diagnostics), undefined);
    assert.match(diagnostics.join("\n"), /list "--x="/);
    assert.match(diagnostics.join("\n"), /ending in `\*`/);
  });

  it("loads flags from commands.classify and object entries in commands.allow", () => {
    const config = mergeConfig(testConfig(), {
      commands: {
        allow: ["make lint", { template: "git cat-file *", flags: ["-p"] }],
        classify: [{ template: "git worktree remove *", capability: "modify-project", flags: [] }],
      },
    } as RailConfig, G);
    assert.deepEqual(config.diagnostics, []);
    assert.ok(config.commands.allow.includes("make lint") && config.commands.allow.includes("git cat-file *"));
    assert.deepEqual(config.commands.allowFlags, { "git cat-file *": ["-p"] });
    assert.deepEqual(config.commands.classify, [{ template: "git worktree remove *", capability: "modify-project", flags: [] }]);
    assert.deepEqual(bareCommand(config, "git cat-file -p HEAD"), ["read-project"]);
    assert.deepEqual(bareCommand(config, "git cat-file --textconv HEAD:x"), []);
    assert.deepEqual(bareCommand(config, "git worktree remove --forc x"), []);
  });

  it("skips one bad entry, not the list", () => {
    const config = mergeConfig(testConfig(), {
      commands: {
        allow: { add: ["make lint", { template: "git cat-file *", flags: ["p"] }, { template: "x *", when: 1 }] },
        classify: [{ template: "a *", capability: "read-project", flags: ["-"] }, { template: "b *", capability: "read-project", flags: ["-b"] }],
      },
    } as unknown as RailConfig, G);
    assert.equal(config.diagnostics.length, 3, config.diagnostics.join("\n"));
    assert.ok(config.commands.allow.includes("make lint"));
    assert.ok(!config.commands.allow.includes("git cat-file *"));
    assert.deepEqual(config.commands.classify.map((entry) => entry.template), ["b *"]);
  });

  it("removing an allow entry drops its flags; re-adding starts from any flags", () => {
    const global = mergeConfig(testConfig(), { commands: { allow: [{ template: "git cat-file *", flags: ["-p"] }] } } as RailConfig, G);
    const project = mergeConfig(global, { commands: { allow: { remove: ["git cat-file *"] } } }, P);
    assert.ok(!project.commands.allow.includes("git cat-file *"));
    assert.deepEqual(project.commands.allowFlags, {});
    const again = mergeConfig(project, { commands: { allow: ["git cat-file *"] } }, P);
    assert.deepEqual(again.commands.allowFlags, {});
  });

  it("a plain restatement keeps flags; an allow-command op replaces them and claims the entry", () => {
    const global = mergeConfig(testConfig(), { commands: { allow: [{ template: "git cat-file *", flags: ["-p"] }] } } as RailConfig, G);
    const restated = mergeConfig(global, { commands: { allow: ["git cat-file *"] } }, P);
    assert.deepEqual(restated.commands.allowFlags, { "git cat-file *": ["-p"] });
    assert.equal(restated.provenance.lists["commands.allow"]["git cat-file *"]?.layer, "global");
    const widened = mergeConfig(global, { grants: [{ id: "any-cat", request: "r", created: "c", ops: [{ op: "allow-command", template: "git cat-file *" }] }] }, P);
    assert.deepEqual(widened.commands.allowFlags, {});
    assert.deepEqual(widened.provenance.lists["commands.allow"]["git cat-file *"], { layer: "project", grantId: "any-cat", file: P });
  });

  it("a classify op with different flags replaces the rule and ranks as its layer", () => {
    const global = mergeConfig(testConfig(), { commands: { classify: [{ template: "git worktree remove *", capability: "modify-project" }] } }, G);
    const project = mergeConfig(global, { commands: { classify: [{ template: "git worktree remove *", capability: "modify-project", flags: [] }] } }, P);
    assert.deepEqual(project.commands.classify, [{ template: "git worktree remove *", capability: "modify-project", flags: [] }]);
    assert.equal(project.provenance.lists["commands.classify"]["git worktree remove *"]?.layer, "project");
  });

  it("round-trips flags through grants and session ops", () => {
    const raw = {
      id: "wt",
      request: "clean worktrees",
      created: "2026-11-11",
      ops: [
        { op: "add-class", id: "worktree-cleanup", extends: "local-destructive", definition: "Worktree cleanup.", disposition: "allow" },
        { op: "classify", template: "git worktree remove *", capability: "worktree-cleanup", flags: [] },
        { op: "allow-command", template: "git cat-file *", flags: ["-p"] },
      ],
    };
    const diagnostics: string[] = [];
    const grant = parseGrant(raw, "g", diagnostics)!;
    assert.deepEqual(diagnostics, []);
    const reparsed = parseGrant(JSON.parse(JSON.stringify(serializeGrant(grant))), "g", diagnostics)!;
    assert.deepEqual(reparsed, grant);

    const session = createSessionLayer();
    addSessionGrant(session, grant);
    const effective = withSessionLayer(testConfig(), session);
    assert.deepEqual(effective.diagnostics, []);
    assert.deepEqual(bareCommand(effective, "git worktree remove ../x"), ["worktree-cleanup"]);
    assert.deepEqual(bareCommand(effective, "git worktree remove --force ../x"), []);
    assert.deepEqual(effective.capabilities.classes[0]?.extends, "local-destructive");
  });

  it("writes flags and extends back as base keys that reload to the same policy", () => {
    const ops: PolicyOp[] = [
      { op: "add-class", id: "worktree-cleanup", extends: "local-destructive", definition: "Worktree cleanup.", disposition: "allow" },
      { op: "classify", template: "git worktree remove *", capability: "worktree-cleanup", flags: [] },
      { op: "allow-command", template: "git cat-file *", flags: ["-p"] },
    ];
    const written = applyOpsToRawConfig({ commands: { allow: ["make lint", "git cat-file *"] } }, ops);
    assert.deepEqual(written.commands?.allow, ["make lint", { template: "git cat-file *", flags: ["-p"] }]);
    assert.deepEqual(written.capabilities?.classes, [{ id: "worktree-cleanup", definition: "Worktree cleanup.", disposition: "allow", extends: "local-destructive" }]);
    const reloaded = mergeConfig(testConfig(), written, G);
    assert.deepEqual(reloaded.diagnostics, []);
    assert.deepEqual(reloaded.commands.allowFlags, { "git cat-file *": ["-p"] });
    assert.deepEqual(reloaded.commands.classify[0]?.flags, []);
    assert.equal(reloaded.capabilities.classes[0]?.extends, "local-destructive");

    // allow-command without flags rewrites an object entry back to a plain string.
    const cleared = applyOpsToRawConfig(written, [{ op: "allow-command", template: "git cat-file *" }]);
    assert.deepEqual(cleared.commands?.allow, ["make lint", "git cat-file *"]);
    // A remove drops the object entry by template.
    const removed = applyOpsToRawConfig(written, [{ op: "remove-from-list", list: "commands.allow", values: ["git cat-file *"] }]);
    assert.deepEqual(removed.commands?.allow, { add: ["make lint"], remove: ["git cat-file *"] });
  });

  it("ranks rules by fold position: default < global base < global grant < project < session", () => {
    const layers = [
      compileConfigLayer({ commands: { classify: [{ template: "a *", capability: "read-project" }] }, grants: [{ id: "g1", request: "r", created: "c", ops: [{ op: "classify", template: "b *", capability: "read-project" }] }] }, "global", G),
      compileConfigLayer({ commands: { classify: [{ template: "c *", capability: "read-project" }] } }, "project", P),
    ];
    const folded = foldPolicy(DEFAULT_CONFIG, layers);
    const session = createSessionLayer();
    addSessionGrant(session, { id: "s1", request: "r", created: "c", ops: [{ op: "classify", template: "d *", capability: "read-project" }] });
    const effective = withSessionLayer(folded, session);
    const rank = (template: string) => commandRulesOf(effective).rules.find((entry) => entry.template === template)!.rank;
    assert.deepEqual(rank("grep *"), [0, 0]);
    assert.deepEqual(rank("a *"), [1, 0]);
    assert.deepEqual(rank("b *"), [1, 1]);
    assert.deepEqual(rank("c *"), [2, 0]);
    assert.deepEqual(rank("d *"), [3, 2]);
    assert.deepEqual(provenanceRank(effective, undefined), [0, 0]);
  });
});

describe("opDirection with flags and extends", () => {
  const base = mergeConfig(testConfig(), {
    capabilities: { classes: [{ id: "wt", definition: "Worktrees.", disposition: "allow", extends: "local-destructive" }] },
    commands: { allow: [{ template: "git cat-file *", flags: ["-p"] }], classify: [{ template: "git worktree remove *", capability: "wt", flags: [] }] },
  } as RailConfig, G);

  it("is neutral only for an exact restatement, flags included", () => {
    assert.equal(opDirection({ op: "classify", template: "git worktree remove *", capability: "wt", flags: [] }, base), "neutral");
    assert.equal(opDirection({ op: "classify", template: "git worktree remove *", capability: "wt" }, base), "widening");
    assert.equal(opDirection({ op: "allow-command", template: "git cat-file *", flags: ["-p"] }, base), "neutral");
    assert.equal(opDirection({ op: "allow-command", template: "git cat-file *" }, base), "widening");
    assert.equal(opDirection({ op: "allow-command", template: "git cat-file *", flags: [] }, base), "widening", "narrowing an allow hands commands to the next rule, which may be looser");
  });

  it("calls a deny classify tightening only when it covers what it replaces", () => {
    const denied = mergeConfig(base, { dispositions: { credentials: "deny" } }, G);
    assert.equal(opDirection({ op: "classify", template: "git worktree remove *", capability: "credentials" }, denied), "tightening", "no flags matches a superset");
    assert.equal(opDirection({ op: "classify", template: "git worktree remove *", capability: "credentials", flags: ["-f"] }, denied), "tightening");
    assert.equal(opDirection({ op: "classify", template: "new *", capability: "credentials", flags: [] }, denied), "tightening");
    const any = mergeConfig(denied, { commands: { classify: [{ template: "x *", capability: "read-project" }] } }, G);
    assert.equal(opDirection({ op: "classify", template: "x *", capability: "credentials", flags: [] }, any), "widening", "the commands it stops matching fall elsewhere");
  });

  it("treats a changed parent as widening, and dropping it as tightening", () => {
    assert.equal(opDirection({ op: "add-class", id: "wt", definition: "Worktrees.", disposition: "allow", extends: "local-destructive" }, base), "neutral");
    assert.equal(opDirection({ op: "add-class", id: "wt", definition: "Worktrees.", disposition: "allow", extends: "read-project" }, base), "widening");
    assert.equal(opDirection({ op: "add-class", id: "wt", definition: "Worktrees.", disposition: "allow" }, base), "tightening");
  });
});

describe("class inheritance", () => {
  it("validates extends: built-in ids only", () => {
    const diagnostics: string[] = [];
    assert.deepEqual(parseOp({ op: "add-class", id: "wt", definition: "x", extends: "local-destructive" }, "op", diagnostics), { op: "add-class", id: "wt", definition: "x", extends: "local-destructive" });
    assert.equal(parseOp({ op: "add-class", id: "wt", definition: "x", extends: "k8s-ops" }, "op", diagnostics), undefined);
    assert.equal(parseOp({ op: "add-class", id: "wt", definition: "x", extends: 3 }, "op", diagnostics), undefined);
    assert.equal(diagnostics.length, 2);
    assert.match(diagnostics[0]!, /extends must be a built-in class id/);
    const config = mergeConfig(testConfig(), { capabilities: { classes: [{ id: "wt", definition: "x", extends: "nope" }] } }, G);
    assert.equal(config.capabilities.classes.length, 0);
    assert.match(config.diagnostics.join("\n"), /capabilities\.classes\[0\]: extends must be a built-in/);
  });

  const config = mergeConfig(testConfig(), {
    capabilities: {
      classes: [
        { id: "child", definition: "x", disposition: "allow", extends: "local-destructive" },
        { id: "orphan", definition: "x", disposition: "allow" },
        { id: "reader", definition: "x", disposition: "allow", extends: "read-project" },
        { id: "tooling", definition: "x", disposition: "allow", extends: "run-dev-tools" },
      ],
    },
  }, G);
  const readOnly = createCapabilityState();
  applyReadOnlyPreset(readOnly);

  it("a preset that denies the parent denies the child", () => {
    assert.equal(getEffectiveDisposition(config, readOnly, "child").disposition, "deny");
    assert.equal(getEffectiveDisposition(config, readOnly, "child").scope, "preset");
  });

  it("a parentless class is a writing class to the preset", () => {
    assert.equal(getEffectiveDisposition(config, readOnly, "orphan").disposition, "deny");
  });

  it("a class extending a class the preset leaves alone is not tightened", () => {
    assert.equal(getEffectiveDisposition(config, readOnly, "reader").disposition, "allow");
    assert.equal(getEffectiveDisposition(config, readOnly, "tooling").disposition, "allow");
  });

  it("without a preset nothing changes, and the parent's own row does not flow to the child", () => {
    const parentDenied = mergeConfig(config, { dispositions: { "local-destructive": "deny" } }, G);
    assert.equal(getEffectiveDisposition(parentDenied, undefined, "child").disposition, "allow");
    assert.equal(getEffectiveDisposition(parentDenied, undefined, "orphan").disposition, "allow");
  });

  it("presetDenies covers every built-in in the preset and no read class", () => {
    const preset = { deny: READ_ONLY_PRESET_DENY };
    for (const id of READ_ONLY_PRESET_DENY) assert.equal(presetDenies(preset, config, id), true, id);
    assert.equal(presetDenies(preset, config, "read-project"), false);
    assert.equal(presetDenies(preset, config, "no-such-class"), false, "unknown ids already resolve to ask");
  });

  it("keeps extends through a session-added class", () => {
    const session = createSessionLayer();
    editSessionAddClass(session, { id: "wt", name: "wt", definition: "x", default: "allow", extends: "local-destructive" });
    const effective = withSessionLayer(testConfig(), session);
    assert.equal(effective.capabilities.classes[0]?.extends, "local-destructive");
    assert.equal(getEffectiveDisposition(effective, readOnly, "wt").disposition, "deny");
  });
});

describe("built-in rule pairs", () => {
  // Two templates can both match some command when one's literal words are a
  // prefix of the other's and the shorter one ends in `*` (or they are the
  // same template). For every such pair of built-ins, the rule specificity
  // picks must not be less strict than the one it beats: moving from
  // first-match to most-specific must not loosen any built-in.
  it("no more specific built-in is less strict than a built-in it outranks", () => {
    const parsed = DEFAULT_COMMAND_ALLOW_RULES.map((entry) => {
      const tokens = entry.template.split(" ");
      const anyArgs = tokens.at(-1) === "*";
      return { ...entry, literals: anyArgs ? tokens.slice(0, -1) : tokens, anyArgs };
    });
    const overlaps: string[] = [];
    for (const a of parsed) {
      for (const b of parsed) {
        if (a === b) continue;
        // `a` is broader: a `*` template whose literals prefix b's.
        if (!a.anyArgs || a.literals.length > b.literals.length) continue;
        if (!a.literals.every((token, index) => b.literals[index] === token)) continue;
        if (a.literals.length === b.literals.length && b.anyArgs) continue; // identical templates do not occur
        overlaps.push(`${b.template} over ${a.template}`);
        const witness = [...b.literals, ...(b.anyArgs ? ["x"] : [])].join(" ");
        // Both are defaults, so they share a tier and specificity decides.
        const won = explainCommandMatch(witness, { allow: [a.template, b.template] });
        assert.equal(won.matched && won.segments[0]!.rule, b.template, witness);
        assert.ok(!getStrictnessLoss(b.capability, a.capability), `${b.template} (${b.capability}) is looser than ${a.template} (${a.capability})`);
      }
    }
    // Pinned: today no two built-in templates overlap at all, so no built-in
    // winner changed. A new built-in that overlaps lands here for review.
    assert.deepEqual(overlaps, []);
  });

  function getStrictnessLoss(winner: string, loser: string): boolean {
    const severity = ["allow", "judge", "ask", "deny"];
    return severity.indexOf(defaultDispositionOf(winner)) < severity.indexOf(defaultDispositionOf(loser));
  }
});

describe("policy rules tab", () => {
  it("shows flags and marks a rule another rule on the same template always beats", () => {
    const config = mergeConfig(testConfig(), {
      commands: {
        allow: [{ template: "git cat-file *", flags: ["-p", "-t"] }],
        classify: [
          { template: "git log *", capability: "off-machine-effects" },
          { template: "git worktree remove *", capability: "local-destructive", flags: [] },
        ],
      },
    } as RailConfig, G);
    const text = statusTabLines({ state: createRuntimeState(), config, classifierLabel: "off", theme: PLAIN_THEME, width: 220 }, "policy").join("\n");
    assert.match(text, /git cat-file \* \[flags: -p -t\]/);
    assert.match(text, /git worktree remove \* \[flags: none\] → local-destructive/);
    assert.match(text, /git log \* \(outranked by classify rule → off-machine-effects: built-in default, a user rule matches\)/);
    assert.match(text, /most specific rule wins/);
    const rules = commandRulesOf(config);
    const dead = outrankedRules(rules);
    assert.equal(dead.size, 1, "only the built-in git log * can never win");
    const broad = mergeConfig(testConfig(), { commands: { classify: [{ template: "git *", capability: "local-destructive" }] } }, G);
    const shadowed = [...outrankedRules(commandRulesOf(broad)).keys()].map((entry) => entry.template);
    assert.ok(shadowed.includes("git status *") && shadowed.includes("git --version"));
    assert.ok(!shadowed.includes("grep *"));
  });
});

// Narrow grant shape used in the plan: the whole worktree-cleanup grant,
// end to end against the folded policy.
describe("the worktree-cleanup grant from the plan", () => {
  const grant: Grant = {
    id: "worktree-cleanup",
    request: "i want to allow cleaning up worktrees",
    created: "2026-11-11",
    ops: [
      { op: "add-class", id: "worktree-cleanup", extends: "local-destructive", definition: "Removing or pruning linked git worktrees of this repo.", disposition: "allow" },
      { op: "classify", template: "git worktree remove *", flags: [], capability: "worktree-cleanup" },
      { op: "classify", template: "git worktree prune *", flags: ["--dry-run", "-n", "-v"], capability: "worktree-cleanup" },
    ],
  };
  const config = mergeConfig(testConfig(), { grants: [serializeGrant(grant)] }, P);
  const rules = commandRulesOf(config);

  it("allows the plain forms and nothing forced", () => {
    assert.deepEqual(config.diagnostics, []);
    assert.deepEqual(labels("git worktree remove ../pi-rail-maint", rules), ["worktree-cleanup"]);
    assert.deepEqual(labels("git worktree prune -nv", rules), ["worktree-cleanup"]);
    for (const command of ["git worktree remove --force ../x", "git worktree remove --forc ../x", "git worktree remove -f ../x", "git worktree prune --expire=now", "git worktree remove ../x && rm -rf ~/dev"]) {
      assert.deepEqual(labels(command, rules), [], command);
    }
  });

  it("is denied in read-only mode through its parent", () => {
    const readOnly = createCapabilityState();
    applyReadOnlyPreset(readOnly);
    assert.equal(getEffectiveDisposition(config, readOnly, "worktree-cleanup").disposition, "deny");
  });
});
