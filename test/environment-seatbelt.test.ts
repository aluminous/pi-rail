// Environment scrubbing end to end: what a sandboxed bash command actually
// sees. The scrub (src/policy.ts) used to be undone by the Seatbelt backend,
// which merged sandbox-runtime's whole-host env back over it, so wildcard
// unsets and environment.allow never reached bash. The merge rule itself is
// unit-tested first; the rest runs real commands under sandbox-exec and skips
// cleanly off macOS or wherever sandbox-exec cannot apply a profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { APPROVAL_MAILBOX_ENV } from "../src/approval-mailbox.ts";
import { mergeSandboxRuntimeEnv, SeatbeltBackend } from "../src/backends/seatbelt.ts";
import { scrubEnvironment } from "../src/policy.ts";
import { addSessionGrant, markPolicyApplied, removeSessionGrant } from "../src/session-policy.ts";
import { createRuntimeState, type RuntimeState } from "../src/state.ts";
import { makeFixtureDir, testConfig } from "./helpers.ts";

describe("mergeSandboxRuntimeEnv", () => {
  const host = { PATH: "/usr/bin", HOME: "/Users/me", GITHUB_TOKEN: "secret", PLAIN: "x", DROPPED: "d" };

  it("keeps the scrub authoritative over variables the runtime passes through unchanged", () => {
    const scrubbed = { PATH: "/usr/bin", HOME: "/Users/me", PLAIN: "x", DROPPED: "d" };
    // What sandbox-runtime returns on macOS: process.env, untouched.
    const merged = mergeSandboxRuntimeEnv(scrubbed, { ...host }, host);
    assert.deepEqual(merged, scrubbed, "GITHUB_TOKEN stays out");
  });

  it("applies what the runtime added or changed, and drops what it removed", () => {
    const scrubbed = { PATH: "/usr/bin", PLAIN: "x", DROPPED: "d" };
    const runtime = { PATH: "/usr/bin", HOME: "/Users/me", GITHUB_TOKEN: "secret", PLAIN: "changed", HTTPS_PROXY: "http://localhost:1" };
    const merged = mergeSandboxRuntimeEnv(scrubbed, runtime, host);
    assert.deepEqual(merged, { PATH: "/usr/bin", PLAIN: "changed", HTTPS_PROXY: "http://localhost:1" });
  });

  it("keeps caller-only variables the host environment never had", () => {
    assert.deepEqual(mergeSandboxRuntimeEnv({ EXTRA: "1" }, { ...host }, host), { EXTRA: "1" });
    assert.deepEqual(mergeSandboxRuntimeEnv({ EXTRA: "1" }, undefined, host), { EXTRA: "1" });
  });
});

const PROBE_TIMEOUT_MS = 30_000;

function unavailableReason(): string | undefined {
  if (process.platform !== "darwin") return `Seatbelt is macOS-only; current platform is ${process.platform}`;
  if (!existsSync("/usr/bin/sandbox-exec")) return "sandbox-exec is not installed";
  return undefined;
}

const fixture = makeFixtureDir();
const cwd = path.join(fixture.dir, "project");
mkdirSync(cwd, { recursive: true });

let skipReason = unavailableReason();
let backend: SeatbeltBackend | undefined;
let state: RuntimeState | undefined;

const CANARY = "RAILTEST_CANARY_TOKEN";
const PLAIN = "RAILTEST_PLAIN";
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy"];

before(async () => {
  process.env[CANARY] = "canary";
  process.env[PLAIN] = "plain";
  // helpers.ts deletes any inherited mailbox; this is a fake one, never read.
  process.env[APPROVAL_MAILBOX_ENV] = `${fixture.dir}/mailbox#railtest-token`;
  if (skipReason) return;
  const candidate = new SeatbeltBackend();
  const support = await candidate.supported();
  if (!support.ok) {
    skipReason = support.reason;
    return;
  }
  const runtime = createRuntimeState();
  // The defaults: blacklist mode, with the network layer (and so the proxy) on.
  runtime.config = testConfig();
  try {
    await candidate.initialize(runtime.config!, { cwd } as unknown as ExtensionContext);
  } catch (error) {
    skipReason = `sandbox-runtime could not initialize here: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  runtime.backend = candidate;
  runtime.initialized = true;
  markPolicyApplied(candidate, runtime.config!);
  backend = candidate;
  state = runtime;
  const probe = await bash("true");
  if (probe.code !== 0) skipReason = `sandbox-exec cannot apply the rail's profile here: ${probe.out || `exit ${probe.code}`}`;
});

after(async () => {
  delete process.env[CANARY];
  delete process.env[PLAIN];
  delete process.env[APPROVAL_MAILBOX_ENV];
  await backend?.shutdown();
  fixture.cleanup();
});

/** Runs a command the way src/tools/bash.ts does: scrub with the effective config, then wrap. */
async function bash(command: string): Promise<{ code: number | null; out: string }> {
  const wrapped = await backend!.wrapBash(command, cwd, scrubEnvironment(process.env, state!.config!));
  return new Promise((resolve, reject) => {
    const child = spawn(wrapped.command, wrapped.args, { cwd: wrapped.cwd, env: wrapped.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (out += String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim() });
    });
  });
}

/** Variable names visible inside the sandbox (names only; values never leave the probe). */
async function sandboxedNames(): Promise<Set<string>> {
  const result = await bash("/usr/bin/env -0 | /usr/bin/tr '\\0' '\\n' | /usr/bin/sed -n 's/=.*//p'");
  assert.equal(result.code, 0, result.out);
  return new Set(result.out.split("\n").filter(Boolean));
}

function ready(t: TestContext): boolean {
  if (skipReason || !state) {
    t.skip(skipReason ?? "the Seatbelt backend did not initialize");
    return false;
  }
  return true;
}

describe("environment scrubbing reaches sandboxed bash", () => {
  it("blacklist mode: wildcard canaries and the approval mailbox are gone, ordinary variables and the proxy plumbing stay", async (t) => {
    if (!ready(t)) return;
    const names = await sandboxedNames();
    assert.ok(!names.has(CANARY), "*_TOKEN strips the canary");
    assert.ok(!names.has(APPROVAL_MAILBOX_ENV), "the mailbox token never reaches bash");
    assert.ok(names.has(PLAIN), "an ordinary variable passes in blacklist mode");
    assert.ok(names.has("PATH"));
    for (const name of PROXY_VARS) assert.ok(names.has(name), `the runtime's ${name} survives the scrub`);
  });

  it("whitelist mode: only listed variables (plus the runtime's own) reach bash", async (t) => {
    if (!ready(t)) return;
    addSessionGrant(state!, {
      id: "whitelist-probe",
      request: "test whitelist",
      created: "2026-11-12",
      ops: [{ op: "add-to-list", list: "environment.allow", values: ["PATH", "HOME"] }],
    });
    try {
      const names = await sandboxedNames();
      assert.ok(!names.has(PLAIN), "an unlisted variable is dropped in whitelist mode");
      assert.ok(!names.has(CANARY));
      assert.ok(!names.has(APPROVAL_MAILBOX_ENV));
      assert.ok(names.has("PATH") && names.has("HOME"));
      for (const name of PROXY_VARS) assert.ok(names.has(name), `the runtime's ${name} is not subject to the whitelist`);
    } finally {
      removeSessionGrant(state!, "whitelist-probe");
    }
    assert.ok((await sandboxedNames()).has(PLAIN), "revoking the grant goes back to blacklist mode");
  });
});
