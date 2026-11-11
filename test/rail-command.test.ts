import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_CAPABILITY_IDS, type CapabilityId, type Disposition } from "../src/capabilities.ts";
import { createRailCommand } from "../src/commands/rail.ts";
import { addClass, setRowDisposition } from "../src/dispositions.ts";
import { addSessionGuidance } from "../src/classifier.ts";
import { sessionDispositionEdit, sessionDispositionEdits } from "../src/session-policy.ts";
import { createRuntimeState, type RuntimeState } from "../src/state.ts";
import { DispositionPage } from "../src/tui/disposition-page.ts";
import { StatusPage } from "../src/tui/status-page.ts";
import { testConfig } from "./helpers.ts";

function makeCommand(specs: string[] = []) {
  const state = createRuntimeState();
  state.availableModelSpecs = specs;
  return createRailCommand({
    state,
    enableRail: async () => {},
    disableRail: async () => {},
    runRailSmoke: async () => {},
    runCritique: async () => {},
  });
}

/** A command wired to a preloaded config (never reads the user's real rail.json) and a persist spy. */
function makeDispositionCommand() {
  const state = createRuntimeState();
  state.config = testConfig();
  const persisted: Array<[CapabilityId, Disposition | undefined]> = [];
  const command = createRailCommand({
    state,
    enableRail: async () => {},
    disableRail: async () => {},
    runRailSmoke: async () => {},
    runCritique: async () => {},
    persistDisposition: { disposition: (id, disposition) => void persisted.push([id, disposition]) },
  });
  return { command, state, persisted };
}

interface FakeCtx {
  ctx: ExtensionContext;
  asked: Array<{ title: string; labels: string[] }>;
  notes: string[];
  widgets: Array<{ key: string; lines: string[] | undefined }>;
  /** Titles passed to ctx.ui.input, in order. */
  inputs: string[];
}

/** RPC-shaped context: select answers are matched against the offered labels by substring; undefined cancels. */
function rpcCtx(answers: Array<string | undefined> = []): FakeCtx {
  const asked: FakeCtx["asked"] = [];
  const notes: string[] = [];
  const widgets: FakeCtx["widgets"] = [];
  const inputs: string[] = [];
  let next = 0;
  const ctx = {
    mode: "rpc",
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify: (message: string) => notes.push(message),
      setStatus: () => {},
      setWidget: (key: string, lines: string[] | undefined) => widgets.push({ key, lines }),
      theme: { fg: (_name: string, text: string) => text, bold: (text: string) => text },
      select: async (title: string, labels: string[]) => {
        asked.push({ title, labels });
        const want = answers[next++];
        return want === undefined ? undefined : labels.find((label) => label.includes(want));
      },
      // ctx.ui.input draws from the same scripted answer queue as select.
      input: async (title: string) => {
        inputs.push(title);
        return answers[next++];
      },
    },
  };
  return { ctx: ctx as unknown as ExtensionContext, asked, notes, widgets, inputs };
}

/** TUI-shaped context that runs the custom-component factory and resolves when the panel closes. */
function tuiCtx() {
  const notes: string[] = [];
  let component: unknown;
  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify: (message: string) => notes.push(message),
      setStatus: () => {},
      theme: { fg: (_name: string, text: string) => text, bold: (text: string) => text },
      custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: undefined) => void) => unknown) =>
        new Promise<undefined>((resolve) => {
          component = factory(
            { terminal: { rows: 40 }, requestRender: () => {} },
            { fg: (_name: string, text: string) => text, bold: (text: string) => text },
            { matches: (keyData: string, keyId: string) => keyId === "tui.select.cancel" && keyData === "<esc>" },
            resolve,
          );
        }),
    },
  };
  return { ctx: ctx as unknown as ExtensionContext, notes, panel: () => component };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

/** This session's table-row edits: the set-disposition ops in the session-edits grant. */
function overrides(state: RuntimeState) {
  return sessionDispositionEdits(state);
}

describe("rail argument completions", () => {
  it("lists all subcommands for an empty prefix", () => {
    const items = makeCommand().getArgumentCompletions("");
    assert.ok(items);
    assert.deepEqual(items.map((i) => i.value), ["status", "policy", "policy rules", "set", "grant", "grant cancel", "grant add", "grant check", "grants", "guide", "guide clear", "explain", "test", "test read", "test write", "why", "on", "off", "off session", "readonly", "model", "smoke", "critique"]);
    assert.ok(items.every((i) => i.description));
  });

  it("completes the grant subcommands", () => {
    assert.deepEqual(makeCommand().getArgumentCompletions("gra")?.map((i) => i.value), ["grant", "grant cancel", "grant add", "grant check", "grants"]);
  });

  it("narrows subcommands by prefix", () => {
    const items = makeCommand().getArgumentCompletions("of");
    assert.deepEqual(items?.map((i) => i.value), ["off", "off session"]);
  });

  it("completes model arguments with fixed specs first, full-args values", () => {
    const items = makeCommand(["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"]).getArgumentCompletions("model ");
    assert.ok(items);
    assert.deepEqual(items.slice(0, 7).map((i) => i.value), ["model auto", "model current", "model off", "model status", "model save", "model judge", "model configurator"]);
    assert.ok(items.some((i) => i.value === "model openai/gpt-5-mini"));
  });

  it("completes the judge subform without auto or off", () => {
    const command = makeCommand(["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"]);
    assert.deepEqual(command.getArgumentCompletions("model ju")?.map((i) => i.value), ["model judge"], "the keyword completes first");

    const items = command.getArgumentCompletions("model judge ");
    assert.ok(items);
    assert.deepEqual(items.slice(0, 2).map((i) => i.value), ["model judge current", "model judge status"]);
    assert.ok(!items.some((i) => i.label === "auto" || i.label === "off"), "the judge cannot be off, and auto is the namer's list");
    assert.ok(items.some((i) => i.value === "model judge anthropic/claude-haiku-4-5"));
  });

  it("completes the configurator subform with its own auto but no off", () => {
    const command = makeCommand(["openai/gpt-5-mini"]);
    const items = command.getArgumentCompletions("model configurator ");
    assert.deepEqual(items?.map((i) => i.value), ["model configurator auto", "model configurator current", "model configurator status", "model configurator openai/gpt-5-mini"]);
  });

  it("filters the judge subform by partial text", () => {
    const command = makeCommand(["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"]);
    assert.deepEqual(command.getArgumentCompletions("model judge haiku")?.map((i) => i.value), ["model judge anthropic/claude-haiku-4-5"]);
    assert.equal(command.getArgumentCompletions("model judge zzz"), null);
  });

  it("filters model specs by partial text", () => {
    const items = makeCommand(["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"]).getArgumentCompletions("model haiku");
    assert.deepEqual(items?.map((i) => i.value), ["model anthropic/claude-haiku-4-5"]);
  });

  it("completes critique with model specs but no classifier keywords", () => {
    const items = makeCommand(["openai/gpt-5-mini"]).getArgumentCompletions("critique ");
    assert.deepEqual(items?.map((i) => i.value), ["critique openai/gpt-5-mini"]);
  });

  it("returns null when nothing matches", () => {
    assert.equal(makeCommand().getArgumentCompletions("bogus"), null);
    assert.equal(makeCommand([]).getArgumentCompletions("critique zzz"), null);
  });

  it("completes set with class ids, then with dispositions", () => {
    const { command } = makeDispositionCommand();
    const classes = command.getArgumentCompletions("set ");
    assert.deepEqual(classes?.map((item) => item.label), [...BUILTIN_CAPABILITY_IDS]);
    assert.deepEqual(classes?.[0]?.value, "set read-project");
    assert.match(classes?.[0]?.description ?? "", /currently allow/);

    assert.deepEqual(command.getArgumentCompletions("set read-s")?.map((item) => item.value), ["set read-system"]);

    const dispositions = command.getArgumentCompletions("set credentials ");
    assert.deepEqual(dispositions?.map((item) => item.value), ["set credentials allow", "set credentials judge", "set credentials ask", "set credentials deny"]);
    assert.deepEqual(command.getArgumentCompletions("set credentials de")?.map((item) => item.label), ["deny"]);
    assert.equal(command.getArgumentCompletions("set credentials zz"), null);
    assert.equal(command.getArgumentCompletions("set zzz"), null);
  });
});

describe("/rail set", () => {
  it("applies a disposition at session scope", async () => {
    const { command, state, persisted } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    await command.handler("set off-machine-effects deny", ctx);
    assert.deepEqual(overrides(state), { "off-machine-effects": "deny" });
    assert.deepEqual(persisted, [], "session scope writes nothing to disk");
    assert.match(notes.at(-1)!, /off-machine-effects → deny for this session\. \/rail policy then Ctrl\+S persists it\./);
  });

  it("reports the current value and its source when no disposition is given", async () => {
    const { command, state } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    await command.handler("set credentials", ctx);
    assert.match(notes.at(-1)!, /^credentials: judge — built-in default$/);

    setRowDisposition(state.config, state, "credentials", "ask");
    await command.handler("set credentials", ctx);
    assert.match(notes.at(-1)!, /^credentials: ask — this session$/);

    state.readOnly = true;
    await command.handler("set modify-project", ctx);
    assert.match(notes.at(-1)!, /^modify-project: deny — read-only preset \(row says allow\)$/);
  });

  it("explains the preset when an edit cannot take effect yet", async () => {
    const { command } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    await command.handler("readonly", ctx);
    await command.handler("set modify-project allow", ctx);
    assert.match(notes.at(-1)!, /read-only preset still forces deny/);
  });

  it("rejects unknown classes, unknown dispositions, and extra words", async () => {
    const { command, state } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    await command.handler("set nonsense deny", ctx);
    assert.match(notes.at(-1)!, /Unknown capability class: nonsense/);
    await command.handler("set credentials maybe", ctx);
    assert.match(notes.at(-1)!, /Unknown disposition: maybe/);
    await command.handler("set", ctx);
    assert.match(notes.at(-1)!, /Usage: \/rail set <class>/);
    await command.handler("set credentials deny please", ctx);
    assert.match(notes.at(-1)!, /Usage: \/rail set <class>/);
    assert.deepEqual(overrides(state), {});
  });
});

describe("/rail policy routing", () => {
  it("opens the interactive page in the TUI and toggles it closed", async () => {
    const { command, state } = makeDispositionCommand();
    const tui = tuiCtx();
    await command.handler("policy", tui.ctx);
    assert.equal(state.liveView?.kind, "policy", "the page registers as the live view so stats refresh");
    const page = tui.panel();
    assert.ok(page instanceof DispositionPage);
    page.handleInput("\x1b[C");
    assert.deepEqual(overrides(state), { "read-project": "judge" }, "the page edits the live session state");

    await command.handler("policy", tui.ctx);
    await settled();
    assert.equal(state.liveView, undefined, "a second /rail policy closes the page");
  });

  it("routes /rail policy rules to the mechanism rules alone over RPC", async () => {
    const { command, state } = makeDispositionCommand();
    const { ctx, widgets } = rpcCtx();
    await command.handler("policy rules", ctx);
    assert.equal(state.liveView?.kind, "policy");
    assert.equal(widgets.at(-1)?.key, "rail-policy");
    const text = widgets.at(-1)?.lines?.join("\n") ?? "";
    assert.match(text, /─ Filesystem/);
    assert.match(text, /─ Network/);
    assert.doesNotMatch(text, /══ Session/, "the policy tab alone, not the whole status page");
  });

  it("opens the status page on the policy tab in the TUI, and switches instead of closing", async () => {
    const { command, state } = makeDispositionCommand();
    const tui = tuiCtx();
    await command.handler("policy rules", tui.ctx);
    const page = tui.panel();
    assert.ok(page instanceof StatusPage, "the mechanism rules are a status-page tab now");
    assert.equal(state.liveView?.kind, "status");
    assert.equal(page.activeTab(), "policy");

    // Another tab of the same page retargets rather than toggling shut.
    await command.handler("status", tui.ctx);
    assert.equal(state.liveView?.kind, "status", "the panel stayed open");
    assert.equal(page.activeTab(), "session");

    await command.handler("policy rules", tui.ctx);
    assert.equal(page.activeTab(), "policy");

    // Re-invoking the tab already showing is the toggle.
    await command.handler("policy rules", tui.ctx);
    await settled();
    assert.equal(state.liveView, undefined, "same-tab invocation closes the panel");
  });

  it("renders the mechanism rules on the status page's policy tab", async () => {
    const { command } = makeDispositionCommand();
    const tui = tuiCtx();
    await command.handler("policy rules", tui.ctx);
    const page = tui.panel() as StatusPage;
    const text = page.render(200).join("\n");
    assert.match(text, /Tab: session \| models \| namer \| judge \| engine \| policy/);
    assert.match(text, /─ Filesystem/);
  });

  it("leaves the disposition page a single view with no tabs", async () => {
    const { command } = makeDispositionCommand();
    const tui = tuiCtx();
    await command.handler("policy", tui.ctx);
    const page = tui.panel() as DispositionPage;
    const text = page.render(200).join("\n");
    assert.match(text, /Capability policy/);
    assert.doesNotMatch(text, /Tab:/, "the rules tab left with the tab header");
    assert.match(text, /the resolved filesystem\/network rules are \/rail policy rules/);
  });

  it("warns on an unknown policy argument", async () => {
    const { command } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    await command.handler("policy nonsense", ctx);
    assert.match(notes.at(-1)!, /Usage: \/rail policy \[rules\]/);
  });

  it("degrades to a select flow over RPC: pick a class, pick a disposition, repeat, save", async () => {
    const { command, state, persisted } = makeDispositionCommand();
    const { ctx, asked, notes } = rpcCtx(["off-machine-effects", "deny", "Save persistently", undefined]);
    await command.handler("policy", ctx);

    assert.equal(asked.length, 4);
    assert.match(asked[0]!.title, /Capability dispositions \(changes apply to this session\)/);
    assert.equal(asked[0]!.labels.length, 14, "twelve classes plus Add new class and Save persistently");
    assert.match(asked[0]!.labels[0]!, /^read-project\s+allow$/);
    assert.equal(asked[0]!.labels.at(-1), "Save persistently");
    assert.match(asked[1]!.title, /off-machine-effects — currently ask/);
    assert.deepEqual(asked[1]!.labels, ["allow", "judge", "ask (current)", "deny", "Edit definition…"], "built-ins are editable but not deletable");
    assert.match(asked[2]!.labels.find((label) => label.startsWith("off-machine-effects"))!, /off-machine-effects\s+deny\s+\(modified\)/);

    assert.deepEqual(persisted, [["off-machine-effects", "deny"]]);
    assert.deepEqual(overrides(state), {}, "saving clears the session overrides");
    assert.match(notes.join("\n"), /off-machine-effects → deny for this session\./);
    assert.match(notes.at(-1)!, /Dispositions saved: 1 row\./);
    assert.equal(state.liveView, undefined, "the select flow is not a live view");
  });

  it("is a stderr error when headless", async () => {
    const { command } = makeDispositionCommand();
    const ctx = { mode: "print", hasUI: false, isIdle: () => true, ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_n: string, t: string) => t } } } as unknown as ExtensionContext;
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => void errors.push(message);
    try {
      await command.handler("policy", ctx);
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /requires an interactive session/);
  });
});

describe("/rail guide", () => {
  it("adds guidance from inline text and reports the ring position", async () => {
    const { command, state } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    await command.handler("guide staging deploys are expected here", ctx);

    assert.deepEqual(state.classifier.sessionGuidance, ["User guidance: staging deploys are expected here"]);
    assert.match(notes.at(-1)!, /^Guidance added for this session \(1\/12\)\.$/);
  });

  it("prompts when bare in an interactive session", async () => {
    const { command, state } = makeDispositionCommand();
    const { ctx, notes, inputs } = rpcCtx(["the deploy script is meant to push"]);
    await command.handler("guide", ctx);

    assert.deepEqual(inputs, ["Guidance for the rail this session"]);
    assert.deepEqual(state.classifier.sessionGuidance, ["User guidance: the deploy script is meant to push"]);
    assert.match(notes.at(-1)!, /Guidance added for this session \(1\/12\)\./);
  });

  it("is a no-op when the prompt is cancelled or empty", async () => {
    const { command, state } = makeDispositionCommand();
    const { ctx } = rpcCtx([undefined]);
    await command.handler("guide", ctx);
    assert.equal(state.classifier.sessionGuidance, undefined);

    const empty = rpcCtx(["   "]);
    await command.handler("guide", empty.ctx);
    assert.equal(state.classifier.sessionGuidance, undefined);
  });

  it("shares the ring and the cap with approval-comment guidance", async () => {
    const { command, state } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    addSessionGuidance(state.classifier, "allowed", "bash", "npm test", "tests are fine");
    await command.handler("guide and so are builds", ctx);

    assert.equal(state.classifier.sessionGuidance!.length, 2);
    assert.match(state.classifier.sessionGuidance![0]!, /^User allowed bash/);
    assert.match(state.classifier.sessionGuidance![1]!, /^User guidance: and so are builds/);
    assert.match(notes.at(-1)!, /\(2\/12\)/);

    for (let i = 0; i < 20; i++) await command.handler(`guide entry ${i}`, ctx);
    assert.equal(state.classifier.sessionGuidance!.length, 12, "the ring is capped");
    assert.match(notes.at(-1)!, /\(12\/12\)/);
  });

  it("clears every entry and says how many went", async () => {
    const { command, state } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    await command.handler("guide one", ctx);
    await command.handler("guide two", ctx);
    await command.handler("guide clear", ctx);

    assert.equal(state.classifier.sessionGuidance, undefined);
    assert.match(notes.at(-1)!, /^Cleared 2 guidance entries\.$/);

    await command.handler("guide clear", ctx);
    assert.match(notes.at(-1)!, /^No session guidance to clear\.$/);
  });

  it("warns instead of prompting when bare and headless", async () => {
    const { command, state } = makeDispositionCommand();
    const notes: string[] = [];
    const logs: string[] = [];
    const ctx = {
      mode: "print",
      hasUI: false,
      isIdle: () => true,
      ui: { notify: (message: string) => notes.push(message), setStatus: () => {}, theme: { fg: (_n: string, t: string) => t } },
    } as unknown as ExtensionContext;
    const original = console.log;
    console.log = (message: string) => void logs.push(message);
    try {
      await command.handler("guide", ctx);
    } finally {
      console.log = original;
    }
    assert.match(notes.at(-1)!, /^Usage: \/rail guide <text>$/);
    assert.equal(state.classifier.sessionGuidance, undefined);
  });
});

describe("/rail set with a custom class", () => {
  it("accepts a class added this session and completes it", async () => {
    const { command, state } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    addClass(state.config, state, { id: "touches-customer-data", definition: "Customer records." });

    await command.handler("set touches-customer-data deny", ctx);
    assert.match(notes.at(-1)!, /touches-customer-data → deny for this session/);
    assert.equal(sessionDispositionEdit(state, "touches-customer-data"), "deny");

    await command.handler("set touches-customer-data", ctx);
    assert.match(notes.at(-1)!, /touches-customer-data: deny — this session/);

    const completions = command.getArgumentCompletions("set touches");
    assert.deepEqual(completions?.map((item) => item.label), ["touches-customer-data"]);
  });

  it("still rejects an id no layer declares, listing the registry", async () => {
    const { command } = makeDispositionCommand();
    const { ctx, notes } = rpcCtx();
    await command.handler("set invented-class deny", ctx);
    assert.match(notes.at(-1)!, /Unknown capability class: invented-class/);
    assert.match(notes.at(-1)!, /read-project/, "the message lists what is known");
  });
});
