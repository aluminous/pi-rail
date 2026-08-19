import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addUserGuidance, clearSessionGuidance, sessionGuidanceCount } from "../classifier.ts";
import { loadConfig, type StatusLineMode } from "../config.ts";
import type { DispositionPersistence } from "../dispositions.ts";
import { formatDecisionTrace, formatEmptyTrace } from "../decision-trace.ts";
import { updatePersistentStatusLine } from "../persistent-settings.ts";
import type { RuntimeState } from "../state.ts";
import { classifierModelLabel, networkPolicyLabel, updateRailStatus } from "../status.ts";
import { isStatusTab, PLAIN_THEME, statusReportLines, statusTabLines, type StatusTab, type StatusView } from "../status-tabs.ts";
import { showRailView, toggleRailPanel, toggleRailView } from "../live-view.ts";
import { appendRailTelemetry } from "../telemetry.ts";
import type { PanelTheme } from "../tui/report-panel.ts";
import { StatusPage } from "../tui/status-page.ts";
import { pickFromList, type SelectItem } from "../tui/select-list.ts";
import { formatError } from "../util.ts";
import { createDispositionCommands } from "./dispositions.ts";
import { runModelCommand } from "./model.ts";
import { createRailTest } from "./test.ts";
import { createRailWhy } from "./why.ts";

export interface RailCommandDeps {
  state: RuntimeState;
  enableRail(ctx: ExtensionContext): Promise<void>;
  disableRail(ctx: ExtensionContext, scope: "next-agent" | "session"): Promise<void>;
  runRailSmoke(ctx: ExtensionContext): Promise<void>;
  runCritique(args: string, ctx: ExtensionContext): Promise<void>;
  /** Disposition persist boundary; defaults to the global config writers, overridden in tests. */
  persistDisposition?: Partial<DispositionPersistence>;
  /**
   * Posts a rail notice into the agent's conversation context (pi.sendMessage
   * with the "pi-rail" custom type, delivered next turn so it never interrupts).
   * Optional: absent in tests and headless contexts that have no session to
   * message; toggleReadOnly degrades to a notify-only toast when it is unset.
   */
  postRailNotice?(content: string): void;
}

const SUBCOMMANDS: Array<{ value: string; description: string }> = [
  { value: "status", description: "Toggle the live status page: session, models, namer, judge, engine, policy tabs" },
  { value: "policy", description: "Open the capability policy page (edit rows and classes for this session; Ctrl+S saves)" },
  { value: "policy rules", description: "Open the status page on the resolved mechanism rules: filesystem, network, environment" },
  { value: "set", description: "Set one class for this session: set <class> [allow|judge|ask|deny]" },
  { value: "guide", description: "Add classifier guidance for this session: guide <text> (or bare to be prompted)" },
  { value: "guide clear", description: "Drop every guidance entry collected this session" },
  { value: "explain", description: "Show the newest decision trace (explain <n> for older ones)" },
  { value: "test", description: "Dry-run a shell command through the rail without executing it" },
  { value: "test read", description: "Dry-run a file read through the rail (test read <path>)" },
  { value: "test write", description: "Dry-run a file write through the rail (test write <path>)" },
  { value: "why", description: "Map sandbox denials from the last sandboxed command to rail rules" },
  { value: "on", description: "Enable the rail" },
  { value: "off", description: "Disable for the next agent turn, then re-enable" },
  { value: "off session", description: "Disable until the session ends (no rail!)" },
  { value: "readonly", description: "Toggle read-only mode: write/edit blocked, bash restricted" },
  { value: "model", description: "Choose the namer model (auto|current|off|provider/model); `model judge …` picks the judge" },
  { value: "smoke", description: "Run sandbox and namer smoke tests" },
  { value: "critique", description: "Critique the capability classes and content screen with a model" },
];

export function createRailCommand(deps: RailCommandDeps) {
  const { state } = deps;
  const runRailTest = createRailTest({ state });
  const runRailWhy = createRailWhy({ state });

  const show = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
    if (!ctx.hasUI) console.log(message);
    ctx.ui.notify(message, level);
  };

  const dispositions = createDispositionCommands({
    state,
    persist: deps.persistDisposition,
    notify: show,
  });

  /**
   * `/rail guide`: volunteer classifier guidance instead of waiting to be
   * asked. Entries join the same session ring approval comments feed, so the
   * namer and judge see them on the next action. Both the add and the clear
   * are persisted as rail records: session replay rebuilds the guidance ring
   * from the branch, and un-persisted guide traffic would silently vanish on
   * /tree navigation (or a cleared ring would resurrect).
   */
  async function runGuide(args: string, ctx: ExtensionContext): Promise<void> {
    const trimmed = args.trim();
    if (trimmed.toLowerCase() === "clear") {
      const removed = clearSessionGuidance(state.classifier);
      if (removed > 0) appendRailTelemetry(state, { kind: "guidance", tool: "rail", cleared: true });
      show(ctx, removed === 0 ? "No session guidance to clear." : `Cleared ${removed} guidance entr${removed === 1 ? "y" : "ies"}.`);
      return;
    }
    let text = trimmed;
    if (!text) {
      if (!ctx.hasUI) {
        show(ctx, "Usage: /rail guide <text>", "warning");
        return;
      }
      // Cancel and empty submit both resolve falsy here, and both mean no-op.
      text = (await ctx.ui.input("Guidance for the rail this session", "e.g. this repo's deploy script is expected to push")) ?? "";
      if (!text.trim()) return;
    }
    addUserGuidance(state.classifier, text);
    appendRailTelemetry(state, { kind: "guidance", tool: "rail", text });
    const { count, limit } = sessionGuidanceCount(state.classifier);
    show(ctx, `Guidance added for this session (${count}/${limit}).`);
  }

  async function enable(ctx: ExtensionContext): Promise<void> {
    try {
      await deps.enableRail(ctx);
      show(ctx, "Pi Rail enabled.");
    } catch (error) {
      state.enabled = false;
      state.initialized = false;
      state.lastError = formatError(error);
      show(ctx, `Could not enable Pi Rail: ${state.lastError}`, "error");
    }
  }

  async function disableTurn(ctx: ExtensionContext): Promise<void> {
    await deps.disableRail(ctx, "next-agent");
    show(ctx, "Pi Rail disabled for the next agent turn; it will re-enable when the agent finishes.", "warning");
  }

  async function disableSession(ctx: ExtensionContext): Promise<void> {
    await deps.disableRail(ctx, "session");
    show(ctx, "Pi Rail disabled for this session; bash and file-tool policy checks run without the rail.", "warning");
  }

  /**
   * Ctrl+R toggle. The common case flips the rail off for the upcoming agent
   * turn (it re-enables itself at agent_end, exactly like `/rail off`). Pressing
   * it again while that one-turn disable is armed re-enables immediately. And if
   * the rail was off for the whole session (`/rail off session` or config), the
   * toggle switches it back on rather than silently doing nothing.
   */
  async function toggleForTurn(ctx: ExtensionContext): Promise<void> {
    // disabledForNextAgent (off next turn) or fully off for the session → re-enable.
    if (state.disabledForNextAgent || !state.enabled) {
      await enable(ctx);
      return;
    }
    await disableTurn(ctx);
  }

  function toggleReadOnly(ctx: ExtensionContext): void {
    state.readOnly = !state.readOnly;
    const notice = state.readOnly
      ? "Rail read-only mode on: write/edit are blocked and bash is restricted to read-only commands."
      : "Rail read-only mode off: write/edit and bash are no longer restricted by read-only mode.";
    show(ctx, notice);
    // Mirror the toggle into the agent's context so the model knows the rail is
    // locked down (or freed) before its next turn — the read-only policy changes
    // what write/edit/bash it can get away with, so it is worth the context token.
    deps.postRailNotice?.(notice);
  }

  /** Shows the nth-newest decision trace (1-based, default newest) through the report view. */
  function showExplain(ctx: ExtensionContext, args: string): void {
    const total = state.traces.length;
    if (total === 0) {
      showRailView(ctx, state, "report", () => formatEmptyTrace().split("\n"));
      return;
    }
    const n = args.trim() === "" ? 1 : Number.parseInt(args.trim(), 10);
    if (!Number.isInteger(n) || n < 1 || n > total) {
      show(ctx, `Usage: /rail explain [n] with n between 1 (newest) and ${total}.`, "warning");
      return;
    }
    const trace = state.traces[n - 1]!;
    showRailView(ctx, state, "report", () => formatDecisionTrace(trace, n, total).split("\n"));
  }

  /** Width assumed for the RPC widget, which has no terminal to measure; wide enough for the models table. */
  const RPC_WIDTH = 100;

  function statusView(ctx: ExtensionContext, width: number, theme: PanelTheme): StatusView {
    const config = state.config ?? loadConfig(ctx);
    return { state, config, classifierLabel: classifierModelLabel(ctx, config, state), theme, width };
  }

  /**
   * The tabbed status page. In the TUI it is one docked panel, so invoking a
   * different tab while it is open switches rather than closing — only
   * re-invoking the tab you are already on toggles the panel shut.
   *
   * RPC has no tab affordance, so it degrades to a live widget: every tab
   * concatenated under its own header for `/rail status`, and the policy tab
   * alone for `/rail policy rules`. Headless has no user to show a view to,
   * which showRailView turns into a stderr error. None of these paths ever
   * posts into the conversation.
   */
  function openStatus(ctx: ExtensionContext, tab: StatusTab = "session"): void {
    const open = state.liveView;
    if (open?.kind === "status" && open.selectTab && open.activeTab?.() !== tab) {
      open.selectTab(tab);
      return;
    }
    const opened = toggleRailPanel(ctx, state, "status", (host) => {
      const page = new StatusPage({
        ...host,
        initialTab: tab,
        view: (width, theme) => statusView(ctx, width, theme),
      });
      // Let a later /rail policy rules retarget the tab on the open panel. The
      // live-view seam is string-typed so state.ts stays free of TUI types.
      if (state.liveView) {
        state.liveView.selectTab = (next) => {
          if (isStatusTab(next)) page.selectTab(next);
        };
        state.liveView.activeTab = () => page.activeTab();
      }
      return page;
    });
    if (opened) return;
    const lines = () => {
      const view = statusView(ctx, RPC_WIDTH, PLAIN_THEME);
      return tab === "policy" ? statusTabLines(view, "policy") : statusReportLines(view);
    };
    toggleRailView(ctx, state, tab === "policy" ? "policy" : "status", lines);
  }

  function panelHeader(ctx: ExtensionContext): string[] {
    const config = state.config ?? loadConfig(ctx);
    const health = state.enabled && state.initialized ? "enforcing" : state.enabled ? "enabled, not initialized" : state.disabledForNextAgent ? "off next turn" : "disabled";
    const modelLabel = classifierModelLabel(ctx, config, state);
    const classifier = modelLabel.startsWith("classifier") ? modelLabel : `classifier ${modelLabel}`;
    const s = state.stats;
    return [
      `${state.backend?.name ?? config.backend} · ${health} · ${networkPolicyLabel(config)} · ${classifier}`,
      `R${s.ruleHits} deterministic · C${s.classifierHits} reviews · D${s.classifierDenials} denials · ${s.blocked} blocked · ${s.errors} errors · ↑${s.classifierInputTokens} ↓${s.classifierOutputTokens} tokens`,
    ];
  }

  const STATUS_LINE_MODES: Array<{ value: StatusLineMode; description: string }> = [
    { value: "always", description: "Show the rail statusline at all times" },
    { value: "auto", description: "Show only when the rail is off or erroring, or something was denied since your last message" },
    { value: "never", description: "Hide the rail statusline entirely" },
  ];

  async function chooseStatusLine(ctx: ExtensionContext): Promise<void> {
    const config = state.config ?? loadConfig(ctx);
    state.config = config;
    const items: SelectItem<StatusLineMode>[] = STATUS_LINE_MODES.map((mode) => ({
      value: mode.value,
      label: mode.value,
      searchText: `${mode.value} statusline ${mode.description}`,
      description: mode.description,
      current: config.statusLine === mode.value,
    }));
    const picked = await pickFromList<StatusLineMode>(ctx, { title: "Rail statusline", items });
    if (!picked) return;
    config.statusLine = picked.value;
    try {
      updatePersistentStatusLine(picked.value);
      show(ctx, `Rail statusline set to ${picked.value} and saved.`);
    } catch (error) {
      show(ctx, `Rail statusline set to ${picked.value} for this session, but saving failed: ${formatError(error)}`, "warning");
    }
  }

  type PanelAction = "on" | "off-turn" | "off-session" | "readonly" | "model" | "statusline" | "smoke" | "critique" | "status" | "dispositions" | "policy-rules" | "explain";

  async function openPanel(ctx: ExtensionContext): Promise<void> {
    const items: SelectItem<PanelAction>[] = [];
    if (!state.enabled) {
      items.push({ value: "on", label: "Enable rail", searchText: "enable on start rail", description: "Initialize the sandbox backend and enforce policy" });
    } else {
      items.push(
        { value: "off-turn", label: "Disable for next turn", searchText: "disable off next turn pause", description: "One agent turn with no rail, then the rail re-enables itself" },
        { value: "off-session", label: "Disable for session", searchText: "disable off session no rail", description: "No rail until Pi restarts — asks for confirmation" },
      );
    }
    items.push(
      { value: "readonly", label: `Read-only mode: ${state.readOnly ? "on" : "off"}`, searchText: "readonly read only ro toggle mode", description: "Block write/edit and restrict bash to read-only commands" },
      { value: "model", label: "Reviewer models…", searchText: "model namer judge classifier auto choose select", description: "Pick the namer and judge models (Tab switches; namer supports auto/off)" },
      { value: "statusline", label: "Statusline visibility…", searchText: "statusline status line visibility always never auto hide show", description: "Show the rail statusline always, never, or only when notable" },
      { value: "smoke", label: "Run smoke tests", searchText: "smoke test verify sandbox namer classifier", description: "Verify sandboxed execution and capability naming end to end" },
      { value: "critique", label: "Critique capabilities", searchText: "critique capabilities classes screen rules review improve", description: "Have Pi's current model review the class definitions, table, and screen" },
      { value: "status", label: "Status page", searchText: "status report details approvals live popup overlay tabs models namer judge engine", description: "Live status page: decisions, reviewer cost, recent namings and judgements, engine, policy" },
      { value: "dispositions", label: "Dispositions…", searchText: "dispositions policy capabilities classes allow deny ask judge edit table page", description: "Edit the capability disposition table: arrows cycle a row for this session, Ctrl+S saves" },
      { value: "policy-rules", label: "Policy rules", searchText: "policy rules filesystem network environment provenance mechanism show", description: "Resolved filesystem/network/environment rules with their config provenance" },
      { value: "explain", label: "Explain last decision", searchText: "explain trace decision why last chain stages", description: "Show the decision chain the rail ran for the most recent tool call" },
    );

    const picked = await pickFromList<PanelAction>(ctx, { title: "Pi Rail", headerLines: panelHeader(ctx), items });
    if (!picked) return;
    switch (picked.value) {
      case "on":
        return enable(ctx);
      case "off-turn":
        return disableTurn(ctx);
      case "off-session": {
        const ok = await ctx.ui.confirm("Disable Pi Rail for this session?", "Bash and file-tool policy checks will run without the rail until Pi restarts.");
        if (ok) return disableSession(ctx);
        return;
      }
      case "readonly":
        return toggleReadOnly(ctx);
      case "model":
        return runModelCommand("", ctx, state);
      case "statusline":
        return chooseStatusLine(ctx);
      case "smoke":
        return deps.runRailSmoke(ctx);
      case "critique":
        return deps.runCritique("", ctx);
      case "status":
        return openStatus(ctx);
      case "dispositions":
        return dispositions.openSettings(ctx);
      case "policy-rules":
        // Same routing as `/rail policy rules`: the status page's policy tab.
        return openStatus(ctx, "policy");
      case "explain":
        return showExplain(ctx, "");
    }
  }

  async function handler(args: string, ctx: ExtensionContext): Promise<void> {
    try {
      await dispatch(args, ctx);
    } finally {
      updateRailStatus(ctx, state);
    }
  }

  async function dispatch(args: string, ctx: ExtensionContext): Promise<void> {
    const trimmed = args.trim();
    const [head = "", ...restParts] = trimmed.split(/\s+/);
    const rest = restParts.join(" ");
    const sub = head.toLowerCase();

    // Headless modes have no user to drive these; the seam modules turn them
    // into a clean no-op (pickFromList resolves undefined) or stderr error.
    if (!sub) return openPanel(ctx);
    if (sub === "status") return openStatus(ctx);
    // /rail policy IS the disposition page; the resolved mechanism rules are a
    // tab of the status page, since they are evidence rather than something to edit.
    if (sub === "policy") {
      const target = rest.trim().toLowerCase();
      if (!target) return dispositions.openSettings(ctx);
      if (target === "rules") return openStatus(ctx, "policy");
      show(ctx, "Usage: /rail policy [rules]", "warning");
      return;
    }
    if (sub === "set") return dispositions.runSet(rest, ctx);
    if (sub === "guide") return runGuide(rest, ctx);
    if (sub === "explain") return showExplain(ctx, rest);
    if (sub === "test") return runRailTest(rest, ctx);
    if (sub === "why" && !rest) return runRailWhy(ctx);
    if (sub === "on" || sub === "enable") return enable(ctx);
    if (sub === "off" || sub === "disable") {
      if (rest.toLowerCase() === "session") return disableSession(ctx);
      if (!rest) return disableTurn(ctx);
    }
    if ((sub === "readonly" || sub === "ro") && !rest) return toggleReadOnly(ctx);
    if (sub === "model") return runModelCommand(rest, ctx, state);
    if (sub === "smoke" && !rest) return deps.runRailSmoke(ctx);
    if (sub === "critique") return deps.runCritique(rest, ctx);

    show(ctx, "Usage: /rail [status|policy [rules]|set <class> [disposition]|guide <text>|guide clear|explain [n]|test …|why|on|off|off session|readonly|model …|smoke|critique …]", "warning");
  }

  function getArgumentCompletions(argumentPrefix: string) {
    const prefix = argumentPrefix.replace(/^\s+/, "");
    const setMatch = prefix.match(/^set\s+(.*)$/i);
    if (setMatch) return dispositions.setCompletions(setMatch[1]!);
    // The judge subform comes first: it is a different keyword set, and only
    // `model judge ` (with the space) opens it, so `model ju` still completes
    // to `model judge` through the namer branch below.
    const judgeMatch = prefix.match(/^model\s+judge\s+(.*)$/i);
    if (judgeMatch) {
      const partial = judgeMatch[1]!.toLowerCase();
      // No "auto" and no "off": the judge cannot be disabled, and auto is the
      // namer's cheap-model list.
      const fixed = ["current", "status"];
      const items = [...fixed, ...state.availableModelSpecs]
        .filter((spec) => spec.toLowerCase().includes(partial))
        .slice(0, 20)
        .map((spec) => ({ value: `model judge ${spec}`, label: spec, description: fixed.includes(spec) ? undefined : "configured model" }));
      return items.length > 0 ? items : null;
    }
    const modelMatch = prefix.match(/^(model|critique)\s+(.*)$/i);
    if (modelMatch) {
      const sub = modelMatch[1]!.toLowerCase();
      const partial = modelMatch[2]!.toLowerCase();
      const fixed = sub === "model" ? ["auto", "current", "off", "status", "judge"] : [];
      const specs = [...fixed, ...state.availableModelSpecs];
      const items = specs
        .filter((spec) => spec.toLowerCase().includes(partial))
        .slice(0, 20)
        .map((spec) => ({ value: `${sub} ${spec}`, label: spec, description: fixed.includes(spec) ? undefined : "configured model" }));
      return items.length > 0 ? items : null;
    }
    const items = SUBCOMMANDS
      .filter((cmd) => cmd.value.startsWith(prefix.toLowerCase()))
      .map((cmd) => ({ value: cmd.value, label: cmd.value, description: cmd.description }));
    return items.length > 0 ? items : null;
  }

  return { handler, getArgumentCompletions, toggleForTurn };
}
