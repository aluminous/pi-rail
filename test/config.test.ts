import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  globalRailConfigPath,
  loadConfig,
  mergeConfig,
  type RailConfig,
} from "../src/config.ts";
import { getEffectiveDisposition } from "../src/capabilities.ts";
import { makeFixtureDir, testConfig, withTempAgentDir } from "./helpers.ts";

describe("mergeConfig", () => {
  it("overrides scalar and nested fields and records the source", () => {
    const merged = mergeConfig(testConfig(), { enabled: false, backend: "none", classifier: { enabled: true, model: "openai/gpt-4o-mini" } }, "test.json");
    assert.equal(merged.enabled, false);
    assert.equal(merged.backend, "none");
    assert.equal(merged.classifier.enabled, true);
    assert.equal(merged.classifier.model, "openai/gpt-4o-mini");
    assert.deepEqual(merged.sources, ["defaults", "test.json"]);
  });

  it("applies a valid statusLine mode and rejects an invalid one", () => {
    const merged = mergeConfig(testConfig(), { statusLine: "auto" }, "test.json");
    assert.equal(merged.statusLine, "auto");
    const rejected = mergeConfig(testConfig(), { statusLine: "sometimes" as never }, "test.json");
    assert.equal(rejected.statusLine, "always");
    assert.equal(rejected.diagnostics.length, 1);
    assert.match(rejected.diagnostics[0]!, /statusLine/);
  });

  it("appends a bare array to the inherited list rather than replacing it", () => {
    const merged = mergeConfig(testConfig(), { filesystem: { denyRead: ["/only/this"] } }, "test.json");
    assert.deepEqual(merged.filesystem.denyRead, [...DEFAULT_CONFIG.filesystem.denyRead, "/only/this"]);
    assert.deepEqual(merged.filesystem.allowWrite, DEFAULT_CONFIG.filesystem.allowWrite);
  });

  it("toggles filesystem and network restriction layers independently", () => {
    const merged = mergeConfig(
      testConfig(),
      { filesystem: { enabled: false }, network: { enabled: false }, classifier: { enabled: true } },
      "classifier-focused.json",
    );
    assert.equal(merged.filesystem.enabled, false);
    assert.equal(merged.network.enabled, false);
    assert.equal(merged.classifier.enabled, true);
    assert.deepEqual(merged.filesystem.denyRead, DEFAULT_CONFIG.filesystem.denyRead);
    assert.deepEqual(merged.network.allowedDomains, DEFAULT_CONFIG.network.allowedDomains);
  });

  it("rejects invalid values with a diagnostic instead of applying them", () => {
    const merged = mergeConfig(
      testConfig(),
      {
        backend: "windows" as never,
        filesystem: { denyRead: [42] as never },
        classifier: { timeoutMs: -5 },
      },
      "test.json",
    );
    assert.equal(merged.backend, DEFAULT_CONFIG.backend);
    assert.deepEqual(merged.filesystem.denyRead, DEFAULT_CONFIG.filesystem.denyRead);
    assert.equal(merged.classifier.timeoutMs, DEFAULT_CONFIG.classifier.timeoutMs);
    assert.equal(merged.diagnostics.length, 3);
  });

  it("layers project config over global config", () => {
    const afterGlobal = mergeConfig(testConfig(), { network: { enabled: false } }, "global.json");
    const afterProject = mergeConfig(afterGlobal, { network: { enabled: true, allowedDomains: ["example.com"] } }, "project.json");
    assert.equal(afterProject.network.enabled, true);
    assert.deepEqual(afterProject.network.allowedDomains, [...DEFAULT_CONFIG.network.allowedDomains, "example.com"]);
    assert.deepEqual(afterProject.sources, ["defaults", "global.json", "project.json"]);
  });

  it("loads a config carrying retired classifier.rules with one diagnostic and no error", () => {
    const merged = mergeConfig(
      testConfig(),
      { classifier: { enabled: true, rules: { allow: ["My Rule: fine."], soft_deny: [], hard_deny: ["Whatever:"] } } } as Partial<RailConfig>,
      "test.json",
    );
    assert.equal(merged.diagnostics.length, 1);
    assert.match(merged.diagnostics[0]!, /Ignoring test\.json\.classifier\.rules/);
    assert.match(merged.diagnostics[0]!, /disposition table/);
    assert.match(merged.diagnostics[0]!, /capabilities\.definitions/);
    // The rest of the classifier block still applies, and nothing rule-shaped survives.
    assert.equal(merged.classifier.enabled, true);
    assert.equal((merged.classifier as unknown as Record<string, unknown>).rules, undefined);
  });

  it("does not mutate DEFAULT_CONFIG through merges", () => {
    const before = structuredClone(DEFAULT_CONFIG);
    mergeConfig(testConfig(), { filesystem: { denyRead: ["/mutated"] } }, "test.json");
    assert.deepEqual(DEFAULT_CONFIG, before);
  });
});

// Every list takes the same two forms, so these exercise the shared chokepoint
// through one representative list each rather than repeating nine times.
describe("lists only append", () => {
  const G = { layer: "global", file: "global.json" } as const;

  it("treats a bare array exactly like {add: [...]}", () => {
    const bare = mergeConfig(testConfig(), { filesystem: { denyRead: ["/extra/secret"] } }, "test.json");
    const explicit = mergeConfig(testConfig(), { filesystem: { denyRead: { add: ["/extra/secret"] } } }, "test.json");
    assert.deepEqual(explicit.filesystem.denyRead, bare.filesystem.denyRead);
    assert.deepEqual(explicit.provenance.lists["filesystem.denyRead"], bare.provenance.lists["filesystem.denyRead"]);
    assert.deepEqual(bare.filesystem.denyRead, [...DEFAULT_CONFIG.filesystem.denyRead, "/extra/secret"]);
  });

  it("extends every list, not just the filesystem ones", () => {
    const merged = mergeConfig(
      testConfig(),
      {
        filesystem: { allowWrite: ["~/scratch"], denyWrite: ["~/.terraform.d"] },
        environment: { allow: ["MY_VAR"], unset: ["MY_SECRET"] },
        network: { allowedDomains: ["registry.npmjs.org"] },
        commands: { allow: ["shellcheck *"] },
      },
      "test.json",
    );
    assert.deepEqual(merged.filesystem.allowWrite, [...DEFAULT_CONFIG.filesystem.allowWrite, "~/scratch"]);
    assert.deepEqual(merged.filesystem.denyWrite, [...DEFAULT_CONFIG.filesystem.denyWrite, "~/.terraform.d"]);
    assert.deepEqual(merged.environment.allow, [...DEFAULT_CONFIG.environment.allow, "MY_VAR"]);
    assert.deepEqual(merged.environment.unset, [...DEFAULT_CONFIG.environment.unset, "MY_SECRET"]);
    assert.deepEqual(merged.network.allowedDomains, [...DEFAULT_CONFIG.network.allowedDomains, "registry.npmjs.org"]);
    assert.deepEqual(merged.commands.allow, [...DEFAULT_CONFIG.commands.allow, "shellcheck *"]);
  });

  it("drops duplicates instead of repeating an entry the inherited list already has", () => {
    const merged = mergeConfig(testConfig(), { filesystem: { denyRead: ["~/.ssh", "/extra", "/extra"] } }, "test.json");
    assert.deepEqual(merged.filesystem.denyRead, [...DEFAULT_CONFIG.filesystem.denyRead, "/extra"]);
  });

  it("drops inherited entries only when a layer removes them by name", () => {
    const merged = mergeConfig(testConfig(), { filesystem: { denyRead: { remove: ["~/.ssh", "/never-there"] } } }, "global.json");
    assert.deepEqual(merged.filesystem.denyRead, DEFAULT_CONFIG.filesystem.denyRead.filter((entry) => entry !== "~/.ssh"));
    assert.equal(merged.provenance.lists["filesystem.denyRead"]["~/.ssh"], undefined, "a removed entry has no provenance left");
    assert.deepEqual(merged.diagnostics, [], "removing an absent entry is a quiet no-op");
  });

  it("applies a layer's removes before its adds", () => {
    const merged = mergeConfig(testConfig(), { filesystem: { denyRead: { remove: ["~/.ssh"], add: ["~/.ssh", "/extra"] } } }, "global.json");
    assert.deepEqual(merged.filesystem.denyRead.slice(-2), ["~/.ssh", "/extra"]);
    assert.deepEqual(merged.provenance.lists["filesystem.denyRead"]["~/.ssh"], G);
  });

  it("extends an empty list into just its own values", () => {
    const merged = mergeConfig(testConfig(), { filesystem: { allowRead: ["~/reference"] } }, "test.json");
    assert.deepEqual(merged.filesystem.allowRead, ["~/reference"]);
  });

  describe("provenance", () => {
    it("labels only the added entries, leaving inherited sources intact", () => {
      const merged = mergeConfig(testConfig(), { filesystem: { denyRead: ["/extra/secret"] } }, "global.json");
      const sources = merged.provenance.lists["filesystem.denyRead"];
      assert.deepEqual(sources["/extra/secret"], G);
      assert.deepEqual(sources["~/.ssh"], { layer: "default" }, "an untouched default keeps default provenance");
    });

    it("lets a restatement claim a built-in default in place", () => {
      const merged = mergeConfig(testConfig(), { filesystem: { denyRead: ["~/.ssh"] } }, "global.json");
      assert.deepEqual(merged.filesystem.denyRead, DEFAULT_CONFIG.filesystem.denyRead, "position and membership are unchanged");
      assert.deepEqual(merged.provenance.lists["filesystem.denyRead"]["~/.ssh"], G);
    });

    it("credits the layer that introduced an entry, not the one that restates it", () => {
      const afterGlobal = mergeConfig(testConfig(), { commands: { allow: ["cargo *"] } }, "global.json");
      const afterProject = mergeConfig(afterGlobal, { commands: { allow: ["cargo *", "just *"] } }, "/repo/.pi/rail.json");
      const sources = afterProject.provenance.lists["commands.allow"];
      assert.deepEqual(sources["cargo *"], G);
      assert.deepEqual(sources["just *"], { layer: "project", file: "/repo/.pi/rail.json" });
    });
  });

  describe("three layers", () => {
    it("accumulates through every layer", () => {
      const afterGlobal = mergeConfig(testConfig(), { network: { allowedDomains: ["global.example"] } }, "global.json");
      const afterProject = mergeConfig(afterGlobal, { network: { allowedDomains: ["project.example"] } }, "/repo/.pi/rail.json");
      assert.deepEqual(afterProject.network.allowedDomains, [...DEFAULT_CONFIG.network.allowedDomains, "global.example", "project.example"]);
      const sources = afterProject.provenance.lists["network.allowedDomains"];
      assert.equal(sources["github.com"]?.layer, "default");
      assert.equal(sources["global.example"]?.layer, "global");
      assert.equal(sources["project.example"]?.layer, "project");
    });

    it("lets a later layer remove what an earlier layer added", () => {
      const afterGlobal = mergeConfig(testConfig(), { network: { allowedDomains: ["global.example"] } }, "global.json");
      const afterProject = mergeConfig(afterGlobal, { network: { allowedDomains: { remove: ["global.example", "github.com"], add: ["project.example"] } } }, "/repo/.pi/rail.json");
      assert.ok(!afterProject.network.allowedDomains.includes("global.example"));
      assert.ok(!afterProject.network.allowedDomains.includes("github.com"));
      assert.equal(afterProject.network.allowedDomains.at(-1), "project.example");
    });
  });

  describe("malformed and removed forms leave the list exactly as it was", () => {
    const cases: Array<{ name: string; value: unknown; diagnostic: string }> = [
      { name: "the removed {replace: true} form", value: { replace: true, values: ["/x"] }, diagnostic: `the {"replace", "values"} form has been removed` },
      { name: "the removed {replace: false} form", value: { replace: false, values: ["/x"] }, diagnostic: "lists only append" },
      { name: "values without replace", value: { values: ["/x"] }, diagnostic: `the {"replace", "values"} form has been removed` },
      { name: "unknown key", value: { add: ["/x"], merge: true }, diagnostic: "unexpected key merge" },
      { name: "non-string add", value: { add: [7] }, diagnostic: "expected an array of strings" },
      { name: "non-string values", value: [7], diagnostic: "expected an array of strings" },
      { name: "a bare string", value: "everything", diagnostic: "expected an array of strings" },
    ];

    for (const { name, value, diagnostic } of cases) {
      it(name, () => {
        const merged = mergeConfig(testConfig(), { filesystem: { denyRead: value as never } }, "test.json");
        assert.deepEqual(merged.filesystem.denyRead, DEFAULT_CONFIG.filesystem.denyRead);
        assert.deepEqual(merged.provenance.lists["filesystem.denyRead"], DEFAULT_CONFIG.provenance.lists["filesystem.denyRead"]);
        const matching = merged.diagnostics.filter((entry) => entry.includes("test.json.filesystem.denyRead") && entry.includes(diagnostic));
        assert.equal(matching.length, 1, `expected one diagnostic naming the list and ${diagnostic}; got ${JSON.stringify(merged.diagnostics)}`);
      });
    }

    it("leaves an earlier layer's addition standing", () => {
      const afterGlobal = mergeConfig(testConfig(), { commands: { allow: ["cargo *"] } }, "global.json");
      const afterProject = mergeConfig(afterGlobal, { commands: { allow: { replace: true, values: [] } as never } }, "project.json");
      assert.deepEqual(afterProject.commands.allow, afterGlobal.commands.allow);
      assert.deepEqual(afterProject.provenance.lists["commands.allow"]["cargo *"], G);
    });
  });
});

describe("config provenance", () => {
  it("seeds every default list entry with the default layer", () => {
    const config = testConfig();
    assert.deepEqual(config.provenance.lists["filesystem.denyRead"]["~/.ssh"], { layer: "default" });
    assert.deepEqual(config.provenance.lists["environment.unset"]["*_TOKEN"], { layer: "default" });
    assert.deepEqual(config.provenance.lists["commands.allow"]["grep *"], { layer: "default" });
  });

  it("names the layer, the grant, and the file behind each entry", () => {
    const merged = mergeConfig(
      testConfig(),
      {
        environment: { unset: ["MY_SECRET"] },
        grants: [{ id: "npm-registry", request: "let npm reach its registry", created: "2026-11-11", ops: [{ op: "add-to-list", list: "network.allowedDomains", values: ["registry.npmjs.org"] }] }],
      },
      "global.json",
    );
    assert.deepEqual(merged.provenance.lists["environment.unset"].MY_SECRET, { layer: "global", file: "global.json" });
    assert.deepEqual(merged.provenance.lists["network.allowedDomains"]["registry.npmjs.org"], { layer: "global", grantId: "npm-registry", file: "global.json" });
    assert.deepEqual(merged.provenance.lists["filesystem.allowWrite"]["."], { layer: "default" }, "untouched lists keep default provenance");
    assert.deepEqual(merged.grants, [{ layer: "global", id: "npm-registry", request: "let npm reach its registry", file: "global.json" }]);
  });
});

describe("capabilities config", () => {
  const globalPath = globalRailConfigPath();
  const projectPath = "/repo/.pi/rail.json";

  it("parses custom classes, defaulting name to the id and disposition to ask", () => {
    const config = mergeConfig(
      testConfig(),
      { capabilities: { classes: [{ id: "touches-customer-data", definition: "Customer records." }] } },
      globalPath,
    );
    assert.deepEqual(config.capabilities.classes, [
      { id: "touches-customer-data", name: "touches-customer-data", definition: "Customer records.", default: "ask" },
    ]);
    assert.deepEqual(config.provenance.classes["touches-customer-data"], { layer: "global", file: globalPath });
  });

  it("skips invalid class entries with a diagnostic and still loads the rest", () => {
    const config = mergeConfig(
      testConfig(),
      {
        capabilities: {
          classes: [
            { id: "Not Kebab", definition: "x" },
            { id: "read-project", definition: "shadowing a built-in" },
            { id: "no-definition" },
            { id: "bad-disposition", definition: "x", disposition: "maybe" },
            { id: "good-one", definition: "A real class." },
          ],
        },
      },
      globalPath,
    );
    assert.deepEqual(config.capabilities.classes.map((entry) => entry.id), ["good-one"]);
    const diagnostics = config.diagnostics.join("\n");
    assert.match(diagnostics, /classes\[0\]: id must be kebab-case/);
    assert.match(diagnostics, /classes\[1\]: "read-project" is a built-in class/);
    assert.match(diagnostics, /classes\[2\]: definition must be a non-empty string/);
    assert.match(diagnostics, /classes\[3\]: disposition must be/);
  });

  it("merges classes by id across layers, keeping position so the namer prefix does not shuffle", () => {
    const base = mergeConfig(
      testConfig(),
      {
        capabilities: {
          classes: [
            { id: "alpha", definition: "Global alpha." },
            { id: "beta", definition: "Global beta." },
          ],
        },
      },
      globalPath,
    );
    const merged = mergeConfig(base, { capabilities: { classes: [{ id: "alpha", definition: "Project alpha." }] } }, projectPath);
    assert.deepEqual(merged.capabilities.classes.map((entry) => entry.id), ["alpha", "beta"], "position is preserved");
    assert.equal(merged.capabilities.classes[0]!.definition, "Project alpha.", "project wins per id");
    assert.equal(merged.provenance.classes.alpha?.file, projectPath);
    assert.equal(merged.provenance.classes.beta?.file, globalPath, "untouched classes keep their source");
  });

  it("accepts built-in definition overrides and rejects unknown keys", () => {
    const config = mergeConfig(
      testConfig(),
      { capabilities: { definitions: { "read-project": "New wording.", "made-up": "nope" } } },
      globalPath,
    );
    assert.deepEqual(config.capabilities.definitions, { "read-project": "New wording." });
    assert.deepEqual(config.provenance.definitions["read-project"], { layer: "global", file: globalPath });
    assert.match(config.diagnostics.join("\n"), /definitions\.made-up: not a built-in capability class/);
  });

  it("lets a config set a disposition for a class it defines in the same file", () => {
    const config = mergeConfig(
      testConfig(),
      {
        capabilities: { classes: [{ id: "touches-customer-data", definition: "Customer records." }] },
        dispositions: { "touches-customer-data": "deny" },
      },
      globalPath,
    );
    assert.equal(config.dispositions["touches-customer-data"], "deny");
    assert.equal(getEffectiveDisposition(config, undefined, "touches-customer-data").disposition, "deny");
  });

  it("still rejects a disposition for a class nobody declared", () => {
    const config = mergeConfig(testConfig(), { dispositions: { "never-declared": "deny" } }, globalPath);
    assert.match(config.diagnostics.join("\n"), /dispositions\.never-declared: unknown capability class/);
  });
});

describe("commands.classify config", () => {
  const globalPath = globalRailConfigPath();
  const projectPath = "/repo/.pi/rail.json";
  const K8S_CLASS = { id: "k8s-ops", definition: "Cluster operations.", disposition: "ask" };

  it("parses template → capability entries against the built-in classes", () => {
    const config = mergeConfig(testConfig(), { commands: { classify: [{ template: "docker *", capability: "run-dev-tools" }] } }, globalPath);
    assert.deepEqual(config.commands.classify, [{ template: "docker *", capability: "run-dev-tools" }]);
    assert.equal(config.provenance.lists["commands.classify"]["docker *"]?.file, globalPath);
    assert.deepEqual(config.diagnostics, []);
  });

  it("accepts a custom class the same file declares", () => {
    const config = mergeConfig(
      testConfig(),
      { capabilities: { classes: [K8S_CLASS] }, commands: { classify: [{ template: "kubectl *", capability: "k8s-ops" }] } },
      globalPath,
    );
    assert.deepEqual(config.commands.classify, [{ template: "kubectl *", capability: "k8s-ops" }]);
    assert.deepEqual(config.diagnostics, []);
  });

  it("skips an entry naming an unknown class and keeps the rest of the list", () => {
    const config = mergeConfig(
      testConfig(),
      {
        commands: {
          classify: [
            { template: "kubectl *", capability: "k8s-ops" },
            { template: "docker *", capability: "run-dev-tools" },
          ],
        },
      },
      globalPath,
    );
    assert.deepEqual(config.commands.classify, [{ template: "docker *", capability: "run-dev-tools" }]);
    assert.match(config.diagnostics.join("\n"), /classify\[0\]: "k8s-ops" is not a known capability class — declare it \(capabilities\.classes or an add-class op\) first/);
  });

  it("skips malformed entries entry by entry, with the array index in the diagnostic", () => {
    const config = mergeConfig(
      testConfig(),
      {
        commands: {
          classify: [
            "kubectl *",
            { template: 7, capability: "read-project" },
            { template: "", capability: "read-project" },
            { template: "*", capability: "read-project" },
            { template: "kubectl * pods", capability: "read-project" },
            { template: "helm *", capability: "" },
            { template: "helm *", capability: "read-project", disposition: "ask" },
            { template: "docker *", capability: "run-dev-tools" },
          ] as never,
        },
      },
      globalPath,
    );
    assert.deepEqual(config.commands.classify, [{ template: "docker *", capability: "run-dev-tools" }]);
    const diagnostics = config.diagnostics.join("\n");
    assert.match(diagnostics, /classify\[0\]: expected an array of \{"template"/);
    assert.match(diagnostics, /classify\[1\]: template must be a string/);
    assert.match(diagnostics, /classify\[2\]: template must be a non-empty command template/);
    assert.match(diagnostics, /classify\[3\]: a template must name a command head before `\*`/);
    assert.match(diagnostics, /classify\[4\]: `\*` only means "any arguments" as the last word/);
    assert.match(diagnostics, /classify\[5\]: capability must be a non-empty string/);
    assert.match(diagnostics, /classify\[6\]: unexpected key disposition/);
  });

  it("takes a bare array or {add}, appending in entry order", () => {
    const base = mergeConfig(testConfig(), { commands: { classify: [{ template: "kubectl *", capability: "read-system" }] } }, globalPath);
    const extended = mergeConfig(base, { commands: { classify: { add: [{ template: "docker *", capability: "run-dev-tools" }] } } }, projectPath);
    const bare = mergeConfig(base, { commands: { classify: [{ template: "docker *", capability: "run-dev-tools" }] } }, projectPath);
    assert.deepEqual(extended.commands.classify, [
      { template: "kubectl *", capability: "read-system" },
      { template: "docker *", capability: "run-dev-tools" },
    ]);
    assert.deepEqual(bare.commands.classify, extended.commands.classify);
    assert.equal(extended.provenance.lists["commands.classify"]["kubectl *"]?.file, globalPath);
    assert.equal(extended.provenance.lists["commands.classify"]["docker *"]?.file, projectPath);
  });

  it("credits the introducing layer for a restatement but the re-mapping layer for a changed class", () => {
    const base = mergeConfig(
      testConfig(),
      { commands: { classify: [{ template: "kubectl *", capability: "read-system" }, { template: "docker *", capability: "run-dev-tools" }] } },
      globalPath,
    );
    const merged = mergeConfig(
      base,
      { commands: { classify: [{ template: "docker *", capability: "run-dev-tools" }, { template: "kubectl *", capability: "off-machine-effects" }] } },
      projectPath,
    );
    assert.deepEqual(merged.commands.classify, [
      { template: "kubectl *", capability: "off-machine-effects" },
      { template: "docker *", capability: "run-dev-tools" },
    ], "a re-mapped template keeps its position");
    assert.equal(merged.provenance.lists["commands.classify"]["docker *"]?.file, globalPath, "a pure restatement credits the layer that introduced it");
    assert.equal(merged.provenance.lists["commands.classify"]["kubectl *"]?.file, projectPath);
  });

  it("leaves the inherited list alone when the envelope itself is malformed or removed", () => {
    const base = mergeConfig(testConfig(), { commands: { classify: [{ template: "kubectl *", capability: "read-system" }] } }, globalPath);
    for (const value of [{ replace: false, values: [] }, { values: [] }, { add: {} }, "kubectl *", { add: [], merge: true }, { remove: ["kubectl *"] }]) {
      const merged = mergeConfig(base, { commands: { classify: value as never } }, projectPath);
      assert.deepEqual(merged.commands.classify, base.commands.classify, JSON.stringify(value));
      assert.deepEqual(merged.provenance.lists["commands.classify"], base.provenance.lists["commands.classify"]);
      assert.ok(merged.diagnostics.length > base.diagnostics.length, `expected a diagnostic for ${JSON.stringify(value)}`);
    }
  });

  it("defaults to an empty list with no provenance entries", () => {
    assert.deepEqual(DEFAULT_CONFIG.commands.classify, []);
    assert.deepEqual(DEFAULT_CONFIG.provenance.lists["commands.classify"], {});
  });
});

describe("loadConfig layering", () => {
  const writeJson = (dir: string, name: string, body: unknown) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), JSON.stringify(body), "utf8");
  };

  /** loadConfig against a throwaway agent dir and project dir; both layers start empty. */
  function withLayers(fn: (layers: { globalDir: string; projectDir: string; load: (trusted?: boolean) => ReturnType<typeof loadConfig> }) => void): void {
    withTempAgentDir((agentDir) => {
      const project = makeFixtureDir();
      try {
        fn({
          globalDir: path.join(agentDir, "extensions"),
          projectDir: path.join(project.dir, CONFIG_DIR_NAME),
          load: (trusted = true) => loadConfig({ cwd: project.dir, isProjectTrusted: () => trusted } as unknown as ExtensionContext),
        });
      } finally {
        project.cleanup();
      }
    });
  }

  it("loads a global rail.json with no diagnostics at all", () => {
    withLayers(({ globalDir, load }) => {
      writeJson(globalDir, "rail.json", { backend: "none" });
      const config = load();
      assert.equal(config.backend, "none");
      assert.deepEqual(config.diagnostics, []);
      assert.equal(globalRailConfigPath(), path.join(globalDir, "rail.json"));
    });
  });

  // guard.json loading and its advisory are gone: a stray one is simply not a config file.
  it("never reads a legacy guard.json, and says nothing about it", () => {
    withLayers(({ globalDir, projectDir, load }) => {
      writeJson(globalDir, "guard.json", { backend: "none", statusLine: "never" });
      writeJson(projectDir, "guard.json", { statusLine: "never" });
      const config = load();
      assert.equal(config.backend, "seatbelt");
      assert.equal(config.statusLine, "always");
      assert.deepEqual(config.sources, ["defaults"]);
      assert.deepEqual(config.diagnostics, []);
    });
  });

  it("ignores an untrusted project config with one diagnostic", () => {
    withLayers(({ projectDir, load }) => {
      writeJson(projectDir, "rail.json", { statusLine: "never" });
      const config = load(false);
      assert.equal(config.statusLine, "always");
      assert.match(config.diagnostics.join("\n"), /Ignoring untrusted project config/);
    });
  });

  // The list forms and grants have to survive the JSON round trip, not just
  // mergeConfig: defaults → global → project is the layering users actually get.
  it("folds base keys and grants through the real three-layer load, in order", () => {
    withLayers(({ globalDir, projectDir, load }) => {
      const globalPath = path.join(globalDir, "rail.json");
      const projectPath = path.join(projectDir, "rail.json");
      writeJson(globalDir, "rail.json", {
        capabilities: { classes: [{ id: "k8s-ops", definition: "Cluster operations.", disposition: "ask" }] },
        commands: { allow: ["cargo *"], classify: [{ template: "kubectl *", capability: "k8s-ops" }] },
        network: { allowedDomains: ["global.example"] },
        grants: [{ id: "k8s-deny", request: "never touch clusters", created: "2026-11-11", ops: [{ op: "set-disposition", capability: "k8s-ops", disposition: "deny" }] }],
      });
      writeJson(projectDir, "rail.json", {
        dispositions: { "k8s-ops": "judge" },
        commands: { allow: ["just *"], classify: { add: [{ template: "helm *", capability: "k8s-ops" }] } },
        network: { allowedDomains: { remove: ["global.example"], add: ["project.example"] } },
        grants: [{ id: "k8s-deny", request: "the project's own grant of the same id", created: "2026-11-11", ops: [{ op: "set-disposition", capability: "k8s-ops", disposition: "ask" }] }],
      });
      const config = load();
      assert.deepEqual(config.diagnostics, []);
      assert.deepEqual(config.commands.allow, [...DEFAULT_CONFIG.commands.allow, "cargo *", "just *"]);
      assert.deepEqual(config.commands.classify, [
        { template: "kubectl *", capability: "k8s-ops" },
        { template: "helm *", capability: "k8s-ops" },
      ], "a project layer can classify into a class the global layer declared");
      assert.deepEqual(config.network.allowedDomains, [...DEFAULT_CONFIG.network.allowedDomains, "project.example"]);
      // global base → global grants → project base → project grants: the
      // project's grant is last and wins, and a same-id grant in another
      // layer is a separate grant that provenance tells apart.
      assert.equal(config.dispositions["k8s-ops"], "ask");
      assert.deepEqual(config.provenance.dispositions["k8s-ops"], { layer: "project", grantId: "k8s-deny", file: projectPath });
      assert.deepEqual(config.grants.map((grant) => `${grant.layer}:${grant.id}`), ["global:k8s-deny", "project:k8s-deny"]);
      assert.deepEqual(config.sources, ["defaults", globalPath, projectPath]);
    });
  });
});
