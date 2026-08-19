// Decision-trace tests: trace contents for each interceptor stage (path
// block, exempt read, allowlisted command, screen, namer/table/judge via a
// fake complete function) and the /rail explain rendering path.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RailBackend } from "../src/backends/types.ts";
import type { CompleteFn } from "../src/classifier.ts";
import { createRailCommand } from "../src/commands/rail.ts";
import { formatDecisionTrace, TRACE_LIMIT, type DecisionTrace } from "../src/decision-trace.ts";
import { interceptToolCall } from "../src/interceptor.ts";
import { createRuntimeState, lastRailDecision, recordDecisionTrace, resetSessionState } from "../src/state.ts";
import { makeFixtureDir, testConfig } from "./helpers.ts";

const fixture = makeFixtureDir();
after(() => fixture.cleanup());

mkdirSync(path.join(fixture.dir, "project", "src"), { recursive: true });
writeFileSync(path.join(fixture.dir, "project", "src", "app.ts"), "ok");
const cwd = path.join(fixture.dir, "project");

/** Minimal fake ExtensionContext, with optional model wiring for classifier reviews. */
function fakeCtx(options?: { model?: { provider: string; id: string } }) {
  const ctx = {
    cwd,
    hasUI: false,
    mode: "print",
    abort() {},
    ui: { notify() {} },
    modelRegistry: {
      getAvailable: () => [],
      find: () => options?.model,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    sessionManager: { getBranch: () => [] },
    signal: undefined,
  };
  return ctx as unknown as ExtensionContext;
}

function railState(config: ReturnType<typeof testConfig>) {
  const state = createRuntimeState();
  state.config = config;
  state.enabled = true;
  state.initialized = true;
  return state;
}

function fakeComplete(script: string[]): CompleteFn {
  return (async () => {
    const step = script.shift();
    if (step === undefined) throw new Error("fake complete script exhausted");
    return {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: step }],
      usage: { input: 10, output: 5 },
      timestamp: Date.now(),
    } as unknown as Awaited<ReturnType<CompleteFn>>;
  }) as CompleteFn;
}

describe("decision traces", () => {
  it("records a path-policy block with the matching deny pattern", async () => {
    const state = railState(testConfig());
    const result = await interceptToolCall({ toolName: "write", input: { path: ".env", content: "SECRET=1" } }, fakeCtx(), state);
    assert.equal(result?.block, true);
    assert.equal(state.traces.length, 1);
    const trace = state.traces[0]!;
    assert.equal(trace.toolName, "write");
    assert.equal(trace.final, "blocked");
    assert.deepEqual(trace.stages.map((s) => s.stage), ["path-policy"]);
    assert.equal(trace.stages[0]!.outcome, "block");
    assert.match(trace.stages[0]!.detail, /denied by pattern \.env/);
  });

  it("routes a denyRead read to the credentials label instead of blocking on the path", async () => {
    writeFileSync(path.join(cwd, ".env"), "SECRET=1");
    const state = railState(testConfig());
    const result = await interceptToolCall({ toolName: "read", input: { path: ".env" } }, fakeCtx(), state);
    // Headless, so the judge-class ask still ends as a block — but via the table, not the path.
    assert.equal(result?.block, true);
    const trace = state.traces[0]!;
    assert.match(trace.action, /read: \.env/);
    const pathStage = trace.stages.find((s) => s.stage === "path-policy");
    assert.equal(pathStage?.outcome, "label");
    assert.match(pathStage!.detail, /credentials label instead of a block/);
    const exemption = trace.stages.find((s) => s.stage === "read-exemption");
    assert.match(exemption!.detail, /matches denyRead '\.env' → credentials/);
    const capabilities = trace.stages.find((s) => s.stage === "capabilities");
    assert.equal(capabilities?.outcome, "judge");
    assert.match(capabilities!.detail, /credentials→judge \(default\)/);
  });

  it("records the exempt-read condition for an in-cwd read", async () => {
    const state = railState(testConfig((c) => (c.classifier.enabled = true)));
    const result = await interceptToolCall({ toolName: "read", input: { path: "src/app.ts" } }, fakeCtx(), state);
    assert.equal(result, undefined);
    const trace = state.traces[0]!;
    assert.equal(trace.final, "allowed");
    const exemption = trace.stages.find((s) => s.stage === "read-exemption");
    assert.equal(exemption?.outcome, "exempt");
    assert.match(exemption!.detail, /in session cwd → read-project/);
    assert.ok(!trace.stages.some((s) => s.stage === "namer"), "exempt reads must not reach the namer");
    const capabilities = trace.stages.find((s) => s.stage === "capabilities");
    assert.equal(capabilities?.outcome, "allow");
  });

  it("records per-segment rule matches for an allowlisted command", async () => {
    const state = railState(testConfig((c) => (c.classifier.enabled = true)));
    state.backend = { name: "seatbelt" } as RailBackend;
    const result = await interceptToolCall({ toolName: "bash", input: { command: "grep foo src || git status" } }, fakeCtx(), state);
    assert.equal(result, undefined);
    const trace = state.traces[0]!;
    assert.equal(trace.final, "allowed");
    const allowlist = trace.stages.find((s) => s.stage === "command-allowlist");
    assert.equal(allowlist?.outcome, "exempt");
    assert.match(allowlist!.detail, /`grep foo src` → rule `grep \*` \(read-project\)/);
    assert.match(allowlist!.detail, /`git status` → rule `git status \*` \(read-project\)/);
    const capabilities = trace.stages.find((s) => s.stage === "capabilities");
    assert.equal(capabilities?.outcome, "allow");
    assert.match(capabilities!.detail, /read-project→allow \(default\) ⇒ allow/);
  });

  it("records a classify hit under its own stage, with the rule and the resolution", async () => {
    const state = railState(testConfig((c) => {
      c.capabilities.classes = [{ id: "k8s-ops", name: "Cluster ops", definition: "Cluster operations.", default: "deny" }];
      c.commands.classify = [{ template: "kubectl *", capability: "k8s-ops" }];
    }));
    state.backend = { name: "seatbelt" } as RailBackend;
    const result = await interceptToolCall({ toolName: "bash", input: { command: "kubectl delete pod api && git status" } }, fakeCtx(), state);
    assert.equal(result?.block, true);
    const trace = state.traces[0]!;
    assert.equal(trace.final, "blocked");
    assert.ok(!trace.stages.some((s) => s.stage === "command-allowlist"), "the stage is named for the list that matched first");
    const classify = trace.stages.find((s) => s.stage === "commands.classify");
    assert.equal(classify?.outcome, "exempt");
    assert.match(classify!.detail, /`kubectl delete pod api` → classify rule `kubectl \*` \(k8s-ops\)/);
    assert.match(classify!.detail, /`git status` → rule `git status \*` \(read-project\)/, "allowlist hits in the same chain stay labelled as allowlist hits");
    assert.match(classify!.detail, /⇒ deny, decided without naming/);
    assert.ok(!trace.stages.some((s) => s.stage === "namer"), "a deterministic tightening never reaches the namer");
  });

  it("records why a deterministic allow still needs the namer", async () => {
    const state = railState(testConfig((c) => {
      c.classifier.enabled = true;
      c.commands.classify = [{ template: "kubectl *", capability: "read-system" }];
    }));
    const result = await interceptToolCall({ toolName: "bash", input: { command: "kubectl get pods" } }, fakeCtx(), state);
    assert.equal(result?.block, true, "the classifier is unavailable here, so the fallback blocks");
    const classify = state.traces[0]!.stages.find((s) => s.stage === "commands.classify");
    assert.equal(classify?.outcome, "skipped");
    assert.match(classify!.detail, /⇒ allow, which needs an enforcing Seatbelt sandbox — naming required/);
  });

  it("records the allowlist refusal reason for a non-allowlisted segment", async () => {
    const state = railState(testConfig());
    state.backend = { name: "seatbelt" } as RailBackend;
    state.classifier.enabledOverride = true;
    const result = await interceptToolCall({ toolName: "bash", input: { command: "grep a; curl example.com" } }, fakeCtx(), state);
    assert.equal(result?.block, true, "classifier is unavailable here, so the call blocks");
    const allowlist = state.traces[0]!.stages.find((s) => s.stage === "command-allowlist");
    assert.equal(allowlist?.outcome, "not exempt");
    assert.match(allowlist!.detail, /`curl example.com`: no allowlist rule matches/);
  });

  it("records the namer labels and the table resolution", async () => {
    const config = testConfig((c) => {
      c.classifier.enabled = true;
      c.classifier.model = "test/fake-model";
    });
    const state = railState(config);
    const complete = fakeComplete(['{"labels":["run-dev-tools"]}']);
    const result = await interceptToolCall(
      { toolName: "bash", input: { command: "npm run build" } },
      fakeCtx({ model: { provider: "test", id: "fake-model" } }),
      state,
      complete,
    );
    assert.equal(result, undefined);
    const trace = state.traces[0]!;
    assert.equal(trace.final, "allowed");
    const namer = trace.stages.find((s) => s.stage === "namer");
    assert.equal(namer?.outcome, "run-dev-tools");
    assert.match(namer!.detail, /model test\/fake-model/);
    const capabilities = trace.stages.find((s) => s.stage === "capabilities");
    assert.equal(capabilities?.outcome, "allow");
    assert.match(capabilities!.detail, /run-dev-tools→allow \(default\) ⇒ allow/);
    assert.equal(lastRailDecision(state)?.decision, "allow");
    assert.deepEqual(lastRailDecision(state)?.labels, ["run-dev-tools"]);
  });

  it("records the judge stage when the table escalates", async () => {
    const config = testConfig((c) => {
      c.classifier.enabled = true;
      c.classifier.model = "test/fake-model";
      c.classifier.judgeModel = "test/fake-model";
    });
    const state = railState(config);
    const complete = fakeComplete([
      '{"labels":["local-destructive"]}',
      '{"decision":"deny","reason":"removes untracked work with no recovery path"}',
    ]);
    const result = await interceptToolCall(
      { toolName: "bash", input: { command: "rm -rf build" } },
      fakeCtx({ model: { provider: "test", id: "fake-model" } }),
      state,
      complete,
    );
    assert.equal(result?.block, true);
    assert.match(result.reason, /Rail judge denied/);
    const trace = state.traces[0]!;
    assert.deepEqual(
      trace.stages.map((s) => s.stage),
      ["command-allowlist", "namer", "capabilities", "judge"],
    );
    const judge = trace.stages.find((s) => s.stage === "judge");
    assert.equal(judge?.outcome, "deny");
    assert.match(judge!.detail, /removes untracked work/);
  });

  it("keeps traces newest first, caps at TRACE_LIMIT, and resets per session", async () => {
    const state = railState(testConfig());
    for (let i = 0; i < TRACE_LIMIT + 5; i++) {
      const trace: DecisionTrace = { at: i, toolName: "read", action: `read: ${i}`, final: "allowed", stages: [] };
      recordDecisionTrace(state, trace);
    }
    assert.equal(state.traces.length, TRACE_LIMIT);
    assert.equal(state.traces[0]!.action, `read: ${TRACE_LIMIT + 4}`);
    resetSessionState(state);
    assert.equal(state.traces.length, 0);
  });
});

describe("/rail explain", () => {
  function makeCommand() {
    const state = createRuntimeState();
    const command = createRailCommand({
      state,
      enableRail: async () => {},
      disableRail: async () => {},
      runRailSmoke: async () => {},
      runCritique: async () => {},
    });
    const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
    const notifications: string[] = [];
    const ctx = {
      mode: "rpc",
      hasUI: true,
      isIdle: () => true,
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus() {},
        setWidget: (key: string, lines: string[] | undefined) => widgets.push({ key, lines }),
        theme: { fg: (_name: string, text: string) => text },
      },
    };
    return { state, command, widgets, notifications, ctx: ctx as unknown as ExtensionContext };
  }

  it("renders the newest trace through the report view", async () => {
    const { state, command, widgets, ctx } = makeCommand();
    recordDecisionTrace(state, { at: Date.now(), toolName: "read", action: "read: old.txt", final: "allowed", stages: [] });
    recordDecisionTrace(state, {
      at: Date.now(),
      toolName: "write",
      action: "write: /etc/hosts",
      final: "blocked",
      stages: [{ stage: "path-policy", outcome: "block", detail: "write denied by pattern /etc" }],
    });
    await command.handler("explain", ctx);
    const lines = widgets.at(-1)?.lines ?? [];
    assert.equal(widgets.at(-1)?.key, "rail-report");
    assert.ok(lines.some((line) => line.includes("write: /etc/hosts")));
    assert.ok(lines.some((line) => line.includes("[BLOCK] path-policy: write denied by pattern /etc")));
    assert.ok(lines.some((line) => line.includes("(1/2, newest first)")));
  });

  it("selects the nth trace and rejects out-of-range indexes", async () => {
    const { state, command, widgets, notifications, ctx } = makeCommand();
    recordDecisionTrace(state, { at: Date.now(), toolName: "read", action: "read: old.txt", final: "allowed", stages: [] });
    recordDecisionTrace(state, { at: Date.now(), toolName: "read", action: "read: new.txt", final: "allowed", stages: [] });
    await command.handler("explain 2", ctx);
    assert.ok((widgets.at(-1)?.lines ?? []).some((line) => line.includes("read: old.txt")));
    await command.handler("explain 7", ctx);
    assert.match(notifications.at(-1) ?? "", /between 1 \(newest\) and 2/);
  });

  it("shows an empty-state report when nothing was traced", async () => {
    const { command, widgets, ctx } = makeCommand();
    await command.handler("explain", ctx);
    assert.ok((widgets.at(-1)?.lines ?? []).some((line) => line.includes("no intercepted tool calls traced yet")));
  });
});

describe("formatDecisionTrace", () => {
  it("maps stage outcomes to the report tag vocabulary", () => {
    const trace: DecisionTrace = {
      at: Date.now(),
      toolName: "bash",
      action: "bash: rm -rf /",
      final: "blocked",
      stages: [
        { stage: "readonly", outcome: "pass", detail: "bash permitted pending capability review" },
        { stage: "judge", outcome: "deny", detail: "deny · destroys work with no recovery path" },
      ],
    };
    const text = formatDecisionTrace(trace, 1, 1);
    assert.match(text, /\[ALLOW\] readonly:/);
    assert.match(text, /\[BLOCK\] judge:/);
    assert.match(text, /final: blocked/);
  });
});
