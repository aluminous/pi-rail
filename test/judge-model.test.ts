// The judge model as a picked setting: how a spec resolves (session override
// over config over the "current" default), what `/rail model judge …` accepts,
// and that it stays a session value until `/rail model save` writes it. Every
// test that could write redirects the agent dir first — none of these may
// touch the developer's real rail.json.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { judgeModelSpec, resolveJudgeModel } from "../src/classifier.ts";
import { runModelCommand } from "../src/commands/model.ts";
import type { RailConfig } from "../src/config.ts";
import { getPersistentConfigPath } from "../src/persistent-settings.ts";
import { createRuntimeState, type RuntimeState } from "../src/state.ts";
import { testConfig, withTempAgentDirAsync } from "./helpers.ts";

const sessionModel = { provider: "anthropic", id: "claude-opus-4-5" };
const codexMini = { provider: "openai-codex", id: "gpt-5.4-mini" };
const strongAlternative = { provider: "openai", id: "gpt-5.4" };

const catalog = [codexMini, strongAlternative];

interface Fake {
  ctx: ExtensionContext;
  state: RuntimeState;
  notes: Array<{ message: string; level: string }>;
}

/** `options.noSessionModel` drops ctx.model, the "current" spec's only source. */
function fake(options?: { noSessionModel?: boolean }): Fake {
  const current = options?.noSessionModel ? undefined : sessionModel;
  const notes: Fake["notes"] = [];
  const state = createRuntimeState();
  state.config = testConfig();
  const ctx = {
    mode: "rpc",
    hasUI: true,
    model: current,
    modelRegistry: {
      refresh: () => {},
      getAvailable: () => catalog,
      find: (provider: string, id: string) => catalog.find((model) => model.provider === provider && model.id === id),
    },
    ui: {
      notify: (message: string, level: string) => void notes.push({ message, level }),
      setStatus: () => {},
      select: async () => undefined,
    },
  } as unknown as ExtensionContext;
  return { ctx, state, notes };
}

const lastNote = (fixture: Fake) => fixture.notes.at(-1)!.message;

function readPersisted(): RailConfig {
  return JSON.parse(readFileSync(getPersistentConfigPath(), "utf8")) as RailConfig;
}

describe("judge model resolution", () => {
  it("defaults to the session's own model", () => {
    const config = testConfig();
    assert.equal(config.classifier.judgeModel, "current");
    const { ctx } = fake();
    assert.deepEqual(resolveJudgeModel(ctx, config, {}), sessionModel);
  });

  it("takes the configured spec when there is no session override", () => {
    const { ctx } = fake();
    const config = testConfig((c) => void (c.classifier.judgeModel = "openai/gpt-5.4"));
    assert.equal(judgeModelSpec(config, {}), "openai/gpt-5.4");
    assert.deepEqual(resolveJudgeModel(ctx, config, {}), strongAlternative);
  });

  it("lets the session override win over config", () => {
    const { ctx } = fake();
    const config = testConfig((c) => void (c.classifier.judgeModel = "openai/gpt-5.4"));
    const state = { judgeModelOverride: "current" };
    assert.equal(judgeModelSpec(config, state), "current");
    assert.deepEqual(resolveJudgeModel(ctx, config, state), sessionModel);
  });

  it("is independent of the namer override", () => {
    const { ctx } = fake();
    const config = testConfig();
    const state = { modelOverride: "openai/gpt-5.4", judgeModelOverride: "openai-codex/gpt-5.4-mini" };
    assert.deepEqual(resolveJudgeModel(ctx, config, state), codexMini);
  });

  it("resolves to nothing when the spec names an absent model", () => {
    const { ctx } = fake();
    assert.equal(resolveJudgeModel(ctx, testConfig(), { judgeModelOverride: "openrouter/nope" }), undefined);
  });

  it("resolves to nothing when 'current' has no session model", () => {
    const { ctx } = fake({ noSessionModel: true });
    assert.equal(resolveJudgeModel(ctx, testConfig(), {}), undefined);
  });
});

describe("/rail model judge", () => {
  it("reports the resolved judge model when bare, and for `status`", async () => {
    const fixture = fake();
    await runModelCommand("judge", fixture.ctx, fixture.state);
    assert.match(lastNote(fixture), /^judge: current → anthropic\/claude-opus-4-5$/m);
    assert.equal(fixture.state.classifier.judgeModelOverride, undefined, "querying changes nothing");

    await runModelCommand("judge status", fixture.ctx, fixture.state);
    assert.match(lastNote(fixture), /^judge: current → anthropic\/claude-opus-4-5$/m);
  });

  it("sets an explicit model at session scope, writing nothing until save", async () => {
    await withTempAgentDirAsync(async () => {
      const fixture = fake();
      await runModelCommand("judge openai/gpt-5.4", fixture.ctx, fixture.state);

      assert.equal(fixture.state.classifier.judgeModelOverride, "openai/gpt-5.4");
      assert.match(lastNote(fixture), /Rail judge: openai\/gpt-5\.4 — for this session; \/rail model save persists it\./);
      assert.equal(existsSync(getPersistentConfigPath()), false, "nothing is written by the set itself");
      assert.deepEqual(resolveJudgeModel(fixture.ctx, fixture.state.config!, fixture.state.classifier), strongAlternative);

      await runModelCommand("save", fixture.ctx, fixture.state);
      assert.equal(readPersisted().classifier?.judgeModel, "openai/gpt-5.4");
      assert.equal(readPersisted().classifier?.model, undefined, "the namer's key is untouched");
      assert.match(lastNote(fixture), /judge: current → openai\/gpt-5\.4/);
    });
  });

  it("saves `current` as the spec, not the resolved model", async () => {
    await withTempAgentDirAsync(async () => {
      const fixture = fake();
      fixture.state.config = testConfig((c) => void (c.classifier.judgeModel = "openai/gpt-5.4"));
      await runModelCommand("judge current", fixture.ctx, fixture.state);

      assert.equal(fixture.state.classifier.judgeModelOverride, "current");
      assert.match(lastNote(fixture), /Rail judge: current → anthropic\/claude-opus-4-5 — for this session/);
      await runModelCommand("save", fixture.ctx, fixture.state);
      assert.equal(readPersisted().classifier?.judgeModel, "current");
    });
  });

  it("refuses `off`: a judge disposition with no judge must keep failing loudly", async () => {
    const fixture = fake();
    await runModelCommand("judge off", fixture.ctx, fixture.state);
    assert.equal(fixture.notes.at(-1)!.level, "error");
    assert.match(lastNote(fixture), /judge cannot be turned off/);
    assert.equal(fixture.state.classifier.judgeModelOverride, undefined);
    assert.equal(fixture.state.classifier.enabledOverride, undefined, "and it does not disable the classifier either");
  });

  it("refuses `auto`, which would point escalation review at the cheap namer list", async () => {
    const fixture = fake();
    await runModelCommand("judge auto", fixture.ctx, fixture.state);
    assert.equal(fixture.notes.at(-1)!.level, "error");
    assert.match(lastNote(fixture), /namer's known-good cheap-model list/);
    assert.equal(fixture.state.classifier.judgeModelOverride, undefined);
  });

  it("rejects an unknown model and a bare word, leaving the setting alone", async () => {
    const fixture = fake();
    await runModelCommand("judge openrouter/nope", fixture.ctx, fixture.state);
    assert.match(lastNote(fixture), /^Model not found: openrouter\/nope$/);
    await runModelCommand("judge gpt-5.4", fixture.ctx, fixture.state);
    assert.match(lastNote(fixture), /^Model not found: gpt-5\.4$/);
    assert.equal(fixture.state.classifier.judgeModelOverride, undefined);
  });

  it("reports no session model rather than saving `current` blind", async () => {
    const fixture = fake({ noSessionModel: true });
    await runModelCommand("judge current", fixture.ctx, fixture.state);
    assert.match(lastNote(fixture), /^No current Pi model is selected\.$/);
    assert.equal(fixture.state.classifier.judgeModelOverride, undefined);
  });
});

describe("/rail model keeps meaning the namer", () => {
  it("routes a spec to the namer and leaves the judge alone", async () => {
    await withTempAgentDirAsync(async () => {
      const fixture = fake();
      await runModelCommand("openai-codex/gpt-5.4-mini", fixture.ctx, fixture.state);

      assert.equal(fixture.state.classifier.modelOverride, "openai-codex/gpt-5.4-mini");
      assert.equal(fixture.state.classifier.enabledOverride, true, "picking a namer model turns review on");
      assert.equal(fixture.state.classifier.judgeModelOverride, undefined);
      await runModelCommand("save", fixture.ctx, fixture.state);
      assert.equal(readPersisted().classifier?.model, "openai-codex/gpt-5.4-mini");
      assert.equal(readPersisted().classifier?.judgeModel, undefined);
    });
  });

  it("saves every seat set in turn in one save, and the configurator has its own keyword", async () => {
    await withTempAgentDirAsync(async () => {
      const fixture = fake();
      await runModelCommand("auto", fixture.ctx, fixture.state);
      await runModelCommand("judge openai/gpt-5.4", fixture.ctx, fixture.state);
      await runModelCommand("configurator current", fixture.ctx, fixture.state);
      assert.equal(fixture.state.classifier.grantModelOverride, "current");
      await runModelCommand("configurator off", fixture.ctx, fixture.state);
      assert.match(lastNote(fixture), /nothing to turn off/);
      assert.equal(existsSync(getPersistentConfigPath()), false);

      await runModelCommand("save", fixture.ctx, fixture.state);
      const persisted = readPersisted().classifier;
      assert.equal(persisted?.model, "auto");
      assert.equal(persisted?.judgeModel, "openai/gpt-5.4");
      assert.equal(persisted?.grantModel, "current");
      assert.equal(persisted?.enabled, true);
    });
  });

  it("shows every seat in the status report, marking unsaved session values", async () => {
    const fixture = fake();
    fixture.state.classifier.judgeModelOverride = "openai/gpt-5.4";
    await runModelCommand("status", fixture.ctx, fixture.state);

    const report = lastNote(fixture);
    assert.match(report, /^namer: off$/m, "the default config has review off");
    assert.match(report, /^judge: openai\/gpt-5\.4 \(this session, unsaved; saved: current\)$/m);
    assert.match(report, /^configurator: auto → anthropic\/claude-opus-4-5$/m, "no listed configurator model has auth: auto falls back to current");
  });
});
