// The configurator's entry points: `/rail grant <text>` (headless refusal, the
// docked progress panel, a proposal reaching the phase-3 confirmation with
// the rationale on top, a decline, cancel, usage under the "configurator"
// role) and "Allow, and generalise…" (the TUI dialog row, the RPC select
// option, a plain approval for the interceptor and replay, the seeded run,
// the mailbox seed) — plus a structural check that nothing the session model
// can reach starts the agent.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { Api, AssistantMessage, Context, Model, ToolCall } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { forwardAskToParent, startApprovalMailbox } from "../src/approval-mailbox.ts";
import { askRailApproval, type AskOptions, type RailAsk } from "../src/approvals.ts";
import { interceptToolCall } from "../src/interceptor.ts";
import type { CompleteFn } from "../src/classifier.ts";
import { createGrantCommands } from "../src/commands/grant.ts";
import { loadConfig } from "../src/config.ts";
import type { Grant } from "../src/policy-store.ts";
import { createRuntimeState, modelUsageRows } from "../src/state.ts";
import { RailApprovalDialog, type RailApprovalAnswer } from "../src/tui/approval-dialog.ts";
import { GrantConfirmPage } from "../src/tui/grant-page.ts";
import { withTempAgentDirAsync } from "./helpers.ts";

const WORKTREE: Grant = JSON.parse(readFileSync(new URL("../examples/grants/worktree-cleanup.json", import.meta.url), "utf8"));
const CANDIDATE = { id: WORKTREE.id, ops: WORKTREE.ops, examples: WORKTREE.examples };
const MODEL = { provider: "test", id: "fake", api: "anthropic-messages", name: "fake" } as unknown as Model<Api>;
const ENTER = "\r";
const keybindings = {
  matches: (data: string, id: string) =>
    (id === "tui.select.up" && data === "<up>") ||
    (id === "tui.select.down" && data === "<down>") ||
    (id === "tui.select.confirm" && (data === ENTER || data === "<enter>")) ||
    (id === "tui.select.cancel" && data === "<esc>"),
};
const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
const settled = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

// `args` stays loose: fixtures stand in for whatever a provider sends,
// malformed included. ToolCall["arguments"] is Record<string, any> in pi-ai
// 0.84 and JsonObject later; the assertion below is valid against both.
type Call = { name: string; args: Record<string, unknown> };
function assistant(calls: Call[]): AssistantMessage {
  return {
    role: "assistant",
    content: calls.map((call, index) => ({ type: "toolCall" as const, id: `c${index}-${Math.random()}`, name: call.name, arguments: call.args as ToolCall["arguments"] })),
    api: "anthropic-messages",
    provider: "test",
    model: "fake",
    usage: { input: 900, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 940, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function scripted(steps: Array<Call[] | ((context: Context, signal?: AbortSignal) => Promise<AssistantMessage>)>) {
  const contexts: Context[] = [];
  let index = 0;
  const complete = (async (_model: Model<Api>, context: Context, options?: { signal?: AbortSignal }) => {
    contexts.push(structuredClone({ systemPrompt: context.systemPrompt, messages: context.messages }) as Context);
    const step = steps[Math.min(index++, steps.length - 1)]!;
    return typeof step === "function" ? step(context, options?.signal) : assistant(step);
  }) as unknown as CompleteFn;
  return { complete, contexts };
}

interface Harness {
  ctx: ExtensionContext;
  notes: string[];
  components: unknown[];
  widgets: Map<string, string[] | undefined>;
  selects: Array<{ title: string; labels: string[] }>;
  editors: Array<{ title: string; prefill?: string }>;
  dispose(): void;
}

const opened: Harness[] = [];
// Report panels tick on an interval until disposed; a failing test must not leave one running.
after(() => {
  for (const harness of opened) harness.dispose();
});

function makeCtx(cwd: string, mode: "tui" | "rpc" | "print", options: { answers?: string[]; editor?: (prefill?: string) => string | undefined } = {}): Harness {
  const notes: string[] = [];
  const components: unknown[] = [];
  const widgets = new Map<string, string[] | undefined>();
  const selects: Harness["selects"] = [];
  const editors: Harness["editors"] = [];
  const answers = [...(options.answers ?? [])];
  const ctx = {
    cwd,
    mode,
    hasUI: mode !== "print",
    isProjectTrusted: () => false,
    abort() {},
    ui: {
      notify: (message: string) => notes.push(message),
      setStatus() {},
      setWidget: (key: string, lines: string[] | undefined) => widgets.set(key, lines),
      theme: plainTheme,
      select: async (title: string, labels: string[]) => {
        selects.push({ title, labels });
        const want = answers.shift();
        return want === undefined ? undefined : labels.find((label) => label === want || label.includes(want));
      },
      confirm: async () => true,
      editor: async (title: string, prefill?: string) => {
        editors.push({ title, prefill });
        return options.editor ? options.editor(prefill) : prefill;
      },
      custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => unknown) =>
        new Promise<unknown>((resolve) => {
          components.push(factory({ terminal: { rows: 80 }, requestRender() {} }, plainTheme, keybindings, resolve));
        }),
    },
    modelRegistry: {
      getAvailable: () => [],
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    sessionManager: { getBranch: () => [] },
    signal: undefined,
  };
  const harness: Harness = {
    ctx: ctx as unknown as ExtensionContext,
    notes,
    components,
    widgets,
    selects,
    editors,
    dispose: () => {
      for (const component of components) (component as { dispose?: () => void }).dispose?.();
    },
  };
  opened.push(harness);
  return harness;
}

function setup(ctx: ExtensionContext, complete: CompleteFn) {
  const state = createRuntimeState();
  state.config = loadConfig(ctx);
  state.config.classifier.enabled = true;
  const commands = createGrantCommands({
    state,
    notify: (target, message) => target.ui.notify(message, "info"),
    loadBase: (target) => {
      const config = loadConfig(target);
      config.classifier.enabled = true;
      return config;
    },
    readCorpus: () => [],
    today: () => "2026-11-12",
    complete,
    resolveModel: () => MODEL,
  });
  state.startGeneralise = (target, seed) => commands.generalise(target, seed);
  return { state, commands };
}

async function inProject(fn: (cwd: string) => Promise<void>): Promise<void> {
  await withTempAgentDirAsync(async (agentDir) => {
    const cwd = path.join(agentDir, "project");
    mkdirSync(cwd, { recursive: true });
    await fn(cwd);
  });
}

const PROPOSE: Call[][] = [
  [{ name: "dry_run", args: { tool: "bash", input: { command: "git worktree remove ../x" } } }],
  [{ name: "propose", args: { grant: { ...CANDIDATE, request: "allow everything" }, rationale: "Rung 3: no built-in class is just unforced worktree removal." } }],
];

describe("/rail grant <text>", () => {
  it("refuses in a headless session before calling any model", async () => {
    await inProject(async (cwd) => {
      const harness = makeCtx(cwd, "print");
      const model = scripted(PROPOSE);
      const { commands } = setup(harness.ctx, model.complete);
      await commands.runGrant("i want to allow cleaning up worktrees", harness.ctx);
      await commands.agentSettled();
      assert.equal(model.contexts.length, 0);
      assert.match(harness.notes.join("\n"), /needs an interactive session/);
    });
  });

  it("shows progress, then the phase-3 confirmation with the rationale on top; Enter applies the verbatim request", async () => {
    await inProject(async (cwd) => {
      const harness = makeCtx(cwd, "tui");
      const model = scripted(PROPOSE);
      const { state, commands } = setup(harness.ctx, model.complete);
      await commands.runGrant("i want to allow cleaning up worktrees", harness.ctx);
      // The command returns before the run ends; the panel is the progress view.
      await commands.agentSettled();
      const page = harness.components.at(-1) as GrantConfirmPage;
      assert.ok(page instanceof GrantConfirmPage);
      const text = page.render(140).join("\n");
      assert.match(text, /Proposed by the configurator \(test\/fake, rung 3, 2 turns\)/);
      assert.match(text, /Rung 3: no built-in class is just unforced worktree removal/);
      assert.match(text, /Request: i want to allow cleaning up worktrees/);
      page.handleInput(ENTER);
      await settled();
      assert.deepEqual(state.sessionPolicy.grants.map((grant) => [grant.id, grant.request, grant.created]), [["worktree-cleanup", "i want to allow cleaning up worktrees", "2026-11-12"]]);
      const usage = modelUsageRows(state.stats);
      assert.deepEqual(usage.map((row) => [row.role, row.model, row.calls]), [["configurator", "test/fake", 2]]);
      assert.equal(state.grantAgentRun, undefined);
      harness.dispose();
    });
  });

  it("degrades to the select confirmation over RPC, with the rationale in the title", async () => {
    await inProject(async (cwd) => {
      const harness = makeCtx(cwd, "rpc", { answers: ["Discard"] });
      const model = scripted(PROPOSE);
      const { state, commands } = setup(harness.ctx, model.complete);
      await commands.runGrant("i want to allow cleaning up worktrees", harness.ctx);
      await commands.agentSettled();
      assert.ok(harness.widgets.has("rail-report"), "progress rides a widget over RPC");
      const confirm = harness.selects.at(-1)!;
      assert.match(confirm.title, /Proposed by the configurator/);
      assert.ok(confirm.labels.includes("Apply for this session"));
      assert.deepEqual(state.sessionPolicy.grants, []);
    });
  });

  it("shows a decline and applies nothing", async () => {
    await inProject(async (cwd) => {
      const harness = makeCtx(cwd, "tui");
      const model = scripted([[{ name: "decline", args: { kind: "guidance", reason: "This depends on the conversation.", alternative: "/rail guide be relaxed about npm scripts I ask for" } }]]);
      const { state, commands } = setup(harness.ctx, model.complete);
      await commands.runGrant("be relaxed about npm scripts I ask for", harness.ctx);
      await commands.agentSettled();
      const panel = harness.components.at(-1) as { render(width: number): string[] };
      const text = panel.render(140).join("\n");
      assert.match(text, /Rail configurator declined \(guidance\)/);
      assert.match(text, /Instead: \/rail guide be relaxed/);
      assert.match(text, /Nothing was applied/);
      assert.deepEqual(state.sessionPolicy.grants, []);
      harness.dispose();
    });
  });

  it("runs one at a time, and /rail grant cancel stops the run", async () => {
    await inProject(async (cwd) => {
      const harness = makeCtx(cwd, "tui");
      const hang = (_context: Context, signal?: AbortSignal) =>
        new Promise<AssistantMessage>((resolve) => signal?.addEventListener("abort", () => resolve({ ...assistant([]), stopReason: "aborted" }), { once: true }));
      const model = scripted([hang]);
      const { state, commands } = setup(harness.ctx, model.complete);
      await commands.runGrant("allow cleaning up worktrees", harness.ctx);
      await settled();
      assert.ok(state.grantAgentRun);
      await commands.runGrant("something else", harness.ctx);
      assert.match(harness.notes.join("\n"), /already working on/);
      await commands.runGrant("cancel", harness.ctx);
      await commands.agentSettled();
      assert.equal(state.grantAgentRun, undefined);
      assert.match(harness.notes.join("\n"), /stopped \(aborted\); nothing applied/);
      harness.dispose();
    });
  });
});

describe("Allow, and generalise…", () => {
  function dialog(offerGeneralise: boolean) {
    const answers: RailApprovalAnswer[] = [];
    const component = new RailApprovalDialog({ title: "t", message: "m", theme: plainTheme, keybindings, done: (answer) => answers.push(answer), offerGeneralise });
    return { component, answers };
  }

  it("is a third row in the TUI dialog, between Allow and Deny, never the default", () => {
    const offered = dialog(true);
    assert.deepEqual(offered.component.render(80).filter((line) => /Allow|Deny/.test(line)).map((line) => line.replace(/\x1B\[[0-9;]*m|\x1B_[^\x07]*\x07/g, "").replace(/^(→ |  )/, "").trim()), ["Allow", "Allow, and generalise…", "Deny"]);
    offered.component.handleInput("<down>");
    offered.component.handleInput("<enter>");
    assert.deepEqual(offered.answers, [{ approved: true, generalise: true }]);

    const plain = dialog(false);
    assert.equal(plain.component.render(80).some((line) => line.includes("generalise")), false);
    const enter = dialog(true);
    enter.component.handleInput("<enter>");
    assert.deepEqual(enter.answers, [{ approved: true }], "Enter on the default row is a plain Allow");
  });

  it("over RPC is the fifth option, offered only with a seed and the configurator wired", async () => {
    const state = createRuntimeState();
    const harness = makeCtx("/tmp", "rpc", { answers: ["Allow, and generalise…"] });
    const started: unknown[] = [];
    state.startGeneralise = (_ctx, seed) => void started.push(seed);
    const seed = { tool: "bash", input: { command: "npm run build" } };
    const outcome = await askRailApproval(harness.ctx, state, "Rail asks", "npm run build", { generaliseSeed: seed });
    assert.deepEqual(harness.selects[0]!.labels, ["Allow", "Allow with comment", "Allow, and generalise…", "Deny", "Deny with comment"]);
    assert.deepEqual(outcome, { kind: "answered", answer: { approved: true, generalise: true }, forwarded: false });
    assert.deepEqual(started, [], "not started inside the ask: the tool call goes first");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(started, [seed]);

    const unwired = createRuntimeState();
    const second = makeCtx("/tmp", "rpc", { answers: ["Allow"] });
    await askRailApproval(second.ctx, unwired, "Rail asks", "x", { generaliseSeed: seed });
    assert.equal(second.selects[0]!.labels.length, 4);
    const noSeed = makeCtx("/tmp", "rpc", { answers: ["Allow"] });
    await askRailApproval(noSeed.ctx, state, "Rail asks", "x");
    assert.equal(noSeed.selects[0]!.labels.length, 4);
  });

  it("asks once for the request text (prefilled), then runs the seeded configurator", async () => {
    await inProject(async (cwd) => {
      const harness = makeCtx(cwd, "tui", { editor: (prefill) => `${prefill} and similar builds` });
      const model = scripted([[{ name: "decline", args: { kind: "unclear", reason: "Which builds?" } }]]);
      const { state } = setup(harness.ctx, model.complete);
      await state.startGeneralise!(harness.ctx, { tool: "write", input: { path: "dist/out.js", content: "SECRET-CONTENT" } });
      assert.equal(harness.editors[0]!.prefill, "allow things like this: write dist/out.js");
      const sent = JSON.stringify(model.contexts);
      assert.match(sent, /allow things like this: write dist\/out.js and similar builds/);
      assert.match(sent, /seed_action/);
      assert.doesNotMatch(sent, /SECRET-CONTENT/);
      harness.dispose();
    });
  });

  it("does nothing more when the request text is emptied", async () => {
    await inProject(async (cwd) => {
      const harness = makeCtx(cwd, "tui", { editor: () => "  " });
      const model = scripted(PROPOSE);
      const { state } = setup(harness.ctx, model.complete);
      await state.startGeneralise!(harness.ctx, { tool: "bash", input: { command: "npm run build" } });
      assert.equal(model.contexts.length, 0);
      assert.match(harness.notes.join("\n"), /Generalise cancelled/);
    });
  });
});

describe("Allow, and generalise… in the interceptor and the mailbox", () => {
  it("is a plain approval for the tool call, telemetry and the corpus, and seeds the configurator afterwards", async () => {
    await inProject(async (cwd) => {
      const harness = makeCtx(cwd, "rpc", { answers: ["Allow, and generalise…"] });
      const state = createRuntimeState();
      state.config = loadConfig(harness.ctx);
      state.config.classifier.enabled = false;
      // A deterministic ask: a user rule labels the push off-machine-effects (ask).
      state.config.commands.classify = [{ template: "git push fork *", capability: "off-machine-effects" }];
      state.enabled = true;
      state.initialized = true;
      const records: Array<Record<string, unknown>> = [];
      state.appendEntry = (_type, data) => void records.push(structuredClone(data) as Record<string, unknown>);
      const seeds: unknown[] = [];
      state.startGeneralise = (_ctx, seed) => void seeds.push(seed);
      const result = await interceptToolCall({ toolName: "bash", input: { command: "git push fork feature-x" } }, harness.ctx, state);
      assert.equal(result, undefined, "the tool call proceeds");
      const review = records.find((record) => record.kind === "review");
      assert.equal(review?.userAnswer, "approved");
      assert.equal(review?.decision, "allow");
      assert.match(JSON.stringify(state.traces[0]), /asked to generalise/);
      assert.deepEqual(seeds, []);
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.deepEqual(seeds, [{ tool: "bash", input: { command: "git push fork feature-x" } }]);
    });
  });

  it("is offered on a forwarded ask with the child's command as the seed; the child sees a plain approval", async () => {
    await withTempAgentDirAsync(async () => {
      const log: AskOptions[] = [];
      const ask = (async (_ctx, _state, _title, _message, options) => {
        log.push(options ?? {});
        return { kind: "answered", answer: { approved: true, generalise: true }, forwarded: false };
      }) as RailAsk;
      const state = createRuntimeState();
      state.lastUiContext = { hasUI: true } as ExtensionContext;
      const env: NodeJS.ProcessEnv = {};
      const mailbox = startApprovalMailbox({ state, ask, env, pollMs: 20 });
      assert.ok(mailbox);
      try {
        const result = await forwardAskToParent({
          title: "Rail asks for approval",
          message: "git push fork feature-x",
          meta: { toolName: "bash", site: "capability", labels: ["off-machine-effects"], command: "git push fork feature-x" },
          env,
          pollMs: 10,
        });
        assert.deepEqual(result, { ok: true, answer: { approved: true } });
        assert.deepEqual(log[0]!.generaliseSeed, { tool: "bash", input: { command: "git push fork feature-x" } });
      } finally {
        mailbox.stop();
      }
    });
  });
});

describe("who can start the configurator", () => {
  const root = new URL("..", import.meta.url).pathname;
  const sources = (dir: string): string[] =>
    readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? sources(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : [],
    );
  const files = ["index.ts", ...sources("src")].map((file) => ({ file, text: readFileSync(path.join(root, file), "utf8") }));

  it("runGrantAgent is called only from the /rail grant command module", () => {
    const callers = files.filter(({ file, text }) => file !== "src/grant-agent.ts" && /\brunGrantAgent\s*\(/.test(text)).map(({ file }) => file);
    assert.deepEqual(callers, ["src/commands/grant.ts"]);
  });

  it("startGeneralise is invoked only by the approval dialog's answer, and set only by the /rail command", () => {
    const invokers = files.filter(({ text }) => /\bstart\(ctx, seed\)|startGeneralise\?\.\(|startGeneralise\(/.test(text)).map(({ file }) => file);
    assert.deepEqual(invokers, ["src/approvals.ts"]);
    const setters = files.filter(({ text }) => /\.startGeneralise\s*=/.test(text)).map(({ file }) => file);
    assert.deepEqual(setters, ["src/commands/rail.ts"]);
  });

  it("registers no tool but bash and no message or input hook", () => {
    const index = files.find(({ file }) => file === "index.ts")!.text;
    assert.equal(index.match(/pi\.registerTool\(/g)?.length, 1);
    assert.match(index, /pi\.registerTool\(\{\s*\.\.\.localBash/);
    const hooks = [...index.matchAll(/pi\.on\("([^"]+)"/g)].map((match) => match[1]);
    for (const hook of hooks) assert.ok(!["input", "message", "before_agent_start", "context"].includes(hook!), String(hook));
    for (const { file, text } of files) assert.doesNotMatch(text, /sendUserMessage\(/, file);
  });
});

