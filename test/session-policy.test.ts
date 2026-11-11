// The session policy layer on RuntimeState: page edits as session-edits ops,
// named session grants, the snapshot that survives resume without rewinding
// with /tree, and moving grants between the session and a config file.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SandboxStaleError, type RailBackend } from "../src/backends/types.ts";
import { explainCommandMatch, matchedCapabilities } from "../src/command-allowlist.ts";
import { mergeConfig, type RailConfig, type ResolvedRailConfig } from "../src/config.ts";
import { addClass, describeDispositionSource, dispositionRow, hasUnsavedChanges, saveDispositions, setRowDisposition } from "../src/dispositions.ts";
import { decidePathAccess } from "../src/policy.ts";
import type { Grant } from "../src/policy-store.ts";
import {
  RAIL_SESSION_POLICY_TYPE,
  addSessionGrant,
  demoteGrantToSession,
  listSessionGrants,
  markPolicyApplied,
  promoteSessionGrant,
  reloadBaseConfig,
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
      ops: [
        { op: "add-to-list", list: "filesystem.allowWrite", values: ["/"] },
        { op: "set-disposition", capability: "ghost", disposition: "allow" },
      ],
    });
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /unknown capability class "ghost"/);
    assert.ok(state.config!.filesystem.allowWrite.includes("/"), "a sandbox list applies at the session layer");
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
      grants: [{ id: "wide", request: "r", created: "c", ops: [{ op: "add-to-list", list: "network.allowedDomains", values: ["x.example"] }, { op: "set-disposition", capability: "ghost", disposition: "allow" }] }],
      edits: [],
    });
    const state = createRuntimeState();
    assert.deepEqual(restoreSessionPolicy(state, manager.getEntries()), [], "it parses fine");
    state.config = testConfig();
    const diagnostics = sessionPolicyDiagnostics(state);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /session grant wide .*unknown capability class "ghost"/);
    assert.ok(state.config!.network.allowedDomains.includes("x.example"), "the restored network op applies");

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

// ── Re-pointing the sandbox (GRANTS_PLAN phase 4) ────────────────────────────

describe("sandbox-backed lists move both engines in one step", () => {
  interface Applied {
    allowWrite: string[];
    allowedDomains: string[];
    unset: string[];
    /** Whether the file tools saw this very config while the backend applied it. */
    sameAsFileTools: boolean;
  }

  /** A state with an initialized fake backend that records every applyPolicy (and throws `fail` when given). */
  function sandboxed(options: { fail?: () => Error; persistent?: SessionManager } = {}) {
    const fixture = makeFixtureDir();
    const cwd = path.join(fixture.dir, "project");
    const outside = path.join(fixture.dir, "outside");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const state = options.persistent ? wiredState(options.persistent) : createRuntimeState();
    state.config = testConfig((c) => (c.filesystem.allowWrite = ["."]));
    const applied: Applied[] = [];
    const backend = {
      name: "fake",
      applyPolicy(config: ResolvedRailConfig) {
        if (options.fail) throw options.fail();
        applied.push({
          allowWrite: [...config.filesystem.allowWrite],
          allowedDomains: [...config.network.allowedDomains],
          unset: [...config.environment.unset],
          sameAsFileTools: state.config === config,
        });
      },
    } as unknown as RailBackend;
    state.backend = backend;
    state.initialized = true;
    markPolicyApplied(backend, state.config!);
    const writable = () => decidePathAccess(state.config!, cwd, path.join(outside, "file.txt"), "write").allowed;
    return { state, applied, cwd, outside, writable, cleanup: fixture.cleanup };
  }

  const writeOutside = (outside: string): Grant => ({
    id: "write-outside",
    request: "let me write to the outside dir",
    created: "2026-11-12",
    ops: [{ op: "add-to-list", list: "filesystem.allowWrite", values: [outside] }],
  });

  it("re-points the sandbox at the config the file tools read, on add and on removal", () => {
    const { state, applied, outside, writable, cleanup } = sandboxed();
    try {
      assert.equal(writable(), false);
      assert.deepEqual(addSessionGrant(state, writeOutside(outside)), []);
      assert.equal(applied.length, 1);
      assert.ok(applied[0]!.allowWrite.includes(outside));
      assert.equal(applied[0]!.sameAsFileTools, true, "the backend applied exactly what the file tools now read");
      assert.equal(writable(), true);

      assert.equal(removeSessionGrant(state, "write-outside"), true);
      assert.equal(applied.length, 2);
      assert.ok(!applied[1]!.allowWrite.includes(outside));
      assert.equal(writable(), false);
    } finally {
      cleanup();
    }
  });

  it("leaves the sandbox alone for changes that move no sandbox list", () => {
    const { state, applied, cleanup } = sandboxed();
    try {
      setSessionDisposition(state, "network-fetch", "deny");
      addSessionGrant(state, worktreeGrant);
      removeSessionGrant(state, worktreeGrant.id);
      assert.deepEqual(applied, []);
    } finally {
      cleanup();
    }
  });

  it("fails closed: a refused update leaves both engines and the session file on the previous policy", () => {
    const manager = SessionManager.inMemory();
    const { state, outside, writable, cleanup } = sandboxed({ fail: () => new Error("profile rejected"), persistent: manager });
    try {
      assert.throws(() => addSessionGrant(state, writeOutside(outside)), /could not be re-pointed, so the change was undone: profile rejected/);
      assert.deepEqual(listSessionGrants(state), [], "the grant is not in the layer");
      assert.ok(!state.config!.filesystem.allowWrite.includes(outside));
      assert.equal(writable(), false, "the file tools did not widen");
      assert.equal(snapshots(manager).length, 0, "nothing was persisted");
      assert.equal(state.initialized, true, "the sandbox kept its previous profile, so bash keeps running");
      // A change the sandbox does not have to follow still goes through.
      setSessionDisposition(state, "network-fetch", "deny");
      assert.equal(snapshots(manager).length, 1);
    } finally {
      cleanup();
    }
  });

  it("blocks bash when the backend could not restore its previous profile either", () => {
    const { state, outside, writable, cleanup } = sandboxed({ fail: () => new SandboxStaleError("both updates failed") });
    try {
      assert.throws(() => addSessionGrant(state, writeOutside(outside)), /bash is blocked until the rail restarts/);
      assert.equal(state.initialized, false);
      assert.match(state.lastError!, /both updates failed/);
      assert.equal(writable(), false);
    } finally {
      cleanup();
    }
  });

  it("only moves the file tools while no backend is initialized (initialize compiles the effective config)", () => {
    const { state, applied, outside, writable, cleanup } = sandboxed();
    try {
      state.initialized = false;
      addSessionGrant(state, writeOutside(outside));
      assert.deepEqual(applied, []);
      assert.equal(writable(), true);
    } finally {
      cleanup();
    }
  });

  it("promotes without a reload and never re-points the sandbox at a policy without the grant", () => {
    const { state, applied, outside, writable, cleanup } = sandboxed();
    try {
      addSessionGrant(state, writeOutside(outside));
      assert.equal(promoteSessionGrant(state, "write-outside", { layer: "global", file: "/nonexistent/rail.json" }, () => {}), undefined);
      assert.deepEqual(listSessionGrants(state), []);
      assert.ok(applied.every((entry) => entry.allowWrite.includes(outside)), JSON.stringify(applied));
      assert.equal(writable(), true);
    } finally {
      cleanup();
    }
  });

  it("re-points the sandbox when a reload brings new lists, holding the restart-only switches", () => {
    const { state, applied, outside, writable, cleanup } = sandboxed();
    try {
      const file = "/virtual/rail.json";
      const raw = { filesystem: { allowWrite: [outside] }, network: { enabled: false, allowedDomains: ["files.example"] }, environment: { unset: ["SECRET_THING"] } };
      const notes = reloadBaseConfig(state, () => mergeConfig(testConfig((c) => (c.filesystem.allowWrite = ["."])), raw as RailConfig, file));
      assert.equal(applied.length, 1);
      assert.ok(applied[0]!.allowWrite.includes(outside));
      assert.ok(applied[0]!.allowedDomains.includes("files.example"));
      assert.ok(applied[0]!.unset.includes("SECRET_THING"));
      assert.equal(applied[0]!.sameAsFileTools, true);
      assert.equal(writable(), true);
      assert.equal(state.config!.network.enabled, true, "network.enabled waits for a restart");
      assert.equal(notes.length, 1);
      assert.match(notes[0]!, /^network\.enabled changed on disk and apply when the rail next starts/);
    } finally {
      cleanup();
    }
  });

  it("holds the previous lists in both engines when the sandbox refuses a reload, and applies the rest", () => {
    const { state, outside, writable, cleanup } = sandboxed({ fail: () => new Error("profile rejected") });
    try {
      const raw = { filesystem: { allowWrite: [outside] }, commands: { allow: ["just *"] } };
      const notes = reloadBaseConfig(state, () => mergeConfig(testConfig((c) => (c.filesystem.allowWrite = ["."])), raw as RailConfig, "/virtual/rail.json"));
      assert.equal(notes.length, 1);
      assert.match(notes[0]!, /could not be re-pointed.*profile rejected.*apply when the rail next starts/);
      assert.equal(writable(), false);
      assert.ok(!state.config!.filesystem.allowWrite.includes(outside));
      assert.ok(state.config!.commands.allow.includes("just *"), "what the sandbox does not enforce still reloads");
      assert.equal(state.config!.provenance.lists["filesystem.allowWrite"][outside], undefined);
    } finally {
      cleanup();
    }
  });
});
