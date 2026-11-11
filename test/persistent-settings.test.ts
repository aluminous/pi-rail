// The Ctrl+S write path. These exercise the real file writers, so every test
// redirects the agent dir to a temp fixture first — nothing here may touch the
// developer's own ~/.pi/agent/extensions/rail.json.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { RailConfig } from "../src/config.ts";
import { parseGrants, serializeGrant, type Grant } from "../src/policy-store.ts";
import {
  addGrantToConfigFile,
  appendPersistentBaseOps,
  getPersistentConfigPath,
  moveGrantBetweenConfigFiles,
  readConfigFileGrants,
  removeGrantFromConfigFile,
  updatePersistentCapabilityClass,
  updatePersistentCapabilityDefinition,
  updatePersistentDisposition,
  updatePersistentStatusLine,
} from "../src/persistent-settings.ts";
import { makeFixtureDir, withTempAgentDir } from "./helpers.ts";

/** withTempAgentDir plus a reader for whichever config file the writers chose. */
function withPersistedConfig(fn: (read: () => RailConfig, agentDir: string) => void): void {
  withTempAgentDir((agentDir) => {
    fn(() => JSON.parse(readFileSync(getPersistentConfigPath(), "utf8")) as RailConfig, agentDir);
  });
}

describe("persisting capability classes", () => {
  it("creates, updates, and removes a class, leaving no empty section behind", () => {
    withPersistedConfig((read) => {
      updatePersistentCapabilityClass("touches-customer-data", {
        id: "touches-customer-data",
        definition: "Customer records.",
        disposition: "ask",
      });
      assert.deepEqual(read().capabilities?.classes, [
        { id: "touches-customer-data", definition: "Customer records.", disposition: "ask" },
      ]);

      // Same id rewrites in place rather than appending a duplicate.
      updatePersistentCapabilityClass("touches-customer-data", {
        id: "touches-customer-data",
        name: "Customer data",
        definition: "Rewritten.",
        disposition: "deny",
      });
      assert.deepEqual(read().capabilities?.classes, [
        { id: "touches-customer-data", name: "Customer data", definition: "Rewritten.", disposition: "deny" },
      ]);

      updatePersistentCapabilityClass("touches-customer-data", undefined);
      assert.equal(read().capabilities, undefined, "the last removal takes the section with it");
    });
  });

  it("keeps sibling classes when one is removed", () => {
    withPersistedConfig((read) => {
      updatePersistentCapabilityClass("alpha", { id: "alpha", definition: "A.", disposition: "ask" });
      updatePersistentCapabilityClass("beta", { id: "beta", definition: "B.", disposition: "deny" });
      updatePersistentCapabilityClass("alpha", undefined);
      assert.deepEqual(read().capabilities?.classes?.map((entry) => (entry as { id: string }).id), ["beta"]);
    });
  });

  it("writes and clears built-in definition overrides", () => {
    withPersistedConfig((read) => {
      updatePersistentCapabilityDefinition("read-project", "Rephrased.");
      assert.deepEqual(read().capabilities?.definitions, { "read-project": "Rephrased." });
      updatePersistentCapabilityDefinition("read-project", undefined);
      assert.equal(read().capabilities, undefined);
    });
  });

  it("does not disturb unrelated settings already in the file", () => {
    withPersistedConfig((read) => {
      updatePersistentDisposition("modify-project", "deny");
      updatePersistentCapabilityClass("alpha", { id: "alpha", definition: "A.", disposition: "ask" });
      const config = read();
      assert.deepEqual(config.dispositions, { "modify-project": "deny" });
      assert.equal(config.capabilities?.classes?.length, 1);
    });
  });
});

describe("persisting into the global rail.json", () => {
  const globalDir = (agentDir: string) => path.join(agentDir, "extensions");
  const seed = (agentDir: string, name: string, body: unknown) => {
    mkdirSync(globalDir(agentDir), { recursive: true });
    writeFileSync(path.join(globalDir(agentDir), name), JSON.stringify(body, null, 2), "utf8");
  };
  const read = (agentDir: string, name: string) =>
    JSON.parse(readFileSync(path.join(globalDir(agentDir), name), "utf8")) as RailConfig;

  it("creates rail.json when no config file exists yet", () => {
    withTempAgentDir((agentDir) => {
      updatePersistentDisposition("modify-project", "deny");
      assert.equal(getPersistentConfigPath(), path.join(globalDir(agentDir), "rail.json"));
      assert.deepEqual(read(agentDir, "rail.json").dispositions, { "modify-project": "deny" });
    });
  });

  // guard.json loading is gone: a stray one is neither read nor written.
  it("ignores a legacy guard.json entirely", () => {
    withTempAgentDir((agentDir) => {
      seed(agentDir, "guard.json", { backend: "none" });
      assert.equal(getPersistentConfigPath(), path.join(globalDir(agentDir), "rail.json"));
      updatePersistentDisposition("modify-project", "deny");
      assert.deepEqual(read(agentDir, "guard.json"), { backend: "none" }, "the legacy file is never touched");
      assert.deepEqual(read(agentDir, "rail.json"), { dispositions: { "modify-project": "deny" } });
    });
  });

  it("keeps unrelated keys and existing grants, and leaves no temp or lock file behind", () => {
    withTempAgentDir((agentDir) => {
      const grant = { id: "kept", request: "keep me", created: "2026-11-11", ops: [], examples: [{ tool: "bash", input: { command: "ls" }, expect: ["allow"] }] };
      seed(agentDir, "rail.json", { backend: "seatbelt", futureKey: { x: 1 }, grants: [grant] });
      updatePersistentDisposition("modify-project", "deny");
      updatePersistentStatusLine("auto");
      appendPersistentBaseOps([{ op: "classify", template: "kubectl *", capability: "off-machine-effects" }]);
      const persisted = read(agentDir, "rail.json") as RailConfig & { futureKey?: unknown };
      assert.equal(persisted.backend, "seatbelt");
      assert.deepEqual(persisted.futureKey, { x: 1 });
      assert.deepEqual(persisted.grants, [grant], "grants survive base-key writes verbatim");
      assert.deepEqual(persisted.commands?.classify, [{ template: "kubectl *", capability: "off-machine-effects" }]);
      assert.deepEqual(readdirSync(globalDir(agentDir)), ["rail.json"]);
    });
  });
});

describe("grants in config files", () => {
  const grant = (id: string): Grant => ({
    id,
    request: `request for ${id}`,
    created: "2026-11-11",
    ops: [{ op: "allow-command", template: "git worktree prune" }],
    examples: [{ tool: "bash", input: { command: "git worktree prune" }, expect: ["allow"], why: "prune only drops stale entries" }],
  });

  it("adds, refuses a duplicate id, and removes a grant, returning what it held", () => {
    const fixture = makeFixtureDir();
    try {
      const file = path.join(fixture.dir, ".pi", "rail.json");
      addGrantToConfigFile(file, grant("worktree-cleanup"));
      assert.deepEqual(readConfigFileGrants(file).map((entry) => entry.id), ["worktree-cleanup"]);
      assert.throws(() => addGrantToConfigFile(file, grant("worktree-cleanup")), /already has a grant "worktree-cleanup"/);
      const removed = removeGrantFromConfigFile(file, "worktree-cleanup");
      assert.deepEqual(removed, serializeGrant(grant("worktree-cleanup")));
      assert.equal(removeGrantFromConfigFile(file, "worktree-cleanup"), undefined);
      assert.equal((JSON.parse(readFileSync(file, "utf8")) as RailConfig).grants, undefined, "an emptied grants array goes away");
    } finally {
      fixture.cleanup();
    }
  });

  it("moves a grant between files byte-for-byte, unknown fields included", () => {
    const fixture = makeFixtureDir();
    try {
      const from = path.join(fixture.dir, "global", "rail.json");
      const to = path.join(fixture.dir, "project", "rail.json");
      // A field this version does not read must survive the move untouched.
      const raw = { ...serializeGrant(grant("worktree-cleanup")), note: "from a later version" };
      mkdirSync(path.dirname(from), { recursive: true });
      writeFileSync(from, JSON.stringify({ backend: "none", grants: [raw] }), "utf8");
      moveGrantBetweenConfigFiles(from, to, "worktree-cleanup");
      assert.deepEqual(readConfigFileGrants(to), [raw]);
      assert.deepEqual(JSON.parse(readFileSync(from, "utf8")), { backend: "none" }, "the source keeps everything else");
      assert.throws(() => moveGrantBetweenConfigFiles(from, to, "worktree-cleanup"), /has no grant/);
    } finally {
      fixture.cleanup();
    }
  });

  it("round-trips a written grant through the loader unchanged", () => {
    const fixture = makeFixtureDir();
    try {
      const file = path.join(fixture.dir, "rail.json");
      addGrantToConfigFile(file, grant("worktree-cleanup"));
      const diagnostics: string[] = [];
      const parsed = parseGrants(readConfigFileGrants(file), "grants", diagnostics);
      assert.deepEqual(diagnostics, []);
      assert.deepEqual(parsed, [grant("worktree-cleanup")]);
    } finally {
      fixture.cleanup();
    }
  });
});
