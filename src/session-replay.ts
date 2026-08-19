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
import {
  recordCapabilityDecided,
  recordCapabilityHits,
  recordCapabilityOutcome,
  recordScreenVerdict,
  type CapabilityOutcome,
  type CapabilityState,
} from "./capabilities.ts";
import { addSessionGuidance, addUserGuidance, clearSessionGuidance } from "./classifier.ts";
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
  type DecisionEntry,
  type RailStats,
  type RuntimeState,
} from "./state.ts";
import { RAIL_TELEMETRY_TYPE, type RailApprovalTelemetry, type RailErrorTelemetry, type RailGuidanceTelemetry, type RailReviewTelemetry, type UserAnswer } from "./telemetry.ts";

/** The slice of RuntimeState that is a pure function of the session branch. */
export interface DerivedRailState {
  stats: RailStats;
  /** The rebuilt decision spine; the state.ts views (recentEvents, …) slice it exactly as they slice the live one. */
  decisions: DecisionEntry[];
  /**
   * Per-class stats (hits/decided/outcomes/screen verdicts): the
   * "Capabilities seen this session" table. Only the stats HALF of
   * state.capabilities — the settings half (overrides, preset, custom
   * classes) is deliberately not here; see applyDerivedRailState.
   */
  capabilityStats: CapabilityState["stats"];
  sessionGuidance: string[] | undefined;
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
    decisions: scratch.decisions,
    capabilityStats: scratch.capabilities.stats,
    sessionGuidance: scratch.classifier.sessionGuidance,
  };
}

/**
 * Derives from the branch and installs the result on the live state.
 *
 * Scope is deliberately narrow — only the branch-derived memory. Process and
 * session infrastructure (approvalMailbox, backend, config, warnings,
 * dialogQueue, liveView) is untouched, as is state.approvals — path
 * approvals are session-scoped by design and hold however the leaf moves.
 * state.capabilities splits down the middle: its stats half (hits, decided,
 * outcomes, screen verdicts — what the "Capabilities seen this session"
 * table shows) is a record of branch decisions and is replaced here, while
 * its settings half (disposition overrides, the preset, custom classes,
 * definition edits) is user configuration, not memory, and is never touched
 * by replay.
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
  state.decisions = derived.decisions;
  // Stats only: the surrounding CapabilityState (overrides/preset/custom
  // classes) keeps its identity and its settings.
  state.capabilities.stats = derived.capabilityStats;
  state.classifier.sessionGuidance = derived.sessionGuidance;
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

/** Mirrors the finish() path of enforceCapabilities: skip counter, capability decision, guidance. */
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
  recordCapabilityOutcome(scratch.capabilities, record.labels, reviewOutcome(record));
  if (typeof record.screenTripped === "boolean") recordScreenVerdict(scratch.capabilities, record.labels, record.screenTripped);
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
}

/**
 * Reconstructs the CapabilityOutcome the live finish() recorded, from fields
 * that survive every redaction tier. The mapping inverts enforceCapabilities:
 * judge participation is the `judge` sub-object (stripToMemoryCore keeps its
 * verdict and reason even at "off"), an answered ask is `userAnswer`, and the
 * one ambiguous shape — decision "deny" with no answer — splits on why: a
 * judge deny or a table deny is a deny outcome, while anything else was an
 * ask nobody could answer (headless, mailbox gone), which live files as
 * ask-denied.
 */
function reviewOutcome(record: RailReviewTelemetry): CapabilityOutcome {
  // A stop is never judge-tagged live: the user interrupted rather than answered.
  if (record.userAnswer === "stopped") return "ask-stopped";
  if (record.userAnswer !== undefined) return record.judge ? "judge-ask" : record.userAnswer === "approved" ? "ask-approved" : "ask-denied";
  if (record.decision === "allow") return record.judge ? "judge-allow" : "allow";
  if (record.judge) return record.judge.verdict === "deny" ? "judge-deny" : "ask-denied";
  return record.resolvedDisposition === "deny" ? "deny" : "ask-denied";
}

/** How the path dialog's tri-state answer lands in per-class outcomes; mirrors PATH_OUTCOMES in the interceptor. */
const PATH_ASK_OUTCOMES: Record<UserAnswer, CapabilityOutcome> = { approved: "ask-approved", denied: "ask-denied", stopped: "ask-stopped" };

/**
 * Mirrors askPathApproval: one persisted record stands for the whole
 * request→answer exchange, so replay re-runs the same helper sequence the
 * dialog did (requested always; then granted, stopped, or denied). A
 * `remembered` record is the exception — session path memory answered without
 * a dialog, and live records no counters, ring events, or guidance for those,
 * only the per-class stats.
 */
function replayApproval(scratch: RuntimeState, raw: Record<string, unknown>, at: number): void {
  if ((raw.access !== "read" && raw.access !== "write") || typeof raw.path !== "string" || !USER_ANSWERS.has(raw.outcome as string)) return;
  const record = raw as unknown as RailApprovalTelemetry;
  const kind = record.access as AccessKind;
  if (record.remembered !== true) {
    recordApprovalRequested(scratch, record.tool, kind, record.path, at);
    if (record.outcome === "approved") recordApprovalGranted(scratch, record.tool, kind, record.path, at);
    else if (record.outcome === "stopped") recordApprovalStopped(scratch, record.tool, kind, record.path, at);
    else recordApprovalDenied(scratch);
    // A stop is not an answer, so it carries no guidance — same rule as live.
    if (record.userComment && record.outcome !== "stopped") {
      addSessionGuidance(scratch.classifier, record.outcome === "approved" ? "allowed" : "denied", record.tool, `${kind} ${record.path}`, record.userComment);
    }
  }
  // Labels mean the disposition table routed a capability ask to this dialog,
  // whose per-class stats the interceptor records outside askPathApproval; a
  // plain stage-1 path ask carries none and records none live either.
  if (isStringArray(record.labels)) {
    recordCapabilityHits(scratch.capabilities, record.labels);
    if (typeof record.decidedBy === "string") recordCapabilityDecided(scratch.capabilities, record.decidedBy);
    recordCapabilityOutcome(scratch.capabilities, record.labels, PATH_ASK_OUTCOMES[record.outcome]);
    if (typeof record.screenTripped === "boolean") recordScreenVerdict(scratch.capabilities, record.labels, record.screenTripped);
  }
}
