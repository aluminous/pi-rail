// /rail grant add|check and /rail grants: the confirmation (TUI and RPC), the
// sensitive-op approval, the apply paths (session, global, project), headless
// refusal, revoke/promote/demote taking effect live, and the `grant` field on
// review records.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, mock } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RailBackend } from "../src/backends/types.ts";
import { createGrantCommands, grantUsage, readGrantFile } from "../src/commands/grant.ts";
import { globalRailConfigPath, loadConfig, projectRailConfigPath, type RailConfig } from "../src/config.ts";
import { formatDecisionTrace } from "../src/decision-trace.ts";
import { dryRunAction } from "../src/grant-eval.ts";
import { interceptToolCall } from "../src/interceptor.ts";
import type { Grant } from "../src/policy-store.ts";
import { buildCorpusRecord, type CorpusRecord } from "../src/replay-corpus.ts";
import { createRuntimeState, type RuntimeState } from "../src/state.ts";
import { GrantConfirmPage, GrantsPage, SENSITIVE_TOGGLE_KEY } from "../src/tui/grant-page.ts";
import { makeFixtureDir, withTempAgentDirAsync } from "./helpers.ts";

const WORKTREE: Grant = JSON.parse(readFileSync(new URL("../examples/grants/worktree-cleanup.json", import.meta.url), "utf8"));
const ENTER = "\r";

const keybindings = {
  matches: (data: string, id: string) =>
    (id === "tui.select.up" && data === "<up>") ||
    (id === "tui.select.down" && data === "<down>") ||
    (id === "tui.select.confirm" && data === ENTER) ||
    (id === "tui.select.cancel" && data === "<esc>"),
};
const plainTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
const settled = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

interface Harness {
  ctx: ExtensionContext;
  notes: string[];
  panel: () => unknown;
  asked: Array<{ title: string; labels: string[] }>;
}

/** A context of the given mode; select answers are matched by substring. */
function makeCtx(cwd: string, mode: "tui" | "rpc" | "print", options: { trusted?: boolean; answers?: string[] } = {}): Harness {
  const notes: string[] = [];
  const asked: Harness["asked"] = [];
  const answers = [...(options.answers ?? [])];
  let component: unknown;
  const ctx = {
    cwd,
    mode,
    hasUI: mode !== "print",
    isProjectTrusted: () => options.trusted ?? false,
    abort() {},
    ui: {
      notify: (message: string) => notes.push(message),
      setStatus() {},
      setWidget() {},
      theme: plainTheme,
      select: async (title: string, labels: string[]) => {
        asked.push({ title, labels });
        const want = answers.shift();
        return want === undefined ? undefined : labels.find((label) => label.includes(want));
      },
      confirm: async () => true,
      custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: undefined) => void) => unknown) =>
        new Promise<undefined>((resolve) => {
          component = factory({ terminal: { rows: 60 }, requestRender() {} }, plainTheme, keybindings, resolve);
        }),
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    sessionManager: { getBranch: () => [] },
    signal: undefined,
  };
  return { ctx: ctx as unknown as ExtensionContext, notes, panel: () => component, asked };
}

function setup(ctx: ExtensionContext, records: CorpusRecord[] = []) {
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
    readCorpus: () => records,
    today: () => "2026-11-12",
  });
  return { state, commands };
}

function writeGrantFile(dir: string, grant: unknown, name = "grant.json"): string {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(grant), "utf8");
  return file;
}

function decide(state: RuntimeState, command: string, cwd: string) {
  return dryRunAction(state.config!, { tool: "bash", input: { command } }, { cwd });
}

/** The worktree grant plus a sensitive bare-head allow (`yq *`), optionally with an example that needs it. */
function withYq(exampleNeedsJq: boolean): Grant {
  return {
    ...WORKTREE,
    id: "worktree-and-yq",
    ops: [...WORKTREE.ops, { op: "allow-command", template: "yq *" }],
    examples: [...WORKTREE.examples!, ...(exampleNeedsJq ? [{ tool: "bash", input: { command: "yq . package.json" }, expect: ["allow" as const] }] : [])],
  };
}

describe("readGrantFile", () => {
  it("requires a request and defaults created to today", () => {
    const fixture = makeFixtureDir();
    try {
      const { id, ops, examples } = WORKTREE;
      const missing = readGrantFile(writeGrantFile(fixture.dir, { id, ops }), fixture.dir, "2026-11-12");
      assert.ok("error" in missing && /"request" is required/.test(missing.error));
      const read = readGrantFile(writeGrantFile(fixture.dir, { id, request: "r", ops, examples }), fixture.dir, "2026-11-12");
      assert.ok("raw" in read);
      assert.equal(read.raw.created, "2026-11-12");
      assert.match(JSON.stringify(readGrantFile("missing.json", fixture.dir, "x")), /Could not read/);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("/rail grant add — the confirmation", () => {
  it("applies for this session on Enter, live on the next decision", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const cwd = path.join(agentDir, "project");
      mkdirSync(cwd, { recursive: true });
      const harness = makeCtx(cwd, "tui");
      const { state, commands } = setup(harness.ctx);
      assert.equal(decide(state, "git worktree remove ../x", cwd).outcome, "indeterminate");
      await commands.runGrant(`add ${writeGrantFile(agentDir, WORKTREE)}`, harness.ctx);
      const page = harness.panel() as GrantConfirmPage;
      assert.ok(page instanceof GrantConfirmPage);
      const text = page.render(120).join("\n");
      assert.match(text, /Request: i want to allow cleaning up worktrees/);
      assert.match(text, /Label `git worktree remove \*` \(no flags\) as worktree-cleanup — widening/);
      assert.match(text, /✓ `git worktree remove \.\.\/pi-rail-maint` → allow/);
      assert.match(text, /0 past asks become allows · 0 critical cases change · 0 indeterminate/);
      assert.doesNotMatch(text, /save to project/, "no trusted project config dir");
      page.handleInput(ENTER);
      await settled();
      assert.deepEqual(state.sessionPolicy.grants.map((grant) => grant.id), ["worktree-cleanup"]);
      const run = decide(state, "git worktree remove ../x", cwd);
      assert.equal(run.outcome, "allow");
      assert.equal(run.grant, "worktree-cleanup");
      assert.match(harness.notes.join("\n"), /applied for this session \(3 ops\)/);
    });
  });

  it("applies and saves to global: the grant is in the file and live at the global layer", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const cwd = path.join(agentDir, "project");
      mkdirSync(cwd, { recursive: true });
      const harness = makeCtx(cwd, "tui");
      const { state, commands } = setup(harness.ctx);
      await commands.runGrant(`add ${writeGrantFile(agentDir, WORKTREE)}`, harness.ctx);
      const page = harness.panel() as GrantConfirmPage;
      page.handleInput("<down>");
      assert.deepEqual(page.selectedRow(), { kind: "answer", value: "global" });
      page.handleInput(ENTER);
      await settled();
      const written = JSON.parse(readFileSync(globalRailConfigPath(), "utf8")) as RailConfig;
      assert.deepEqual((written.grants as unknown as Grant[]).map((grant) => grant.id), ["worktree-cleanup"]);
      assert.deepEqual(state.sessionPolicy.grants, []);
      assert.ok(state.config!.grants.some((grant) => grant.layer === "global" && grant.id === "worktree-cleanup"));
      assert.equal(decide(state, "git worktree remove ../x", cwd).outcome, "allow");
    });
  });

  it("offers save to project only with a trusted project config dir, and saves there", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const cwd = path.join(agentDir, "project");
      mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      const harness = makeCtx(cwd, "tui", { trusted: true });
      const { state, commands } = setup(harness.ctx);
      await commands.runGrant(`add ${writeGrantFile(agentDir, WORKTREE)}`, harness.ctx);
      const page = harness.panel() as GrantConfirmPage;
      assert.match(page.render(120).join("\n"), /Apply and save to project/);
      page.handleInput("<down>");
      page.handleInput("<down>");
      assert.deepEqual(page.selectedRow(), { kind: "answer", value: "project" });
      page.handleInput(ENTER);
      await settled();
      const written = JSON.parse(readFileSync(projectRailConfigPath(cwd), "utf8")) as RailConfig;
      assert.deepEqual((written.grants as unknown as Grant[]).map((grant) => grant.id), ["worktree-cleanup"]);
      assert.ok(state.config!.grants.some((grant) => grant.layer === "project"));
      assert.equal(existsSync(globalRailConfigPath()), false);
    });
  });

  it("drops an unapproved sensitive op on Enter, and keeps one toggled with Space", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const cwd = path.join(agentDir, "project");
      mkdirSync(cwd, { recursive: true });
      const dropped = makeCtx(cwd, "tui");
      const first = setup(dropped.ctx);
      await first.commands.runGrant(`add ${writeGrantFile(agentDir, withYq(false))}`, dropped.ctx);
      const page = dropped.panel() as GrantConfirmPage;
      assert.match(page.render(140).join("\n"), /\[ \] op 4: `yq \*` exempts every yq command from review/);
      assert.deepEqual(page.selectedRow(), { kind: "answer", value: "session" }, "Enter starts on an answer, never a toggle");
      page.handleInput(ENTER);
      await settled();
      const applied = first.state.sessionPolicy.grants[0]!;
      assert.equal(applied.ops.length, 3, "the sensitive op is really dropped");
      assert.ok(!first.state.config!.commands.allow.includes("yq *"));
      assert.match(dropped.notes.join("\n"), /dropped unapproved sensitive op 4/);

      const kept = makeCtx(cwd, "tui");
      const second = setup(kept.ctx);
      await second.commands.runGrant(`add ${writeGrantFile(agentDir, withYq(false))}`, kept.ctx);
      const toggles = kept.panel() as GrantConfirmPage;
      toggles.handleInput("<up>");
      assert.deepEqual(toggles.selectedRow(), { kind: "sensitive", opIndex: 3 });
      toggles.handleInput(ENTER);
      assert.deepEqual(toggles.approvedOps(), [], "Enter never toggles");
      toggles.handleInput(SENSITIVE_TOGGLE_KEY);
      assert.deepEqual(toggles.approvedOps(), [3]);
      toggles.handleInput("<down>");
      toggles.handleInput(ENTER);
      await settled();
      assert.equal(second.state.sessionPolicy.grants[0]!.ops.length, 4);
      assert.ok(second.state.config!.commands.allow.includes("yq *"));
    });
  });

  it("re-evaluates and refuses when dropping a sensitive op leaves the grant's examples failing", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const cwd = path.join(agentDir, "project");
      mkdirSync(cwd, { recursive: true });
      const harness = makeCtx(cwd, "tui");
      const { state, commands } = setup(harness.ctx);
      await commands.runGrant(`add ${writeGrantFile(agentDir, withYq(true))}`, harness.ctx);
      const page = harness.panel() as GrantConfirmPage;
      page.handleInput(ENTER);
      await settled();
      assert.deepEqual(state.sessionPolicy.grants, [], "nothing applied");
      assert.match(page.render(160).join("\n"), /Without the unapproved sensitive op 4, the grant fails its gates: example 5 \(`yq \. package\.json`\)/);
    });
  });

  it("shows a rejected grant with Discard only", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const cwd = path.join(agentDir, "project");
      mkdirSync(cwd, { recursive: true });
      const harness = makeCtx(cwd, "tui");
      const { state, commands } = setup(harness.ctx);
      const noNegatives = { ...WORKTREE, examples: WORKTREE.examples!.slice(0, 2) };
      await commands.runGrant(`add ${writeGrantFile(agentDir, noNegatives)}`, harness.ctx);
      const page = harness.panel() as GrantConfirmPage;
      const text = page.render(160).join("\n");
      assert.match(text, /rejected/);
      assert.match(text, /no passing negative example/);
      assert.doesNotMatch(text, /Apply for this session/);
      assert.deepEqual(page.selectedRow(), { kind: "answer", value: "discard" });
      page.handleInput(ENTER);
      await settled();
      assert.deepEqual(state.sessionPolicy.grants, []);
    });
  });

  it("asks about each sensitive op separately over RPC, dropping by default", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const cwd = path.join(agentDir, "project");
      mkdirSync(cwd, { recursive: true });
      const dropping = makeCtx(cwd, "rpc", { answers: ["Drop this op", "Apply for this session"] });
      const first = setup(dropping.ctx);
      await first.commands.runGrant(`add ${writeGrantFile(agentDir, withYq(false))}`, dropping.ctx);
      assert.deepEqual(dropping.asked[0]?.labels, ["Drop this op", "Approve this op"]);
      assert.match(dropping.asked[0]!.title, /Sensitive op 4: `yq \*` exempts every yq command/);
      assert.equal(first.state.sessionPolicy.grants[0]?.ops.length, 3);

      const approving = makeCtx(cwd, "rpc", { answers: ["Approve this op", "Apply for this session"] });
      const second = setup(approving.ctx);
      await second.commands.runGrant(`add ${writeGrantFile(agentDir, withYq(false))}`, approving.ctx);
      assert.equal(second.state.sessionPolicy.grants[0]?.ops.length, 4);
    });
  });

  it("refuses a widening grant headless, and applies a tightening one to the session", async (t) => {
    const log = t.mock.method(console, "log", () => {});
    await withTempAgentDirAsync(async (agentDir) => {
      const cwd = path.join(agentDir, "project");
      mkdirSync(cwd, { recursive: true });
      const harness = makeCtx(cwd, "print");
      const { state, commands } = setup(harness.ctx);
      await commands.runGrant(`add ${writeGrantFile(agentDir, WORKTREE)}`, harness.ctx);
      assert.deepEqual(state.sessionPolicy.grants, []);
      assert.match(harness.notes.join("\n"), /widens policy, which needs the rail's own confirmation dialog/);
      assert.ok(log.mock.callCount() > 0, "the report is printed");
      const tighten: Grant = { id: "no-fetch", request: "deny network fetches", created: "2026-11-12", ops: [{ op: "set-disposition", capability: "network-fetch", disposition: "deny" }] };
      await commands.runGrant(`add ${writeGrantFile(agentDir, tighten, "tight.json")}`, harness.ctx);
      assert.deepEqual((state.sessionPolicy.grants as Grant[]).map((grant) => grant.id), ["no-fetch"]);
    });
    mock.restoreAll();
  });

  it("check prints the report and applies nothing, headless too", async (t) => {
    const log = t.mock.method(console, "log", () => {});
    await withTempAgentDirAsync(async (agentDir) => {
      const cwd = path.join(agentDir, "project");
      mkdirSync(cwd, { recursive: true });
      const harness = makeCtx(cwd, "print");
      const { state, commands } = setup(harness.ctx);
      await commands.runGrant(`check ${writeGrantFile(agentDir, WORKTREE)}`, harness.ctx);
      assert.deepEqual(state.sessionPolicy.grants, []);
      const printed = log.mock.calls.map((call) => String(call.arguments[0])).join("\n");
      assert.match(printed, /# Rail grant worktree-cleanup — passes its gates/);
      assert.match(printed, /Seatbelt is assumed enforcing/);
    });
    mock.restoreAll();
  });
});

describe("/rail grants — revoke, promote, demote take effect live", () => {
  it("revokes, demotes, and promotes a file grant with the live base refolded each time", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const cwd = path.join(agentDir, "project");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(path.dirname(globalRailConfigPath()), { recursive: true });
      writeFileSync(globalRailConfigPath(), JSON.stringify({ grants: [WORKTREE] }), "utf8");
      const harness = makeCtx(cwd, "tui");
      const { state, commands } = setup(harness.ctx);
      assert.equal(decide(state, "git worktree remove ../x", cwd).outcome, "allow");

      await commands.openGrants(harness.ctx);
      const page = harness.panel() as GrantsPage;
      assert.match(page.render(160).join("\n"), /worktree-cleanup\s+global\s+3 ops\s+0 this session · 0 in corpus · never decided/);

      // Demote: out of the file, into the session, and the base no longer has it.
      page.handleInput("d");
      assert.deepEqual(state.sessionPolicy.grants.map((grant) => grant.id), ["worktree-cleanup"]);
      assert.equal(JSON.parse(readFileSync(globalRailConfigPath(), "utf8")).grants, undefined);
      assert.ok(!state.baseConfig!.grants.some((grant) => grant.id === "worktree-cleanup"), "the live base was refolded without it");
      assert.equal(decide(state, "git worktree remove ../x", cwd).grant, "worktree-cleanup");
      assert.equal(state.config!.provenance.lists["commands.classify"]["git worktree remove *"]?.layer, "session");

      // Promote back: in the file, out of the session, at the global layer.
      page.handleInput("g");
      assert.deepEqual(state.sessionPolicy.grants, []);
      assert.equal(state.config!.provenance.lists["commands.classify"]["git worktree remove *"]?.layer, "global");

      // Revoke: r once warns, r again deletes; the next decision no longer sees it.
      page.handleInput("r");
      assert.match(page.render(160).join("\n"), /Press r again to revoke worktree-cleanup/);
      assert.equal(decide(state, "git worktree remove ../x", cwd).outcome, "allow");
      page.handleInput("r");
      assert.equal(JSON.parse(readFileSync(globalRailConfigPath(), "utf8")).grants, undefined);
      assert.equal(decide(state, "git worktree remove ../x", cwd).outcome, "indeterminate");
      assert.match(page.render(160).join("\n"), /No grants/);
    });
  });

  it("revokes a session grant", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const cwd = path.join(agentDir, "project");
      mkdirSync(cwd, { recursive: true });
      const harness = makeCtx(cwd, "rpc", { answers: ["worktree-cleanup", "Revoke"] });
      const { state, commands } = setup(harness.ctx);
      state.sessionPolicy.grants = [WORKTREE];
      state.sessionPolicy.revision++;
      await commands.openGrants(harness.ctx);
      assert.deepEqual(state.sessionPolicy.grants, []);
      assert.equal(decide(state, "git worktree remove ../x", cwd).outcome, "indeterminate");
    });
  });
});

describe("grant attribution", () => {
  it("names the deciding grant in telemetry, the corpus, the trace, and the session count", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const cwd = path.join(agentDir, "project");
      mkdirSync(cwd, { recursive: true });
      const harness = makeCtx(cwd, "print");
      const { state, commands } = setup(harness.ctx);
      state.sessionPolicy.grants = [WORKTREE];
      state.sessionPolicy.revision++;
      state.enabled = true;
      state.initialized = true;
      state.backend = { name: "seatbelt" } as RailBackend;
      const telemetry: Array<Record<string, unknown>> = [];
      state.appendEntry = (_type, data) => telemetry.push(data as Record<string, unknown>);
      const corpus: CorpusRecord[] = [];
      state.corpus = { dir: agentDir, append: (record) => corpus.push(record) };

      await interceptToolCall({ toolName: "bash", input: { command: "git worktree remove ../x" } }, harness.ctx, state);
      assert.equal(telemetry.at(-1)?.grant, "worktree-cleanup");
      assert.equal(corpus.at(-1)?.grant, "worktree-cleanup");
      assert.equal(state.grantDecisions["worktree-cleanup"], 1);
      assert.match(formatDecisionTrace(state.traces[0]!, 1, 1), /decided by grant worktree-cleanup/);

      // A decision no grant made carries no grant.
      await interceptToolCall({ toolName: "bash", input: { command: "grep foo src" } }, harness.ctx, state);
      assert.equal(telemetry.at(-1)?.grant, undefined);
      assert.equal(corpus.at(-1)?.grant, undefined);

      // Detail tier: telemetry "off" keeps the memory core only.
      state.config!.classifier.telemetry = "off";
      state.baseConfig!.classifier.telemetry = "off";
      await interceptToolCall({ toolName: "bash", input: { command: "git worktree prune" } }, harness.ctx, state);
      assert.equal(telemetry.at(-1)?.grant, undefined);
      assert.equal(corpus.at(-1)?.grant, "worktree-cleanup", "the corpus keeps it always");

      const rows = createGrantCommands({ state, notify() {}, loadBase: () => state.baseConfig!, readCorpus: () => corpus }).grantRows(harness.ctx);
      assert.deepEqual(rows.map((row) => [row.id, row.session, row.corpus, row.lastDecided !== undefined]), [["worktree-cleanup", 2, 2, true]]);
      void commands;
    });
  });

  it("counts corpus decisions per grant, with the newest date", () => {
    const records = [
      buildCorpusRecord({ kind: "review", tool: "bash", cwd: "/x", input: { command: "a" }, outcome: "allow", grant: "g1" }, new Date("2026-11-01T00:00:00Z")),
      buildCorpusRecord({ kind: "review", tool: "bash", cwd: "/x", input: { command: "b" }, outcome: "allow", grant: "g1" }, new Date("2026-11-05T00:00:00Z")),
      buildCorpusRecord({ kind: "review", tool: "bash", cwd: "/x", input: { command: "c" }, outcome: "allow" }, new Date("2026-11-06T00:00:00Z")),
    ];
    const usage = grantUsage(records);
    assert.deepEqual(usage.get("g1"), { total: 2, last: "2026-11-05T00:00:00.000Z" });
    assert.equal(usage.size, 1);
  });
});
