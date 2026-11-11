import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { ResolvedRailConfig } from "../config.ts";
import { scrubEnvironment } from "../policy.ts";
import type { RailBackend } from "../backends/types.ts";

export function createSandboxedBashOps(params: {
  backend: RailBackend;
  /**
   * Read when a command starts, not when the ops are created: the scrub must
   * use the same policy the backend wraps with in the same tick, or a policy
   * change committed in between (src/session-policy.ts) would scrub with one
   * environment list and sandbox with another.
   */
  config: () => ResolvedRailConfig;
  enabled: () => boolean;
  initialized: () => boolean;
  lastError: () => string | undefined;
  /** Called as a sandboxed command starts; the returned function marks its end (for /rail why's log window). */
  recordCommand?: (command: string) => () => void;
}): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      if (!params.enabled()) throw new Error("Rail is disabled");
      if (!params.initialized()) throw new Error(`Rail is not initialized${params.lastError() ? `: ${params.lastError()}` : ""}`);

      const scrubbedEnv = scrubEnvironment(env, params.config());
      const wrapped = await params.backend.wrapBash(command, cwd, scrubbedEnv);
      const recordEnd = params.recordCommand?.(command);

      return new Promise((resolve, reject) => {
        const child = spawn(wrapped.command, wrapped.args, {
          cwd: wrapped.cwd,
          env: wrapped.env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let settled = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        const killProcessGroup = () => {
          if (!child.pid) return;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killProcessGroup();
          }, timeout * 1000);
        }

        const onAbort = () => killProcessGroup();
        signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          recordEnd?.();
          reject(error);
        });

        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          recordEnd?.();

          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      });
    },
  };
}
