// Session replay: the rail's derived memory as a function of the session
// branch. pi's session is a tree — /tree navigation moves the current leaf
// backward AND forward between branches of the same file, /fork starts a new
// file from an entry, and sessions resume — while the rail's memory (the
// recent-decisions ring the judge reads, session guidance, stats) used to be
// in-memory only: navigation left it stale ("an action equivalent to one the
// user just denied" kept biasing the judge after the denial was navigated
// away from) and fork/resume wiped even the history that IS on the branch.
//
// The fix: the rail already writes every decision as a `custom` entry
// (customType "rail", src/telemetry.ts) parented under the branch where it
// happened, so the branch root→leaf is the authoritative record of what this
// timeline experienced. deriveRailState folds those entries into the derived
// state; index.ts applies it on session_start (resume/fork restore their
// prefix) and on session_tree (navigation rewinds and un-rewinds). There is
// no in-flight race to worry about: navigateTree cannot run mid-stream.
//
// Compatibility: none, by explicit decision. Replay reads only customType
// "rail" entries in the current record shapes; anything old-shaped (the
// legacy "guard" customType, records without the memory-core fields) or
// unparseable is silently skipped — a per-entry guard so one bad record never
// poisons the whole replay. Old sessions simply replay with whatever matches.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { addSessionGuidance, addUserGuidance, clearSessionGuidance, type LastRailDecision } from "./classifier.ts";
import type { AccessKind } from "./policy.ts";
import {
  createRuntimeState,
  recordApprovalDenied,
  recordApprovalGranted,
  recordApprovalRequested,
  recordApprovalStopped,
  recordCapabilityDecision,
  recordClassifierError,
  recordClassifierSkip,
  recordJudgement,
  recordPolicyBlock,
  resetTurnStats,
  type ClassificationRecord,
  type JudgementRecord,
  type RailEvent,
  type RailStats,
  type RuntimeState,
} from "./state.ts";
import { RAIL_TELEMETRY_TYPE, type RailApprovalTelemetry, type RailErrorTelemetry, type RailGuidanceTelemetry, type RailReviewTelemetry } from "./telemetry.ts";

/** The slice of RuntimeState that is a pure function of the session branch. */
export interface DerivedRailState {
  stats: RailStats;
  recent: RailEvent[];
  recentClassifications: ClassificationRecord[];
  recentJudgements: JudgementRecord[];
  sessionGuidance: string[] | undefined;
  lastDecision: LastRailDecision | undefined;
}

/**
 * Rebuilds the rail's derived memory from a session branch (root→leaf entry
 * list, as ctx.sessionManager.getBranch() returns it). Pure: same entries in,
 * same state out, so navigating A→B→A restores A's memory exactly.
 *
 * The fold runs the very same record* helpers the live path uses, against a
 * scratch RuntimeState — the one way to guarantee replayed counters and ring
 * entries cannot drift from what live recording would have produced. Event
 * timestamps come from the session entries themselves.
 */
export function deriveRailState(entries: readonly SessionEntry[]): DerivedRailState {
  const scratch = createRuntimeState();
  for (const entry of entries) {
    // Per-entry guard: replay is reconstruction, not enforcement, so a
    // malformed record forfeits only itself.
    try {
      if (entry.type !== "custom" || entry.customType !== RAIL_TELEMETRY_TYPE) continue;
      const parsed = Date.parse(entry.timestamp);
      replayRecord(scratch, entry.data, Number.isFinite(parsed) ? parsed : 0);
    } catch {
      // Skipped: one bad record never poisons the rest of the branch.
    }
  }
  // Turn counters are per-live-turn; a branch is not a turn, and agent_start
  // resets them anyway. Zero, not whatever the fold accumulated.
  resetTurnStats(scratch);
  return {
    stats: scratch.stats,
    recent: scratch.recent,
    recentClassifications: scratch.recentClassifications,
    recentJudgements: scratch.recentJudgements,
    sessionGuidance: scratch.classifier.sessionGuidance,
    lastDecision: scratch.classifier.lastDecision,
  };
}

/**
 * Derives from the branch and installs the result on the live state.
 *
 * Scope is deliberately narrow — only the branch-derived memory. Process and
 * session infrastructure (approvalMailbox, backend, config, warnings,
 * dialogQueue, liveView) is untouched, as are two session-scoped-by-design
 * stores that are NOT functions of the branch: state.approvals (path
 * approvals hold for the session however the leaf moves) and
 * state.capabilities (session disposition overrides are settings, not
 * memory; their per-class hit counters ride along).
 *
 * Stats consequently become per-branch: after navigation the counters
 * describe the current timeline, not everything the process ever did — which
 * is the more truthful reading of "this session's decisions". Token and
 * usage counters rebuild only from records that carry the telemetry detail
 * tier; with telemetry off they read zero, and per-model usage
 * (stats.modelUsage) is not reconstructed at all — model-call accounting is
 * recorded where calls return, including calls whose decision never produced
 * a review record, so any rebuild would be a guess. The cost tab restarts at
 * navigation rather than lie.
 */
export function applyDerivedRailState(state: RuntimeState, entries: readonly SessionEntry[]): void {
  const derived = deriveRailState(entries);
  state.stats = derived.stats;
  state.recent = derived.recent;
  state.recentClassifications = derived.recentClassifications;
  state.recentJudgements = derived.recentJudgements;
  state.classifier.sessionGuidance = derived.sessionGuidance;
  state.classifier.lastDecision = derived.lastDecision;
  // Traces carry per-stage detail (policy matches, namer evidence, dialog
  // outcomes) that is never persisted, so they cannot be rebuilt: cleared on
  // navigation rather than left describing a branch the user left.
  state.traces = [];
}

const RAIL_OUTCOMES = new Set(["allow", "deny", "ask", "stop"]);
const RAIL_DECISIONS = new Set(["allow", "deny", "ask"]);
const DISPOSITIONS = new Set(["allow", "judge", "ask", "deny"]);
const USER_ANSWERS = new Set(["approved", "denied", "stopped"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * One record into the scratch state. The shape checks below are the no-legacy
 * line: a record must carry the current memory-core fields (e.g. `reviewed`,
 * `target`, `subject` on reviews; `verdict`+`reason` on judges) or it is
 * skipped whole — no userApproved/approved boolean fallbacks, no "guard"
 * customType, no partial credit.
 */
function replayRecord(scratch: RuntimeState, data: unknown, at: number): void {
  if (!data || typeof data !== "object") return;
  const record = data as Record<string, unknown>;
  if (typeof record.tool !== "string") return;
  switch (record.kind) {
    case "review":
      replayReview(scratch, record, at);
      return;
    case "approval":
      replayApproval(scratch, record, at);
      return;
    case "block":
      if (typeof record.reason === "string") recordPolicyBlock(scratch, record.tool as string, record.reason, at);
      return;
    case "error":
      if (typeof record.reason === "string" && typeof (record as Partial<RailErrorTelemetry>).failureKind === "string") {
        recordClassifierError(scratch, record.tool as string, record.reason, record.failureKind as string, at);
      }
      return;
    case "guidance": {
      const guidance = record as Partial<RailGuidanceTelemetry>;
      if (guidance.cleared === true) clearSessionGuidance(scratch.classifier);
      else if (typeof guidance.text === "string") addUserGuidance(scratch.classifier, guidance.text);
      return;
    }
    default:
      return;
  }
}

/** Mirrors the finish() path of enforceCapabilities: skip counter, capability decision, guidance, last decision. */
function replayReview(scratch: RuntimeState, raw: Record<string, unknown>, at: number): void {
  if (
    !RAIL_OUTCOMES.has(raw.decision as string) ||
    !isStringArray(raw.labels) ||
    !DISPOSITIONS.has(raw.resolvedDisposition as string) ||
    typeof raw.reason !== "string" ||
    typeof raw.reviewed !== "boolean" ||
    typeof raw.target !== "string" ||
    typeof raw.subject !== "string"
  ) {
    return;
  }
  const record = raw as unknown as RailReviewTelemetry;
  if (record.judge && (!RAIL_DECISIONS.has(record.judge.verdict) || typeof record.judge.reason !== "string")) return;

  if (!record.reviewed && record.resolvedDisposition === "allow") recordClassifierSkip(scratch);
  recordCapabilityDecision(scratch, record.tool, {
    at,
    target: record.target,
    labels: record.labels,
    decision: record.decision,
    disposition: record.resolvedDisposition,
    decidedBy: typeof record.decidedBy === "string" ? record.decidedBy : undefined,
    reason: record.reason,
    reviewed: record.reviewed,
    tokenUsage: record.usage,
    // The live ring shows the whole review's latency, namer plus judge; the
    // record keeps them apart (detail tier), so recombine here.
    latencyMs: (record.latencyMs ?? 0) + (record.judge?.latencyMs ?? 0),
    model: record.model,
  });
  if (record.judge) {
    recordJudgement(scratch, {
      at,
      toolName: record.tool,
      target: record.target,
      labels: record.labels,
      verdict: record.judge.verdict,
      reason: record.judge.reason,
      latencyMs: record.judge.latencyMs ?? 0,
      inputTokens: record.judge.usage?.input ?? 0,
      outputTokens: record.judge.usage?.output ?? 0,
      model: record.judge.model,
    });
  }
  if (record.userComment && (record.userAnswer === "approved" || record.userAnswer === "denied")) {
    addSessionGuidance(scratch.classifier, record.userAnswer === "approved" ? "allowed" : "denied", record.tool, record.subject, record.userComment);
  }
  scratch.classifier.lastDecision = { toolName: record.tool, at, labels: record.labels, decision: record.decision, reason: record.reason };
}

/**
 * Mirrors askPathApproval: one persisted record stands for the whole
 * request→answer exchange, so replay re-runs the same helper sequence the
 * dialog did (requested always; then granted, stopped, or denied).
 */
function replayApproval(scratch: RuntimeState, raw: Record<string, unknown>, at: number): void {
  if ((raw.access !== "read" && raw.access !== "write") || typeof raw.path !== "string" || !USER_ANSWERS.has(raw.outcome as string)) return;
  const record = raw as unknown as RailApprovalTelemetry;
  const kind = record.access as AccessKind;
  recordApprovalRequested(scratch, record.tool, kind, record.path, at);
  if (record.outcome === "approved") recordApprovalGranted(scratch, record.tool, kind, record.path, at);
  else if (record.outcome === "stopped") recordApprovalStopped(scratch, record.tool, kind, record.path, at);
  else recordApprovalDenied(scratch);
  // A stop is not an answer, so it carries no guidance — same rule as live.
  if (record.userComment && record.outcome !== "stopped") {
    addSessionGuidance(scratch.classifier, record.outcome === "approved" ? "allowed" : "denied", record.tool, `${kind} ${record.path}`, record.userComment);
  }
}
