import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedRailConfig } from "../config.ts";
import type { DegradedPattern } from "../policy.ts";

export interface WrappedCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  diagnostics?: string[];
}

/** The policy a backend actually enforces after it expands and augments the configured one. */
export interface EffectivePolicy {
  filesystem: {
    allowRead: string[];
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
    /** Config patterns this backend's sandbox cannot express faithfully. */
    degraded: DegradedPattern[];
  };
  network: {
    allowedDomains: string[];
  };
}

/** applyPolicy failed and the backend could not put its previous policy back either: what it enforces is unknown. */
export class SandboxStaleError extends Error {
  override name = "SandboxStaleError";
}

export interface RailBackend {
  name: string;
  supported(): Promise<{ ok: true } | { ok: false; reason: string }>;
  initialize(config: ResolvedRailConfig, ctx: ExtensionContext): Promise<void>;
  wrapBash(command: string, cwd: string, env: Record<string, string>): Promise<WrappedCommand>;
  /**
   * Re-points an initialized backend at `config`'s sandbox-backed lists
   * (filesystem.*, network.*Domains, environment.*) for every command wrapped
   * from now on. Synchronous, so the caller can make the same config visible
   * to the file tools in the same step (src/session-policy.ts,
   * commitPolicyChange). All or nothing: on a throw the backend still
   * enforces exactly what it enforced before the call, or — when even that
   * could not be restored — the error is a SandboxStaleError and the caller
   * must stop running commands. Settings the backend fixes at initialize
   * (filesystem.enabled, network.enabled, seatbelt overrides) are not lists
   * and are rejected when they differ.
   */
  applyPolicy(config: ResolvedRailConfig): void;
  /** Returns the expanded policy this backend enforces, or undefined if it enforces nothing beyond the config. */
  describeEffectivePolicy(config: ResolvedRailConfig): EffectivePolicy | undefined;
  shutdown(): Promise<void>;
}
