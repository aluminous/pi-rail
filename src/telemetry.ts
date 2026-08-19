// Rail decision records. Every rail decision lands as a `custom` entry in
// pi's own session log (customType "rail"; "guard" before the rename, still
// read by eval/session-stats.ts). The records serve two masters:
//
// 1. Session memory. The rail's own derived state — recent-decisions ring,
//    session guidance, stats — is a function of the current session branch
//    (src/session-replay.ts): /tree navigation, /fork, and resume all rebuild
//    it from these entries, which live in the tree exactly where they
//    happened. The memory core of each record (kind, tool, decision/outcome,
//    labels, reason, userAnswer, comment) is therefore ALWAYS written,
//    regardless of the telemetry setting: the rail cannot let a privacy
//    preference amputate its own memory.
// 2. Telemetry. Real sessions become a corpus for analyzing and improving
//    the classifier. The `classifier.telemetry` setting gates only this extra
//    detail — projections, token usage, latency, models — not the memory core.
//
// Entries sit next to the tool call they judged, do not participate in LLM
// context, and are written best-effort: logging must never block, delay, or
// break a tool call.
//
// Privacy: the session file already contains the full tool call input and its
// result, so a minimized projection adds little exposure — but sessions can be
// shared (`pi share` uploads the whole file), so the default "minimal" tier
// truncates projected values. "full" keeps complete projections and policy
// summaries for eval-case extraction; "off" strips everything but the memory
// core (the reasons the memory core keeps are strings the user already saw in
// dialogs and blocks).
import type { CapabilityId, Disposition } from "./capabilities.ts";
import type { RailDecision, RailOutcome, ReviewProjection } from "./classifier-protocol.ts";
import type { ResolvedRailConfig } from "./config.ts";
import type { RuntimeState } from "./state.ts";
import { textPrefix } from "./util.ts";

export const RAIL_TELEMETRY_TYPE = "rail";

const MINIMAL_VALUE_LIMIT = 200;

export type RailTelemetryMode = "off" | "minimal" | "full";

/** How a user disposed of an approval prompt. "stopped" is the stop key, which is not an answer. */
export type UserAnswer = "approved" | "denied" | "stopped";

export interface RailTelemetryBase {
  kind: "review" | "block" | "approval" | "error" | "guidance";
  tool: string;
}

/** The escalation review, when the resolved disposition was `judge`. */
export interface RailJudgeTelemetry {
  model?: string;
  verdict: RailDecision;
  /** The judge's own explanation — memory core: it is what the judgement ring replays. */
  reason: string;
  /** Detail tier only; absent when telemetry is off. */
  latencyMs?: number;
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
  /**
   * The command or path the call was about (actionTarget, truncated) — memory
   * core: session replay rebuilds the recent-review rings from it.
   */
  target: string;
  /**
   * What the approval dialog and session guidance call the action (describeAction
   * without the tool-name prefix) — memory core: replay rebuilds guidance
   * entries from it, and it must match what the live path fed addSessionGuidance
   * or the rebuilt guidance would drift from what the user actually answered.
   */
  subject: string;
  /**
   * True when a model (namer and/or judge) took part in the decision — memory
   * core: replay needs it to split rule hits from classifier hits, and it is
   * not derivable from `model` (a namer call can fail model resolution yet
   * still review) or from the detail tier (stripped when telemetry is off).
   */
  reviewed: boolean;
  /** Content-screen verdict for write/edit calls; absent when the screen did not apply. */
  screenTripped?: boolean;
  /** Quote the namer offered as evidence the user asked for this action. */
  authorizationEvidence?: string;
  attempts?: number;
  /** Namer latency; 0 when the labels were entirely deterministic. Detail tier: absent when telemetry is off. */
  latencyMs?: number;
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
  /** Detail tier only; absent when telemetry is off. */
  latencyMs?: number;
  model?: string;
}

/**
 * `/rail guide` traffic. Persisted so session replay can rebuild the guidance
 * ring exactly: volunteered guidance and clears live in the tree at the point
 * they happened, so /tree navigation rewinds (and un-rewinds) them like any
 * approval comment.
 */
export interface RailGuidanceTelemetry extends RailTelemetryBase {
  kind: "guidance";
  /** The volunteered guidance text; absent on a clear. */
  text?: string;
  /** True when the user dropped every guidance entry (`/rail guide clear`). */
  cleared?: boolean;
}

export type RailTelemetryRecord =
  | RailReviewTelemetry
  | RailBlockTelemetry
  | RailApprovalTelemetry
  | RailErrorTelemetry
  | RailGuidanceTelemetry;

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

/**
 * Applies the configured privacy tier to a record about to be persisted.
 *
 * "off" does not mean "write nothing" — the memory core is what session
 * replay (src/session-replay.ts) rebuilds the rail's derived state from, so
 * it survives every tier. "off" strips the telemetry detail: projections,
 * token usage, latency, models, attempts, screen verdicts, and the namer's
 * evidence quote. The keys are dropped rather than zeroed so a corpus reader
 * cannot mistake "not recorded" for "measured as zero".
 */
export function redactTelemetryRecord(record: RailTelemetryRecord, mode: RailTelemetryMode): RailTelemetryRecord {
  if (mode === "off") return stripToMemoryCore(record);
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

/** The fields session replay feeds on, and nothing else. Block, approval, and guidance records are all core already. */
function stripToMemoryCore(record: RailTelemetryRecord): RailTelemetryRecord {
  if (record.kind === "review") {
    return {
      kind: "review",
      tool: record.tool,
      decision: record.decision,
      labels: record.labels,
      resolvedDisposition: record.resolvedDisposition,
      ...(record.decidedBy !== undefined ? { decidedBy: record.decidedBy } : {}),
      target: record.target,
      subject: record.subject,
      reviewed: record.reviewed,
      reason: record.reason,
      ...(record.judge ? { judge: { verdict: record.judge.verdict, reason: record.judge.reason } } : {}),
      ...(record.userAnswer !== undefined ? { userAnswer: record.userAnswer } : {}),
      ...(record.userComment !== undefined ? { userComment: record.userComment } : {}),
      ...(record.forwarded !== undefined ? { forwarded: record.forwarded } : {}),
    };
  }
  if (record.kind === "error") {
    return { kind: "error", tool: record.tool, reason: record.reason, failureKind: record.failureKind };
  }
  return record;
}

/**
 * Persists a rail decision record to the session log via pi.appendEntry.
 * Always writes when a session is wired: the records are the rail's own
 * memory (session replay derives state.recent, guidance, and stats from
 * them), so the telemetry setting only chooses the redaction tier — it can
 * no longer suppress the write. Never throws: session logging is
 * observability, not enforcement, and ephemeral sessions silently skip
 * persistence inside SessionManager.
 */
export function appendRailTelemetry(state: RuntimeState, record: RailTelemetryRecord): void {
  if (!state.appendEntry) return;
  // No config (a not-yet-initialized session) redacts like "off": memory core only.
  const mode = state.config ? telemetryMode(state.config) : "off";
  try {
    state.appendEntry(RAIL_TELEMETRY_TYPE, redactTelemetryRecord(record, mode));
  } catch {
    // Best-effort: a session that cannot persist entries must not affect the tool call.
  }
}
