// /rail grant add <file>, /rail grant check <file>, and /rail grants: grants by
// hand (GRANTS_PLAN phase 3). A grant file is evaluated by the gates
// (src/grant-eval.ts) against the live session; `check` prints the report and
// changes nothing, `add` opens the confirmation, and `grants` lists every named
// grant with revoke / promote / demote.
//
// Approval is the rail's own dialog and nothing else. A sensitive op is
// approved by toggling it in the confirmation (a key that is not Enter); no
// text — the grant's request, a comment, guidance — approves anything, and
// this path never goes through the approval mailbox: a session without a UI of
// its own cannot approve a sensitive op, and cannot apply a widening grant at
// all.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EVAL_CASES } from "../../eval/cases.ts";
import { classifierEnabled } from "../classifier.ts";
import { globalRailConfigPath, loadConfig, loadPolicyLayers, projectRailConfigPath, type ResolvedRailConfig } from "../config.ts";
import {
  confirmationLines,
  evaluateGrant,
  formatGrantReport,
  grantWithApprovedOps,
  type CriticalCase,
  type GrantEvalContext,
  type GrantReport,
  type NameFn,
} from "../grant-eval.ts";
import { showRailPanel, showRailView, toggleRailPanel, toggleRailView } from "../live-view.ts";
import { addGrantToConfigFile, removeGrantFromConfigFile } from "../persistent-settings.ts";
import { SESSION_EDITS_GRANT_ID, type Grant, type GrantLayerName, type PolicyLayer } from "../policy-store.ts";
import { readCorpus, type CorpusRecord } from "../replay-corpus.ts";
import { addSessionGrant, demoteGrantToSession, promoteSessionGrant, reloadBaseConfig, revokeGrant, type GrantFileOps } from "../session-policy.ts";
import type { RuntimeState } from "../state.ts";
import {
  GrantConfirmPage,
  GrantsPage,
  grantActions,
  grantAnswerOptions,
  lastDecidedLabel,
  sensitiveOpGroups,
  type GrantAction,
  type GrantAnswer,
  type GrantRow,
} from "../tui/grant-page.ts";
import { pickFromList, type SelectItem } from "../tui/select-list.ts";
import { formatError } from "../util.ts";

export interface GrantCommandDeps {
  state: RuntimeState;
  notify(ctx: ExtensionContext, message: string, level?: "info" | "warning" | "error"): void;
  /** The base config folded from the files; default loadConfig. Also what a file-layer change refolds from. */
  loadBase?: (ctx: ExtensionContext) => ResolvedRailConfig;
  /** The file layers, for existing grants and their examples; default loadPolicyLayers. */
  loadLayers?: (ctx: ExtensionContext) => PolicyLayer[];
  /** The replay corpus; default: the wired corpus directory, or nothing. */
  readCorpus?: () => CorpusRecord[];
  /** Eval cases for gate 4; default eval/cases.ts. */
  evalCases?: readonly CriticalCase[];
  /** Grant file writers; default the real config files. */
  files?: Pick<GrantFileOps, "write" | "remove">;
  /** Optional namer re-run hook for the gates (no production caller yet). */
  nameFn?: NameFn;
  today?: () => string;
}

/** A grant file as read: the raw object with `created` defaulted, or why it cannot be used. */
export function readGrantFile(file: string, cwd: string, today: string): { raw: Record<string, unknown>; path: string } | { error: string } {
  const expanded = file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;
  const resolved = path.resolve(cwd, expanded);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    return { error: `Could not read ${resolved}: ${formatError(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: `${resolved} must hold one grant object` };
  const raw = { ...(parsed as Record<string, unknown>) };
  if (typeof raw.request !== "string" || !raw.request.trim()) return { error: `${resolved}: "request" is required — the request in your own words` };
  if (raw.created === undefined) raw.created = today;
  return { raw, path: resolved };
}

/** Per grant id: decisions it decided in the corpus, and the newest one's timestamp. */
export function grantUsage(records: readonly CorpusRecord[]): Map<string, { total: number; last?: string }> {
  const usage = new Map<string, { total: number; last?: string }>();
  for (const record of records) {
    if (!record.grant) continue;
    const entry = usage.get(record.grant) ?? { total: 0 };
    entry.total++;
    if (!entry.last || record.at > entry.last) entry.last = record.at;
    usage.set(record.grant, entry);
  }
  return usage;
}

function projectConfigAvailable(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted() && existsSync(path.dirname(projectRailConfigPath(ctx.cwd)));
  } catch {
    return false;
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function createGrantCommands(deps: GrantCommandDeps) {
  const { state, notify } = deps;
  const loadBase = deps.loadBase ?? ((ctx: ExtensionContext) => loadConfig(ctx));
  const loadLayers = deps.loadLayers ?? ((ctx: ExtensionContext) => loadPolicyLayers(ctx).layers);
  const corpus = deps.readCorpus ?? (() => (state.corpus ? readCorpus(state.corpus.dir) : []));
  const today = deps.today ?? (() => new Date().toISOString().slice(0, 10));
  const files = deps.files ?? {};

  function effective(ctx: ExtensionContext): ResolvedRailConfig {
    if (!state.config) state.config = loadBase(ctx);
    return state.config!;
  }

  function fileOps(ctx: ExtensionContext, notes: string[]): GrantFileOps {
    return { write: files.write ?? addGrantToConfigFile, remove: files.remove ?? removeGrantFromConfigFile, reload: () => loadBase(ctx), notes };
  }

  /** Every named grant, with its layer and full content (examples included). */
  function existingGrants(ctx: ExtensionContext): Array<{ layer: GrantLayerName; grant: Grant; file?: string }> {
    const fromFiles = loadLayers(ctx).flatMap((layer) => layer.grants.map((grant) => ({ layer: layer.name as GrantLayerName, grant, ...(layer.file ? { file: layer.file } : {}) })));
    return [...fromFiles, ...state.sessionPolicy.grants.map((grant) => ({ layer: "session" as const, grant }))];
  }

  function evalContext(ctx: ExtensionContext, records: readonly CorpusRecord[]): GrantEvalContext {
    const base = effective(ctx);
    return {
      base,
      layer: "session",
      session: state.sessionPolicy,
      existingGrants: existingGrants(ctx),
      corpus: records,
      evalCases: deps.evalCases ?? EVAL_CASES,
      cwd: ctx.cwd,
      classifierEnabled: classifierEnabled(base, state.classifier),
      enforcing: true,
      ...(deps.nameFn ? { nameFn: deps.nameFn } : {}),
    };
  }

  async function evaluateFile(ctx: ExtensionContext, file: string): Promise<{ report: GrantReport; records: readonly CorpusRecord[] } | undefined> {
    if (!file.trim()) {
      notify(ctx, "Usage: /rail grant add <file> | /rail grant check <file>", "warning");
      return undefined;
    }
    const read = readGrantFile(file.trim(), ctx.cwd, today());
    if ("error" in read) {
      notify(ctx, read.error, "warning");
      return undefined;
    }
    const records = corpus();
    return { report: await evaluateGrant(read.raw, evalContext(ctx, records)), records };
  }

  /** `/rail grant check <file>`: the full report, nothing applied; works headless. */
  async function runCheck(file: string, ctx: ExtensionContext): Promise<void> {
    const evaluated = await evaluateFile(ctx, file);
    if (!evaluated) return;
    const lines = formatGrantReport(evaluated.report);
    if (!ctx.hasUI) {
      console.log(lines.join("\n"));
      return;
    }
    showRailView(ctx, state, "report", () => lines);
  }

  /**
   * Applies a confirmed grant: the non-sensitive ops plus the approved
   * sensitive ones. When unapproved sensitive ops are dropped the rest is
   * re-evaluated first, and a remainder that fails its gates (its own
   * examples, typically) is not applied. Returns an error to show, or
   * undefined once applied.
   */
  async function apply(ctx: ExtensionContext, report: GrantReport, records: readonly CorpusRecord[], answer: Exclude<GrantAnswer, "discard">, approved: ReadonlySet<number>): Promise<string | undefined> {
    const original = report.grant;
    if (!original || !report.ok) return "This grant failed its gates and cannot be applied.";
    const { grant, dropped } = grantWithApprovedOps(original, report.sensitive, approved);
    if (grant.ops.length === 0) return "Every op of this grant is sensitive and none is approved — nothing to apply.";
    if (dropped.length > 0) {
      const again = await evaluateGrant(grant, evalContext(ctx, records));
      const droppedLabel = `op${dropped.length === 1 ? "" : "s"} ${dropped.map((index) => index + 1).join(", ")}`;
      if (!again.ok) return `Without the unapproved sensitive ${droppedLabel}, the grant fails its gates: ${again.failures[0] ?? "see /rail grant check"}. Approve it, or edit the grant.`;
      // Leaving ops out can move gate 5's attribution onto an op that was not
      // sensitive before; it must be approved too.
      const kept = original.ops.map((_, index) => index).filter((index) => !dropped.includes(index));
      const fresh = again.sensitive.map((item) => kept[item.opIndex]!).filter((index) => !approved.has(index));
      if (fresh.length > 0) return `Without the unapproved sensitive ${droppedLabel}, op ${fresh[0]! + 1} becomes sensitive (${again.sensitive.find((item) => kept[item.opIndex] === fresh[0])?.reason}). Approve it too, or discard.`;
    }
    const droppedNote = dropped.length > 0 ? `; dropped unapproved sensitive op${dropped.length === 1 ? "" : "s"} ${dropped.map((index) => index + 1).join(", ")}` : "";
    const opsNote = `${plural(grant.ops.length, "op")}${droppedNote}`;
    try {
      if (answer === "session") {
        const problems = addSessionGrant(state, grant);
        notify(ctx, `Grant ${grant.id} applied for this session (${opsNote}).${problems.length > 0 ? ` ${problems.join("; ")}` : ""} /rail grants promotes it to a config file.`);
        return undefined;
      }
      const file = answer === "global" ? globalRailConfigPath() : projectRailConfigPath(ctx.cwd);
      (files.write ?? addGrantToConfigFile)(file, grant);
      const notes = reloadBaseConfig(state, () => loadBase(ctx));
      notify(ctx, `Grant ${grant.id} saved to the ${answer} config (${file}) and applied (${opsNote}).${notes.length > 0 ? ` ${notes.join(" ")}` : ""}`);
      return undefined;
    } catch (error) {
      return `Could not apply ${grant.id}: ${formatError(error)}`;
    }
  }

  /** `/rail grant add <file>`: evaluate, then the confirmation. */
  async function runAdd(file: string, ctx: ExtensionContext): Promise<void> {
    const evaluated = await evaluateFile(ctx, file);
    if (!evaluated) return;
    const { report, records } = evaluated;

    // No UI of its own: nothing can be approved here, so nothing that widens
    // is applied — the dialog is the only approval there is.
    if (!ctx.hasUI) {
      const lines = formatGrantReport(report);
      console.log(lines.join("\n"));
      if (!report.ok) {
        notify(ctx, `Grant ${report.grant?.id ?? ""} rejected by its gates; nothing applied.`, "warning");
        return;
      }
      if (report.widening || report.sensitive.length > 0) {
        notify(ctx, `Grant ${report.grant!.id} widens policy, which needs the rail's own confirmation dialog: run /rail grant add in an interactive session. Nothing applied.`, "warning");
        return;
      }
      const error = await apply(ctx, report, records, "session", new Set());
      if (error) notify(ctx, error, "warning");
      return;
    }

    const projectAvailable = projectConfigAvailable(ctx);
    const opened = showRailPanel(ctx, state, "grant", (host) => new GrantConfirmPage({
      ...host,
      report,
      projectAvailable,
      apply: (answer, approved) => apply(ctx, report, records, answer, approved),
      discard: () => notify(ctx, `Grant ${report.grant?.id ?? ""} discarded; nothing applied.`),
    }));
    if (opened) return;
    await runConfirmSelect(ctx, report, records, projectAvailable);
  }

  /**
   * RPC degradation of the confirmation: one select per sensitive op (its
   * first, default answer drops it), then the answers. A pick is a deliberate
   * action in the rail's dialog, like the TUI toggle.
   */
  async function runConfirmSelect(ctx: ExtensionContext, report: GrantReport, records: readonly CorpusRecord[], projectAvailable: boolean): Promise<void> {
    const title = ["Rail grant", ...confirmationLines(report)].join("\n");
    if (!report.ok) {
      showRailView(ctx, state, "report", () => formatGrantReport(report));
      notify(ctx, `Grant ${report.grant?.id ?? ""} rejected by its gates; nothing applied.`, "warning");
      return;
    }
    const approved = new Set<number>();
    for (const group of sensitiveOpGroups(report.sensitive)) {
      const choice = await ctx.ui.select(`${title}\n\nSensitive op ${group.opIndex + 1}: ${group.reasons.join("; ")}\nThis op needs its own approval.`, ["Drop this op", "Approve this op"]);
      if (choice === undefined) {
        notify(ctx, `Grant ${report.grant!.id} discarded; nothing applied.`);
        return;
      }
      if (choice === "Approve this op") approved.add(group.opIndex);
    }
    const options = grantAnswerOptions(projectAvailable);
    const picked = await ctx.ui.select(title, options.map((option) => option.label));
    const answer = options.find((option) => option.label === picked)?.value;
    if (!answer || answer === "discard") {
      notify(ctx, `Grant ${report.grant!.id} discarded; nothing applied.`);
      return;
    }
    const error = await apply(ctx, report, records, answer, approved);
    if (error) notify(ctx, error, "warning");
  }

  // ── /rail grants ────────────────────────────────────────────────────────────

  function grantRows(ctx: ExtensionContext): GrantRow[] {
    const config = effective(ctx);
    const usage = grantUsage(corpus());
    const content = new Map(existingGrants(ctx).map((entry) => [`${entry.layer}:${entry.grant.id}`, entry.grant]));
    return config.grants
      .filter((applied) => applied.id !== SESSION_EDITS_GRANT_ID)
      .map((applied) => {
        const grant = content.get(`${applied.layer}:${applied.id}`);
        const used = usage.get(applied.id);
        return {
          id: applied.id,
          request: applied.request,
          layer: applied.layer,
          ...(applied.file ? { file: applied.file } : {}),
          ops: grant?.ops.length ?? 0,
          examples: grant?.examples?.length ?? 0,
          session: state.grantDecisions[applied.id] ?? 0,
          corpus: used?.total ?? 0,
          ...(used?.last ? { lastDecided: used.last } : {}),
        };
      });
  }

  function act(ctx: ExtensionContext, row: GrantRow, action: GrantAction): { message: string; level: "info" | "warning" | "error" } {
    const notes: string[] = [];
    const ops = fileOps(ctx, notes);
    let error: string | undefined;
    let done: string;
    try {
      switch (action) {
        case "revoke":
          error = revokeGrant(state, row.layer, row.id, row.file, ops);
          done = `Revoked ${row.id} from the ${row.layer} layer.`;
          break;
        case "promote-global":
        case "promote-project": {
          const layer = action === "promote-global" ? "global" : "project";
          const file = layer === "global" ? globalRailConfigPath() : projectRailConfigPath(ctx.cwd);
          // No new approval: the grant was approved (sensitive ops one by
          // one) when it was applied, and promotion moves it unchanged.
          error = promoteSessionGrant(state, row.id, { layer, file }, ops);
          done = `Promoted ${row.id} to the ${layer} config (${file}).`;
          break;
        }
        case "demote":
          if (row.layer === "session" || !row.file) {
            error = `${row.id} is not in a config file.`;
            done = "";
            break;
          }
          error = demoteGrantToSession(state, { layer: row.layer, file: row.file }, row.id, ops);
          done = `Demoted ${row.id} to this session; it is no longer in ${row.file}.`;
          break;
      }
    } catch (caught) {
      error = formatError(caught);
      done = "";
    }
    if (error) return { message: error, level: "warning" };
    return { message: [done, ...notes].join(" "), level: notes.length > 0 ? "warning" : "info" };
  }

  function rowLine(row: GrantRow): string {
    return `${row.id} · ${row.layer} · ${plural(row.ops, "op")} · ${row.session} this session · ${row.corpus} in corpus · ${lastDecidedLabel(row)}`;
  }

  /** `/rail grants`: the grants view (TUI), a select flow (RPC), a printed list (headless). */
  async function openGrants(ctx: ExtensionContext): Promise<void> {
    const projectAvailable = projectConfigAvailable(ctx);
    const opened = toggleRailPanel(ctx, state, "grants", (host) => new GrantsPage({
      ...host,
      rows: () => grantRows(ctx),
      projectAvailable,
      act: (row, action) => {
        const result = act(ctx, row, action);
        notify(ctx, result.message, result.level);
        return result;
      },
    }));
    if (opened) return;
    if (!ctx.hasUI) {
      const rows = grantRows(ctx);
      console.log(rows.length === 0 ? "No grants." : rows.map(rowLine).join("\n"));
      return;
    }
    for (;;) {
      const rows = grantRows(ctx);
      if (rows.length === 0) {
        toggleRailView(ctx, state, "grants", () => ["No grants. /rail grant add <file> adds one."]);
        return;
      }
      const picked = await pickFromList<string>(ctx, {
        title: "Grants",
        items: rows.map((row) => ({ value: `${row.layer}:${row.id}`, label: rowLine(row), searchText: `${row.id} ${row.layer} ${row.request}`, description: row.request })),
      });
      if (!picked) return;
      const row = rows.find((entry) => `${entry.layer}:${entry.id}` === picked.value);
      if (!row) return;
      const labels: Record<GrantAction, string> = {
        "promote-global": "Promote to the global config",
        "promote-project": "Promote to the project config",
        demote: "Demote to this session",
        revoke: "Revoke (delete the grant)",
      };
      const items: SelectItem<GrantAction>[] = grantActions(row, projectAvailable).map((action) => ({ value: action, label: labels[action], searchText: labels[action] }));
      const choice = await pickFromList<GrantAction>(ctx, { title: `${row.id} — ${row.request}`, items });
      if (!choice) continue;
      if (choice.value === "revoke" && !(await ctx.ui.confirm(`Revoke ${row.id}?`, `It is deleted from the ${row.layer} layer${row.file ? ` (${row.file})` : ""}.`))) continue;
      const result = act(ctx, row, choice.value);
      notify(ctx, result.message, result.level);
    }
  }

  /** `/rail grant <add|check> <file>`. */
  async function runGrant(args: string, ctx: ExtensionContext): Promise<void> {
    const [sub = "", ...rest] = args.trim().split(/\s+/);
    const file = rest.join(" ");
    if (sub === "add") return runAdd(file, ctx);
    if (sub === "check") return runCheck(file, ctx);
    notify(ctx, "Usage: /rail grant add <file> | /rail grant check <file> — /rail grants lists them", "warning");
  }

  return { runGrant, openGrants, grantRows };
}
