import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { interceptToolCall } from "../src/interceptor.ts";
import { createRuntimeState, type RuntimeState } from "../src/state.ts";
import { appendRailTelemetry, redactTelemetryRecord, type RailReviewTelemetry, type RailTelemetryRecord } from "../src/telemetry.ts";
import { testConfig } from "./helpers.ts";

function fakeCtx(): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI: false,
    ui: {
      notify() {},
      confirm: async () => false,
    },
  } as unknown as ExtensionContext;
}

function readyState(captured: RailTelemetryRecord[], overrides?: Parameters<typeof testConfig>[0]): { state: RuntimeState; config: ReturnType<typeof testConfig> } {
  const config = testConfig(overrides);
  const state = createRuntimeState();
  state.config = config;
  state.enabled = true;
  state.initialized = true;
  state.appendEntry = (customType, data) => {
    assert.equal(customType, "rail");
    captured.push(data as RailTelemetryRecord);
  };
  return { state, config };
}

describe("redactTelemetryRecord", () => {
  const record: RailReviewTelemetry = {
    kind: "review",
    tool: "bash",
    decision: "allow",
    labels: ["run-dev-tools"],
    resolvedDisposition: "allow",
    decidedBy: "run-dev-tools",
    screenTripped: false,
    latencyMs: 10,
    reason: "ok",
    projection: {
      toolName: "bash",
      cwd: "/repo",
      inputSummary: { command: `curl ${"x".repeat(500)}` },
      policySummary: ["network: allowed 5 domains"],
    },
  };

  it("truncates projected values and drops policy summary in minimal mode", () => {
    const redacted = redactTelemetryRecord(record, "minimal") as typeof record;
    const command = redacted.projection!.inputSummary.command as string;
    assert.ok(command.startsWith("curl "), "keeps the command prefix");
    assert.match(command, /\u2026\[truncated \d+ chars\]$/, "marks truncation");
    assert.ok(command.length < (record.projection!.inputSummary.command as string).length, "shortens the value");
    assert.deepEqual(redacted.projection!.policySummary, []);
  });

  it("keeps the full projection in full mode", () => {
    const redacted = redactTelemetryRecord(record, "full") as typeof record;
    assert.equal((redacted.projection!.inputSummary.command as string).length, (record.projection!.inputSummary.command as string).length);
    assert.deepEqual(redacted.projection!.policySummary, ["network: allowed 5 domains"]);
  });

  it("keeps the capability fields through redaction", () => {
    const redacted = redactTelemetryRecord(record, "minimal") as typeof record;
    assert.deepEqual(redacted.labels, ["run-dev-tools"]);
    assert.equal(redacted.resolvedDisposition, "allow");
    assert.equal(redacted.screenTripped, false);
  });

  it("leaves non-review records untouched in minimal mode", () => {
    const block: RailTelemetryRecord = { kind: "block", tool: "write", reason: "outside roots" };
    assert.deepEqual(redactTelemetryRecord(block, "minimal"), block);
  });
});

describe("appendRailTelemetry", () => {
  it("writes records as rail custom entries", () => {
    const captured: RailTelemetryRecord[] = [];
    const { state } = readyState(captured);
    appendRailTelemetry(state, { kind: "block", tool: "write", reason: "denied" });
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.kind, "block");
  });

  it("writes nothing when telemetry is off", () => {
    const captured: RailTelemetryRecord[] = [];
    const { state } = readyState(captured, (c) => { c.classifier.telemetry = "off"; });
    appendRailTelemetry(state, { kind: "block", tool: "write", reason: "denied" });
    assert.equal(captured.length, 0);
  });

  it("writes nothing when no session appender is wired", () => {
    const state = createRuntimeState();
    state.config = testConfig();
    appendRailTelemetry(state, { kind: "block", tool: "write", reason: "denied" });
  });

  it("never throws when the session appender fails", () => {
    const state = createRuntimeState();
    state.config = testConfig();
    state.appendEntry = () => {
      throw new Error("no session file");
    };
    appendRailTelemetry(state, { kind: "block", tool: "write", reason: "denied" });
  });
});

describe("interceptor telemetry wiring", () => {
  it("records policy blocks", async () => {
    const captured: RailTelemetryRecord[] = [];
    const { state } = readyState(captured, (c) => { c.classifier.enabled = false; });
    const result = await interceptToolCall(
      { toolName: "write", input: { path: `${process.cwd()}/.env`, content: "x" } },
      fakeCtx(),
      state,
    );
    assert.equal(result?.block, true);
    const block = captured.find((r) => r.kind === "block");
    assert.ok(block, "expected a block record");
    assert.equal(block.tool, "write");
  });

  it("records denied path approvals", async () => {
    const captured: RailTelemetryRecord[] = [];
    const { state } = readyState(captured, (c) => {
      c.classifier.enabled = false;
      c.filesystem.allowWrite = [];
    });
    const result = await interceptToolCall(
      { toolName: "write", input: { path: `${process.cwd()}/some-file.txt`, content: "x" } },
      fakeCtx(),
      state,
    );
    assert.equal(result?.block, true);
    const approval = captured.find((r) => r.kind === "approval");
    assert.ok(approval, "expected an approval record");
    assert.equal(approval.kind === "approval" && approval.outcome, "denied");
  });

  it("records nothing when telemetry is off", async () => {
    const captured: RailTelemetryRecord[] = [];
    const { state } = readyState(captured, (c) => {
      c.classifier.enabled = false;
      c.classifier.telemetry = "off";
    });
    await interceptToolCall(
      { toolName: "write", input: { path: `${process.cwd()}/.env`, content: "x" } },
      fakeCtx(),
      state,
    );
    assert.equal(captured.length, 0);
  });
});
