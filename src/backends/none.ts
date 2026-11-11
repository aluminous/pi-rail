import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedRailConfig } from "../config.ts";
import type { RailBackend, WrappedCommand } from "./types.ts";

export class NoneBackend implements RailBackend {
  name = "none";

  async supported(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async initialize(_config: ResolvedRailConfig, _ctx: ExtensionContext): Promise<void> {
    // Explicit no-op backend, useful for disabled/development flows.
  }

  async wrapBash(command: string, cwd: string, env: Record<string, string>): Promise<WrappedCommand> {
    return { command: "bash", args: ["-c", command], cwd, env };
  }

  applyPolicy(_config: ResolvedRailConfig): void {
    // Nothing is sandboxed, so there is nothing to re-point.
  }

  describeEffectivePolicy(): undefined {
    return undefined;
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}
