import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type ResolvedRailConfig } from "../src/config.ts";

// Tests may run inside an interactive rail session whose approval mailbox is
// advertised in the environment; inheriting it would make every "headless"
// assertion forward its ask to the developer's own dialog. Same rationale as
// the PI_CODING_AGENT_DIR redirect below: isolation must hold before anything
// else runs.
delete process.env.PI_RAIL_APPROVAL_MAILBOX;

export function testConfig(overrides?: (config: ResolvedRailConfig) => void): ResolvedRailConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  overrides?.(config);
  return config;
}

export function makeFixtureDir(): { dir: string; cleanup: () => void } {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "pi-rail-test-")));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

/**
 * Points the agent dir at a throwaway fixture. The redirect is asserted here:
 * if the env var ever stops being honoured, tests that write config must fail
 * rather than quietly start editing the developer's real rail.json.
 */
function enterTempAgentDir(): { dir: string; exit: () => void } {
  const fixture = makeFixtureDir();
  const previous = process.env[ENV_AGENT_DIR];
  process.env[ENV_AGENT_DIR] = fixture.dir;
  assert.equal(getAgentDir(), fixture.dir, "the agent dir redirect must hold before any write");
  return {
    dir: fixture.dir,
    exit: () => {
      if (previous === undefined) delete process.env[ENV_AGENT_DIR];
      else process.env[ENV_AGENT_DIR] = previous;
      fixture.cleanup();
    },
  };
}

/** Runs fn against a throwaway agent dir, then restores the environment. */
export function withTempAgentDir(fn: (agentDir: string) => void): void {
  const fixture = enterTempAgentDir();
  try {
    fn(fixture.dir);
  } finally {
    fixture.exit();
  }
}

/** withTempAgentDir for command handlers, which are async: the restore waits for them. */
export async function withTempAgentDirAsync(fn: (agentDir: string) => Promise<void>): Promise<void> {
  const fixture = enterTempAgentDir();
  try {
    await fn(fixture.dir);
  } finally {
    fixture.exit();
  }
}
