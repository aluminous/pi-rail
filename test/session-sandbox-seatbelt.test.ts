// Session-layer filesystem, network, and environment grants against the real
// Seatbelt backend (GRANTS_PLAN phase 4). A grant added or revoked mid-session
// must move both engines in one step: sandboxed bash (via sandbox-runtime's
// updateConfig) and the file tools' path policy (which reads state.config).
// Each case runs real commands under sandbox-exec and asks src/policy.ts the
// same question. Skips cleanly off macOS, and wherever sandbox-exec cannot
// apply a profile (inside another sandbox, for instance).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SeatbeltBackend } from "../src/backends/seatbelt.ts";
import { decidePathAccess, scrubEnvironment } from "../src/policy.ts";
import type { Grant, PolicyOp } from "../src/policy-store.ts";
import { addSessionGrant, markPolicyApplied, removeSessionGrant } from "../src/session-policy.ts";
import { createRuntimeState, type RuntimeState } from "../src/state.ts";
import { makeFixtureDir, testConfig } from "./helpers.ts";

const PROBE_TIMEOUT_MS = 30_000;

function unavailableReason(): string | undefined {
  if (process.platform !== "darwin") return `Seatbelt is macOS-only; current platform is ${process.platform}`;
  if (!existsSync("/usr/bin/sandbox-exec")) return "sandbox-exec is not installed";
  return undefined;
}

const fixture = makeFixtureDir();
const cwd = path.join(fixture.dir, "project");
const secretDir = path.join(cwd, "secret");
const protectedDir = path.join(cwd, "protected");
mkdirSync(secretDir, { recursive: true });
mkdirSync(protectedDir, { recursive: true });
writeFileSync(path.join(secretDir, "token.txt"), "SECRET");

let skipReason = unavailableReason();
let backend: SeatbeltBackend | undefined;
let state: RuntimeState | undefined;
/** A write root outside every default one (the temp dir and ~/Library/Caches are defaults): the per-user cache dir. */
let outside: string | undefined;

before(async () => {
  if (skipReason) return;
  try {
    const cacheDir = execFileSync("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], { encoding: "utf8" }).trim();
    outside = realpathSync.native(mkdtempSync(path.join(cacheDir, "pi-rail-test-")));
  } catch {
    outside = undefined;
  }
  const candidate = new SeatbeltBackend();
  const support = await candidate.supported();
  if (!support.ok) {
    skipReason = support.reason;
    return;
  }
  const runtime = createRuntimeState();
  runtime.config = testConfig();
  try {
    await candidate.initialize(runtime.config!, { cwd } as unknown as ExtensionContext);
  } catch (error) {
    skipReason = `sandbox-runtime could not initialize here: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  // As index.ts enableRail wires it.
  runtime.backend = candidate;
  runtime.initialized = true;
  markPolicyApplied(candidate, runtime.config!);
  backend = candidate;
  state = runtime;
  // Inside another sandbox, sandbox-exec cannot apply a real profile
  // ("sandbox_apply: Operation not permitted"); a trivial one may still pass,
  // so probe with the profile under test.
  const probe = await bash("true");
  if (probe.code !== 0) skipReason = `sandbox-exec cannot apply the rail's profile here: ${probe.out || `exit ${probe.code}`}`;
});

after(async () => {
  await backend?.shutdown();
  if (outside) rmSync(outside, { recursive: true, force: true });
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

function grant(id: string, ops: PolicyOp[]): Grant {
  return { id, request: `test ${id}`, created: "2026-11-12", ops };
}

function ready(t: TestContext): boolean {
  if (skipReason || !state) {
    t.skip(skipReason ?? "the Seatbelt backend did not initialize");
    return false;
  }
  return true;
}

const fileTools = (target: string, kind: "read" | "write") => decidePathAccess(state!.config!, cwd, target, kind).allowed;

describe("session grants re-point the live Seatbelt profile", () => {
  it("adds and removes a write root in both engines; a running command keeps its profile", async (t) => {
    if (!ready(t)) return;
    if (!outside) return t.skip("no per-user cache dir to use as an outside write root");
    const target = path.join(outside, "written.txt");
    const write = `echo hi > '${target}' && echo WROTE`;
    assert.equal(fileTools(target, "write"), false);
    assert.notEqual((await bash(write)).code, 0, "outside every root before the grant");

    addSessionGrant(state!, grant("write-outside", [{ op: "add-to-list", list: "filesystem.allowWrite", values: [outside] }]));
    assert.equal(fileTools(target, "write"), true);
    const added = await bash(write);
    assert.equal(added.code, 0, added.out);
    assert.equal(added.out, "WROTE");

    // Started under the widened profile, it finishes after the revoke.
    const inflight = bash(`sleep 1; echo hi > '${path.join(outside, "inflight.txt")}' && echo WROTE`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(removeSessionGrant(state!, "write-outside"), true);
    assert.equal(fileTools(target, "write"), false);
    const removed = await bash(write);
    assert.notEqual(removed.code, 0, "the removed root is gone for the next command");
    assert.match(removed.out, /Operation not permitted/);
    assert.equal((await inflight).out, "WROTE", "a command already running keeps the profile it started with");
  });

  it("adds denyRead and denyWrite entries in both engines, and lifts them on revoke", async (t) => {
    if (!ready(t)) return;
    const secret = path.join(secretDir, "token.txt");
    const guarded = path.join(protectedDir, "out.txt");
    assert.equal(fileTools(secret, "read"), true);
    assert.equal(fileTools(guarded, "write"), true);
    assert.equal((await bash(`cat '${secret}'`)).out, "SECRET");

    addSessionGrant(state!, grant("deny-both", [
      { op: "add-to-list", list: "filesystem.denyRead", values: [secretDir] },
      { op: "add-to-list", list: "filesystem.denyWrite", values: [protectedDir] },
    ]));
    assert.equal(fileTools(secret, "read"), false);
    assert.equal(fileTools(guarded, "write"), false);
    const read = await bash(`cat '${secret}'`);
    assert.notEqual(read.code, 0);
    assert.match(read.out, /Operation not permitted/);
    const write = await bash(`echo x > '${guarded}'`);
    assert.notEqual(write.code, 0);
    assert.match(write.out, /Operation not permitted/);

    removeSessionGrant(state!, "deny-both");
    assert.equal(fileTools(secret, "read"), true);
    assert.equal((await bash(`cat '${secret}'`)).out, "SECRET");
    assert.equal((await bash(`echo x > '${guarded}' && echo WROTE`)).out, "WROTE");
  });

  it("allows and then denies a domain through the proxy", async (t) => {
    if (!ready(t)) return;
    const server = http.createServer((_request, response) => response.end("HELLO"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      // NO_PROXY exempts localhost, so force the request through the sandbox's proxy.
      const curl = `/usr/bin/curl -s -o /dev/null -w '%{http_code}' --noproxy '' -x "$HTTP_PROXY" http://localhost:${port}/`;
      assert.equal((await bash(curl)).out, "403", "not on the allowlist");

      addSessionGrant(state!, grant("allow-localhost", [{ op: "add-to-list", list: "network.allowedDomains", values: ["localhost"] }]));
      assert.equal((await bash(curl)).out, "200");

      addSessionGrant(state!, grant("deny-localhost", [{ op: "add-to-list", list: "network.deniedDomains", values: ["localhost"] }]));
      assert.equal((await bash(curl)).out, "403", "denies win over allows");

      removeSessionGrant(state!, "deny-localhost");
      assert.equal((await bash(curl)).out, "200");
      removeSessionGrant(state!, "allow-localhost");
      assert.equal((await bash(curl)).out, "403");
    } finally {
      server.close();
    }
  });

  it("refuses to re-point the restart-only switches, keeping the profile", async (t) => {
    if (!ready(t)) return;
    const off = testConfig((c) => (c.network.enabled = false));
    assert.throws(() => backend!.applyPolicy(off), /apply at restart/);
    const secret = path.join(secretDir, "token.txt");
    addSessionGrant(state!, grant("deny-secret", [{ op: "add-to-list", list: "filesystem.denyRead", values: [secretDir] }]));
    try {
      assert.notEqual((await bash(`cat '${secret}'`)).code, 0, "the profile in force is still the session's");
    } finally {
      removeSessionGrant(state!, "deny-secret");
    }
  });

  it("unsets a named variable for the next command, and restores it on revoke", async (t) => {
    if (!ready(t)) return;
    const name = "PI_RAIL_SESSION_SANDBOX_PROBE";
    process.env[name] = "visible";
    try {
      const show = `echo "\${${name}-unset}"`;
      assert.equal((await bash(show)).out, "visible");
      addSessionGrant(state!, grant("unset-probe", [{ op: "add-to-list", list: "environment.unset", values: [name] }]));
      assert.equal((await bash(show)).out, "unset");
      removeSessionGrant(state!, "unset-probe");
      assert.equal((await bash(show)).out, "visible");
    } finally {
      delete process.env[name];
    }
  });
});
