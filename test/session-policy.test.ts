// The session policy layer on RuntimeState: page edits as session-edits ops,
// named session grants, the snapshot that survives resume without rewinding
// with /tree, and moving grants between the session and a config file.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { explainCommandMatch, matchedCapabilities } from "../src/command-allowlist.ts";
import { mergeConfig, type RailConfig } from "../src/config.ts";
import { addClass, describeDispositionSource, dispositionRow, hasUnsavedChanges, saveDispositions, setRowDisposition } from "../src/dispositions.ts";
import type { Grant } from "../src/policy-store.ts";
import {
  RAIL_SESSION_POLICY_TYPE,
  addSessionGrant,
  demoteGrantToSession,
  listSessionGrants,
  promoteSessionGrant,
  removeSessionGrant,
  restoreSessionPolicy,
  sessionDispositionEdit,
  sessionPolicyDiagnostics,
  setSessionDisposition,
} from "../src/session-policy.ts";
import { createRuntimeState, resetSessionState, type RuntimeState } from "../src/state.ts";
import { makeFixtureDir, testConfig } from "./helpers.ts";

const worktreeGrant: Grant = {
  id: "worktree-cleanup",
  request: "i want to allow cleaning up worktrees",
  created: "2026-11-11",
  ops: [
    { op: "add-class", id: "worktree-cleanup", definition: "Removing or pruning linked git worktrees of this repo.", disposition: "allow" },
    { op: "classify", template: "git worktree prune", capability: "worktree-cleanup" },
  ],
  examples: [{ tool: "bash", input: { command: "git worktree prune" }, expect: ["allow"] }],
};

/** A state wired to an in-memory pi SessionManager, as index.ts wires appendEntry to pi.appendEntry. */
function wiredState(manager: SessionManager): RuntimeState {
  const state = createRuntimeState();
  state.config = testConfig();
  state.sessionPolicyPersistent = true;
  state.appendEntry = (customType, data) => void manager.appendCustomEntry(customType, data);
  return state;
}

function snapshots(manager: SessionManager) {
  return manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === RAIL_SESSION_POLICY_TYPE);
}

describe("state.config sees the session layer", () => {
  it("applies session edits on the very next read, and assignment sets the base", () => {
    const state = createRuntimeState();
    const base = testConfig();
    state.config = base;
    assert.equal(state.config, base, "an empty session layer is the base itself");
    setSessionDisposition(state, "credentials", "deny");
    assert.equal(state.config?.dispositions.credentials, "deny");
    assert.equal(state.baseConfig, base);
    assert.equal(base.dispositions.credentials, "judge", "the base is not edited");

    // Re-assigning the derived value maps back to the base: no double layer.
    state.config = state.config;
    assert.equal(state.baseConfig, base);
    assert.equal(state.config?.sources.filter((source) => source === "session").length, 1);
  });

  it("makes a session classify rule match immediately, into a class the session added", () => {
    const state = createRuntimeState();
    state.config = testConfig();
    addSessionGrant(state, worktreeGrant);
    const config = state.config!;
    const labels = matchedCapabilities(explainCommandMatch("git worktree prune", { classify: config.commands.classify, allow: config.commands.allow }));
    assert.deepEqual(labels, ["worktree-cleanup"]);
    assert.equal(dispositionRow(state.config, state, "worktree-cleanup").effective.disposition, "allow");
  });

  it("reports a grant's refused ops to the caller and lists, removes grants", () => {
    const state = createRuntimeState();
    state.config = testConfig();
    const diagnostics = addSessionGrant(state, {
      id: "wide-open",
      request: "let me write anywhere",
      created: "2026-11-11",
      ops: [{ op: "add-to-list", list: "filesystem.allowWrite", values: ["/"] }],
    });
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /filesystem\.allowWrite applies only from a config file/);
    assert.ok(!state.config!.filesystem.allowWrite.includes("/"));
    assert.deepEqual(listSessionGrants(state).map((grant) => grant.id), ["wide-open"]);
    assert.equal(removeSessionGrant(state, "wide-open"), true);
    assert.equal(removeSessionGrant(state, "wide-open"), false);
    assert.deepEqual(listSessionGrants(state), []);
  });

  it("names a session grant as the source of a row, separately from page edits", () => {
    const state = createRuntimeState();
    state.config = testConfig();
    addSessionGrant(state, { id: "no-creds", request: "never read creds", created: "", ops: [{ op: "set-disposition", capability: "credentials", disposition: "deny" }] });
    const row = dispositionRow(state.config, state, "credentials");
    assert.equal(row.value, "deny");
    assert.equal(row.persisted, "deny", "a named grant is what the row falls back to, not an unsaved edit");
    assert.equal(row.modified, false);
    assert.equal(describeDispositionSource(row.effective), "session grant no-creds");
    assert.equal(hasUnsavedChanges(state), false, "Ctrl+S promotes page edits, not named grants");

    setRowDisposition(state.config, state, "credentials", "ask");
    assert.equal(dispositionRow(state.config, state, "credentials").modified, true);
    setRowDisposition(state.config, state, "credentials", "deny");
    assert.equal(sessionDispositionEdit(state, "credentials"), undefined, "back on the grant's value the edit is dropped");
  });

  it("Ctrl+S promotes only session-edits, leaving named grants in the session", () => {
    const state = createRuntimeState();
    state.config = testConfig();
    addSessionGrant(state, worktreeGrant);
    setRowDisposition(state.config, state, "modify-project", "ask");
    const rows: string[] = [];
    saveDispositions(state.config, state, { disposition: (id, disposition) => void rows.push(`${id}=${disposition}`), capabilityClass: () => {}, capabilityDefinition: () => {}, baseOps: () => assert.fail("no other ops") });
    assert.deepEqual(rows, ["modify-project=ask"]);
    assert.deepEqual(listSessionGrants(state).map((grant) => grant.id), ["worktree-cleanup"]);
    assert.equal(state.config!.dispositions["modify-project"], "ask");
    assert.deepEqual(state.baseConfig!.provenance.dispositions["modify-project"]?.layer, "global", "the saved row is in the base now, as global");
  });
});

describe("session policy persistence", () => {
  it("writes a full snapshot on every change, and nothing for an ephemeral session", () => {
    const manager = SessionManager.inMemory();
    const state = wiredState(manager);
    setRowDisposition(state.config, state, "credentials", "deny");
    addClass(state.config, state, { id: "touches-customer-data", definition: "Customer records." });
    addSessionGrant(state, worktreeGrant);
    const written = snapshots(manager);
    assert.equal(written.length, 3);
    const last = written.at(-1)! as { data: { grants: unknown[]; edits: unknown[] } };
    assert.equal(last.data.grants.length, 1);
    assert.equal(last.data.edits.length, 2, "each snapshot is the whole layer, not a delta");

    const ephemeral = createRuntimeState();
    const appended: string[] = [];
    ephemeral.appendEntry = (type) => void appended.push(type);
    setSessionDisposition(ephemeral, "credentials", "deny");
    assert.deepEqual(appended, [], "sessionPolicyPersistent false: nothing written");
  });

  it("restores from the last snapshot in the whole file, not the current branch", () => {
    const manager = SessionManager.inMemory();
    const state = wiredState(manager);
    manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    const forkPoint = manager.getLeafId()!;
    setSessionDisposition(state, "credentials", "deny");
    addSessionGrant(state, worktreeGrant);
    // /tree back to before both changes: the snapshots are now off-branch.
    manager.branch(forkPoint);
    manager.appendMessage({ role: "user", content: "another branch", timestamp: 2 });
    assert.equal(manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === RAIL_SESSION_POLICY_TYPE), false);

    const resumed = createRuntimeState();
    resumed.config = testConfig();
    assert.deepEqual(restoreSessionPolicy(resumed, manager.getEntries()), []);
    assert.equal(resumed.config!.dispositions.credentials, "deny", "the setting survived even though the branch never saw it");
    assert.deepEqual(listSessionGrants(resumed), [worktreeGrant], "grants round-trip with their examples");

    // A later change on the new branch is the latest snapshot and wins.
    const live = wiredState(manager);
    restoreSessionPolicy(live, manager.getEntries());
    removeSessionGrant(live, "worktree-cleanup");
    const again = createRuntimeState();
    restoreSessionPolicy(again, manager.getEntries());
    assert.deepEqual(listSessionGrants(again), []);
    assert.equal(sessionDispositionEdit(again, "credentials"), "deny");
  });

  it("reports what folding a restored grant refused, for session start to surface", () => {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry(RAIL_SESSION_POLICY_TYPE, {
      version: 1,
      grants: [{ id: "wide", request: "r", created: "c", ops: [{ op: "add-to-list", list: "network.allowedDomains", values: ["x.example"] }] }],
      edits: [],
    });
    const state = createRuntimeState();
    assert.deepEqual(restoreSessionPolicy(state, manager.getEntries()), [], "it parses fine");
    state.config = testConfig();
    const diagnostics = sessionPolicyDiagnostics(state);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /session grant wide .*network\.allowedDomains applies only from a config file/);

    const clean = createRuntimeState();
    clean.config = testConfig();
    assert.deepEqual(sessionPolicyDiagnostics(clean), []);
  });

  it("starts a new session with an empty layer, and validates what it restores", () => {
    const state = createRuntimeState();
    setSessionDisposition(state, "credentials", "deny");
    resetSessionState(state);
    assert.deepEqual(state.sessionPolicy.edits, []);
    assert.deepEqual(restoreSessionPolicy(state, SessionManager.inMemory().getEntries()), [], "no snapshot, nothing to restore");

    const manager = SessionManager.inMemory();
    manager.appendCustomEntry(RAIL_SESSION_POLICY_TYPE, {
      version: 1,
      grants: [{ id: "later", request: "r", created: "c", ops: [{ op: "classify", template: "x *", capability: "read-project", flags: ["n"] }] }],
      edits: [{ op: "set-disposition", capability: "credentials", disposition: "deny" }, { op: "teleport" }],
    });
    const diagnostics = restoreSessionPolicy(state, manager.getEntries());
    assert.equal(diagnostics.length, 2);
    assert.match(diagnostics.join("\n"), /flag "n" must start with "-"/);
    assert.deepEqual(state.sessionPolicy.edits, [{ op: "set-disposition", capability: "credentials", disposition: "deny" }]);
    assert.deepEqual(state.sessionPolicy.grants[0]?.ops, [], "a malformed op is refused, not half-applied");
  });
});

describe("moving named grants to and from config files", () => {
  it("promotes a session grant into a file without moving any effective value", () => {
    const fixture = makeFixtureDir();
    try {
      const file = path.join(fixture.dir, ".pi", "rail.json");
      const state = createRuntimeState();
      state.config = testConfig();
      addSessionGrant(state, worktreeGrant);
      const before = state.config!.commands.classify;
      assert.equal(promoteSessionGrant(state, "worktree-cleanup", { layer: "project", file }), undefined);
      assert.deepEqual(listSessionGrants(state), []);
      assert.deepEqual(state.config!.commands.classify, before);
      assert.deepEqual(state.config!.provenance.lists["commands.classify"]["git worktree prune"], { layer: "project", grantId: "worktree-cleanup", file });
      const written = JSON.parse(readFileSync(file, "utf8")) as RailConfig;
      assert.deepEqual(written.grants, [worktreeGrant]);
      // And the file loads back to the same grant.
      const loaded = mergeConfig(testConfig(), written, file);
      assert.deepEqual(loaded.diagnostics, []);
      assert.deepEqual(loaded.grants.map((grant) => `${grant.layer}:${grant.id}`), ["project:worktree-cleanup"]);
      assert.match(promoteSessionGrant(state, "worktree-cleanup", { layer: "project", file })!, /No session grant/);
    } finally {
      fixture.cleanup();
    }
  });

  it("demotes a file grant into the session, keeping its examples", () => {
    const fixture = makeFixtureDir();
    try {
      const file = path.join(fixture.dir, "rail.json");
      writeFileSync(file, JSON.stringify({ backend: "none", grants: [worktreeGrant] }), "utf8");
      const state = createRuntimeState();
      state.config = testConfig();
      assert.equal(demoteGrantToSession(state, { layer: "global", file }, "worktree-cleanup"), undefined);
      assert.deepEqual(listSessionGrants(state), [worktreeGrant]);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { backend: "none" });
      assert.match(demoteGrantToSession(state, { layer: "global", file }, "worktree-cleanup")!, /already has a grant/);
    } finally {
      fixture.cleanup();
    }
  });
});
