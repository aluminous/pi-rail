import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  approvalForwardingAvailable,
  APPROVAL_MAILBOX_ENV,
  forwardAskToParent,
  MAILBOX_VERSION,
  startApprovalMailbox,
  type ApprovalMailbox,
} from "../src/approval-mailbox.ts";
import type { AskOptions, AskOutcome, RailAsk } from "../src/approvals.ts";
import type { RailApprovalAnswer } from "../src/tui/approval-dialog.ts";
import { createRuntimeState, recentEvents, type RuntimeState } from "../src/state.ts";
import { withTempAgentDirAsync } from "./helpers.ts";

const FAST = { parentPollMs: 20, childPollMs: 10 };

function interactiveState(): RuntimeState {
  const state = createRuntimeState();
  state.lastUiContext = { hasUI: true } as ExtensionContext;
  return state;
}

function answering(answer: RailApprovalAnswer, log?: Array<{ title: string; message: string; options?: AskOptions }>): RailAsk {
  return (async (_ctx, _state, title, message, options) => {
    log?.push({ title, message, options });
    return { kind: "answered", answer, forwarded: false } satisfies AskOutcome;
  }) as RailAsk;
}

/** Starts a mailbox against a private env object, so process.env is never touched. */
function startMailbox(params: { state?: RuntimeState; ask: RailAsk; env?: NodeJS.ProcessEnv }): {
  mailbox: ApprovalMailbox;
  env: NodeJS.ProcessEnv;
  state: RuntimeState;
} {
  const env = params.env ?? {};
  const state = params.state ?? interactiveState();
  const mailbox = startApprovalMailbox({ state, ask: params.ask, env, pollMs: FAST.parentPollMs });
  assert.ok(mailbox, "mailbox should start for an interactive non-child session");
  return { mailbox, env, state };
}

/** A crafted mailbox with no servicer, for child-side failure paths. */
function craftMailbox(agentDir: string, overrides?: { version?: number; heartbeatAgeMs?: number }): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = path.join(agentDir, "rail-approvals", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  fs.mkdirSync(path.join(dir, "requests"), { recursive: true });
  fs.mkdirSync(path.join(dir, "responses"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "mailbox.json"),
    JSON.stringify({ type: "rail-approval-mailbox", version: overrides?.version ?? MAILBOX_VERSION, pid: process.pid, createdAt: Date.now() }),
  );
  fs.writeFileSync(path.join(dir, "heartbeat"), "");
  if (overrides?.heartbeatAgeMs) {
    const then = new Date(Date.now() - overrides.heartbeatAgeMs);
    fs.utimesSync(path.join(dir, "heartbeat"), then, then);
  }
  return { dir, env: { [APPROVAL_MAILBOX_ENV]: `${dir}#test-token` } };
}

function forward(env: NodeJS.ProcessEnv, extras?: { signal?: AbortSignal; message?: string }) {
  return forwardAskToParent({
    title: "Rail path approval",
    message: extras?.message ?? "write access outside the configured roots",
    meta: { toolName: "write", site: "path", access: "write", path: "/outside/file" },
    env,
    pollMs: FAST.childPollMs,
    signal: extras?.signal,
  });
}

describe("approval mailbox round trips", () => {
  it("forwards an approve-with-comment answer and cleans up both files", async () => {
    await withTempAgentDirAsync(async () => {
      const log: Array<{ title: string; message: string; options?: AskOptions }> = [];
      const { mailbox, env, state } = startMailbox({ ask: answering({ approved: true, comment: "staging ok" }, log) });
      try {
        const result = await forward({ ...env, PI_SUBAGENT_CHILD_AGENT: "researcher", PI_SUBAGENT_RUN_ID: "run-1234567890" });
        assert.deepEqual(result, { ok: true, answer: { approved: true, comment: "staging ok" } });
        assert.equal(log.length, 1);
        assert.match(log[0]!.title, /subagent researcher \(run run-1234\)/);
        assert.match(log[0]!.message, /From subagent researcher/);
        assert.match(log[0]!.message, /write access outside the configured roots/);
        assert.equal(log[0]!.options?.defaultDeny, true, "background-popped dialogs default to Deny");
        assert.equal(typeof log[0]!.options?.onCancelHandle, "function");
        assert.deepEqual(fs.readdirSync(path.join(mailbox.dir, "requests")), []);
        assert.deepEqual(fs.readdirSync(path.join(mailbox.dir, "responses")), []);
        assert.equal(recentEvents(state)[0]?.decision, "allow");
        assert.match(recentEvents(state)[0]?.reason ?? "", /forwarded ask from subagent researcher/);
      } finally {
        mailbox.stop();
      }
      assert.equal(env[APPROVAL_MAILBOX_ENV], undefined, "stop() clears the env var it set");
      assert.equal(fs.existsSync(mailbox.dir), false, "stop() removes the mailbox dir");
    });
  });

  it("forwards a deny-with-comment answer", async () => {
    await withTempAgentDirAsync(async () => {
      const { mailbox, env } = startMailbox({ ask: answering({ approved: false, comment: "not in this repo" }) });
      try {
        const result = await forward(env);
        assert.deepEqual(result, { ok: true, answer: { approved: false, comment: "not in this repo" } });
      } finally {
        mailbox.stop();
      }
    });
  });

  it("carries a stop across the round trip, so the child stops its turn instead of denying", async () => {
    await withTempAgentDirAsync(async () => {
      const { mailbox, env, state } = startMailbox({ ask: answering({ approved: false, cancelled: true }) });
      try {
        const result = await forward(env);
        // Without `cancelled` surviving the envelope the child sees a plain
        // deny, and the model is free to work around it.
        assert.deepEqual(result, { ok: true, answer: { approved: false, cancelled: true } });
        assert.equal(recentEvents(state)[0]?.decision, "stop", "the parent logs it as a stop, not a denial");
        assert.match(recentEvents(state)[0]?.reason ?? "", /user stopped the turn/);
      } finally {
        mailbox.stop();
      }
    });
  });

  it("serializes concurrent requests into one dialog at a time", async () => {
    await withTempAgentDirAsync(async () => {
      let open = 0;
      let maxOpen = 0;
      const ask: RailAsk = (async () => {
        open++;
        maxOpen = Math.max(maxOpen, open);
        await new Promise((resolve) => setTimeout(resolve, 30));
        open--;
        return { kind: "answered", answer: { approved: true }, forwarded: false } satisfies AskOutcome;
      }) as RailAsk;
      const { mailbox, env } = startMailbox({ ask });
      try {
        const results = await Promise.all([forward(env), forward(env), forward(env)]);
        for (const result of results) assert.deepEqual(result, { ok: true, answer: { approved: true } });
        assert.equal(maxOpen, 1, "dialogs must never overlap");
      } finally {
        mailbox.stop();
      }
    });
  });

  it("restores a shadowed env value on stop", async () => {
    await withTempAgentDirAsync(async () => {
      const env: NodeJS.ProcessEnv = { [APPROVAL_MAILBOX_ENV]: "/outer/mailbox#outer-token" };
      const { mailbox } = startMailbox({ ask: answering({ approved: true }), env });
      assert.notEqual(env[APPROVAL_MAILBOX_ENV], "/outer/mailbox#outer-token", "start shadows the outer mailbox");
      mailbox.stop();
      assert.equal(env[APPROVAL_MAILBOX_ENV], "/outer/mailbox#outer-token", "stop restores the outer mailbox");
    });
  });
});

describe("approval mailbox validation", () => {
  it("answers a bad-token request with a rejection instead of dropping it", async () => {
    await withTempAgentDirAsync(async () => {
      const { mailbox, env } = startMailbox({ ask: answering({ approved: true }) });
      try {
        const dir = (env[APPROVAL_MAILBOX_ENV] as string).split("#")[0]!;
        const forged = { ...env, [APPROVAL_MAILBOX_ENV]: `${dir}#wrong-token` };
        const result = await forward(forged);
        assert.deepEqual(result, { ok: false, failure: "rejected" }, "a child with a stale token fails fast, not forever");
      } finally {
        mailbox.stop();
      }
    });
  });

  it("rejects malformed and oversized requests by requestId, and never shows a dialog for them", async () => {
    await withTempAgentDirAsync(async () => {
      const log: Array<{ title: string }> = [];
      const { mailbox } = startMailbox({ ask: answering({ approved: true }, log as never) });
      try {
        const malformedId = "11111111-2222-4333-8444-555555555555";
        const oversizedId = "66666666-7777-4888-9999-aaaaaaaaaaaa";
        fs.writeFileSync(path.join(mailbox.dir, "requests", `${Date.now()}-${malformedId}.json`), "not json{");
        fs.writeFileSync(
          path.join(mailbox.dir, "requests", `${Date.now()}-${oversizedId}.json`),
          JSON.stringify({ type: "rail-approval-request", padding: "x".repeat(70 * 1024) }),
        );
        await new Promise((resolve) => setTimeout(resolve, 120));
        const responses = fs.readdirSync(path.join(mailbox.dir, "responses")).sort();
        assert.deepEqual(responses, [`${malformedId}.json`, `${oversizedId}.json`].sort());
        const malformed = JSON.parse(fs.readFileSync(path.join(mailbox.dir, "responses", `${malformedId}.json`), "utf-8"));
        assert.equal(malformed.approved, false);
        assert.equal(malformed.rejected, "malformed");
        const oversized = JSON.parse(fs.readFileSync(path.join(mailbox.dir, "responses", `${oversizedId}.json`), "utf-8"));
        assert.equal(oversized.rejected, "too-large");
        assert.deepEqual(fs.readdirSync(path.join(mailbox.dir, "requests")), [], "consumed requests are unlinked");
        assert.equal(log.length, 0, "invalid requests never reach the dialog");
      } finally {
        mailbox.stop();
      }
    });
  });

  it("skips a request whose child is already dead without asking", async () => {
    await withTempAgentDirAsync(async () => {
      const log: unknown[] = [];
      const { mailbox, env } = startMailbox({ ask: answering({ approved: true }, log as never) });
      try {
        // The token is not on disk by design; a hand-crafted request reads it
        // from the env the mailbox was started with, like a real child would.
        const token = (env[APPROVAL_MAILBOX_ENV] as string).split("#")[1]!;
        const dead = spawnSync("true").pid ?? 999999;
        const requestId = "12121212-3434-4565-8787-909090909090";
        fs.writeFileSync(
          path.join(mailbox.dir, "requests", `${Date.now()}-${requestId}.json`),
          JSON.stringify({
            type: "rail-approval-request",
            version: MAILBOX_VERSION,
            token,
            requestId,
            ts: Date.now(),
            childPid: dead,
            toolName: "write",
            site: "path",
            title: "t",
            message: "m",
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 120));
        assert.deepEqual(fs.readdirSync(path.join(mailbox.dir, "requests")), [], "dead-child request is reaped");
        assert.deepEqual(fs.readdirSync(path.join(mailbox.dir, "responses")), [], "nobody is waiting, so no response");
        assert.equal(log.length, 0);
      } finally {
        mailbox.stop();
      }
    });
  });
});

describe("approval mailbox liveness", () => {
  it("returns parent-gone when the heartbeat goes stale mid-wait", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const { dir, env } = craftMailbox(agentDir);
      const wait = forward(env);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const then = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(dir, "heartbeat"), then, then);
      const result = await wait;
      assert.deepEqual(result, { ok: false, failure: "parent-gone" });
      assert.deepEqual(fs.readdirSync(path.join(dir, "requests")), [], "the child unlinks its request on exit");
    });
  });

  it("returns cancelled when the abort signal fires mid-wait", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const { dir, env } = craftMailbox(agentDir);
      const controller = new AbortController();
      const wait = forward(env, { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort();
      const result = await wait;
      assert.deepEqual(result, { ok: false, failure: "cancelled" });
      assert.deepEqual(fs.readdirSync(path.join(dir, "requests")), []);
    });
  });

  it("treats unset env, missing dir, wrong version, and stale heartbeat as unavailable", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      assert.equal(approvalForwardingAvailable({}), false, "unset env");
      assert.equal(approvalForwardingAvailable({ [APPROVAL_MAILBOX_ENV]: "/nope/missing#tok" }), false, "missing dir");
      const wrongVersion = craftMailbox(path.join(agentDir, "v2"), { version: 2 });
      assert.equal(approvalForwardingAvailable(wrongVersion.env), false, "wrong mailbox version");
      const stale = craftMailbox(path.join(agentDir, "stale"), { heartbeatAgeMs: 60_000 });
      assert.equal(approvalForwardingAvailable(stale.env), false, "stale heartbeat");
      const fresh = craftMailbox(path.join(agentDir, "fresh"));
      assert.equal(approvalForwardingAvailable(fresh.env), true, "fresh heartbeat is available");
    });
  });
});

describe("approval mailbox lifecycle", () => {
  it("never starts in a child or headless session", async () => {
    await withTempAgentDirAsync(async () => {
      const child = startApprovalMailbox({ state: interactiveState(), ask: answering({ approved: true }), env: { PI_SUBAGENT_CHILD: "1" } });
      assert.equal(child, undefined, "children must not shadow the root mailbox");
      const headless = startApprovalMailbox({ state: createRuntimeState(), ask: answering({ approved: true }), env: {} });
      assert.equal(headless, undefined, "no UI means no one to answer");
    });
  });

  it("is idempotent: a second start stops the first mailbox", async () => {
    await withTempAgentDirAsync(async () => {
      const env: NodeJS.ProcessEnv = {};
      const first = startApprovalMailbox({ state: interactiveState(), ask: answering({ approved: true }), env, pollMs: FAST.parentPollMs });
      const second = startApprovalMailbox({ state: interactiveState(), ask: answering({ approved: true }), env, pollMs: FAST.parentPollMs });
      assert.ok(first && second);
      try {
        assert.equal(fs.existsSync(first.dir), false, "the orphaned first mailbox is removed");
        assert.ok(env[APPROVAL_MAILBOX_ENV]?.startsWith(`${second.dir}#`), "env points at the live mailbox");
      } finally {
        second.stop();
      }
    });
  });

  it("sweeps dead sibling mailboxes at startup", async () => {
    await withTempAgentDirAsync(async (agentDir) => {
      const stale = craftMailbox(agentDir, { heartbeatAgeMs: 120_000 });
      const { mailbox } = startMailbox({ ask: answering({ approved: true }) });
      try {
        assert.equal(fs.existsSync(stale.dir), false, "stale sibling reaped by the startup sweep");
        assert.equal(fs.existsSync(mailbox.dir), true);
      } finally {
        mailbox.stop();
      }
    });
  });
});
