import type { RailBackend } from "./backends/types.ts";
import {
  applyReadOnlyPreset,
  clearPreset,
  createCapabilityState,
  recordCapabilityDecided,
  recordCapabilityHits,
  type CapabilityId,
  type CapabilityState,
  type Disposition,
} from "./capabilities.ts";
import type { ClassifierTokenUsage, RailDecision } from "./classifier-protocol.ts";
import type { ClassifierState } from "./classifier.ts";
import type { ResolvedRailConfig } from "./config.ts";
import { TRACE_LIMIT, type DecisionTrace } from "./decision-trace.ts";
import type { AccessKind } from "./policy.ts";

export interface RailEvent {
  at: number;
  toolName: string;
  decision: "allow" | "deny" | "ask" | "block" | "error";
  /** Capability labels behind the decision, when it came from the table. */
  capabilities?: CapabilityId[];
  reason: string;
}

/** Which reviewer made a model call: the cheap namer, or the judge the table escalates to. */
export type ReviewerRole = "namer" | "judge";

/**
 * Token, dollar, and latency accounting for one model in one reviewer role.
 * Namer and judge are kept apart even on the same model spec: "what does
 * classification cost" and "what does escalation cost" are different questions,
 * and a session where judge:current is the session's own strong model would
 * otherwise average the two together.
 */
export interface ModelUsageStats {
  /** provider/id, or "unknown" when the spec could not be resolved at call time. */
  model: string;
  role: ReviewerRole;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Dollars, summed over the calls the provider actually priced. */
  costUsd: number;
  /** Calls whose usage carried no price, so a cost total can say how much of the session it covers. */
  unpricedCalls: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
}

/** How many entries the recent-classification and recent-judgement rings keep. */
export const REVIEW_RING_LIMIT = 20;

/** One resolved capability decision, as the namer tab lists them. */
export interface ClassificationRecord {
  at: number;
  toolName: string;
  /** The command or path the call was about (truncated); "" when the tool has neither. */
  target: string;
  labels: CapabilityId[];
  /** What the table resolved over those labels, before a judge or the user answered. */
  disposition: Disposition;
  decision: RailDecision;
  /** The whole review's latency — namer plus judge; 0 when the labels were entirely deterministic. */
  latencyMs: number;
  /** The whole review's tokens, judge included; the judge tab breaks out its own share. */
  inputTokens: number;
  outputTokens: number;
  /** Namer model; absent when the labels were deterministic (a `judge` disposition still means the judge ran). */
  model?: string;
}

/** One escalation review, as the judge tab lists them. */
export interface JudgementRecord {
  at: number;
  toolName: string;
  /** The command or path the call was about (truncated); "" when the tool has neither. */
  target: string;
  labels: CapabilityId[];
  verdict: RailDecision;
  reason: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  model?: string;
}

export interface RailStats {
  reviewed: number;
  allowed: number;
  denied: number;
  asked: number;
  blocked: number;
  errors: number;
  /** Classifier failures bucketed by cause ("timeout", "server error", "connection", …); only kinds actually seen appear. */
  errorsByKind: Record<string, number>;
  ruleHits: number;
  classifierHits: number;
  classifierDenials: number;
  /** Reads and allowlisted commands exempted from classifier review deterministically. */
  classifierSkips: number;
  classifierInputTokens: number;
  classifierOutputTokens: number;
  /** Input tokens served from the provider prompt cache (subset of total prompt tokens, not of classifierInputTokens). */
  classifierCacheReadTokens: number;
  classifierCacheWriteTokens: number;
  /** Per-model, per-role accounting, keyed "<role>:<model>"; only models actually called appear. */
  modelUsage: Record<string, ModelUsageStats>;
  turnRuleHits: number;
  turnClassifierHits: number;
  turnClassifierDenials: number;
  turnBlocked: number;
}

/** "status"/"policy" are the toggleable live views; "report" is one-shot output (smoke, critique). */
export type RailViewKind = "status" | "policy" | "report";

/**
 * An open live rail view — a TUI overlay popup or an RPC widget.
 * refresh() re-renders content from current state, close() dismisses it.
 */
export interface RailLiveView {
  kind: RailViewKind;
  refresh(): void;
  close(): void;
  /**
   * Tabbed panels only (the policy page): retarget the open panel instead of
   * closing it, so `/rail policy rules` with the dispositions tab up switches
   * tabs rather than toggling the whole panel away.
   */
  selectTab?(tab: string): void;
  activeTab?(): string;
}

export interface RuntimeState {
  config: ResolvedRailConfig | undefined;
  backend: RailBackend | undefined;
  enabled: boolean;
  disabledForNextAgent: boolean;
  /** Session read-only mode: write/edit blocked, bash named-and-judged under the read-only disposition preset (blocked if the classifier is off). */
  readOnly: boolean;
  initialized: boolean;
  lastError: string | undefined;
  warnings: string[];
  classifier: ClassifierState;
  /** Session disposition overrides, the read-only preset, and per-class stats. */
  capabilities: CapabilityState;
  /** Open live status/policy view (TUI overlay or RPC widget), if any. */
  liveView?: RailLiveView;
  approvals: {
    read: string[];
    write: string[];
  };
  stats: RailStats;
  recent: RailEvent[];
  /** Resolved capability decisions, newest first (last REVIEW_RING_LIMIT): the status page's namer tab. */
  recentClassifications: ClassificationRecord[];
  /** Escalation reviews, newest first (last REVIEW_RING_LIMIT): the status page's judge tab. */
  recentJudgements: JudgementRecord[];
  /** Per-call decision traces for /rail explain, newest first (last TRACE_LIMIT). */
  traces: DecisionTrace[];
  /** Most recent sandboxed bash execution, for the /rail why sandbox-denial window. */
  lastBashCommand?: { command: string; startedAt: number; endedAt?: number };
  /** provider/id specs with configured auth, cached at session start for argument completions (which get no ctx). */
  availableModelSpecs: string[];
  /** Child identities (session file/transcript) already warned about running without rail acknowledgement. */
  subagentAckWarned: Set<string>;
  /** Writes a custom entry to pi's session log (pi.appendEntry). Undefined in tests without session wiring. */
  appendEntry?: (customType: string, data: unknown) => void;
}

export function createRailStats(): RailStats {
  return {
    reviewed: 0,
    allowed: 0,
    denied: 0,
    asked: 0,
    blocked: 0,
    errors: 0,
    errorsByKind: {},
    ruleHits: 0,
    classifierHits: 0,
    classifierDenials: 0,
    classifierSkips: 0,
    classifierInputTokens: 0,
    classifierOutputTokens: 0,
    classifierCacheReadTokens: 0,
    classifierCacheWriteTokens: 0,
    modelUsage: {},
    turnRuleHits: 0,
    turnClassifierHits: 0,
    turnClassifierDenials: 0,
    turnBlocked: 0,
  };
}

export function createRuntimeState(): RuntimeState {
  return {
    config: undefined,
    backend: undefined,
    enabled: false,
    disabledForNextAgent: false,
    readOnly: false,
    initialized: false,
    lastError: undefined,
    warnings: [],
    classifier: {},
    capabilities: createCapabilityState(),
    approvals: { read: [], write: [] },
    stats: createRailStats(),
    recent: [],
    recentClassifications: [],
    recentJudgements: [],
    traces: [],
    availableModelSpecs: [],
    subagentAckWarned: new Set(),
  };
}

/** Resets per-session fields in place; the state object identity is shared by closures. */
export function resetSessionState(state: RuntimeState): void {
  state.liveView?.close();
  state.liveView = undefined;
  state.enabled = false;
  state.disabledForNextAgent = false;
  state.readOnly = false;
  state.initialized = false;
  state.lastError = undefined;
  state.warnings = [];
  state.classifier = {};
  state.capabilities = createCapabilityState();
  state.approvals = { read: [], write: [] };
  state.stats = createRailStats();
  state.recent = [];
  state.recentClassifications = [];
  state.recentJudgements = [];
  state.traces = [];
  state.lastBashCommand = undefined;
  state.subagentAckWarned = new Set();
}

/**
 * Keeps the session disposition preset in sync with read-only mode. Derived
 * rather than set by the toggle, so anything that flips state.readOnly (the
 * command, a shortcut, a test) gets the preset without having to remember it.
 */
export function syncCapabilityPreset(state: RuntimeState): void {
  if (state.readOnly) applyReadOnlyPreset(state.capabilities);
  else clearPreset(state.capabilities);
}

/** Resets the per-turn counters. A "turn" spans from one user message to the next, not each agent loop iteration. */
export function resetTurnStats(state: RuntimeState): void {
  state.stats.turnRuleHits = 0;
  state.stats.turnClassifierHits = 0;
  state.stats.turnClassifierDenials = 0;
  state.stats.turnBlocked = 0;
}

function pushRecent(state: RuntimeState, event: RailEvent) {
  state.recent.unshift(event);
  state.recent = state.recent.slice(0, 8);
}

/**
 * One reviewer model call: tokens, dollars, and latency against the model that
 * served it. Recorded where the call returns rather than where the decision
 * lands, so a review whose decision path skips the telemetry finish (an
 * out-of-roots write that ends in the path-approval dialog) still accounts for
 * the tokens it burned.
 */
export function recordModelCall(
  state: RuntimeState,
  params: { role: ReviewerRole; model: string | undefined; latencyMs: number; usage: ClassifierTokenUsage | undefined },
): void {
  const model = params.model ?? "unknown";
  const key = `${params.role}:${model}`;
  const entry = (state.stats.modelUsage[key] ??= {
    model,
    role: params.role,
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    unpricedCalls: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
  });
  entry.calls++;
  entry.input += params.usage?.input ?? 0;
  entry.output += params.usage?.output ?? 0;
  entry.cacheRead += params.usage?.cacheRead ?? 0;
  entry.cacheWrite += params.usage?.cacheWrite ?? 0;
  if (typeof params.usage?.costUsd === "number") entry.costUsd += params.usage.costUsd;
  else entry.unpricedCalls++;
  entry.totalLatencyMs += params.latencyMs;
  entry.maxLatencyMs = Math.max(entry.maxLatencyMs, params.latencyMs);
}

/** Per-model rows in a stable order: namer before judge, then busiest first. */
export function modelUsageRows(stats: RailStats): ModelUsageStats[] {
  const roleOrder: Record<ReviewerRole, number> = { namer: 0, judge: 1 };
  return Object.values(stats.modelUsage).sort(
    (a, b) => roleOrder[a.role] - roleOrder[b.role] || b.calls - a.calls || a.model.localeCompare(b.model),
  );
}

export function recordJudgement(state: RuntimeState, record: JudgementRecord): void {
  state.recentJudgements.unshift(record);
  state.recentJudgements = state.recentJudgements.slice(0, REVIEW_RING_LIMIT);
}

export function recordDecisionTrace(state: RuntimeState, trace: DecisionTrace): void {
  state.traces.unshift(trace);
  state.traces = state.traces.slice(0, TRACE_LIMIT);
}

/** A deterministic policy rule hard-blocked the call. */
export function recordPolicyBlock(state: RuntimeState, toolName: string, reason: string): void {
  state.stats.ruleHits++;
  state.stats.turnRuleHits++;
  state.stats.blocked++;
  state.stats.turnBlocked++;
  pushRecent(state, { at: Date.now(), toolName, decision: "block", reason });
}

/** An out-of-roots path triggered an interactive approval request. */
export function recordApprovalRequested(state: RuntimeState, toolName: string, kind: AccessKind, path: string): void {
  state.stats.ruleHits++;
  state.stats.turnRuleHits++;
  state.stats.asked++;
  pushRecent(state, { at: Date.now(), toolName, decision: "ask", reason: `${kind} approval requested for ${path}` });
}

export function recordApprovalGranted(state: RuntimeState, toolName: string, kind: AccessKind, path: string): void {
  pushRecent(state, { at: Date.now(), toolName, decision: "allow", reason: `approved ${kind} path ${path}` });
}

export function recordApprovalDenied(state: RuntimeState): void {
  state.stats.blocked++;
  state.stats.turnBlocked++;
}

export interface CapabilityDecisionRecord {
  /** The command or path the call was about, for the recent-classifications ring. */
  target: string;
  labels: CapabilityId[];
  decision: RailDecision;
  /** The resolved table disposition that produced this decision. */
  disposition: Disposition;
  /** The one label that produced that disposition, when the caller resolved it. */
  decidedBy?: CapabilityId;
  reason: string;
  /** True when a model call (namer and/or judge) was involved; deterministic table hits count as rule hits instead. */
  reviewed: boolean;
  tokenUsage?: ClassifierTokenUsage;
  /** Review latency and namer model, for the recent-classifications ring; 0/undefined for deterministic labels. */
  latencyMs?: number;
  model?: string;
}

/** One resolved capability decision: statusline counters, per-class stats, and the two recent-decision rings. */
export function recordCapabilityDecision(state: RuntimeState, toolName: string, record: CapabilityDecisionRecord): void {
  if (record.reviewed) {
    state.stats.reviewed++;
    state.stats.classifierHits++;
    state.stats.turnClassifierHits++;
  } else {
    state.stats.ruleHits++;
    state.stats.turnRuleHits++;
  }
  state.stats.classifierInputTokens += record.tokenUsage?.input ?? 0;
  state.stats.classifierOutputTokens += record.tokenUsage?.output ?? 0;
  state.stats.classifierCacheReadTokens += record.tokenUsage?.cacheRead ?? 0;
  state.stats.classifierCacheWriteTokens += record.tokenUsage?.cacheWrite ?? 0;
  if (record.decision === "allow") state.stats.allowed++;
  if (record.decision === "deny") {
    state.stats.denied++;
    state.stats.classifierDenials++;
    state.stats.turnClassifierDenials++;
  }
  if (record.decision === "ask") state.stats.asked++;
  recordCapabilityHits(state.capabilities, record.labels);
  if (record.decidedBy) recordCapabilityDecided(state.capabilities, record.decidedBy);
  const at = Date.now();
  pushRecent(state, { at, toolName, decision: record.decision, capabilities: record.labels, reason: record.reason });
  state.recentClassifications.unshift({
    at,
    toolName,
    target: record.target,
    labels: record.labels,
    disposition: record.disposition,
    decision: record.decision,
    latencyMs: record.latencyMs ?? 0,
    inputTokens: record.tokenUsage?.input ?? 0,
    outputTokens: record.tokenUsage?.output ?? 0,
    model: record.model,
  });
  state.recentClassifications = state.recentClassifications.slice(0, REVIEW_RING_LIMIT);
}

/** A read or allowlisted command skipped classifier review deterministically. */
export function recordClassifierSkip(state: RuntimeState): void {
  state.stats.classifierSkips++;
}

/**
 * One classifier failure — namer or judge. `kind` is the coarse cause bucket
 * from classifyClassifierFailure, so a session can say whether its five errors
 * were one provider incident or five different problems.
 */
export function recordClassifierError(state: RuntimeState, toolName: string, reason: string, kind: string): void {
  state.stats.errors++;
  state.stats.errorsByKind[kind] = (state.stats.errorsByKind[kind] ?? 0) + 1;
  pushRecent(state, { at: Date.now(), toolName, decision: "error", reason });
}
