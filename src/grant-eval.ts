/**
 * Grant evaluation (GRANTS_PLAN, "Replay corpus" and "Validation gates"): a
 * dry run of one action under a policy, a replay of recorded decisions under
 * a candidate policy, and the gates a candidate grant must pass before it is
 * shown to the user.
 *
 * Everything here runs the interceptor's own deterministic stage helpers —
 * planPathPolicy, classifyRead, classifyCommand, the content screen, the
 * disposition table — in the interceptor's order, so a grant cannot evaluate
 * differently in the gates than it would live. Two things a dry run cannot
 * reproduce exactly, and says so in every report:
 *
 * - the namer. Where no deterministic mapper labels an action end to end the
 *   live rail asks a model. The gates do not (unless a caller passes a
 *   `nameFn`); they compare instead whether the candidate changes anything
 *   the namer sees or anything its labels resolve to;
 * - the sandbox. A deterministic allow holds live only while Seatbelt is
 *   enforcing. The gates assume it is (`enforcing`, default true).
 *
 * The judge and the user are never simulated: `judge` and `ask` are outcomes
 * in their own right here, exactly the disposition the table would hand on.
 *
 * Pure apart from the optional async `nameFn`: no file or session I/O. The
 * report is plain, serialisable data — the phase-5 configurator agent receives
 * it as a tool result — so its messages say what failed and what to change.
 */
import {
  capabilityName,
  capabilityRegistry,
  getEffectiveDisposition,
  isBuiltinCapabilityId,
  namerRegistry,
  READ_ONLY_PRESET_DENY,
  resolveCapabilities,
  type CapabilityId,
  type CapabilityState,
  type Disposition,
} from "./capabilities.ts";
import { capabilityForTemplate, describeFlags } from "./command-allowlist.ts";
import type { ResolvedRailConfig } from "./config.ts";
import { screenToolCall } from "./content-screen.ts";
import { addTraceStage, type DecisionTrace, type DecisionTraceStage } from "./decision-trace.ts";
import { INTERCEPTED_TOOLS } from "./intercepted-tools.ts";
import { classifyCommand, classifyRead, planPathPolicy } from "./interceptor.ts";
import {
  applyLayer,
  applyOpsInPlace,
  baseConfigOf,
  decidingGrant,
  opDirection,
  parseGrant,
  sessionPolicyLayer,
  type Grant,
  type GrantExample,
  type GrantLayerName,
  type OpDirection,
  type PolicyLayer,
  type PolicyOp,
  type Provenance,
  type SessionLayer,
  type StringListKey,
} from "./policy-store.ts";
import type { CorpusRecord } from "./replay-corpus.ts";
import type { UserAnswer } from "./telemetry.ts";

// ── Outcomes ─────────────────────────────────────────────────────────────────

/** What a dry run says the rail would do. `block` is a deterministic policy block (denyWrite, read-only mode). */
export type DryRunOutcome = Disposition | "block";

/** A dry-run outcome, or `indeterminate` when only the namer could label the action and no labels were supplied. */
export type EvalOutcome = DryRunOutcome | "indeterminate";

const OUTCOME_SEVERITY: Record<DryRunOutcome, number> = { allow: 0, judge: 1, ask: 2, deny: 3, block: 4 };

/** Positive when `a` is stricter than `b`. */
export function compareOutcomes(a: DryRunOutcome, b: DryRunOutcome): number {
  return OUTCOME_SEVERITY[a] - OUTCOME_SEVERITY[b];
}

/** Whether an outcome satisfies an example's `expect`. A deterministic block satisfies "deny": it is the stricter form of it. */
export function outcomeMatches(outcome: EvalOutcome, expect: readonly Disposition[]): boolean {
  if (outcome === "indeterminate") return false;
  if (outcome === "block") return expect.includes("deny");
  return expect.includes(outcome);
}

// ── The dry run ──────────────────────────────────────────────────────────────

export interface DryRunAction {
  tool: string;
  input: Record<string, unknown>;
}

export interface DryRunOptions {
  cwd: string;
  /** Whether Seatbelt bounds commands. Default true: the gates' stated assumption, since a deterministic allow needs it. */
  enforcing?: boolean;
  /** Session read-only mode (the preset and the write/bash gate). Default off. */
  readOnly?: boolean;
  /** Whether the classifier runs. Default: the config's own setting. */
  classifierEnabled?: boolean;
  /**
   * Namer labels from outside: a recorded naming (replay) or a nameFn call.
   * Used only where the live rail would call the namer, and filtered exactly
   * as the live parser filters a response (unknown and rules-only ids drop;
   * nothing left means unclassified).
   */
  namerLabels?: CapabilityId[];
  /** Replay of a write/edit whose content the corpus does not keep: the recorded screen verdict stands in for screening it. */
  screenTripped?: boolean;
  /**
   * Replay of a redacted record: labels that are a floor. Unioned with
   * whatever the stages produce before the table resolves, and never dropped.
   */
  floorLabels?: CapabilityId[];
}

export interface DryRunResult {
  outcome: EvalOutcome;
  /** Final labels: deterministic and namer together. For an indeterminate result, the deterministic part alone. */
  labels: CapabilityId[];
  /** The labels the deterministic stages produced on their own. */
  deterministicLabels: CapabilityId[];
  /**
   * What decided: the class id when the disposition table did, otherwise the
   * stage ("read-only", "path-policy", "path-approval", "classifier-off",
   * "not-intercepted", "rail-disabled", "no-path", "namer").
   */
  decidedBy: string;
  /** No model was involved: the deterministic stages decided alone (supplied namer labels make this false). */
  deterministic: boolean;
  /** The live rail would call the namer here (whether or not labels were supplied). */
  needsNamer: boolean;
  /** The named grant behind the deciding label, as decidingGrant attributes it live. */
  grant?: string;
  trace: DecisionTraceStage[];
}

function presetState(readOnly: boolean): CapabilityState {
  return { stats: {}, ...(readOnly ? { preset: { name: "read-only", deny: READ_ONLY_PRESET_DENY } } : {}) };
}

/** The namer's labels as the live parser would keep them: known, namer-visible ids, deduplicated; none left means unclassified. */
export function filterNamerLabels(config: ResolvedRailConfig, labels: readonly CapabilityId[]): CapabilityId[] {
  const valid = new Set(namerRegistry(capabilityRegistry(config)).map((entry) => entry.id));
  const kept = [...new Set(labels.filter((label) => valid.has(label)))];
  return kept.length > 0 ? kept : ["unclassified"];
}

/**
 * The outcome of one {tool, input} under `config`, by the interceptor's own
 * stages in the interceptor's order (runInterceptStages): read-only gate, path
 * policy, the deterministic label mappers, the classifier-off pass-through,
 * the namer, the disposition table. Nothing is recorded anywhere.
 *
 * Where the live rail differs: an out-of-roots read stops at its approval
 * dialog here (outcome ask, decided by path-approval) — the dry run has no
 * approvals to remember — and the judge and the user are not consulted.
 */
export function dryRunAction(config: ResolvedRailConfig, action: DryRunAction, options: DryRunOptions): DryRunResult {
  const trace: DecisionTrace = { at: 0, toolName: action.tool, action: "", final: "allowed", stages: [] };
  const input = action.input;
  const cwd = options.cwd;
  const enforcing = options.enforcing ?? true;
  const readOnly = options.readOnly ?? false;
  const classifierOn = options.classifierEnabled ?? config.classifier.enabled;
  const capabilities = presetState(readOnly);
  const floor = options.floorLabels ?? [];

  const result = (outcome: EvalOutcome, decidedBy: string, extra: Partial<DryRunResult> = {}): DryRunResult => ({
    outcome,
    labels: [],
    deterministicLabels: [],
    decidedBy,
    deterministic: true,
    needsNamer: false,
    ...extra,
    trace: trace.stages,
  });

  if (!config.enabled) return result("allow", "rail-disabled");
  const spec = INTERCEPTED_TOOLS[action.tool];
  if (!spec) return result("allow", "not-intercepted");

  // enforceReadOnlyMode
  if (readOnly) {
    if (spec.access.includes("write")) {
      addTraceStage(trace, "readonly", "block", `${action.tool} blocked: rail is in read-only mode`);
      return result("block", "read-only");
    }
    const scratch: DecisionTrace = { at: 0, toolName: action.tool, action: "", final: "allowed", stages: [] };
    if (action.tool === "bash" && !classifierOn && classifyCommand(input, capabilities, config, enforcing, scratch).needsNaming) {
      addTraceStage(trace, "readonly", "block", "bash blocked: read-only mode and the classifier is off");
      return result("block", "read-only");
    }
  }

  // enforcePathPolicy
  const plan = planPathPolicy(config, cwd, spec, input);
  if (plan.outcome === "done") return result("allow", "no-path");
  const deterministic: CapabilityId[] = [];
  let allowedReadPath: string | undefined;
  let pathApproval = false;
  if (plan.outcome === "steps") {
    for (const step of plan.steps) {
      if (step.verdict === "allowed") {
        addTraceStage(trace, "path-policy", "pass", `${step.kind} allowed${step.matchedRoot !== undefined ? ` by root '${step.matchedRoot}'` : ""}`);
        if (step.kind === "read") allowedReadPath = step.normalizedPath;
      } else if (step.verdict === "deny-read-label") {
        addTraceStage(trace, "path-policy", "label", `${step.reason} → credentials`);
      } else if (step.verdict === "outside-write") {
        addTraceStage(trace, "path-policy", "label", `${step.reason} → modify-system`);
        deterministic.push("modify-system");
        pathApproval = true;
      } else if (step.verdict === "outside-read") {
        addTraceStage(trace, "path-policy", "ask", `${step.reason} → path approval`);
        return result("ask", "path-approval");
      } else {
        addTraceStage(trace, "path-policy", "block", step.reason);
        return result("block", "path-policy");
      }
    }
  }

  // The deterministic label mappers.
  let needsNaming = false;
  let segments: ReturnType<typeof classifyCommand>["segments"];
  if (spec.access.includes("read") && !spec.access.includes("write")) {
    const read = classifyRead(spec, input, cwd, config, allowedReadPath, trace);
    deterministic.push(...read.labels);
    needsNaming = read.needsNaming;
  } else if (action.tool === "bash") {
    const command = classifyCommand(input, capabilities, config, enforcing, trace);
    deterministic.push(...command.labels);
    needsNaming = command.needsNaming;
    segments = command.segments;
  } else if (spec.access.includes("write")) {
    const screen = screenToolCall(action.tool, input, cwd);
    // Replay passes the recorded verdict for content it does not keep; the
    // path half of the screen still runs, and either one tripping counts.
    const tripped = options.screenTripped === true || screen.tripped;
    addTraceStage(trace, "screen", tripped ? "tripped" : "clean", options.screenTripped !== undefined ? "recorded screen verdict (content is not stored)" : screen.summary);
    if (tripped) needsNaming = true;
    else if (screen.label) deterministic.push(screen.label);
  }

  let named: CapabilityId[] | undefined;
  if (needsNaming && !classifierOn && deterministic.length === 0 && floor.length === 0) {
    addTraceStage(trace, "namer", "skipped", "classifier disabled and no deterministic label — call passes through");
    return result("allow", "classifier-off", { needsNamer: false });
  }
  if (needsNaming && classifierOn) {
    if (!options.namerLabels) {
      addTraceStage(trace, "namer", "needed", "no deterministic rule labels this end to end — the live rail would ask the namer");
      return result("indeterminate", "namer", { labels: [...deterministic], deterministicLabels: [...deterministic], deterministic: false, needsNamer: true });
    }
    named = filterNamerLabels(config, options.namerLabels);
    addTraceStage(trace, "namer", named.join(", "), "supplied namer labels");
  }

  const labels = [...new Set([...deterministic, ...(named ?? []), ...floor])];
  const extra = { labels, deterministicLabels: [...new Set(deterministic)], deterministic: named === undefined, needsNamer: needsNaming && classifierOn };
  if (labels.length === 0) return result("allow", "no-labels", extra);
  const resolution = resolveCapabilities(config, capabilities, labels);
  addTraceStage(trace, "capabilities", resolution.disposition, resolution.effective.map((entry) => `${entry.id}→${entry.disposition}`).join(", "));
  const grant = decidingGrant(config, resolution.decidedBy, segments);
  // An out-of-roots write's ask is the path dialog live; the outcome is still ask.
  if (pathApproval && resolution.disposition === "ask") addTraceStage(trace, "ask", "ask", "the path-approval dialog asks");
  return { ...result(resolution.disposition, resolution.decidedBy.id, extra), ...(grant ? { grant } : {}) };
}

// ── What the namer sees ──────────────────────────────────────────────────────

/**
 * True when the namer could label actions differently under `after`: the set
 * of classes it may use changed, or the definition of one of them did. A
 * rules-only class's definition is not in the namer's prompt (only the judge
 * reads it, and the judge is not replayed), so adding or rewording one leaves
 * every recorded naming standing — which is the point of rules-only classes.
 */
export function namerTaxonomyChanged(before: ResolvedRailConfig, after: ResolvedRailConfig): boolean {
  const visible = (config: ResolvedRailConfig) => JSON.stringify(namerRegistry(capabilityRegistry(config)).map((entry) => [entry.id, entry.definition]));
  return visible(before) !== visible(after);
}

/**
 * How an action only the namer labels can move from `before` to `after`,
 * whatever the namer says: "unchanged" when the taxonomy is the same and
 * every namer-visible class (and every deterministic label in `extraLabels`)
 * keeps its table row; "stricter-or-same" when the taxonomy is the same and no
 * such row loosens — severity-max is monotone, so the same labels can then
 * only resolve the same or stricter; "unknown" otherwise.
 */
export function namerPathChange(before: ResolvedRailConfig, after: ResolvedRailConfig, extraLabels: readonly CapabilityId[] = []): "unchanged" | "stricter-or-same" | "unknown" {
  if (namerTaxonomyChanged(before, after)) return "unknown";
  if (before.classifier.enabled !== after.classifier.enabled) return "unknown";
  const ids = [...namerRegistry(capabilityRegistry(after)).map((entry) => entry.id), ...extraLabels];
  let same = true;
  for (const id of ids) {
    const was = getEffectiveDisposition(before, undefined, id).disposition;
    const now = getEffectiveDisposition(after, undefined, id).disposition;
    if (was === now) continue;
    if (compareOutcomes(now, was) < 0) return "unknown";
    same = false;
  }
  return same ? "unchanged" : "stricter-or-same";
}

/** True when an action only the namer labels is decided exactly as before (see namerPathChange). */
export function namerPathUnchanged(before: ResolvedRailConfig, after: ResolvedRailConfig, extraLabels: readonly CapabilityId[] = []): boolean {
  return namerPathChange(before, after, extraLabels) === "unchanged";
}

// ── Replay ───────────────────────────────────────────────────────────────────

export type ReplayStatus = "unchanged" | "loosened" | "tightened" | "indeterminate" | "skipped";

export interface ReplayResult {
  status: ReplayStatus;
  /** What the record says happened at the table: its resolvedDisposition, "ask" for a plain path ask, "block" for a block. */
  recorded?: DryRunOutcome;
  /** The outcome under `after`; absent when skipped. */
  replayed?: EvalOutcome;
  labels?: CapabilityId[];
  redacted: boolean;
  /** Why the record was skipped or is indeterminate. */
  reason?: string;
}

export interface ReplayOptions {
  classifierEnabled?: boolean;
  enforcing?: boolean;
  /** Fresh namer labels for this record under `after` (a budgeted nameFn call). Never used for a redacted record. */
  namerLabels?: CapabilityId[];
}

/** The recorded action as a dry-run input. Write/edit content is not stored; the recorded screen verdict stands in for it. */
export function corpusAction(record: CorpusRecord): DryRunAction {
  const input: Record<string, unknown> = {};
  if (record.input.command !== undefined) input.command = record.input.command;
  if (record.input.path !== undefined) input.path = record.input.path;
  return { tool: record.tool, input };
}

function recordedOutcome(record: CorpusRecord): DryRunOutcome | undefined {
  if (record.kind === "block") return "block";
  if (record.resolvedDisposition) return record.resolvedDisposition;
  // A plain path ask: the dialog was the decision.
  if (record.kind === "approval") return "ask";
  return undefined;
}

function direction(recorded: DryRunOutcome, replayed: DryRunOutcome): ReplayStatus {
  const delta = compareOutcomes(replayed, recorded);
  return delta === 0 ? "unchanged" : delta > 0 ? "tightened" : "loosened";
}

/**
 * Replays one corpus record under `after` (GRANTS_PLAN, "Replay corpus"):
 *
 * 1. the deterministic mappers run under `after`; if they label it, those labels stand;
 * 2. otherwise the recorded namer labels are reused — unless `after` changes a
 *    class definition or the namer-visible class set relative to `before`, or
 *    the record was decided without the namer: then it is indeterminate;
 * 3. the labels resolve through `after`'s table and the result is compared
 *    with the record's resolvedDisposition.
 *
 * A redacted record's labels and screen verdict are a floor (unioned in, never
 * dropped), it is never re-named, and a taxonomy change makes it
 * indeterminate, never "unchanged". Read-only blocks are skipped (a session
 * toggle, not policy); a path block replays the path policy only, since what
 * follows a lifted block depends on content the corpus does not keep.
 */
export function replayRecord(record: CorpusRecord, before: ResolvedRailConfig, after: ResolvedRailConfig, options: ReplayOptions = {}): ReplayResult {
  const redacted = record.redacted === true;
  const recorded = recordedOutcome(record);
  if (!recorded) return { status: "skipped", redacted, reason: "the record carries no table outcome" };
  const action = corpusAction(record);
  const spec = INTERCEPTED_TOOLS[record.tool];
  if (!spec) return { status: "skipped", redacted, recorded, reason: `${record.tool} is not an intercepted tool` };

  if (record.kind === "block") {
    if (record.reason?.includes("read-only mode")) return { status: "skipped", redacted, recorded, reason: "read-only mode blocks are a session toggle, not policy a grant can change" };
    const plan = planPathPolicy(after, record.cwd, spec, action.input);
    if (plan.outcome === "steps" && plan.steps.some((step) => step.verdict === "block")) return { status: "unchanged", redacted, recorded, replayed: "block" };
    return { status: "loosened", redacted, recorded, replayed: "indeterminate", reason: "no longer blocked by the path policy; what follows depends on content the corpus does not keep" };
  }

  const dry = (namerLabels?: CapabilityId[]) =>
    dryRunAction(after, action, {
      cwd: record.cwd,
      enforcing: options.enforcing,
      classifierEnabled: options.classifierEnabled,
      ...(record.screenTripped !== undefined ? { screenTripped: record.screenTripped } : {}),
      ...(namerLabels ? { namerLabels } : {}),
      ...(redacted && record.labels ? { floorLabels: record.labels } : {}),
    });

  const taxonomyChanged = namerTaxonomyChanged(before, after);
  if (redacted && taxonomyChanged) {
    return { status: "indeterminate", redacted, recorded, replayed: "indeterminate", reason: "redacted records are never re-named, and this policy changes the classes the namer reads" };
  }
  let run = dry();
  if (run.needsNamer && run.outcome === "indeterminate") {
    if (options.namerLabels && !redacted) run = dry(options.namerLabels);
    else if (record.named && record.namerLabels && !taxonomyChanged) run = dry(record.namerLabels);
    else {
      const reason = taxonomyChanged
        ? "this policy changes the classes the namer reads, so the recorded naming no longer stands"
        : "decided without the namer when recorded, but no rule labels it under this policy — it needs a namer run";
      return { status: "indeterminate", redacted, recorded, replayed: "indeterminate", labels: run.labels, reason };
    }
  }
  if (run.outcome === "indeterminate") return { status: "indeterminate", redacted, recorded, replayed: "indeterminate", labels: run.labels };
  return { status: direction(recorded, run.outcome), redacted, recorded, replayed: run.outcome, labels: run.labels };
}

// ── The corpus diff ──────────────────────────────────────────────────────────

export interface CorpusChange {
  at: string;
  tool: string;
  /** The command or path, as recorded (redacted where the record is). */
  subject: string;
  cwd: string;
  /** The record's own table outcome. */
  recorded: DryRunOutcome;
  /** The record replayed under the policy before the candidate. */
  from: EvalOutcome;
  /** The record replayed with the candidate applied. */
  to: EvalOutcome;
  direction: "loosened" | "tightened" | "indeterminate";
  redacted: boolean;
  userAnswer?: UserAnswer;
  /** Index into the records passed in, so a caller can go back to the record. */
  index: number;
  reason?: string;
}

export interface CorpusDiffCounts {
  unchanged: number;
  loosened: number;
  tightened: number;
  indeterminate: number;
}

export interface CorpusDiff extends CorpusDiffCounts {
  total: number;
  /** Records replay cannot use, by reason (read-only blocks, records without a table outcome). */
  skipped: number;
  skipReasons: Record<string, number>;
  /** Records the current policy cannot replay either (decided without the namer back then, needing it now): not this candidate's doing. */
  stale: number;
  /** Redacted records, counted apart from the rest (their labels are a floor; they are never re-named). */
  redacted: CorpusDiffCounts & { total: number };
  /** Recorded asks the candidate turns into allows. */
  pastAsksBecomeAllows: number;
  /** Gate 5: actions the user denied when asked that the candidate would now allow. */
  deniedBecomeAllow: CorpusChange[];
  /** Changed records (both directions plus indeterminate), newest first, capped at CHANGE_LIST_LIMIT. */
  changes: CorpusChange[];
  /** Changed records left out of `changes` by the cap. */
  changesTruncated: number;
}

export const CHANGE_LIST_LIMIT = 100;

function subjectOf(record: CorpusRecord): string {
  return record.input.command ?? record.input.path ?? "";
}

function emptyCounts(): CorpusDiffCounts {
  return { unchanged: 0, loosened: 0, tightened: 0, indeterminate: 0 };
}

/**
 * What the candidate changes across the corpus. Each record is replayed twice
 * — under `before` and under `after` — and the diff is between the two, so a
 * record that drifted under earlier policy changes is not blamed on this
 * candidate. `recorded` still says what actually happened.
 */
export function corpusDiff(
  records: readonly CorpusRecord[],
  before: ResolvedRailConfig,
  after: ResolvedRailConfig,
  options: ReplayOptions & { namerLabelsFor?: (index: number) => CapabilityId[] | undefined } = {},
): CorpusDiff {
  const diff: CorpusDiff = {
    total: records.length,
    skipped: 0,
    skipReasons: {},
    stale: 0,
    ...emptyCounts(),
    redacted: { total: 0, ...emptyCounts() },
    pastAsksBecomeAllows: 0,
    deniedBecomeAllow: [],
    changes: [],
    changesTruncated: 0,
  };
  const taxonomyChanged = namerTaxonomyChanged(before, after);
  const changes: CorpusChange[] = [];
  records.forEach((record, index) => {
    const namerLabels = options.namerLabelsFor?.(index);
    const replayOptions: ReplayOptions = { classifierEnabled: options.classifierEnabled, enforcing: options.enforcing, ...(namerLabels ? { namerLabels } : {}) };
    const now = replayRecord(record, before, before, replayOptions);
    const next = replayRecord(record, before, after, replayOptions);
    if (next.status === "skipped") {
      diff.skipped++;
      const reason = next.reason ?? "skipped";
      diff.skipReasons[reason] = (diff.skipReasons[reason] ?? 0) + 1;
      return;
    }
    const counts = record.redacted ? diff.redacted : diff;
    if (record.redacted) diff.redacted.total++;
    const from = now.replayed ?? "indeterminate";
    const to = next.replayed ?? "indeterminate";
    let kind: CorpusChange["direction"] | "unchanged";
    if (to === "indeterminate" || from === "indeterminate") {
      if (to === "indeterminate" && from === "indeterminate" && !taxonomyChanged && !record.redacted) {
        diff.stale++;
        return;
      }
      kind = "indeterminate";
    } else {
      const delta = compareOutcomes(to, from);
      kind = delta === 0 ? "unchanged" : delta > 0 ? "tightened" : "loosened";
    }
    counts[kind]++;
    if (kind === "unchanged") return;
    const change: CorpusChange = {
      at: record.at,
      tool: record.tool,
      subject: subjectOf(record),
      cwd: record.cwd,
      recorded: next.recorded!,
      from,
      to,
      direction: kind,
      redacted: record.redacted === true,
      ...(record.userAnswer ? { userAnswer: record.userAnswer } : {}),
      index,
      ...(next.reason ? { reason: next.reason } : {}),
    };
    changes.push(change);
    if (kind === "loosened" && to === "allow") {
      if (next.recorded === "ask") diff.pastAsksBecomeAllows++;
      if (record.userAnswer === "denied") diff.deniedBecomeAllow.push(change);
    }
  });
  changes.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  diff.changes = changes.slice(0, CHANGE_LIST_LIMIT);
  diff.changesTruncated = Math.max(0, changes.length - CHANGE_LIST_LIMIT);
  return diff;
}

/** "3 past asks become allows · 0 critical cases change · 2 indeterminate" — the confirmation's one-line summary. */
export function corpusSummaryLine(diff: CorpusDiff, criticalChanged: number): string {
  const parts = [
    `${diff.pastAsksBecomeAllows} past ask${diff.pastAsksBecomeAllows === 1 ? "" : "s"} become${diff.pastAsksBecomeAllows === 1 ? "s" : ""} allow${diff.pastAsksBecomeAllows === 1 ? "" : "s"}`,
    `${criticalChanged} critical case${criticalChanged === 1 ? "" : "s"} change${criticalChanged === 1 ? "s" : ""}`,
    `${diff.indeterminate + diff.redacted.indeterminate} indeterminate`,
  ];
  return parts.join(" · ");
}

// ── Plain-language ops ───────────────────────────────────────────────────────

const LIST_LABELS: Record<StringListKey, string> = {
  "filesystem.allowRead": "the read roots (filesystem.allowRead)",
  "filesystem.denyRead": "the read denials (filesystem.denyRead)",
  "filesystem.allowWrite": "the write roots (filesystem.allowWrite)",
  "filesystem.denyWrite": "the write denials (filesystem.denyWrite)",
  "environment.allow": "the environment passed to commands (environment.allow)",
  "environment.unset": "the environment scrubbed from commands (environment.unset)",
  "network.allowedDomains": "the allowed network domains (network.allowedDomains)",
  "network.deniedDomains": "the denied network domains (network.deniedDomains)",
  "commands.allow": "the commands exempt from review (commands.allow)",
};

function flagsPhrase(flags: readonly string[] | undefined): string {
  if (flags === undefined) return "any flags";
  return flags.length === 0 ? "no flags" : `only flags ${describeFlags(flags)}`;
}

/** One op as a sentence, for the confirmation and the agent's report. */
export function describeOp(op: PolicyOp, config?: ResolvedRailConfig): string {
  const name = (id: CapabilityId) => (config ? capabilityName(id, capabilityRegistry(config)) : id);
  switch (op.op) {
    case "set-disposition":
      return `Set ${op.capability} (${name(op.capability)}) to ${op.disposition}`;
    case "add-class": {
      const facts = [
        op.extends ? `extends ${op.extends}` : "no parent (read-only mode treats it as writing)",
        op.disposition ?? "ask",
        op.namer === true ? "the namer may use it" : "rules only — the namer never sees it",
      ];
      return `Add class ${op.id} (${facts.join(", ")}): ${op.definition}`;
    }
    case "remove-class":
      return `Remove class ${op.id}; rules naming it then resolve to ask`;
    case "set-definition":
      return `Rewrite the definition of ${op.capability}: ${op.definition}`;
    case "classify":
      return `Label \`${op.template}\` (${flagsPhrase(op.flags)}) as ${op.capability}`;
    case "allow-command":
      return `Exempt \`${op.template}\` (${flagsPhrase(op.flags)}) from review, labelled ${capabilityForTemplate(op.template)}`;
    case "add-to-list":
      return `Add ${op.values.join(", ")} to ${LIST_LABELS[op.list]}`;
    case "remove-from-list":
      return `Remove ${op.values.join(", ")} from ${LIST_LABELS[op.list]}`;
  }
}

// ── Sensitive ops ────────────────────────────────────────────────────────────

export type SensitiveKind =
  | "removes-deny-entry"
  | "allows-sensitive-class"
  | "builtin-row-allow"
  | "bare-head-template"
  | "filesystem-widening"
  | "network-widening"
  | "environment-widening"
  | "previously-denied";

/** One reason an op needs its own explicit approval in the rail's dialog. */
export interface SensitiveItem {
  /** Index into the grant's ops. */
  opIndex: number;
  kind: SensitiveKind;
  /** One line, plain language: what this lets happen. */
  reason: string;
}

/** Rows whose allow is sensitive in itself (GRANTS_PLAN, "Sensitive ops"). */
const SENSITIVE_CLASSES: readonly CapabilityId[] = ["credentials", "persistence", "unclassified"];
const DENY_ENTRY_LISTS: readonly StringListKey[] = ["filesystem.denyRead", "filesystem.denyWrite", "network.deniedDomains"];

/**
 * The plan's sensitive-op list, per op. Some items on that list — disabling
 * the rail, the classifier, or failClosed; changing models or the backend —
 * are not expressible as ops at all: the closed op vocabulary in
 * src/policy-store.ts has no op that touches `enabled`, `classifier.*`, or
 * `backend` (those are LayerSettings, written only by hand in a config file),
 * so a grant can never do them and there is nothing to detect here. Keep it
 * that way: an op that could would have to land here first.
 */
function sensitiveItemsFor(op: PolicyOp, index: number, before: ResolvedRailConfig, opDirectionValue: OpDirection): SensitiveItem[] {
  const items: SensitiveItem[] = [];
  const item = (kind: SensitiveKind, reason: string) => items.push({ opIndex: index, kind, reason });
  switch (op.op) {
    case "set-disposition":
      if (op.disposition === "allow" && opDirectionValue === "widening") {
        if (SENSITIVE_CLASSES.includes(op.capability)) {
          item("allows-sensitive-class", `${op.capability} actions would run without review or a prompt`);
        } else if (isBuiltinCapabilityId(op.capability)) {
          item("builtin-row-allow", `every action named ${op.capability} (${capabilityName(op.capability)}) would be allowed, not just the one you asked about`);
        }
      }
      break;
    case "add-class":
      // A custom class's own default is a row too: allow on a class that
      // extends a sensitive one is the same as allowing that one for whatever
      // the namer or a rule puts in it.
      if ((op.disposition ?? "ask") === "allow" && op.extends && SENSITIVE_CLASSES.includes(op.extends)) {
        item("allows-sensitive-class", `${op.id} narrows ${op.extends} and is allowed: actions labelled ${op.id} would run without review`);
      }
      break;
    case "classify":
    case "allow-command": {
      const words = op.template.trim().split(/\s+/);
      // A restatement (a built-in `jq *`, say) changes nothing to approve.
      if (words.length === 2 && words[1] === "*" && opDirectionValue !== "neutral") {
        const what = op.op === "classify" ? `labels every ${words[0]} command as ${op.capability}` : `exempts every ${words[0]} command from review`;
        item("bare-head-template", `\`${op.template}\` ${what}, whatever subcommand follows`);
      }
      break;
    }
    case "remove-from-list": {
      const current = (listOf(before, op.list) ?? []).filter((value) => op.values.includes(value));
      if (DENY_ENTRY_LISTS.includes(op.list) && current.length > 0) {
        item("removes-deny-entry", `${current.join(", ")} would no longer be denied (${op.list})`);
      }
      break;
    }
    case "add-to-list":
    case "set-definition":
    case "remove-class":
      break;
  }
  if ((op.op === "add-to-list" || op.op === "remove-from-list") && opDirectionValue === "widening") {
    if (op.list.startsWith("filesystem.") && !items.some((entry) => entry.kind === "removes-deny-entry")) {
      item("filesystem-widening", `widens filesystem access: ${lowerFirst(describeOp(op))}`);
    } else if (op.list.startsWith("network.") && !items.some((entry) => entry.kind === "removes-deny-entry")) {
      item("network-widening", `widens network access: ${lowerFirst(describeOp(op))}`);
    } else if (op.list.startsWith("environment.")) {
      // Not on the plan's list, but the same kind of change: an environment
      // widening hands variables (tokens among them) to every sandboxed command.
      item("environment-widening", `passes more of the environment to commands: ${lowerFirst(describeOp(op))}`);
    }
  }
  return items;
}

/** "Add x to y" → "add x to y": only the verb, so paths and domain names keep their case. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function listOf(config: ResolvedRailConfig, list: StringListKey): string[] | undefined {
  const [top, key] = list.split(".") as [string, string];
  const section = (config as unknown as Record<string, Record<string, unknown>>)[top];
  const value = section?.[key];
  return Array.isArray(value) ? (value as string[]) : undefined;
}

// ── Gates ────────────────────────────────────────────────────────────────────

/** A minimal view of an eval case (eval/cases.ts), so the gates do not depend on the eval harness. */
export interface CriticalCase {
  name: string;
  toolName: string;
  input: Record<string, unknown>;
  critical?: boolean;
}

/** Labels for one action from a real namer call. Budgeted; never called for a redacted record. */
export type NameFn = (action: DryRunAction & { cwd: string }, config: ResolvedRailConfig) => Promise<CapabilityId[]>;

export interface GrantEvalContext {
  /** The effective policy without the candidate. */
  base: ResolvedRailConfig;
  /** The layer the candidate would be added to. */
  layer: GrantLayerName;
  /**
   * Session target: the live session layer. Given, the candidate folds exactly
   * where addSessionGrant would put it (after the named session grants, before
   * the policy page's edits); without it, on top of `base`.
   */
  session?: SessionLayer;
  /** Every existing named grant, with its layer; their examples are the regression set. */
  existingGrants: ReadonlyArray<{ layer: GrantLayerName; grant: Grant }>;
  corpus: readonly CorpusRecord[];
  /** Eval cases; the `critical` ones are gate 4. */
  evalCases: readonly CriticalCase[];
  /** Where examples and eval cases run (their relative paths resolve here). */
  cwd: string;
  classifierEnabled?: boolean;
  /** Default true; see the module comment. */
  enforcing?: boolean;
  /** Optional namer re-run for indeterminate items, critical cases first. */
  nameFn?: NameFn;
  /** nameFn calls allowed; default 20. */
  nameBudget?: number;
}

export interface GateResult {
  ok: boolean;
  /** What failed, and what to change. Empty when ok. */
  failures: string[];
  /** Worth knowing, does not fail the gate. */
  warnings: string[];
}

export interface ExampleResult {
  /** The grant the example belongs to (the candidate for gate 2). */
  grantId: string;
  index: number;
  tool: string;
  subject: string;
  expect: Disposition[];
  outcome: EvalOutcome;
  /** pass/fail by outcome; outside-grant: only the namer labels it, and nothing it sees or resolves to changes, so it is decided as before. */
  verdict: "pass" | "fail" | "outside-grant";
  passed: boolean;
  /** expect excludes allow. */
  negative: boolean;
  labels: CapabilityId[];
  message: string;
  why?: string;
}

export interface CriticalCaseResult {
  name: string;
  subject: string;
  before: EvalOutcome;
  after: EvalOutcome;
  status: "unchanged" | "tightened" | "loosened" | "needs-namer";
  ok: boolean;
  message: string;
}

export interface OpSummary {
  index: number;
  op: PolicyOp;
  direction: OpDirection;
  description: string;
  sensitive: boolean;
}

export interface GrantReport {
  /** Gates 1–4 all pass. Gate 5 never fails: it adds sensitive items. */
  ok: boolean;
  grant?: Grant;
  layer: GrantLayerName;
  /** Every assumption the dry run made where it cannot match live behaviour exactly. */
  assumptions: string[];
  gates: {
    structural: GateResult;
    examples: GateResult & { results: ExampleResult[] };
    regression: GateResult & { results: ExampleResult[] };
    critical: GateResult & { results: CriticalCaseResult[] };
  };
  ops: OpSummary[];
  /** True when any op widens: such a grant cannot be applied headless and needs a negative example. */
  widening: boolean;
  sensitive: SensitiveItem[];
  corpus?: CorpusDiff;
  /** The confirmation's one-line corpus summary. */
  summary?: string;
  /** Every failure across gates 1–4, in gate order — what the agent iterates on. */
  failures: string[];
  /** nameFn calls spent. */
  namerCalls: number;
}

function gate(): GateResult {
  return { ok: true, failures: [], warnings: [] };
}

function fail(result: GateResult, message: string): void {
  result.ok = false;
  result.failures.push(message);
}

/** The candidate folded at the target layer over `base`. */
export function foldCandidate(base: ResolvedRailConfig, grant: Grant, layer: GrantLayerName, session?: SessionLayer): ResolvedRailConfig {
  if (layer === "session" && session) {
    const withCandidate: SessionLayer = { ...session, grants: [...session.grants.filter((entry) => entry.id !== grant.id), grant] };
    return applyLayer(baseConfigOf(base), sessionPolicyLayer(withCandidate));
  }
  const fileLayer: PolicyLayer = { name: layer, settings: {}, base: [], grants: [grant], diagnostics: [] };
  return applyLayer(base, fileLayer);
}

function provenanceFor(layer: GrantLayerName, grantId: string): Provenance {
  return { layer, grantId };
}

/** Each op's direction against the policy as the ops before it in the same grant left it. */
export function opDirections(grant: Grant, before: ResolvedRailConfig, layer: GrantLayerName): OpDirection[] {
  const running = structuredClone(before);
  const provenance = provenanceFor(layer, grant.id);
  return grant.ops.map((op, index) => {
    const value = opDirection(op, running, provenance);
    applyOpsInPlace(running, [op], provenance, `candidate ops[${index}]`);
    return value;
  });
}

/** Every sensitive item in the grant's ops (gate 5's corpus items are added by evaluateGrant). */
export function sensitiveOps(grant: Grant, before: ResolvedRailConfig, layer: GrantLayerName): SensitiveItem[] {
  const running = structuredClone(before);
  const provenance = provenanceFor(layer, grant.id);
  const items: SensitiveItem[] = [];
  grant.ops.forEach((op, index) => {
    items.push(...sensitiveItemsFor(op, index, running, opDirection(op, running, provenance)));
    applyOpsInPlace(running, [op], provenance, `candidate ops[${index}]`);
  });
  return items;
}

function exampleSubject(example: Pick<GrantExample, "input">): string {
  const input = example.input;
  if (typeof input.command === "string") return input.command;
  if (typeof input.path === "string") return input.path;
  return JSON.stringify(input);
}

function describeOutcome(run: DryRunResult): string {
  if (run.outcome === "indeterminate") return "needs the namer";
  if (run.labels.length > 0) return `${run.outcome} (${run.labels.join(", ")} ⇒ ${run.outcome}, decided by ${run.decidedBy}${run.grant ? ` from grant ${run.grant}` : ""})`;
  return `${run.outcome} (${run.decidedBy})`;
}

interface CheckOptions {
  cwd: string;
  classifierEnabled?: boolean;
  enforcing?: boolean;
  namerLabels?: { before?: CapabilityId[]; after?: CapabilityId[] };
}

/**
 * One example under `after`. An example only the namer labels can still pass
 * as "outside-grant" when it is a negative example and the candidate changes
 * nothing the namer sees or resolves to: it is then decided exactly as before
 * the grant, which is what a negative example is there to show. A positive
 * example must be decided by rules — that is what the grant adds.
 */
export function checkExample(example: GrantExample, grantId: string, index: number, before: ResolvedRailConfig, after: ResolvedRailConfig, options: CheckOptions): ExampleResult {
  const action = { tool: example.tool, input: example.input };
  const dryOptions = { cwd: options.cwd, classifierEnabled: options.classifierEnabled, enforcing: options.enforcing };
  const run = dryRunAction(after, action, { ...dryOptions, ...(options.namerLabels?.after ? { namerLabels: options.namerLabels.after } : {}) });
  const negative = !example.expect.includes("allow");
  const base = {
    grantId,
    index,
    tool: example.tool,
    subject: exampleSubject(example),
    expect: [...example.expect],
    outcome: run.outcome,
    negative,
    labels: run.labels,
    ...(example.why ? { why: example.why } : {}),
  };
  const expected = example.expect.join(" | ");
  if (run.decidedBy === "classifier-off" && negative && dryRunAction(before, action, dryOptions).decidedBy === "classifier-off") {
    // Not a decision at all: with the classifier off an action no rule labels
    // passes through, with or without this grant. The grant's rules do not
    // reach it, which is what a negative example is there to show.
    return {
      ...base,
      verdict: "outside-grant",
      passed: true,
      message: "no rule labels it and the classifier is off, so it passes through unreviewed — exactly as before this grant (turn the classifier on for the namer to decide it)",
    };
  }
  if (run.outcome !== "indeterminate") {
    const passed = outcomeMatches(run.outcome, example.expect);
    return {
      ...base,
      verdict: passed ? "pass" : "fail",
      passed,
      message: passed
        ? `${describeOutcome(run)}; expected ${expected}`
        : `expected ${expected}, got ${describeOutcome(run)}${run.outcome === "allow" && negative ? " — the grant's rules reach this action; narrow the template or its flags" : ""}`,
    };
  }
  const was = dryRunAction(before, action, dryOptions);
  const sameDeterministic = was.outcome === "indeterminate" && JSON.stringify([...was.labels].sort()) === JSON.stringify([...run.labels].sort());
  const change = sameDeterministic ? namerPathChange(before, after, run.labels) : "unknown";
  if (change !== "unknown") {
    if (negative) {
      return {
        ...base,
        verdict: "outside-grant",
        passed: true,
        message: change === "unchanged"
          ? "no rule labels it end to end, so the namer does — and this grant changes nothing the namer sees or what its labels resolve to: decided exactly as before the grant (not verified against a model)"
          : "no rule labels it end to end, so the namer does — and this grant only tightens what its labels resolve to: decided as before the grant or stricter (not verified against a model)",
      };
    }
    return {
      ...base,
      verdict: "fail",
      passed: false,
      message: `expected ${expected}, but no rule of this grant labels it end to end — the namer would decide it. A positive example must be matched by the grant's rules: check the template, its flags, and that every segment of the command matches`,
    };
  }
  return {
    ...base,
    verdict: "fail",
    passed: false,
    message: `needs a namer re-check: only the namer labels it, and this grant changes what the namer reads or what its labels resolve to — expected ${expected} cannot be shown deterministically`,
  };
}

function criticalCase(entry: CriticalCase, before: ResolvedRailConfig, after: ResolvedRailConfig, options: CheckOptions): CriticalCaseResult {
  const action = { tool: entry.toolName, input: entry.input };
  const dryOptions = { cwd: options.cwd, classifierEnabled: options.classifierEnabled, enforcing: options.enforcing };
  const was = dryRunAction(before, action, { ...dryOptions, ...(options.namerLabels?.before ? { namerLabels: options.namerLabels.before } : {}) });
  const now = dryRunAction(after, action, { ...dryOptions, ...(options.namerLabels?.after ? { namerLabels: options.namerLabels.after } : {}) });
  const subject = exampleSubject(entry);
  const result = (status: CriticalCaseResult["status"], ok: boolean, message: string): CriticalCaseResult => ({ name: entry.name, subject, before: was.outcome, after: now.outcome, status, ok, message });
  if (was.outcome !== "indeterminate" && now.outcome !== "indeterminate") {
    const delta = compareOutcomes(now.outcome, was.outcome);
    if (delta === 0) return result("unchanged", true, `${now.outcome}, as before`);
    if (delta > 0) return result("tightened", true, `${was.outcome} → ${now.outcome}`);
    return result("loosened", false, `critical case ${entry.name} moves toward allow: ${was.outcome} → ${describeOutcome(now)}. This grant reaches \`${subject}\`; narrow it so it does not`);
  }
  if (was.outcome === "indeterminate" && now.outcome !== "indeterminate") {
    // The namer used to decide; a rule decides now. Only an allow is a
    // provable move toward allow for a case that must never be allowed.
    if (now.outcome === "allow") return result("loosened", false, `critical case ${entry.name} is now allowed deterministically (${describeOutcome(now)}); before, the namer decided it. Narrow the grant so its rules do not match \`${subject}\``);
    return result("tightened", true, `now decided by rules: ${now.outcome}`);
  }
  const change = was.outcome === "indeterminate" && now.outcome === "indeterminate" && JSON.stringify([...was.labels].sort()) === JSON.stringify([...now.labels].sort())
    ? namerPathChange(before, after, now.labels)
    : "unknown";
  if (change === "unchanged") return result("unchanged", true, "the namer decides it, and nothing it sees or resolves to changes");
  if (change === "stricter-or-same") return result("unchanged", true, "the namer decides it; nothing it sees changes and no row it can name loosens, so it cannot move toward allow");
  return result("needs-namer", false, `critical case ${entry.name} needs a namer re-check: this grant changes what the namer reads or what its labels resolve to, so \`${subject}\` cannot be shown not to move toward allow`);
}

/**
 * Runs every gate on a candidate grant (raw JSON as read from a file or a
 * model's proposal). Gates 1–4 decide `ok`; gate 5 and the sensitive-op list
 * add items the confirmation asks about one by one. Async only for the
 * optional nameFn.
 */
export async function evaluateGrant(candidate: unknown, ctx: GrantEvalContext): Promise<GrantReport> {
  const before = ctx.base;
  const assumptions = [
    `Seatbelt is assumed ${ctx.enforcing === false ? "not enforcing (deterministic allows then go to the namer)" : "enforcing: a deterministic allow holds live only while the sandbox enforces; without it those commands go to the namer"}.`,
    `The classifier is ${(ctx.classifierEnabled ?? before.classifier.enabled) ? "on" : "off — actions no rule labels pass through unreviewed, as they would live"}.`,
    "Read-only mode is assumed off, and path approvals given this session are ignored.",
    ctx.nameFn
      ? "The namer is called (budgeted) only for items no rule decides; the rest are compared by whether this grant changes anything the namer sees or resolves to."
      : "The namer is not called: actions no rule labels end to end are compared by whether this grant changes anything the namer sees or what its labels resolve to.",
    "The judge and your answers are not simulated: judge means the escalation reviewer would decide, ask means you would be asked.",
    ...(ctx.layer === "session" && ctx.session
      ? []
      : [`Evaluated on top of the current effective policy; live, a ${ctx.layer} grant folds beneath any later layer, which can only override it.`]),
  ];
  const structural = gate();
  const report: GrantReport = {
    ok: false,
    layer: ctx.layer,
    assumptions,
    gates: {
      structural,
      examples: { ...gate(), results: [] },
      regression: { ...gate(), results: [] },
      critical: { ...gate(), results: [] },
    },
    ops: [],
    widening: false,
    sensitive: [],
    failures: [],
    namerCalls: 0,
  };

  // Gate 1: structure. Strict where config loading is tolerant: a grant with
  // any op or example that does not parse is not applied at all.
  const diagnostics: string[] = [];
  const grant = parseGrant(candidate, "grant", diagnostics);
  for (const line of diagnostics) fail(structural, line);
  if (!grant) {
    report.failures = [...structural.failures];
    return report;
  }
  report.grant = grant;
  if (!grant.request.trim()) fail(structural, "request is empty — it is the request in the user's own words");
  if (grant.ops.length === 0 && diagnostics.length === 0) fail(structural, "the grant has no ops");
  if (ctx.existingGrants.some((entry) => entry.layer === ctx.layer && entry.grant.id === grant.id)) {
    fail(structural, `the ${ctx.layer} layer already has a grant "${grant.id}" — pick another id, or revoke that one first`);
  }
  const after = foldCandidate(before, grant, ctx.layer, ctx.session);
  const folded = after.diagnostics.filter((line) => line.includes(`grant ${grant.id} `) && !before.diagnostics.includes(line));
  for (const line of folded) fail(structural, line);
  for (const entry of after.capabilities.classes) {
    if (entry.namer !== false || after.provenance.classes[entry.id]?.grantId !== grant.id) continue;
    if (!after.commands.classify.some((rule) => rule.capability === entry.id)) {
      structural.warnings.push(`${entry.id} is rules-only and no classify rule reaches it: it can never be labelled. Add a classify op, or "namer": true if the namer should use it.`);
    }
  }

  // Directions and the op-level sensitive list.
  const directions = opDirections(grant, before, ctx.layer);
  const sensitive = sensitiveOps(grant, before, ctx.layer);
  report.widening = directions.includes("widening");

  // Gate 2: the grant's own examples.
  const checkOptions = { cwd: ctx.cwd, classifierEnabled: ctx.classifierEnabled, enforcing: ctx.enforcing };
  const examples = report.gates.examples;
  examples.results = (grant.examples ?? []).map((example, index) => checkExample(example, grant.id, index, before, after, checkOptions));

  // Gate 4 first among the namer consumers: critical cases get the budget first.
  const critical = report.gates.critical;
  const criticalCases = ctx.evalCases.filter((entry) => entry.critical);
  critical.results = criticalCases.map((entry) => criticalCase(entry, before, after, checkOptions));

  let budget = ctx.nameBudget ?? 20;
  const name = async (action: DryRunAction, config: ResolvedRailConfig): Promise<CapabilityId[] | undefined> => {
    if (!ctx.nameFn || budget <= 0) return undefined;
    budget--;
    report.namerCalls++;
    try {
      return await ctx.nameFn({ ...action, cwd: ctx.cwd }, config);
    } catch {
      return undefined;
    }
  };
  if (ctx.nameFn) {
    for (let i = 0; i < critical.results.length; i++) {
      if (critical.results[i]!.status !== "needs-namer") continue;
      const entry = criticalCases[i]!;
      const action = { tool: entry.toolName, input: entry.input };
      const labelsBefore = await name(action, before);
      const labelsAfter = labelsBefore ? await name(action, after) : undefined;
      if (labelsBefore && labelsAfter) critical.results[i] = criticalCase(entry, before, after, { ...checkOptions, namerLabels: { before: labelsBefore, after: labelsAfter } });
    }
    for (let i = 0; i < examples.results.length; i++) {
      const result = examples.results[i]!;
      if (result.outcome !== "indeterminate" || result.verdict === "outside-grant") continue;
      const example = grant.examples![i]!;
      const labels = await name({ tool: example.tool, input: example.input }, after);
      if (labels) examples.results[i] = checkExample(example, grant.id, i, before, after, { ...checkOptions, namerLabels: { after: labels } });
    }
  }
  for (const result of examples.results) {
    if (!result.passed) fail(examples, `example ${result.index + 1} (\`${result.subject}\`): ${result.message}`);
    else if (result.verdict === "outside-grant") examples.warnings.push(`example ${result.index + 1} (\`${result.subject}\`): ${result.message}`);
  }
  if (report.widening && !examples.results.some((result) => result.negative && result.passed)) {
    const which = directions.map((value, index) => (value === "widening" ? index + 1 : 0)).filter(Boolean).join(", ");
    fail(examples, `the grant widens policy (op${which.includes(",") ? "s" : ""} ${which}) but has no passing negative example — add at least one example whose expect excludes "allow" (e.g. the forced or chained form of the command it allows)`);
  }
  for (const result of critical.results) if (!result.ok) fail(critical, result.message);

  // Gate 3: every existing grant's examples still pass.
  const regression = report.gates.regression;
  for (const entry of ctx.existingGrants) {
    if (entry.grant.id === grant.id && entry.layer === ctx.layer) continue;
    (entry.grant.examples ?? []).forEach((example, index) => {
      const now = checkExample(example, entry.grant.id, index, before, after, checkOptions);
      regression.results.push(now);
      if (now.passed) return;
      // A failure the candidate did not cause is reported, not blamed on it.
      const was = checkExample(example, entry.grant.id, index, before, before, checkOptions);
      if (was.passed) fail(regression, `${entry.layer} grant ${entry.grant.id}, example ${index + 1} (\`${now.subject}\`): ${now.message}`);
      else regression.warnings.push(`${entry.layer} grant ${entry.grant.id}, example ${index + 1} already fails without this grant: ${was.message}`);
    });
  }

  // The corpus diff, with budgeted namer runs for what is left (never redacted records).
  const namerLabelsByIndex = new Map<number, CapabilityId[]>();
  if (ctx.nameFn && budget > 0) {
    for (let index = 0; index < ctx.corpus.length && budget > 0; index++) {
      const record = ctx.corpus[index]!;
      if (record.redacted) continue;
      const replayed = replayRecord(record, before, after, { classifierEnabled: ctx.classifierEnabled, enforcing: ctx.enforcing });
      if (replayed.status !== "indeterminate" || record.kind === "block") continue;
      const labels = await name(corpusAction(record), after);
      if (labels) namerLabelsByIndex.set(index, labels);
    }
  }
  const diff = corpusDiff(ctx.corpus, before, after, {
    classifierEnabled: ctx.classifierEnabled,
    enforcing: ctx.enforcing,
    namerLabelsFor: (index) => namerLabelsByIndex.get(index),
  });
  report.corpus = diff;

  // Gate 5: a previously denied action that becomes an allow is a sensitive
  // item on the op(s) responsible — found by leaving each op out in turn.
  if (diff.deniedBecomeAllow.length > 0) {
    const without = grant.ops.map((_, skip) => foldCandidate(before, { ...grant, ops: grant.ops.filter((__, index) => index !== skip) }, ctx.layer, ctx.session));
    for (const change of diff.deniedBecomeAllow) {
      const record = ctx.corpus[change.index]!;
      let responsible = without.flatMap((config, index) => (replayRecord(record, before, config, { classifierEnabled: ctx.classifierEnabled, enforcing: ctx.enforcing }).replayed !== "allow" ? [index] : []));
      if (responsible.length === 0) responsible = directions.flatMap((value, index) => (value === "widening" ? [index] : []));
      for (const opIndex of responsible) {
        sensitive.push({ opIndex, kind: "previously-denied", reason: `you denied \`${change.subject}\` when asked (${change.at.slice(0, 10)}); this would allow it` });
      }
    }
  }
  report.sensitive = sensitive;
  report.ops = grant.ops.map((op, index) => ({ index, op, direction: directions[index]!, description: describeOp(op, after), sensitive: sensitive.some((item) => item.opIndex === index) }));
  const criticalChanged = critical.results.filter((result) => result.status !== "unchanged").length;
  report.summary = corpusSummaryLine(diff, criticalChanged);

  report.ok = structural.ok && examples.ok && regression.ok && critical.ok;
  report.failures = [...structural.failures, ...examples.failures, ...regression.failures, ...critical.failures];
  return report;
}

/** The grant with only the approved sensitive ops kept: every non-sensitive op, plus each sensitive op whose index is in `approved`. */
export function grantWithApprovedOps(grant: Grant, sensitive: readonly SensitiveItem[], approved: ReadonlySet<number>): { grant: Grant; dropped: number[] } {
  const sensitiveIndexes = new Set(sensitive.map((item) => item.opIndex));
  const dropped = [...sensitiveIndexes].filter((index) => !approved.has(index)).sort((a, b) => a - b);
  return { grant: { ...grant, ops: grant.ops.filter((_, index) => !dropped.includes(index)) }, dropped };
}

/** Plain-text report, for /rail grant check and headless sessions. */
export function formatGrantReport(report: GrantReport): string[] {
  const lines: string[] = [];
  const grant = report.grant;
  lines.push(`# Rail grant ${grant ? grant.id : "(unparsed)"} — ${report.ok ? "passes its gates" : "rejected"}`, "");
  if (grant) lines.push(`  request: ${grant.request}`, `  layer: ${report.layer}`, "");
  if (report.ops.length > 0) {
    lines.push("## Ops");
    for (const op of report.ops) lines.push(`  ${op.index + 1}. [${op.direction}]${op.sensitive ? " [sensitive]" : ""} ${op.description}`);
    lines.push("");
  }
  const section = (title: string, result: GateResult, rows: string[]) => {
    lines.push(`## ${title}: ${result.ok ? "pass" : "FAIL"}`);
    lines.push(...rows);
    for (const failure of result.failures) lines.push(`  ✗ ${failure}`);
    for (const warning of result.warnings) lines.push(`  ! ${warning}`);
    lines.push("");
  };
  section("Gate 1 · structure", report.gates.structural, []);
  section(
    "Gate 2 · own examples",
    report.gates.examples,
    report.gates.examples.results.map((result) => `  ${result.verdict === "fail" ? "✗" : "✓"} \`${result.subject}\` → ${result.outcome === "indeterminate" ? "namer" : result.outcome} (expect ${result.expect.join("|")})${result.verdict === "outside-grant" ? " — outside this grant" : ""}`),
  );
  section("Gate 3 · other grants' examples", report.gates.regression, [`  ${report.gates.regression.results.length} example${report.gates.regression.results.length === 1 ? "" : "s"} replayed`]);
  section(
    "Gate 4 · critical eval cases",
    report.gates.critical,
    report.gates.critical.results.filter((result) => result.status !== "unchanged").map((result) => `  ${result.ok ? "✓" : "✗"} ${result.name}: ${result.before} → ${result.after}`),
  );
  if (report.corpus) {
    const diff = report.corpus;
    lines.push("## Corpus diff");
    if (report.summary) lines.push(`  ${report.summary}`);
    lines.push(
      `  ${diff.total} records · ${diff.loosened} loosen · ${diff.tightened} tighten · ${diff.indeterminate} indeterminate · ${diff.unchanged} unchanged · ${diff.skipped} skipped${diff.stale > 0 ? ` · ${diff.stale} not replayable under the current policy either` : ""}`,
      `  redacted (counted apart): ${diff.redacted.total} · ${diff.redacted.loosened} loosen · ${diff.redacted.tightened} tighten · ${diff.redacted.indeterminate} indeterminate`,
    );
    for (const change of diff.changes.slice(0, 20)) {
      lines.push(`  ${change.direction === "loosened" ? "↓" : change.direction === "tightened" ? "↑" : "?"} ${change.tool}: ${change.subject} — ${change.from} → ${change.to}${change.redacted ? " (redacted)" : ""}${change.userAnswer === "denied" ? " (you denied this)" : ""}`);
    }
    if (diff.changes.length > 20 || diff.changesTruncated > 0) lines.push(`  … ${diff.changes.length - 20 + diff.changesTruncated} more`);
    lines.push("");
  }
  if (report.sensitive.length > 0) {
    lines.push("## Sensitive ops (each needs its own approval in the rail's dialog)");
    for (const item of report.sensitive) lines.push(`  op ${item.opIndex + 1}: ${item.reason}`);
    lines.push("");
  }
  lines.push("## Assumptions");
  for (const line of report.assumptions) lines.push(`  - ${line}`);
  return lines;
}

/**
 * The confirmation's body, shared by the TUI panel and the RPC select title:
 * the request, each op in plain language with its direction, the examples
 * with pass marks, the corpus summary, and every gate failure.
 */
export function confirmationLines(report: GrantReport): string[] {
  const lines: string[] = [];
  const grant = report.grant;
  if (grant) lines.push(`Request: ${grant.request}`, `Grant: ${grant.id}`);
  for (const op of report.ops) lines.push(`  ${op.index + 1}. ${op.description} — ${op.direction}${op.sensitive ? " · sensitive" : ""}`);
  const examples = report.gates.examples.results;
  if (examples.length > 0) {
    lines.push("Examples:");
    for (const result of examples) {
      const mark = result.verdict === "fail" ? "✗" : "✓";
      const got = result.verdict === "outside-grant"
        ? result.outcome === "indeterminate" ? "namer decides, as before this grant" : `${result.outcome}, as before this grant`
        : result.outcome === "indeterminate" ? "needs the namer" : result.outcome;
      lines.push(`  ${mark} \`${result.subject}\` → ${got} (expect ${result.expect.join("|")})`);
    }
  }
  if (report.summary) lines.push(`Corpus: ${report.summary}`);
  if (report.corpus && report.corpus.deniedBecomeAllow.length > 0) lines.push(`  ${report.corpus.deniedBecomeAllow.length} action${report.corpus.deniedBecomeAllow.length === 1 ? "" : "s"} you denied would now be allowed`);
  for (const failure of report.failures) lines.push(`✗ ${failure}`);
  if (report.ok) lines.push(`All gates pass. Seatbelt is assumed enforcing; the namer was ${report.namerCalls > 0 ? `called ${report.namerCalls} time${report.namerCalls === 1 ? "" : "s"}` : "not called"}.`);
  return lines;
}
