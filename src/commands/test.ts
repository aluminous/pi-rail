// /rail test: dry-runs a shell command or file read/write through the rail
// stack — readonly gate, path policy, allowlist labels, content screen, a REAL
// namer call when one is needed, the disposition table, and a REAL judge when
// the table escalates — without executing anything and without touching stats,
// telemetry, recent decisions, traces, or lastDecision. Reuses the same stage
// helpers the interceptor consults, so verdicts cannot drift.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { capabilityName, resolveCapabilities, type CapabilityId, type CapabilityResolution } from "../capabilities.ts";
import { describeClassifierFailure } from "../classifier-protocol.ts";
import { classifierEnabled, judgeModelSpec, judgeToolCall, nameToolCall, resolveClassifierModel, resolveJudgeModel, type CompleteFn, type NamerResult } from "../classifier.ts";
import { describeSegmentMatch, explainCommandMatch, matchedCapabilities } from "../command-allowlist.ts";
import { configSourceLabel, loadConfig, type ResolvedRailConfig } from "../config.ts";
import { screenToolCall } from "../content-screen.ts";
import { INTERCEPTED_TOOLS } from "../intercepted-tools.ts";
import { exemptReadCallReason } from "../interceptor.ts";
import { showRailView } from "../live-view.ts";
import { decidePathAccess, denyReadMatch, type AccessKind } from "../policy.ts";
import { recentEvents, syncCapabilityPreset, type RuntimeState } from "../state.ts";


export interface RailTestDeps {
  state: RuntimeState;
  /** Test seam for the namer/judge calls (production uses the default model-call function). */
  completeFn?: CompleteFn;
}

type TestSubject =
  | { kind: "command"; command: string }
  | { kind: "read" | "write"; path: string };

function parseSubject(args: string): TestSubject | undefined {
  const trimmed = args.trim();
  if (!trimmed) return undefined;
  const fileOp = trimmed.match(/^(read|write)\s+(.+)$/);
  if (fileOp) return { kind: fileOp[1] as "read" | "write", path: fileOp[2]!.trim() };
  return { kind: "command", command: trimmed };
}

function isSessionApproved(state: RuntimeState, kind: AccessKind, target: string): boolean {
  return state.approvals[kind].some((root) => target === root || target.startsWith(`${root}/`));
}

interface NamingPlan {
  /** undefined = the namer would actually run; otherwise the line explaining why not. */
  skip?: string;
  toolName: string;
  input: unknown;
}

function scopeLabel(entry: CapabilityResolution["effective"][number]): string {
  if (entry.scope === "config") return configSourceLabel(entry.source ?? "config");
  if (entry.scope === "preset") return `${entry.source} preset`;
  return entry.scope;
}

export function createRailTest(deps: RailTestDeps) {
  const { state } = deps;

  /** Runs the namer for real when the deterministic mappers could not label the action. */
  async function namerLines(ctx: ExtensionContext, config: ResolvedRailConfig, plan: NamingPlan): Promise<{ lines: string[]; named?: NamerResult; failed?: boolean }> {
    // The deterministic reason is the more useful one when both apply.
    if (plan.skip) return { lines: [`  namer: ${plan.skip}`] };
    if (!classifierEnabled(config, state.classifier)) return { lines: ["  namer: classifier disabled — would not run"] };
    const model = resolveClassifierModel(ctx, config, state.classifier);
    const modelLabel = model ? `${model.provider}/${model.id}` : `unavailable (${state.classifier.modelOverride ?? config.classifier.model})`;
    ctx.ui.notify(`Rail test: running a real capability naming call (${modelLabel})...`, "info");
    try {
      const named = await nameToolCall({ ctx, config, state: state.classifier, toolName: plan.toolName, input: plan.input, completeFn: deps.completeFn });
      const usage = named.tokenUsage;
      const cost = usage ? `${usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)} in / ${usage.output} out tokens` : "token usage not reported";
      return {
        named,
        lines: [
          `  namer: ${named.labels.join(", ")}`,
          ...(named.authorizationEvidence ? [`  authorization evidence: "${named.authorizationEvidence}"`] : []),
          `  real naming call by ${modelLabel} · ${cost}`,
        ],
      };
    } catch (error) {
      return {
        failed: true,
        lines: [
          `  namer: naming failed — ${describeClassifierFailure(error)}`,
          `  a real call would ${config.classifier.failClosed ? "stop the turn (fail closed)" : "fail open and proceed"}`,
        ],
      };
    }
  }

  async function tableLines(
    ctx: ExtensionContext,
    config: ResolvedRailConfig,
    labels: CapabilityId[],
    named: NamerResult | undefined,
    plan: NamingPlan,
  ): Promise<{ lines: string[]; verdict?: string }> {
    if (labels.length === 0) return { lines: ["  no capability labels — nothing for the table to decide"] };
    const resolution = resolveCapabilities(config, state.capabilities, labels);
    const lines = [
      ...resolution.effective.map((entry) => `  ${entry.id} → ${entry.disposition} (${scopeLabel(entry)})`),
      `  severity-max ⇒ ${resolution.disposition} · decided by ${resolution.decidedBy.id} (${capabilityName(resolution.decidedBy.id)})`,
    ];
    if (resolution.disposition === "allow") return { lines, verdict: "would allow" };
    if (resolution.disposition === "deny") return { lines, verdict: "would deny (disposition table)" };
    if (resolution.disposition === "ask") return { lines, verdict: "would ask the user" };

    // judge: run it for real, same as the interceptor would.
    if (!classifierEnabled(config, state.classifier)) {
      return { lines: [...lines, "  judge: classifier is off, so the judge cannot run — would ask instead"], verdict: "would ask the user (judge unavailable)" };
    }
    const model = resolveJudgeModel(ctx, config, state.classifier);
    const modelLabel = model ? `${model.provider}/${model.id}` : `unavailable (${judgeModelSpec(config, state.classifier)})`;
    ctx.ui.notify(`Rail test: running a real judge review (${modelLabel})...`, "info");
    try {
      const judge = await judgeToolCall({
        ctx,
        config,
        state: state.classifier,
        toolName: plan.toolName,
        input: plan.input,
        labels: resolution.labels,
        authorizationEvidence: named?.authorizationEvidence,
        recentGuardDecisions: recentEvents(state).map((event) => `${event.decision} ${event.toolName}: ${event.reason}`),
        completeFn: deps.completeFn,
      });
      const usage = judge.tokenUsage;
      const cost = usage ? `${usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)} in / ${usage.output} out tokens` : "token usage not reported";
      return {
        lines: [...lines, `  judge: would ${judge.decision} — ${judge.reason}`, `  real judge review by ${modelLabel} · ${cost}`],
        verdict: judge.decision === "allow" ? "would allow (judge)" : judge.decision === "deny" ? "would deny (judge)" : "would ask the user (judge)",
      };
    } catch (error) {
      return {
        lines: [...lines, `  judge: review failed — ${describeClassifierFailure(error)}`, "  a real call would fall back to asking the user"],
        verdict: "would ask the user (judge unavailable)",
      };
    }
  }

  async function testFileOp(ctx: ExtensionContext, config: ResolvedRailConfig, kind: "read" | "write", target: string): Promise<string[]> {
    const lines: string[] = [];
    let verdict = "would allow";
    let blocked = false;
    const labels: CapabilityId[] = [];

    if (state.readOnly && kind === "write") {
      lines.push("## Read-only gate", "  [BLOCK] on — write/edit are blocked deterministically", "");
      verdict = "would block (read-only mode)";
      blocked = true;
    } else if (state.readOnly) {
      lines.push("## Read-only gate", "  [ALLOW] on — reads are unaffected", "");
    }

    lines.push("## Path policy");
    if (!config.filesystem.enabled) {
      lines.push("  filesystem restrictions disabled — no path verdict");
    } else {
      const decision = decidePathAccess(config, ctx.cwd, target, kind);
      if (decision.allowed) {
        const worktreeNote = decision.worktreeRoot !== undefined ? ` (anchored at session repo checkout ${decision.worktreeRoot})` : "";
        lines.push(`  [ALLOW] ${kind} ${decision.matchedRoot !== undefined ? `allowed by root '${decision.matchedRoot}'` : "allowed: no deny pattern matches (blacklist mode)"}${worktreeNote}`);
      } else if (decision.code === "denied-by-pattern" && kind === "read") {
        lines.push(`  [ASK] ${decision.reason} → credentials label (no longer a hard block)`);
      } else if (decision.code === "outside-roots") {
        if (isSessionApproved(state, kind, decision.normalizedPath)) {
          lines.push(`  [ALLOW] ${decision.reason} — but already approved this session`);
        } else if (kind === "write") {
          lines.push(`  [ASK] ${decision.reason} → modify-system label`);
          labels.push("modify-system");
        } else {
          lines.push(`  [ASK] ${decision.reason} → would ask for session approval`);
          if (!blocked) verdict = "would ask for path approval";
        }
      } else {
        lines.push(`  [BLOCK] ${decision.reason}`);
        if (!blocked) verdict = "would block (path policy)";
        blocked = true;
      }
    }
    lines.push("");

    const plan: NamingPlan = { toolName: kind, input: { path: target } };
    if (blocked) {
      plan.skip = "not reached — the call is blocked deterministically";
    } else if (kind === "read") {
      const denied = denyReadMatch(config, ctx.cwd, target);
      const exemption = exemptReadCallReason(INTERCEPTED_TOOLS.read!, { path: target }, ctx.cwd, config, undefined);
      lines.push("## Read exemption");
      if (denied) {
        lines.push(`  [ASK] matches denyRead '${denied}' → credentials`);
        labels.push("credentials");
        plan.skip = "skipped — deterministically labeled credentials";
      } else if (exemption) {
        const label: CapabilityId = exemption.startsWith("matches allowRead") ? "read-system" : "read-project";
        lines.push(`  [ALLOW] exempt: ${exemption} → ${label}`);
        labels.push(label);
        plan.skip = `skipped — deterministically exempt (${exemption})`;
      } else {
        lines.push("  not exempt — the namer would label this read");
      }
      lines.push("");
    } else {
      // Writes carry no content in a dry run, so the screen sees the path only.
      const screen = screenToolCall("write", { path: target, content: "" }, ctx.cwd);
      lines.push("## Content screen", `  ${screen.tripped ? "[ASK]" : "[ALLOW]"} ${screen.summary}`, "  note: content not simulated — a real write also screens the body", "");
      if (screen.tripped) plan.skip = undefined;
      else if (screen.label) {
        labels.push(screen.label);
        plan.skip = `skipped — screen clean, deterministic label ${screen.label}`;
      }
    }

    lines.push("## Namer");
    const naming = await namerLines(ctx, config, plan);
    lines.push(...naming.lines);
    lines.push("");
    lines.push("## Disposition table");
    const table = await tableLines(ctx, config, [...labels, ...(naming.named?.labels ?? [])], naming.named, plan);
    lines.push(...table.lines);
    if (naming.failed) verdict = "review failed — see the namer section";
    else if (table.verdict && !blocked && verdict === "would allow") verdict = table.verdict;
    return [`  verdict: ${verdict}`, ...lines];
  }

  async function testCommand(ctx: ExtensionContext, config: ResolvedRailConfig, command: string): Promise<string[]> {
    const lines: string[] = [];
    const match = explainCommandMatch(command, { classify: config.commands.classify, allow: config.commands.allow });
    const enforcing = config.filesystem.enabled && state.initialized && state.backend?.name === "seatbelt";
    // What the matched rules would resolve to, which is what decides whether
    // the deterministic verdict stands on its own or needs the sandbox.
    const matchedLabels = matchedCapabilities(match);
    const matchedDisposition = match.matched ? resolveCapabilities(config, state.capabilities, matchedLabels).disposition : undefined;
    const exempt = match.matched && (matchedDisposition !== "allow" || enforcing);
    const classifierOn = classifierEnabled(config, state.classifier);
    let verdict = "would allow";
    let blocked = false;

    if (state.readOnly) {
      lines.push("## Read-only gate");
      if (classifierOn) lines.push("  [ALLOW] on — bash is named and resolved under the read-only disposition preset");
      else if (exempt) lines.push("  [ALLOW] on — deterministically classified commands stay allowed");
      else {
        lines.push("  [BLOCK] on — classifier is off, so commands cannot be reviewed for writes");
        verdict = "would block (read-only mode)";
        blocked = true;
      }
      lines.push("");
    }

    lines.push("## Command rules");
    if (match.matched) {
      lines.push(...match.segments.map((segment) => `  [ALLOW] ${describeSegmentMatch(segment)}`));
      lines.push(
        matchedDisposition !== "allow"
          ? `  every segment matched — deterministic labels resolve to ${matchedDisposition}, decided without a namer call`
          : enforcing
            ? "  every segment matched — deterministic capability labels, no namer call while the Seatbelt sandbox enforces"
            : "  every segment matched and resolves to allow, but the sandbox is not enforcing (Seatbelt required) — the namer still runs",
      );
    } else {
      lines.push(`  no deterministic verdict: ${match.reason}`);
      for (const segment of match.segments ?? []) {
        lines.push(segment.rule !== undefined ? `  [ALLOW] ${describeSegmentMatch(segment)}` : `  [BLOCK] \`${segment.command}\`: ${segment.refusal}`);
      }
      if ((match.segments ?? []).some((segment) => segment.rule !== undefined)) {
        lines.push("  partial matches carry no labels — the namer sees the whole command");
      }
    }
    lines.push("");

    const labels: CapabilityId[] = exempt ? matchedLabels : [];
    const plan: NamingPlan = { toolName: "bash", input: { command } };
    if (blocked) plan.skip = "not reached — the call is blocked deterministically";
    else if (exempt && matchedDisposition === "allow") plan.skip = `skipped — allowlisted while the sandbox enforces (${labels.join(", ")})`;
    else if (exempt) plan.skip = `skipped — deterministically classified ${labels.join(", ")} ⇒ ${matchedDisposition}`;

    const screen = screenToolCall("bash", { command }, ctx.cwd);
    if (screen.tripped) lines.push("## Content screen", `  [ASK] ${screen.summary}`, "");

    lines.push("## Namer");
    const naming = await namerLines(ctx, config, plan);
    lines.push(...naming.lines);
    lines.push("");
    lines.push("## Disposition table");
    const table = await tableLines(ctx, config, [...labels, ...(naming.named?.labels ?? [])], naming.named, plan);
    lines.push(...table.lines);
    if (naming.failed) verdict = "review failed — see the namer section";
    else if (table.verdict && !blocked) verdict = table.verdict;
    return [`  verdict: ${verdict}`, ...lines];
  }

  return async function runRailTest(args: string, ctx: ExtensionContext): Promise<void> {
    const subject = parseSubject(args);
    if (!subject) {
      const message = "Usage: /rail test <shell command> | test read <path> | test write <path>";
      if (!ctx.hasUI) console.log(message);
      ctx.ui.notify(message, "warning");
      return;
    }
    const config = state.config ?? loadConfig(ctx);
    syncCapabilityPreset(state);
    const subjectLabel = subject.kind === "command" ? `bash: ${subject.command}` : `${subject.kind}: ${subject.path}`;
    const body =
      subject.kind === "command"
        ? await testCommand(ctx, config, subject.command)
        : await testFileOp(ctx, config, subject.kind, subject.path);
    const report = ["# Rail Test (dry run — nothing executed)", "", `  ${subjectLabel}`, ...body.slice(0, 1), "", ...body.slice(1)];
    showRailView(ctx, state, "report", () => report);
  };
}
