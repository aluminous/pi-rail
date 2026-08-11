import type { AccessKind } from "./policy.ts";
import { textPrefix } from "./util.ts";

export interface InterceptedToolSpec {
  /** Path access checks the interceptor runs for this tool, in order. */
  access: AccessKind[];
  /** Extracts the filesystem path this call touches, when the tool takes one. */
  path?(input: Record<string, unknown>): string | undefined;
  /** Low-context input summary sent to the classifier. */
  project(input: Record<string, unknown>): Record<string, unknown>;
}

function pathParam(input: Record<string, unknown>): string | undefined {
  return typeof input.path === "string" ? input.path : undefined;
}

/**
 * Compact "tool: action" line for approval dialogs and session guidance,
 * built from a projection's inputSummary so both always describe the same
 * thing the classifier reviewed.
 */
export function describeAction(toolName: string, inputSummary: Record<string, unknown>): string {
  if (typeof inputSummary.command === "string" && inputSummary.command) {
    return `${toolName}: ${textPrefix(inputSummary.command, 300)}`;
  }
  if (typeof inputSummary.path === "string" && inputSummary.path) {
    const writes = typeof inputSummary.contentLength === "number" ? ` (writes ${inputSummary.contentLength} chars)` : "";
    return `${toolName}: ${inputSummary.path}${writes}`;
  }
  return toolName;
}

/**
 * The command or path a call is about, without the tool-name prefix — the
 * recent-decision rings show the tool in its own column. Truncated like
 * telemetry's minimal tier: the status page is user-only, but the rings
 * outlive the call and a full command line would dominate the state dump.
 */
export function actionTarget(toolName: string, input: unknown): string {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const projected = INTERCEPTED_TOOLS[toolName]?.project(record) ?? {};
  if (typeof projected.command === "string" && projected.command) return textPrefix(projected.command, 120);
  if (typeof projected.path === "string" && projected.path) return textPrefix(projected.path, 120);
  return "";
}

export const INTERCEPTED_TOOLS: Record<string, InterceptedToolSpec> = {
  bash: {
    access: [],
    project: (input) => ({ command: typeof input.command === "string" ? input.command : "", timeout: input.timeout }),
  },
  read: {
    access: ["read"],
    path: pathParam,
    project: (input) => ({ path: input.path }),
  },
  write: {
    access: ["write"],
    path: pathParam,
    project: (input) => {
      const content = typeof input.content === "string" ? input.content : "";
      // Generous prefix: content-level attacks (authorization planting, agent
      // instructions) hide in body text that a short prefix would cut off.
      return { path: input.path, contentLength: content.length, contentPrefix: textPrefix(content, 1000) };
    },
  },
  edit: {
    access: ["read", "write"],
    path: pathParam,
    project: (input) => {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      return {
        path: input.path,
        editCount: edits.length,
        edits: edits.slice(0, 3).map((edit) => {
          const e = edit && typeof edit === "object" ? (edit as Record<string, unknown>) : {};
          return {
            oldTextPrefix: typeof e.oldText === "string" ? textPrefix(e.oldText, 160) : undefined,
            newTextPrefix: typeof e.newText === "string" ? textPrefix(e.newText, 160) : undefined,
          };
        }),
      };
    },
  },
};
