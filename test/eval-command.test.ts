// /rail eval, /rail eval history, /rail eval cancel: refusals before anything
// is spent, the headless run-to-completion, the non-blocking TUI run with its
// progress panel, cancel, the history file, accounting under the "eval" role —
// and that a run leaves every other piece of session state exactly as it was.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompleteFn } from "../src/classifier.ts";
import { createEvalCommands } from "../src/commands/eval.ts";
import { createRailCommand } from "../src/commands/rail.ts";
import { loadConfig } from "../src/config.ts";
import { quickCases, suiteId } from "../src/rail-eval.ts";
import { readEvalHistory } from "../src/rail-eval-history.ts";
import { createRuntimeState, modelUsageRows, type RuntimeState } from "../src/state.ts";
import { fakeModel, scriptedReviewer, type FakeAnswer } from "./eval-fakes.ts";
import { withTempAgentDirAsync } from "./helpers.ts";

const NAMER = fakeModel("test", "namer");
const JUDGE = fakeModel("test", "judge");
const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
const keybindings = { matches: () => false };
const settled = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

interface Harness {
  ctx: ExtensionContext;
  notes: string[];
  components: Array<{ render(width: number): string[]; dispose?(): void }>;
  widgets: Map<string, string[] | undefined>;
}

const opened: Harness[] = [];
after(() => {
  for (const harness of opened) for (const component of harness.components) component.dispose?.();
});

function makeCtx(cwd: string, mode: "tui" | "rpc" | "print", models: Model<Api>[] = [NAMER, JUDGE]): Harness {
  const notes: string[] = [];
  const components: Harness["components"] = [];
  const widgets = new Map<string, string[] | undefined>();
  const ctx = {
    cwd,
    mode,
    hasUI: mode !== "print",
    isProjectTrusted: () => false,
    ui: {
      notify: (message: string) => notes.push(message),
      setStatus() {},
      setWidget: (key: string, lines: string[] | undefined) => widgets.set(key, lines),
      theme: plainTheme,
      custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Harness["components"][number]) =>
        new Promise<unknown>((resolve) => {
          components.push(factory({ terminal: { rows: 80 }, requestRender() {} }, plainTheme, keybindings, resolve));
        }),
    },
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    sessionManager: { getBranch: () => [] },
    signal: undefined,
  };
  const harness: Harness = { ctx: ctx as unknown as ExtensionContext, notes, components, widgets };
  opened.push(harness);
  return harness;
}

function seatedState(ctx: ExtensionContext): RuntimeState {
  const state = createRuntimeState();
  state.config = loadConfig(ctx);
  // Unsaved picker choices: the session values are what the eval must use.
  state.classifier = { enabledOverride: true, modelOverride: "test/namer", judgeModelOverride: "test/judge" };
  return state;
}

/** A reviewer whose calls wait for `release()`, so a test can look at the run in flight. */
function gated(answers: Record<string, FakeAnswer> = {}) {
  const reviewer = scriptedReviewer(quickCases(), answers);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const complete = (async (...args: Parameters<CompleteFn>) => {
    await gate;
    return reviewer.complete(...args);
  }) as unknown as CompleteFn;
  return { complete, release, calls: reviewer.calls };
}

async function captureLog(run: () => Promise<void>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

function snapshot(state: RuntimeState): string {
  const { modelUsage: _usage, ...stats } = state.stats;
  return JSON.stringify({
    stats,
    decisions: state.decisions,
    traces: state.traces,
    classifier: state.classifier,
    capabilities: state.capabilities,
    sessionPolicy: state.sessionPolicy,
    grantDecisions: state.grantDecisions,
    approvals: state.approvals,
    lastError: state.lastError,
  });
}

describe("/rail eval", () => {
  it("refuses with the classifier off, before any model call", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const harness = makeCtx(agentDir, "print");
      const state = seatedState(harness.ctx);
      state.classifier.enabledOverride = false;
      const reviewer = scriptedReviewer(quickCases());
      const evals = createEvalCommands({ state, notify: (ctx, message) => ctx.ui.notify(message, "info"), complete: reviewer.complete, historyPath: () => path.join(agentDir, "rail-evals.jsonl") });
      await evals.runEval("", harness.ctx);
      assert.match(harness.notes.join("\n"), /needs the namer on/);
      assert.equal(reviewer.calls.length, 0);
      assert.equal(state.evalRun, undefined);
      assert.equal(existsSync(path.join(agentDir, "rail-evals.jsonl")), false);
    });
  });

  it("refuses when a seat's model does not resolve", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const harness = makeCtx(agentDir, "print", [NAMER]);
      const state = seatedState(harness.ctx);
      const reviewer = scriptedReviewer(quickCases());
      const evals = createEvalCommands({ state, notify: (ctx, message) => ctx.ui.notify(message, "info"), complete: reviewer.complete, historyPath: () => path.join(agentDir, "h.jsonl") });
      await evals.runEval("", harness.ctx);
      assert.match(harness.notes.join("\n"), /cannot resolve the judge \("test\/judge"\)/);
      state.classifier.modelOverride = "test/missing";
      await evals.runEval("", harness.ctx);
      assert.match(harness.notes.join("\n"), /cannot resolve the namer \("test\/missing"\)/);
      assert.equal(reviewer.calls.length, 0);
    });
  });

  it("headless: states the spend, runs to completion, prints the report, and keeps the run", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const harness = makeCtx(agentDir, "print");
      const state = seatedState(harness.ctx);
      const appended: unknown[] = [];
      state.appendEntry = (type, data) => appended.push({ type, data });
      const corpus: unknown[] = [];
      state.corpus = { dir: path.join(agentDir, "corpus"), append: (record) => corpus.push(record) };
      const before = snapshot(state);
      const reviewer = scriptedReviewer(quickCases());
      const file = path.join(agentDir, "rail-evals.jsonl");
      const evals = createEvalCommands({ state, notify: (ctx, message) => ctx.ui.notify(message, "info"), complete: reviewer.complete, historyPath: () => file });
      const out = await captureLog(() => evals.runEval("", harness.ctx));
      assert.match(harness.notes[0]!, /^Rail eval: 8 cases, about \d+ model calls on your accounts \(namer test\/namer, judge test\/judge\)\.$/);
      assert.match(out, new RegExp(`^# Rail eval · quick suite ${suiteId(quickCases())} · 8 cases · default policy`, "m"));
      assert.match(out, /^8\/8 correct · 0 critical misses · 0 deterministic/m);
      assert.match(out, /^## Past runs \(same suite\)$/m);
      assert.match(out, new RegExp(`History: ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      // Two seats, two models.
      assert.ok(reviewer.calls.some((call) => call.seat === "namer" && call.model === "test/namer"));
      assert.ok(reviewer.calls.some((call) => call.seat === "judge" && call.model === "test/judge"));

      const history = readEvalHistory(file);
      assert.equal(history.length, 1);
      assert.equal(history[0]!.namer, "test/namer");
      assert.equal(history[0]!.judge, "test/judge");
      assert.equal(history[0]!.passed, 8);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.doesNotMatch(readFileSync(file, "utf8"), /curl|reviewer instruction|npm test/i, "no commands, prompts, or output in the history");

      // The cost tab sees the calls under their own role; nothing else moved.
      assert.deepEqual(modelUsageRows(state.stats).map((row) => row.role), ["eval", "eval"]);
      assert.equal(modelUsageRows(state.stats).reduce((sum, row) => sum + row.calls, 0), reviewer.calls.length);
      assert.equal(snapshot(state), before);
      assert.deepEqual(appended, [], "no session telemetry");
      assert.deepEqual(corpus, [], "no replay corpus record");
      assert.equal(state.evalRun, undefined);
    });
  });

  it("TUI: returns at once, shows progress in the panel, then the report", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const harness = makeCtx(agentDir, "tui");
      const state = seatedState(harness.ctx);
      const model = gated();
      const evals = createEvalCommands({ state, notify: (ctx, message) => ctx.ui.notify(message, "info"), complete: model.complete, historyPath: () => path.join(agentDir, "h.jsonl") });
      await evals.runEval("", harness.ctx);
      await settled();
      assert.ok(state.evalRun, "the run is in flight after the command returned");
      const panel = harness.components.at(-1)!;
      const progress = panel.render(120).join("\n");
      assert.match(progress, /case 2\/8 · 0 done/);
      assert.match(progress, /\/rail eval cancel stops the run/);
      // A second run is refused while this one is going.
      await evals.runEval("", harness.ctx);
      assert.match(harness.notes.at(-1)!, /already running/);
      model.release();
      await evals.evalSettled();
      const report = panel.render(120).join("\n");
      assert.match(report, /8\/8 correct · 0 critical misses/);
      assert.match(harness.notes.at(-1)!, /^Rail eval: 8\/8 correct · 0 critical misses\.$/);
      assert.equal(state.evalRun, undefined);
    });
  });

  it("cancel stops the run; the finished part is shown and recorded as incomplete", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const harness = makeCtx(agentDir, "rpc");
      const state = seatedState(harness.ctx);
      const reviewer = scriptedReviewer(quickCases(), { "run-tests": { hang: "namer" }, "git-status": { hang: "namer" } });
      const file = path.join(agentDir, "h.jsonl");
      const evals = createEvalCommands({ state, notify: (ctx, message) => ctx.ui.notify(message, "info"), complete: reviewer.complete, historyPath: () => file });
      await evals.runEval("", harness.ctx);
      await settled();
      assert.ok(harness.widgets.get("rail-report")?.some((line) => line.startsWith("case ")), "progress rides the widget over RPC");
      await evals.runEval("cancel", harness.ctx);
      assert.match(harness.notes.at(-1)!, /Stopping the rail eval/);
      await evals.evalSettled();
      const history = readEvalHistory(file);
      assert.equal(history.length, 1);
      assert.equal(history[0]!.incomplete, true);
      assert.ok(harness.widgets.get("rail-report")?.some((line) => /incomplete: 8 of 8 cases did not run/.test(line)));
      await evals.runEval("cancel", harness.ctx);
      assert.match(harness.notes.at(-1)!, /No rail eval in flight/);
    });
  });

  it("history prints the table without running anything, through /rail eval history", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const harness = makeCtx(agentDir, "print");
      const state = seatedState(harness.ctx);
      const reviewer = scriptedReviewer(quickCases());
      const file = path.join(agentDir, "h.jsonl");
      const rail = createRailCommand({
        state,
        enableRail: async () => {},
        disableRail: async () => {},
        runRailSmoke: async () => {},
        runCritique: async () => {},
        evalDeps: { complete: reviewer.complete, historyPath: () => file },
      });
      const empty = await captureLog(() => rail.handler("eval history", harness.ctx));
      assert.match(empty, /^# Rail eval history · quick suite [0-9a-f]{6}$/m);
      assert.match(empty, /No runs of this suite yet/);
      await captureLog(() => rail.handler("eval", harness.ctx));
      const calls = reviewer.calls.length;
      const shown = await captureLog(() => rail.handler("eval history", harness.ctx));
      assert.match(shown, /^1m ago +namer +judge +8\/8 /m, "only the report's own run reads now");
      assert.equal(reviewer.calls.length, calls, "history calls no model");
      assert.ok(rail.getArgumentCompletions("ev")?.some((item) => item.value === "eval history"));
    });
  });
});
