// The layered policy store: op parsing, the fold and its layer order,
// provenance, the session layer and its restrictions, grant movement, and the
// conservative direction classifier.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getEffectiveDisposition } from "../src/capabilities.ts";
import { DEFAULT_CONFIG, type RailConfig } from "../src/config.ts";
import {
  addSessionGrant,
  applyOpsToRawConfig,
  baseConfigOf,
  compileConfigLayer,
  createSessionLayer,
  demoteGrant,
  editSessionAddClass,
  editSessionDefinition,
  editSessionDeleteClass,
  editSessionDisposition,
  foldPolicy,
  moveGrant,
  opDirection,
  parseGrant,
  parseGrants,
  parseOp,
  promoteGrant,
  provenanceLabel,
  revokeGrant,
  serializeGrant,
  sessionPolicyLayer,
  withSessionLayer,
  withoutSessionEdits,
  type Grant,
  type LayeredGrants,
  type PolicyLayer,
  type PolicyOp,
} from "../src/policy-store.ts";
import { testConfig } from "./helpers.ts";

const G = "/home/u/.pi/agent/extensions/rail.json";
const P = "/repo/.pi/rail.json";

function grant(id: string, ops: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, request: `request ${id}`, created: "2026-11-11", ops, ...extra };
}

function layer(name: "global" | "project", file: string, raw: Partial<RailConfig> & Record<string, unknown>): PolicyLayer {
  return compileConfigLayer(raw, name, file);
}

function sessionWith(...grants: Grant[]) {
  const session = createSessionLayer();
  for (const entry of grants) addSessionGrant(session, entry);
  return session;
}

function parsedGrant(id: string, ops: PolicyOp[]): Grant {
  return { id, request: `request ${id}`, created: "2026-11-11", ops };
}

describe("parseOp", () => {
  const ok = (raw: unknown) => {
    const diagnostics: string[] = [];
    const op = parseOp(raw, "here", diagnostics);
    assert.deepEqual(diagnostics, [], JSON.stringify(raw));
    return op;
  };
  const bad = (raw: unknown, pattern: RegExp) => {
    const diagnostics: string[] = [];
    assert.equal(parseOp(raw, "here", diagnostics), undefined, JSON.stringify(raw));
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /^Ignoring here: /);
    assert.match(diagnostics[0]!, pattern);
  };

  it("accepts each op in the vocabulary, trimming strings", () => {
    assert.deepEqual(ok({ op: "set-disposition", capability: " credentials ", disposition: "deny" }), { op: "set-disposition", capability: "credentials", disposition: "deny" });
    assert.deepEqual(ok({ op: "add-class", id: "worktree-cleanup", definition: " Pruning worktrees. ", disposition: "allow" }), {
      op: "add-class",
      id: "worktree-cleanup",
      definition: "Pruning worktrees.",
      disposition: "allow",
    });
    assert.deepEqual(ok({ op: "add-class", id: "named", name: "Named", definition: "x" }), { op: "add-class", id: "named", name: "Named", definition: "x" });
    assert.deepEqual(ok({ op: "remove-class", id: "old-class" }), { op: "remove-class", id: "old-class" });
    assert.deepEqual(ok({ op: "set-definition", capability: "read-project", definition: "New." }), { op: "set-definition", capability: "read-project", definition: "New." });
    assert.deepEqual(ok({ op: "classify", template: "git worktree remove *", capability: "modify-project" }), {
      op: "classify",
      template: "git worktree remove *",
      capability: "modify-project",
    });
    assert.deepEqual(ok({ op: "allow-command", template: "git worktree list" }), { op: "allow-command", template: "git worktree list" });
    assert.deepEqual(ok({ op: "add-to-list", list: "commands.allow", values: ["just *"] }), { op: "add-to-list", list: "commands.allow", values: ["just *"] });
    assert.deepEqual(ok({ op: "remove-from-list", list: "network.allowedDomains", values: ["docker.io"] }), {
      op: "remove-from-list",
      list: "network.allowedDomains",
      values: ["docker.io"],
    });
  });

  it("rejects fields it does not know instead of ignoring them", () => {
    bad({ op: "classify", template: "git worktree prune *", capability: "modify-project", unless: ["--force"] }, /unexpected key unless on classify/);
    bad({ op: "add-class", id: "x-cleanup", definition: "x", parent: "local-destructive" }, /unexpected key parent on add-class/);
  });

  it("rejects unknown ops and malformed values, one diagnostic each", () => {
    bad({ op: "grant-everything" }, /unknown op "grant-everything"/);
    bad("set-disposition", /expected an op object/);
    bad({ op: "set-disposition", capability: "credentials", disposition: "maybe" }, /disposition must be/);
    bad({ op: "set-disposition", disposition: "deny" }, /capability must be a non-empty string/);
    bad({ op: "add-class", id: "Not Kebab", definition: "x" }, /kebab-case/);
    bad({ op: "add-class", id: "read-project", definition: "x" }, /built-in class/);
    bad({ op: "add-class", id: "no-definition" }, /definition must be a non-empty string/);
    bad({ op: "remove-class", id: "credentials" }, /built-in and cannot be removed/);
    bad({ op: "set-definition", capability: "read-project", definition: "  " }, /definition must be a non-empty string/);
    bad({ op: "classify", template: "*", capability: "read-project" }, /bare `\*`/);
    bad({ op: "classify", template: 7, capability: "read-project" }, /template must be a string/);
    bad({ op: "allow-command", template: "kubectl * pods" }, /only means "any arguments" as the last word/);
    bad({ op: "add-to-list", list: "commands.classify", values: ["x"] }, /list must be one of/);
    bad({ op: "add-to-list", list: "filesystem.denyRead", values: [1] }, /values must be an array of strings/);
  });
});

describe("parseGrant and parseGrants", () => {
  it("skips an invalid op but keeps the rest of the grant", () => {
    const diagnostics: string[] = [];
    const parsed = parseGrant(grant("worktree-cleanup", [{ op: "nope" }, { op: "allow-command", template: "git worktree list" }]), "g", diagnostics);
    assert.deepEqual(parsed?.ops, [{ op: "allow-command", template: "git worktree list" }]);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /g \(worktree-cleanup\)\.ops\[0\]: unknown op/);
  });

  it("refuses a malformed envelope whole", () => {
    const cases: Array<[unknown, RegExp]> = [
      [grant("Bad Id", []), /grant id must be kebab-case/],
      [grant("session-edits", []), /reserved/],
      [grant("fine", [], { extra: true }), /unexpected key extra/],
      [{ id: "fine", created: "x", ops: [] }, /request must be a string/],
      [grant("fine", "not-an-array" as never), /ops must be an array/],
    ];
    for (const [raw, pattern] of cases) {
      const diagnostics: string[] = [];
      assert.equal(parseGrant(raw, "g", diagnostics), undefined);
      assert.match(diagnostics.join("\n"), pattern);
    }
  });

  it("validates examples by shape, drops a bad one, and keeps them round-trip", () => {
    const examples = [
      { tool: "bash", input: { command: "git worktree remove ../x" }, expect: ["allow"] },
      { tool: "bash", input: { command: "git worktree remove --force ../x" }, expect: ["ask", "judge", "deny"], why: "--force discards work" },
      { tool: "bash", input: "not an object", expect: ["allow"] },
      { tool: "bash", input: {}, expect: [] },
    ];
    const diagnostics: string[] = [];
    const parsed = parseGrant(grant("worktree-cleanup", [], { examples }), "g", diagnostics);
    assert.deepEqual(parsed?.examples, examples.slice(0, 2));
    assert.equal(diagnostics.length, 2);
    assert.deepEqual(parseGrant(serializeGrant(parsed!), "g", []), parsed, "serialize → parse is the identity");
  });

  it("keeps grant ids unique within a layer", () => {
    const diagnostics: string[] = [];
    const parsed = parseGrants([grant("a-grant", []), grant("a-grant", [])], "f.grants", diagnostics);
    assert.equal(parsed.length, 1);
    assert.match(diagnostics[0]!, /f\.grants\[1\]: grant id "a-grant" is already used in this layer/);
  });
});

describe("foldPolicy", () => {
  it("folds defaults → global base → global grants → project base → project grants → session", () => {
    const layers = [
      layer("global", G, {
        dispositions: { "network-fetch": "ask", credentials: "ask" },
        grants: [grant("g-grant", [{ op: "set-disposition", capability: "network-fetch", disposition: "allow" }, { op: "set-disposition", capability: "unclassified", disposition: "ask" }])],
      }),
      layer("project", P, {
        dispositions: { unclassified: "deny", "local-destructive": "ask" },
        grants: [grant("p-grant", [{ op: "set-disposition", capability: "local-destructive", disposition: "allow" }])],
      }),
    ];
    const base = foldPolicy(DEFAULT_CONFIG, layers);
    assert.equal(base.dispositions.credentials, "ask", "global base alone");
    assert.equal(base.dispositions["network-fetch"], "allow", "a global grant beats the global base");
    assert.equal(base.dispositions.unclassified, "deny", "the project base beats a global grant");
    assert.equal(base.dispositions["local-destructive"], "allow", "a project grant beats the project base");
    assert.deepEqual(base.provenance.dispositions["network-fetch"], { layer: "global", grantId: "g-grant", file: G });
    assert.deepEqual(base.provenance.dispositions.unclassified, { layer: "project", file: P });
    assert.deepEqual(base.provenance.dispositions["persistence"], { layer: "default" });

    const effective = withSessionLayer(base, sessionWith(parsedGrant("s-grant", [{ op: "set-disposition", capability: "local-destructive", disposition: "deny" }])));
    assert.equal(effective.dispositions["local-destructive"], "deny", "the session layer is last");
    assert.deepEqual(effective.provenance.dispositions["local-destructive"], { layer: "session", grantId: "s-grant" });
    assert.deepEqual(effective.sources, ["defaults", G, P, "session"]);
    assert.deepEqual(effective.grants.map((entry) => `${entry.layer}:${entry.id}`), ["global:g-grant", "project:p-grant", "session:s-grant"]);
  });

  it("is pure: the same layers give the same config, and nothing upstream is mutated", () => {
    const before = structuredClone(DEFAULT_CONFIG);
    const layers = [layer("global", G, { filesystem: { denyRead: ["/x"] }, grants: [grant("g", [{ op: "allow-command", template: "just *" }])] })];
    assert.deepEqual(foldPolicy(DEFAULT_CONFIG, layers), foldPolicy(DEFAULT_CONFIG, layers));
    assert.deepEqual(DEFAULT_CONFIG, before);
  });

  it("validates class references against everything folded so far", () => {
    const config = foldPolicy(DEFAULT_CONFIG, [
      layer("global", G, {
        grants: [
          grant("too-early", [{ op: "classify", template: "kubectl *", capability: "k8s-ops" }]),
          grant("declares", [
            { op: "add-class", id: "k8s-ops", definition: "Cluster operations." },
            { op: "classify", template: "kubectl *", capability: "k8s-ops" },
            { op: "set-disposition", capability: "k8s-ops", disposition: "deny" },
          ]),
        ],
      }),
    ]);
    assert.deepEqual(config.commands.classify, [{ template: "kubectl *", capability: "k8s-ops" }]);
    assert.equal(config.dispositions["k8s-ops"], "deny");
    assert.equal(config.diagnostics.length, 1);
    assert.match(config.diagnostics[0]!, /grant too-early ops\[0\] \(classify\): "k8s-ops" is not a known capability class/);
  });

  it("applies each op kind", () => {
    const config = foldPolicy(DEFAULT_CONFIG, [
      layer("global", G, {
        capabilities: { classes: [{ id: "old-class", definition: "Old." }, { id: "kept", definition: "Kept." }] },
        dispositions: { "old-class": "deny" },
        grants: [
          grant("everything", [
            { op: "remove-class", id: "old-class" },
            { op: "remove-class", id: "never-was" },
            { op: "set-definition", capability: "kept", definition: "Kept, reworded." },
            { op: "set-definition", capability: "read-project", definition: "Reads." },
            { op: "set-definition", capability: "ghost", definition: "x" },
            { op: "allow-command", template: "git worktree list" },
            { op: "add-to-list", list: "environment.unset", values: ["MY_TOKEN_FILE"] },
            { op: "remove-from-list", list: "commands.allow", values: ["pwd"] },
            { op: "set-disposition", capability: "old-class", disposition: "allow" },
          ]),
        ],
      }),
    ]);
    assert.deepEqual(config.capabilities.classes.map((entry) => [entry.id, entry.definition]), [["kept", "Kept, reworded."]]);
    assert.equal(config.dispositions["old-class"], undefined, "the row goes with the class");
    assert.equal(config.capabilities.definitions["read-project"], "Reads.");
    assert.deepEqual(config.provenance.definitions.kept, { layer: "global", grantId: "everything", file: G });
    assert.ok(config.commands.allow.includes("git worktree list"));
    assert.ok(!config.commands.allow.includes("pwd"));
    assert.ok(config.environment.unset.includes("MY_TOKEN_FILE"));
    const diagnostics = config.diagnostics.join("\n");
    assert.match(diagnostics, /no custom class "never-was" to remove/);
    assert.match(diagnostics, /unknown capability class "ghost"/);
    assert.match(diagnostics, /set-disposition\): unknown capability class "old-class"/, "a removed class takes no row");
    assert.equal(config.diagnostics.length, 3);
  });
});

describe("the session layer", () => {
  it("applies filesystem, network, and environment list ops like commands lists (the sandbox follows: src/session-policy.ts)", () => {
    const ops: PolicyOp[] = [
      { op: "add-to-list", list: "filesystem.allowWrite", values: ["/anywhere"] },
      { op: "remove-from-list", list: "filesystem.denyRead", values: ["~/.ssh"] },
      { op: "add-to-list", list: "network.allowedDomains", values: ["evil.example"] },
      { op: "add-to-list", list: "environment.allow", values: ["AWS_SECRET_ACCESS_KEY"] },
      { op: "add-to-list", list: "commands.allow", values: ["just *"] },
      { op: "allow-command", template: "make lint" },
    ];
    const effective = withSessionLayer(testConfig(), sessionWith(parsedGrant("sandboxy", ops)));
    assert.ok(effective.filesystem.allowWrite.includes("/anywhere"));
    assert.ok(!effective.filesystem.denyRead.includes("~/.ssh"));
    assert.ok(effective.network.allowedDomains.includes("evil.example"));
    assert.ok(effective.environment.allow.includes("AWS_SECRET_ACCESS_KEY"));
    assert.ok(effective.commands.allow.includes("just *"));
    assert.ok(effective.commands.allow.includes("make lint"));
    assert.deepEqual(effective.provenance.lists["filesystem.allowWrite"]["/anywhere"], { layer: "session", grantId: "sandboxy" });
    assert.equal(effective.provenance.lists["filesystem.denyRead"]["~/.ssh"], undefined);
    assert.deepEqual(effective.diagnostics, testConfig().diagnostics);
  });

  it("claims a default commands entry when a session grant restates it, but not a config layer's", () => {
    const base = foldPolicy(DEFAULT_CONFIG, [layer("global", G, { commands: { allow: ["cargo *"] } })]);
    const effective = withSessionLayer(base, sessionWith(parsedGrant("restate", [{ op: "add-to-list", list: "commands.allow", values: ["pwd", "cargo *"] }])));
    assert.deepEqual(effective.commands.allow, base.commands.allow, "membership and order unchanged");
    assert.deepEqual(effective.provenance.lists["commands.allow"].pwd, { layer: "session", grantId: "restate" });
    assert.deepEqual(effective.provenance.lists["commands.allow"]["cargo *"], { layer: "global", file: G }, "the introducer keeps credit");
  });

  it("caches the derived config per revision and maps it back to its base", () => {
    const base = testConfig();
    const session = createSessionLayer();
    assert.equal(withSessionLayer(base, session), base, "an empty session is the base itself");
    editSessionDisposition(session, "credentials", "deny");
    const first = withSessionLayer(base, session);
    assert.notEqual(first, base);
    assert.equal(withSessionLayer(base, session), first, "unchanged revision, same object");
    assert.equal(withSessionLayer(first, session), first, "a derived config is never layered twice");
    assert.equal(baseConfigOf(first), base);
    editSessionDisposition(session, "credentials", "ask");
    assert.notEqual(withSessionLayer(base, session), first, "a new revision refolds");
    assert.equal(withSessionLayer(base, session).dispositions.credentials, "ask");
  });

  it("keeps one edit per row, and drops it with undefined", () => {
    const session = createSessionLayer();
    editSessionDisposition(session, "credentials", "deny");
    editSessionDisposition(session, "credentials", "ask");
    assert.deepEqual(session.edits, [{ op: "set-disposition", capability: "credentials", disposition: "ask" }]);
    editSessionDisposition(session, "credentials", undefined);
    assert.deepEqual(session.edits, []);
  });

  it("matches the old class-edit semantics: add, edit inline, forget, or record a removal", () => {
    const base = testConfig((config) => {
      config.capabilities.classes = [{ id: "persisted", name: "persisted", definition: "From config.", default: "ask" }];
    });
    const session = createSessionLayer();
    editSessionAddClass(session, { id: "fresh", name: "fresh", definition: "First.", default: "ask" });
    editSessionDisposition(session, "fresh", "deny");
    editSessionDefinition(session, "fresh", "Second.");
    editSessionDefinition(session, "persisted", "Reworded.");
    assert.deepEqual(session.edits[0], { op: "add-class", id: "fresh", definition: "Second.", disposition: "ask" }, "a session class carries its edits inline");
    let effective = withSessionLayer(base, session);
    assert.equal(effective.dispositions.fresh, "deny");
    assert.equal(effective.capabilities.classes.find((entry) => entry.id === "persisted")?.definition, "Reworded.");

    editSessionDeleteClass(session, "fresh");
    editSessionDeleteClass(session, "persisted");
    assert.deepEqual(session.edits, [{ op: "remove-class", id: "persisted" }], "the session class is forgotten outright; the persisted one is a removal");
    effective = withSessionLayer(base, session);
    assert.deepEqual(effective.capabilities.classes, []);

    editSessionAddClass(session, { id: "persisted", name: "persisted", definition: "Back.", default: "allow" });
    assert.deepEqual(session.edits, [{ op: "add-class", id: "persisted", definition: "Back.", disposition: "allow" }], "re-adding un-removes");
  });

  it("separates the page edits from named session grants", () => {
    const session = sessionWith(parsedGrant("named", [{ op: "set-disposition", capability: "credentials", disposition: "deny" }]));
    editSessionDisposition(session, "credentials", "ask");
    const base = testConfig();
    assert.equal(withSessionLayer(base, session).dispositions.credentials, "ask", "the page edit applies last");
    assert.equal(withoutSessionEdits(base, session).dispositions.credentials, "deny", "undoing the edit lands on the named grant");
    assert.deepEqual(sessionPolicyLayer(session).grants.map((entry) => entry.id), ["named", "session-edits"]);
  });
});

describe("provenance labels", () => {
  it("reads default, layer, layer · grant, and plain session for page edits", () => {
    assert.equal(provenanceLabel(undefined), "default");
    assert.equal(provenanceLabel({ layer: "default" }), "default");
    assert.equal(provenanceLabel({ layer: "global", file: G }), "global");
    assert.equal(provenanceLabel({ layer: "project", grantId: "worktree-cleanup", file: P }), "project · worktree-cleanup");
    assert.equal(provenanceLabel({ layer: "session", grantId: "worktree-cleanup" }), "session · worktree-cleanup");
    assert.equal(provenanceLabel({ layer: "session", grantId: "session-edits" }), "session");
  });
});

describe("moving grants between layers", () => {
  const a = parsedGrant("a-grant", []);
  const b = parsedGrant("b-grant", []);
  const store = (): LayeredGrants => ({ global: [a], project: [], session: [b] });

  it("promotes session → file, demotes file → session, and moves between files, rewriting nothing", () => {
    const original = store();
    const promoted = promoteGrant(original, "b-grant", "project");
    assert.ok(promoted.ok);
    assert.deepEqual(promoted.grants, { global: [a], project: [b], session: [] });
    assert.equal(promoted.grants.project[0], b, "the same grant object travels");
    assert.deepEqual(original, store(), "pure: the input is untouched");

    const demoted = demoteGrant(original, "a-grant", "global");
    assert.ok(demoted.ok);
    assert.deepEqual(demoted.grants, { global: [], project: [], session: [b, a] });

    const moved = moveGrant(original, "a-grant", "global", "project");
    assert.ok(moved.ok);
    assert.deepEqual(moved.grants.project, [a]);
  });

  it("refuses a missing grant, an id the target already has, and a no-op move", () => {
    assert.match((promoteGrant(store(), "nope", "global") as { error: string }).error, /no grant "nope" in the session layer/);
    const clash: LayeredGrants = { global: [a], project: [], session: [a] };
    assert.match((promoteGrant(clash, "a-grant", "global") as { error: string }).error, /already has a grant "a-grant"/);
    assert.equal(moveGrant(store(), "a-grant", "global", "global").ok, false);
  });

  it("revokes by deleting the grant and nothing else", () => {
    const revoked = revokeGrant(store(), "a-grant", "global");
    assert.ok(revoked.ok);
    assert.deepEqual(revoked.grants, { global: [], project: [], session: [b] });
    assert.equal(revokeGrant(store(), "a-grant", "session").ok, false);
  });
});

describe("applyOpsToRawConfig", () => {
  it("writes ops into base keys, keeping list forms and unrelated keys", () => {
    const raw = {
      backend: "none",
      grants: [grant("kept", [])],
      commands: { allow: ["cargo *"] },
      network: { allowedDomains: { add: ["a.example"] } },
    } as RailConfig;
    const next = applyOpsToRawConfig(raw, [
      { op: "allow-command", template: "just *" },
      { op: "remove-from-list", list: "commands.allow", values: ["pwd"] },
      { op: "add-to-list", list: "network.allowedDomains", values: ["b.example"] },
      { op: "classify", template: "kubectl *", capability: "off-machine-effects" },
      { op: "set-disposition", capability: "credentials", disposition: "deny" },
      { op: "add-class", id: "k8s-ops", definition: "Clusters.", disposition: "ask" },
      { op: "set-definition", capability: "read-project", definition: "Reads." },
    ]);
    assert.equal(next.backend, "none");
    assert.deepEqual(next.grants, raw.grants);
    assert.deepEqual(next.commands?.allow, { add: ["cargo *", "just *"], remove: ["pwd"] }, "a remove turns a bare array into the object form");
    assert.deepEqual(next.network?.allowedDomains, ["a.example", "b.example"]);
    assert.deepEqual(next.commands?.classify, [{ template: "kubectl *", capability: "off-machine-effects" }]);
    assert.deepEqual(next.dispositions, { credentials: "deny" });
    assert.deepEqual(next.capabilities, { classes: [{ id: "k8s-ops", definition: "Clusters.", disposition: "ask" }], definitions: { "read-project": "Reads." } });
    assert.deepEqual(raw.commands?.allow, ["cargo *"], "the input is not mutated");

    // What it writes loads back to the same effect.
    const folded = foldPolicy(DEFAULT_CONFIG, [compileConfigLayer(next, "global", G)]);
    assert.deepEqual(folded.diagnostics, []);
    assert.ok(folded.commands.allow.includes("just *") && !folded.commands.allow.includes("pwd"));
  });
});

describe("opDirection", () => {
  const before = foldPolicy(DEFAULT_CONFIG, [
    layer("global", G, {
      capabilities: { classes: [{ id: "allowed-class", definition: "A.", disposition: "allow" }, { id: "asked-class", definition: "B.", disposition: "ask" }] },
      filesystem: { allowRead: [] },
    }),
  ]);
  const cases: Array<[string, PolicyOp, "widening" | "tightening" | "neutral"]> = [
    ["a stricter row", { op: "set-disposition", capability: "network-fetch", disposition: "deny" }, "tightening"],
    ["a looser row", { op: "set-disposition", capability: "credentials", disposition: "allow" }, "widening"],
    ["the same row", { op: "set-disposition", capability: "credentials", disposition: "judge" }, "neutral"],
    ["a new deny class", { op: "add-class", id: "never", definition: "N.", disposition: "deny" }, "tightening"],
    ["a new ask class", { op: "add-class", id: "maybe", definition: "M." }, "widening"],
    ["a redeclaration with new wording", { op: "add-class", id: "asked-class", definition: "B, broader.", disposition: "deny" }, "widening"],
    ["a redeclaration that only tightens", { op: "add-class", id: "asked-class", definition: "B.", disposition: "deny" }, "tightening"],
    ["removing an allow class", { op: "remove-class", id: "allowed-class" }, "tightening"],
    ["removing an ask class", { op: "remove-class", id: "asked-class" }, "widening"],
    ["removing nothing", { op: "remove-class", id: "absent" }, "neutral"],
    ["any definition change", { op: "set-definition", capability: "credentials", definition: "Narrower, honestly." }, "widening"],
    ["classifying into an undeclared class", { op: "classify", template: "rm *", capability: "never-declared" }, "widening"],
    ["classifying into an allow class", { op: "classify", template: "kubectl *", capability: "allowed-class" }, "widening"],
    ["a new allowed command", { op: "allow-command", template: "just *" }, "widening"],
    ["an allowed command already there", { op: "allow-command", template: "pwd" }, "neutral"],
    ["adding to a deny list", { op: "add-to-list", list: "filesystem.denyRead", values: ["/secret"] }, "tightening"],
    ["adding to an allow list", { op: "add-to-list", list: "network.allowedDomains", values: ["x.example"] }, "widening"],
    ["adding the first read root", { op: "add-to-list", list: "filesystem.allowRead", values: ["~/src"] }, "tightening"],
    ["restating a default deny (a claim that can tighten Seatbelt)", { op: "add-to-list", list: "filesystem.denyRead", values: ["~/.ssh"] }, "tightening"],
    ["restating a default allow", { op: "add-to-list", list: "network.allowedDomains", values: ["github.com"] }, "neutral"],
    ["removing from an allow list", { op: "remove-from-list", list: "network.allowedDomains", values: ["docker.io"] }, "tightening"],
    ["removing from a deny list", { op: "remove-from-list", list: "filesystem.denyWrite", values: [".pi"] }, "widening"],
    ["removing what is not there", { op: "remove-from-list", list: "filesystem.denyWrite", values: ["/nope"] }, "neutral"],
  ];
  for (const [name, op, expected] of cases) {
    it(`${name} is ${expected}`, () => assert.equal(opDirection(op, before), expected));
  }

  it("treats classifying into a deny class as tightening", () => {
    const withDeny = foldPolicy(DEFAULT_CONFIG, [layer("global", G, { capabilities: { classes: [{ id: "never", definition: "N.", disposition: "deny" }] } })]);
    assert.equal(getEffectiveDisposition(withDeny, undefined, "never").disposition, "deny");
    assert.equal(opDirection({ op: "classify", template: "rm *", capability: "never" }, withDeny), "tightening");
  });

  it("treats restating a deny a config layer already claimed as neutral", () => {
    const claimed = foldPolicy(DEFAULT_CONFIG, [layer("global", G, { filesystem: { denyRead: ["/secret"] } })]);
    assert.equal(opDirection({ op: "add-to-list", list: "filesystem.denyRead", values: ["/secret"] }, claimed), "neutral");
  });

  it("treats emptying allowRead as widening (back to blacklist mode)", () => {
    const whitelist = foldPolicy(DEFAULT_CONFIG, [layer("global", G, { filesystem: { allowRead: ["~/src"] } })]);
    assert.equal(opDirection({ op: "remove-from-list", list: "filesystem.allowRead", values: ["~/src"] }, whitelist), "widening");
  });

  it("treats environment.allow's first entry as tightening (whitelist mode) and emptying it as widening", () => {
    // The default is blacklist mode: an empty allow list passes every variable not unset.
    assert.deepEqual(DEFAULT_CONFIG.environment.allow, []);
    assert.equal(opDirection({ op: "add-to-list", list: "environment.allow", values: ["PATH"] }, DEFAULT_CONFIG), "tightening");
    const whitelist = foldPolicy(DEFAULT_CONFIG, [layer("global", G, { environment: { allow: ["PATH", "TERM"] } })]);
    assert.deepEqual(whitelist.environment.allow, ["PATH", "TERM"]);
    assert.equal(opDirection({ op: "add-to-list", list: "environment.allow", values: ["JAVA_HOME"] }, whitelist), "widening");
    assert.equal(opDirection({ op: "remove-from-list", list: "environment.allow", values: ["TERM"] }, whitelist), "tightening");
    assert.equal(opDirection({ op: "remove-from-list", list: "environment.allow", values: ["PATH", "TERM"] }, whitelist), "widening");
  });
});
