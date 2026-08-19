// Read-only mode tests: deterministic write/edit blocks, bash fail-closed
// behavior when the classifier cannot review, the read-only disposition
// preset, and the /rail readonly toggle.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RailBackend } from "../src/backends/types.ts";
import { getEffectiveDisposition, READ_ONLY_PRESET_DENY } from "../src/capabilities.ts";
import type { CompleteFn } from "../src/classifier.ts";
import { createRailCommand } from "../src/commands/rail.ts";
import { interceptToolCall } from "../src/interceptor.ts";
import { createRuntimeState, syncCapabilityPreset } from "../src/state.ts";
import { makeFixtureDir, testConfig } from "./helpers.ts";

const fixture = makeFixtureDir();
after(() => fixture.cleanup());

/** Minimal fake ExtensionContext: deterministic interceptor paths plus optional classifier model/auth wiring. */
function fakeCtx(cwd: string, options?: { model?: { provider: string; id: string }; authError?: Error }) {
  const ctx = {
    cwd,
    hasUI: false,
    mode: "print",
    aborted: false,
    notifications: [] as string[],
    abort() {
      ctx.aborted = true;
    },
    ui: {
      notify(message: string) {
        ctx.notifications.push(message);
      },
    },
    modelRegistry: {
      getAvailable: () => [],
      find: () => options?.model,
      getApiKeyAndHeaders: async () => {
        if (options?.authError) throw options.authError;
        return { ok: true, apiKey: "test-key" };
      },
    },
    sessionManager: { getBranch: () => [] },
    signal: undefined,
  };
  return ctx as unknown as ExtensionContext & { aborted: boolean; notifications: string[] };
}

function readOnlyState(config: ReturnType<typeof testConfig>) {
  const state = createRuntimeState();
  state.config = config;
  state.enabled = true;
  state.initialized = true;
  state.readOnly = true;
  return state;
}

mkdirSync(path.join(fixture.dir, "project", "src"), { recursive: true });
writeFileSync(path.join(fixture.dir, "project", "src", "app.ts"), "ok");
const cwd = path.join(fixture.dir, "project");

describe("read-only mode interception", () => {
  it("blocks write deterministically", async () => {
    const state = readOnlyState(testConfig());
    const result = await interceptToolCall({ toolName: "write", input: { path: "src/app.ts", content: "x" } }, fakeCtx(cwd), state);
    assert.equal(result?.block, true);
    assert.match(result.reason, /read-only mode/);
    assert.equal(state.stats.blocked, 1);
  });

  it("blocks edit deterministically", async () => {
    const state = readOnlyState(testConfig());
    const result = await interceptToolCall({ toolName: "edit", input: { path: "src/app.ts", edits: [] } }, fakeCtx(cwd), state);
    assert.equal(result?.block, true);
    assert.match(result.reason, /read-only mode/);
  });

  it("leaves reads unaffected: exempt in-cwd reads still skip review", async () => {
    const state = readOnlyState(testConfig((c) => {
      c.classifier.enabled = true;
    }));
    const result = await interceptToolCall({ toolName: "read", input: { path: "src/app.ts" } }, fakeCtx(cwd), state);
    assert.equal(result, undefined);
    assert.equal(state.stats.classifierSkips, 1);
  });

  it("leaves reads unaffected with the classifier off", async () => {
    const state = readOnlyState(testConfig((c) => {
      c.classifier.enabled = false;
    }));
    const result = await interceptToolCall({ toolName: "read", input: { path: "src/app.ts" } }, fakeCtx(cwd), state);
    assert.equal(result, undefined);
    assert.equal(state.stats.blocked, 0);
  });

  it("blocks bash outright when the classifier is disabled", async () => {
    const state = readOnlyState(testConfig((c) => {
      c.classifier.enabled = false;
    }));
    const result = await interceptToolCall({ toolName: "bash", input: { command: "ls" } }, fakeCtx(cwd), state);
    assert.equal(result?.block, true);
    assert.match(result.reason, /read-only mode/);
    assert.match(result.reason, /classifier/);
    assert.equal(state.stats.blocked, 1);
  });

  it("still allows deterministically allowlisted commands with the classifier off while the sandbox enforces", async () => {
    const state = readOnlyState(testConfig((c) => {
      c.classifier.enabled = false;
    }));
    state.backend = { name: "seatbelt" } as RailBackend;
    const allowed = await interceptToolCall({ toolName: "bash", input: { command: "grep foo src" } }, fakeCtx(cwd), state);
    assert.equal(allowed, undefined);
    const blocked = await interceptToolCall({ toolName: "bash", input: { command: "curl example.com" } }, fakeCtx(cwd), state);
    assert.equal(blocked?.block, true);
    assert.match(blocked.reason, /read-only mode/);
  });

  it("sends bash to review when the classifier is on, failing closed when it is unavailable", async () => {
    const state = readOnlyState(testConfig((c) => {
      c.classifier.enabled = true;
    }));
    const ctx = fakeCtx(cwd);
    const result = await interceptToolCall({ toolName: "bash", input: { command: "ls" } }, ctx, state);
    assert.equal(result?.block, true);
    assert.match(result.reason, /classifier unavailable/i);
    assert.equal(ctx.aborted, true);
  });

  it("fails closed for bash review errors even when failClosed is off", async () => {
    const config = testConfig((c) => {
      c.classifier.enabled = true;
      c.classifier.model = "test/fake-model";
      c.classifier.failClosed = false;
    });
    const options = { model: { provider: "test", id: "fake-model" }, authError: new Error("boom") };

    // Without read-only mode this configuration fails open.
    const openState = readOnlyState(structuredClone(config));
    openState.readOnly = false;
    const openResult = await interceptToolCall({ toolName: "bash", input: { command: "ls" } }, fakeCtx(cwd, options), openState);
    assert.equal(openResult, undefined);

    const state = readOnlyState(config);
    const ctx = fakeCtx(cwd, options);
    const result = await interceptToolCall({ toolName: "bash", input: { command: "ls" } }, ctx, state);
    assert.equal(result?.block, true);
    assert.match(result.reason, /failed closed/);
    assert.equal(ctx.aborted, true);
  });
});

describe("read-only disposition preset", () => {
  function fakeComplete(script: string[]): CompleteFn {
    return (async () => {
      const step = script.shift();
      if (step === undefined) throw new Error("fake complete script exhausted");
      return {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: step }],
        usage: { input: 1, output: 1 },
        timestamp: Date.now(),
      } as unknown as Awaited<ReturnType<CompleteFn>>;
    }) as CompleteFn;
  }

  it("denies the writing classes and leaves reads alone", () => {
    const state = createRuntimeState();
    const config = testConfig();
    state.readOnly = true;
    syncCapabilityPreset(state);
    for (const id of READ_ONLY_PRESET_DENY) {
      assert.equal(getEffectiveDisposition(config, state.capabilities, id).disposition, "deny", `${id} must be denied in read-only mode`);
    }
    assert.equal(getEffectiveDisposition(config, state.capabilities, "read-project").disposition, "allow");
    assert.equal(getEffectiveDisposition(config, state.capabilities, "run-dev-tools").disposition, "allow");
    state.readOnly = false;
    syncCapabilityPreset(state);
    assert.equal(getEffectiveDisposition(config, state.capabilities, "modify-project").disposition, "allow");
  });

  it("blocks a named bash command that would write, without asking the user", async () => {
    const config = testConfig((c) => {
      c.classifier.enabled = true;
      c.classifier.model = "test/fake-model";
    });
    const state = readOnlyState(config);
    state.backend = { name: "seatbelt" } as RailBackend;
    const ctx = fakeCtx(cwd, { model: { provider: "test", id: "fake-model" } });
    const result = await interceptToolCall(
      { toolName: "bash", input: { command: "printf hi > out.txt" } },
      ctx,
      state,
      fakeComplete(['{"labels":["modify-project"]}']),
    );
    assert.equal(result?.block, true);
    assert.match(result.reason, /read-only preset/);
    assert.match(result.reason, /modify-project/);
  });

  // A classify rule is a labelling shortcut, not a permission: the labels it
  // produces go through the same severity-max the namer's do, so the read-only
  // preset still wins over anything mapped to a writing class.
  it("denies a classify-labelled write command under the preset, classifier or not", async () => {
    for (const classifier of [true, false]) {
      const config = testConfig((c) => {
        c.classifier.enabled = classifier;
        c.classifier.model = "test/fake-model";
        c.commands.classify = [{ template: "mytool deploy *", capability: "modify-project" }];
      });
      const state = readOnlyState(config);
      state.backend = { name: "seatbelt" } as RailBackend;
      const result = await interceptToolCall(
        { toolName: "bash", input: { command: "mytool deploy --all" } },
        fakeCtx(cwd, { model: { provider: "test", id: "fake-model" } }),
        state,
        fakeComplete([]),
      );
      assert.equal(result?.block, true, `classifier ${classifier}`);
      assert.match(result.reason, /read-only preset/);
      assert.match(result.reason, /modify-project/);
    }
  });

  // The preset lists built-in ids by construction, so it cannot reach a custom
  // class — the same is already true of a custom label the namer returns, and
  // of any template put in commands.allow. Pinned so the gap stays visible.
  it("does not reach a custom class set to allow, exactly as commands.allow does not", async () => {
    const custom = readOnlyState(testConfig((c) => {
      c.classifier.enabled = false;
      c.capabilities.classes = [{ id: "my-tool", name: "My tool", definition: "A local helper.", default: "allow" }];
      c.commands.classify = [{ template: "mytool write *", capability: "my-tool" }];
    }));
    custom.backend = { name: "seatbelt" } as RailBackend;
    assert.equal(await interceptToolCall({ toolName: "bash", input: { command: "mytool write x" } }, fakeCtx(cwd), custom), undefined);

    const allowlisted = readOnlyState(testConfig((c) => {
      c.classifier.enabled = false;
      c.commands.allow = [...c.commands.allow, "mytool write *"];
    }));
    allowlisted.backend = { name: "seatbelt" } as RailBackend;
    assert.equal(await interceptToolCall({ toolName: "bash", input: { command: "mytool write x" } }, fakeCtx(cwd), allowlisted), undefined);
  });

  it("lets a classify rule keep a read-only command usable with the classifier off", async () => {
    const config = testConfig((c) => {
      c.classifier.enabled = false;
      c.commands.classify = [{ template: "mytool status *", capability: "read-project" }];
    });
    const state = readOnlyState(config);
    state.backend = { name: "seatbelt" } as RailBackend;
    const result = await interceptToolCall({ toolName: "bash", input: { command: "mytool status --wide" } }, fakeCtx(cwd), state);
    assert.equal(result, undefined);
  });

  it("still allows a named read-only command under the preset", async () => {
    const config = testConfig((c) => {
      c.classifier.enabled = true;
      c.classifier.model = "test/fake-model";
    });
    const state = readOnlyState(config);
    state.backend = { name: "seatbelt" } as RailBackend;
    const ctx = fakeCtx(cwd, { model: { provider: "test", id: "fake-model" } });
    const result = await interceptToolCall(
      { toolName: "bash", input: { command: "rg --files-with-matches TODO" } },
      ctx,
      state,
      fakeComplete(['{"labels":["read-project"]}']),
    );
    assert.equal(result, undefined);
  });
});

describe("/rail readonly toggle", () => {
  function makeCommand() {
    const state = createRuntimeState();
    const posted: string[] = [];
    const command = createRailCommand({
      state,
      enableRail: async () => {},
      disableRail: async () => {},
      runRailSmoke: async () => {},
      runCritique: async () => {},
      postRailNotice: (content) => posted.push(content),
    });
    const ctx = {
      hasUI: true,
      isIdle: () => true,
      notifications: [] as string[],
      ui: {
        notify(message: string) {
          ctx.notifications.push(message);
        },
        setStatus() {},
        theme: { fg: (_name: string, text: string) => text },
      },
    };
    return { state, command, ctx: ctx as unknown as ExtensionContext & { notifications: string[] }, posted };
  }

  it("toggles read-only mode on and off, including the ro alias", async () => {
    const { state, command, ctx } = makeCommand();
    await command.handler("readonly", ctx);
    assert.equal(state.readOnly, true);
    assert.match(ctx.notifications[0] ?? "", /read-only mode on/);
    await command.handler("ro", ctx);
    assert.equal(state.readOnly, false);
    assert.match(ctx.notifications[1] ?? "", /read-only mode off/);
  });

  it("mirrors each read-only toggle into the agent's context via postRailNotice", async () => {
    const { state, command, ctx, posted } = makeCommand();
    await command.handler("readonly", ctx);
    await command.handler("readonly", ctx);
    assert.equal(state.readOnly, false);
    assert.equal(posted.length, 2);
    assert.match(posted[0]!, /read-only mode on/);
    assert.match(posted[1]!, /read-only mode off/);
  });
});
