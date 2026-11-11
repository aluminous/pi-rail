import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { explainCommandMatch, matchedCapabilities } from "../src/command-allowlist.ts";
import { commandRulesOf } from "../src/policy-store.ts";
import { readdirSync } from "node:fs";
import { DEFAULT_CONFIG, mergeConfig, type RailConfig } from "../src/config.ts";
import { applyReadOnlyPreset, createCapabilityState, getEffectiveDisposition } from "../src/capabilities.ts";
import { testConfig } from "./helpers.ts";

function readExample(name: string): RailConfig {
  const filePath = fileURLToPath(new URL(`../examples/configs/${name}`, import.meta.url));
  return JSON.parse(readFileSync(filePath, "utf8")) as RailConfig;
}

describe("disposition-only example configurations", () => {
  it("provides a strict deny-by-default profile", () => {
    const config = mergeConfig(testConfig(), readExample("dispositions-deny-by-default.json"), "example");
    assert.equal(config.filesystem.enabled, false);
    assert.equal(config.network.enabled, false);
    assert.deepEqual(config.environment.allow, DEFAULT_CONFIG.environment.allow, "environment scrubbing keeps its defaults");
    assert.equal(config.dispositions["read-project"], "allow");
    assert.equal(config.dispositions["run-dev-tools"], "allow");
    assert.equal(config.dispositions["unclassified"], "deny");
    assert.equal(config.dispositions["modify-project"], "deny");
    assert.deepEqual(config.diagnostics, [], "the profile loads without diagnostics");
  });

  it("provides a concrete allow-by-default profile", () => {
    const config = mergeConfig(testConfig(), readExample("dispositions-allow-by-default.json"), "example");
    assert.equal(config.filesystem.enabled, false);
    assert.equal(config.network.enabled, false);
    assert.equal(config.dispositions["modify-project"], "allow");
    assert.equal(config.dispositions["credentials"], "deny");
    assert.equal(config.dispositions["off-machine-effects"], "deny");
    assert.deepEqual(config.diagnostics, [], "the profile loads without diagnostics");
  });
});

describe("command classification example configuration", () => {
  it("routes its commands into the classes it declares, end to end", () => {
    const config = mergeConfig(testConfig(), readExample("commands-classify.json"), "example");
    assert.deepEqual(config.diagnostics, [], "the profile loads without diagnostics");
    assert.deepEqual(config.capabilities.classes.map((entry) => entry.id), ["k8s-ops", "infra-plan", "worktree-cleanup"]);

    const labels = (command: string) => matchedCapabilities(explainCommandMatch(command, commandRulesOf(config)));
    const disposition = (command: string) => {
      const ids = labels(command);
      assert.ok(ids.length > 0, `expected ${command} to be classified`);
      return ids.map((id) => getEffectiveDisposition(config, undefined, id).disposition);
    };

    assert.deepEqual(labels("kubectl get pods -n prod"), ["k8s-ops"]);
    assert.deepEqual(disposition("kubectl get pods -n prod"), ["ask"]);
    assert.deepEqual(disposition("helm upgrade api ./chart"), ["ask"]);
    assert.deepEqual(disposition("terraform plan -out plan.bin"), ["allow"]);
    assert.deepEqual(disposition("terraform apply plan.bin"), ["ask"], "the built-in off-machine-effects row still decides");
    assert.deepEqual(labels("terraform destroy"), [], "an unmapped subcommand is left to the namer");

    // Specificity: the narrow read carve-out wins over the broad rule above it.
    assert.deepEqual(labels("helm version --short"), ["read-system"]);
    assert.deepEqual(labels("helm list"), ["k8s-ops"]);

    // Flags allowlists: the unforced remove is the class; --force and its
    // abbreviation fall through to the namer.
    assert.deepEqual(disposition("git worktree remove ../wt"), ["allow"]);
    assert.deepEqual(labels("git worktree remove --force ../wt"), []);
    assert.deepEqual(labels("git worktree remove --forc ../wt"), []);
    assert.deepEqual(labels("git worktree prune -nv"), ["worktree-cleanup"]);
    assert.deepEqual(labels("git cat-file -p HEAD"), ["read-project"]);
    assert.deepEqual(labels("git cat-file --textconv HEAD:x"), [], "a flag that runs programs is not on the allowlist");

    // extends: read-only mode reaches the custom class through its parent.
    const readOnly = createCapabilityState();
    applyReadOnlyPreset(readOnly);
    assert.equal(getEffectiveDisposition(config, readOnly, "worktree-cleanup").disposition, "deny");
    assert.equal(getEffectiveDisposition(config, readOnly, "k8s-ops").disposition, "deny", "a parentless custom class is a writing class to the preset");
  });
});

describe("every example configuration", () => {
  const dir = fileURLToPath(new URL("../examples/configs/", import.meta.url));
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
    it(`${name} loads in the append-only list format without diagnostics`, () => {
      const config = mergeConfig(testConfig(), readExample(name), "example");
      assert.deepEqual(config.diagnostics, []);
    });
  }

  it("lets the restricted profiles narrow the inherited lists with explicit removes", () => {
    const offline = mergeConfig(testConfig(), readExample("offline-restricted.json"), "example");
    assert.deepEqual(offline.network.allowedDomains, [], "every default domain is removed: networking is blocked");
    assert.ok(!offline.filesystem.allowWrite.includes("~/.cache"));
    assert.ok(offline.filesystem.allowWrite.includes("."));
    assert.ok(offline.filesystem.denyWrite.includes(".git"));

    const allowlist = mergeConfig(testConfig(), readExample("network-allowlist.json"), "example");
    assert.deepEqual(allowlist.network.allowedDomains, ["github.com", "*.github.com", "*.githubusercontent.com", "registry.npmjs.org"]);
  });
});
