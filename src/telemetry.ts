// Rail decision telemetry. Records every rail decision as a `custom` entry
// in pi's own session log (customType "rail"; "guard" before the rename, still
// read by eval/session-stats.ts) so real sessions become a
// corpus for analyzing and improving the classifier. Entries sit next to the
// tool call they judged, do not participate in LLM context, and are written
// best-effort: telemetry must never block, delay, or break a tool call.
//
// Privacy: the session file already contains the full tool call input and its
// result, so a minimized projection adds little exposure — but sessions can be
// shared (`pi share` uploads the whole file), so the default "minimal" tier
// truncates projected values. "full" keeps complete projections and policy
// summaries for eval-case extraction; "off" writes nothing.
import type { CapabilityId, Disposition } from "./capabilities.ts";
import type { RailDecision, RailOutcome, ReviewProjection } from "./classifier-protocol.ts";
import type { ResolvedRailConfig } from "./config.ts";
import type { RuntimeState } from "./state.ts";
import { textPrefix } from "./util.ts";

export const RAIL_TELEMETRY_TYPE = "rail";
/**
 * The customType written before the pi-guard → pi-rail rename. Never written
 * again; readers that mine session corpora (eval/session-stats.ts) must accept
 * it, or every session recorded before the rename stops being analyzable.
 */
export const LEGACY_RAIL_TELEMETRY_TYPE = "guard";
/** Both customTypes a rail telemetry record can appear under in a session log. */
export const RAIL_TELEMETRY_TYPES: readonly string[] = [RAIL_TELEMETRY_TYPE, LEGACY_RAIL_TELEMETRY_TYPE];

const MINIMAL_VALUE_LIMIT = 200;

export type RailTelemetryMode = "off" | "minimal" | "full";

/** How a user disposed of an approval prompt. "stopped" is the stop key, which is not an answer. */
export type UserAnswer = "approved" | "denied" | "stopped";

export interface RailTelemetryBase {
  kind: "review" | "block" | "approval" | "error";
  tool: string;
}

/** The escalation review, when the resolved disposition was `judge`. */
export interface RailJudgeTelemetry {
  model?: string;
  verdict: RailDecision;
  latencyMs: number;
  attempts?: number;
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

export interface RailReviewTelemetry extends RailTelemetryBase {
  kind: "review";
  /** What actually happened to the call after the table (and judge) decided, and the user answered. */
  decision: RailOutcome;
  /** Capability classes the action was named with, deterministic and model labels together. */
  labels: CapabilityId[];
  /** Severity-max result of the disposition table over those labels. */
  resolvedDisposition: Disposition;
  /** The label that produced the winning disposition. */
  decidedBy?: CapabilityId;
  /** Content-screen verdict for write/edit calls; absent when the screen did not apply. */
  screenTripped?: boolean;
  /** Quote the namer offered as evidence the user asked for this action. */
  authorizationEvidence?: string;
  attempts?: number;
  /** Namer latency; 0 when the labels were entirely deterministic. */
  latencyMs: number;
  /** Namer model. */
  model?: string;
  judge?: RailJudgeTelemetry;
  reason: string;
  /**
   * How the user answered an ask; absent when no ask was shown. "stopped" is
   * its own value rather than `approved: false`, because a corpus that counts
   * stops as refusals reads a jumpy user as a distrusted agent.
   */
  userAnswer?: UserAnswer;
  /** User comment attached to an allow/deny answer, if any. */
  userComment?: string;
  /** True when the answer came from the parent session via the approval mailbox (this session was a headless child). */
  forwarded?: boolean;
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  projection?: ReviewProjection;
}

export interface RailBlockTelemetry extends RailTelemetryBase {
  kind: "block";
  reason: string;
}

export interface RailApprovalTelemetry extends RailTelemetryBase {
  kind: "approval";
  access: string;
  path: string;
  /** Tri-state for the same reason as {@link RailReviewTelemetry.userAnswer}: a stop is not a denial. */
  outcome: UserAnswer;
  reason: string;
  /** User comment attached to an allow/deny answer, if any. */
  userComment?: string;
  /** True when the answer came from the parent session via the approval mailbox (this session was a headless child). */
  forwarded?: boolean;
}

export interface RailErrorTelemetry extends RailTelemetryBase {
  kind: "error";
  reason: string;
  /**
   * The cause bucket: "timeout", "server error", "connection", "unavailable",
   * "invalid response", … Named `failureKind` because `kind` is already the
   * record discriminant. Corpus analysis groups on this; `reason` carries the
   * specific status/code and the attempts burned.
   */
  failureKind: string;
  /** Model calls burned before giving up. */
  attempts?: number;
  latencyMs: number;
  model?: string;
}

export type RailTelemetryRecord =
  | RailReviewTelemetry
  | RailBlockTelemetry
  | RailApprovalTelemetry
  | RailErrorTelemetry;

export function telemetryMode(config: ResolvedRailConfig): RailTelemetryMode {
  return config.classifier.telemetry;
}

function truncateStrings(value: unknown, limit: number): unknown {
  if (typeof value === "string") return textPrefix(value, limit);
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item, limit));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = truncateStrings(item, limit);
    return out;
  }
  return value;
}

/** Applies the configured privacy tier to a record about to be persisted. */
export function redactTelemetryRecord(record: RailTelemetryRecord, mode: RailTelemetryMode): RailTelemetryRecord {
  if (mode === "full" || record.kind !== "review" || !record.projection) return record;
  return {
    ...record,
    projection: {
      ...record.projection,
      inputSummary: truncateStrings(record.projection.inputSummary, MINIMAL_VALUE_LIMIT) as Record<string, unknown>,
      policySummary: [],
    },
  };
}

/**
 * Persists a rail decision record to the session log via pi.appendEntry.
 * Never throws: session logging is observability, not enforcement, and
 * ephemeral sessions silently skip persistence inside SessionManager.
 */
export function appendRailTelemetry(state: RuntimeState, record: RailTelemetryRecord): void {
  const config = state.config;
  if (!config || telemetryMode(config) === "off" || !state.appendEntry) return;
  try {
    state.appendEntry(RAIL_TELEMETRY_TYPE, redactTelemetryRecord(record, telemetryMode(config)));
  } catch {
    // Best-effort: a session that cannot persist entries must not affect the tool call.
  }
}
