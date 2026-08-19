import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { startApprovalMailbox } from "./src/approval-mailbox.ts";
import { askRailApproval, wireBlockedSignal } from "./src/approvals.ts";
import { NoneBackend } from "./src/backends/none.ts";
import { SeatbeltBackend } from "./src/backends/seatbelt.ts";
import type { RailBackend } from "./src/backends/types.ts";
import { createCritiqueRunner } from "./src/commands/critique.ts";
import { createRailCommand } from "./src/commands/rail.ts";
import { createRailSmoke } from "./src/commands/smoke.ts";
import { loadConfig, type ResolvedRailConfig } from "./src/config.ts";
import { interceptToolCall } from "./src/interceptor.ts";
import { compileFilesystemPolicy, summarizeDegradedPatterns } from "./src/policy.ts";
import { createRuntimeState, resetSessionState, resetTurnStats } from "./src/state.ts";
import { registerRailMessageRenderer, updateRailStatus } from "./src/status.ts";
import { acknowledgeRailInSubagentChild, warnUnacknowledgedSubagents } from "./src/subagents-interop.ts";
import { createSandboxedBashOps } from "./src/tools/bash.ts";
import { formatError } from "./src/util.ts";

function makeBackend(config: ResolvedRailConfig): RailBackend {
  if (config.backend === "seatbelt") return new SeatbeltBackend();
  if (config.backend === "none") return new NoneBackend();
  throw new Error("The container backend is planned but not implemented yet");
}

export default function (pi: ExtensionAPI) {
  registerRailMessageRenderer(pi);

  pi.registerFlag("no-rail", {
    description: "Disable the Pi Rail extension and run bash without the rail",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const localBash = createBashTool(localCwd);
  const localBashOps = createLocalBashOperations();
  const state = createRuntimeState();
  // Decision telemetry lands in pi's own session log as custom entries
  // (user-approved feature: rail decision records via pi.appendEntry).
  state.appendEntry = (customType, data) => pi.appendEntry(customType, data);
  // Pane managers (herdr) learn via the shared bus when an approval dialog is
  // blocking on the user; harmless when nothing listens.
  wireBlockedSignal(state, pi.events);

  function sandboxedOps() {
    if (!state.backend || !state.config) return undefined;
    return createSandboxedBashOps({
      backend: state.backend,
      config: state.config,
      enabled: () => state.enabled,
      initialized: () => state.initialized,
      lastError: () => state.lastError,
      recordCommand: (command) => {
        const record = { command, startedAt: Date.now(), endedAt: undefined as number | undefined };
        state.lastBashCommand = record;
        return () => {
          record.endedAt = Date.now();
        };
      },
    });
  }

  // Statusline convention: the statusline is a pure projection of RuntimeState.
  // Mutators (enableRail, record* helpers, commands) never refresh it themselves;
  // instead every entry point — each event handler below and the /rail command
  // dispatch — ends with a single updateRailStatus call, usually in a finally.
  async function enableRail(ctx: ExtensionContext): Promise<void> {
    const config = state.config ?? loadConfig(ctx);
    config.enabled = true;
    state.config = config;
    if (state.enabled && state.initialized) return;
    state.enabled = true;
    state.disabledForNextAgent = false;
    state.lastError = undefined;
    if (state.initialized && state.backend) return;
    state.backend = makeBackend(config);
    const support = await state.backend.supported();
    if (!support.ok) throw new Error(support.reason);
    await state.backend.initialize(config, ctx);
    state.initialized = true;
  }

  async function disableRail(_ctx: ExtensionContext, scope: "next-agent" | "session" = "next-agent"): Promise<void> {
    state.enabled = false;
    state.disabledForNextAgent = scope === "next-agent";
  }

  pi.registerTool({
    ...localBash,
    label: "bash (Pi Rail)",
    async execute(id, params, signal, onUpdate) {
      const ops = sandboxedOps();
      if (!ops || !state.enabled) return localBash.execute(id, params, signal, onUpdate);
      const tool = createBashTool(localCwd, { operations: ops });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", () => {
    if (!state.enabled) return { operations: localBashOps };
    const ops = sandboxedOps();
    if (!ops) return { operations: localBashOps };
    return { operations: ops };
  });

  pi.on("tool_call", async (event, ctx) => {
    state.lastUiContext = ctx;
    try {
      return await interceptToolCall(event, ctx, state);
    } finally {
      updateRailStatus(ctx, state);
    }
  });

  // pi-subagents interop: warn when a finished subagent child never acknowledged
  // the rail on its event bus — that child ran with no rail (see subagents-interop.ts).
  pi.on("tool_result", (event, ctx) => {
    warnUnacknowledgedSubagents(event, ctx, state);
  });

  // turn_start/turn_end fire on every agent-loop iteration; per-turn stats span a whole user prompt, so reset on agent_start.
  pi.on("agent_start", (_event, ctx) => {
    state.lastUiContext = ctx;
    resetTurnStats(state);
    updateRailStatus(ctx, state);
  });

  pi.on("turn_end", (_event, ctx) => {
    state.lastUiContext = ctx;
    updateRailStatus(ctx, state);
  });

  // The classifier label can show "current"/"auto", which resolve against the session model.
  pi.on("model_select", (_event, ctx) => {
    updateRailStatus(ctx, state);
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      resetSessionState(state);
      state.lastUiContext = ctx;
      // The approval mailbox serves headless children even when this session's
      // own rail is disabled, so it starts before the early returns below. ??=
      // keeps it process-lifetime: detached children outlive /new, and a new
      // mailbox here would silently orphan their in-flight asks.
      state.approvalMailbox ??= startApprovalMailbox({ state, ask: askRailApproval });

      const disabledByFlag = pi.getFlag("no-rail") as boolean;
      const config = loadConfig(ctx);
      state.config = config;
      state.warnings.push(...config.diagnostics);
      if (config.enabled && config.backend === "seatbelt" && config.filesystem.enabled) {
        const degraded = summarizeDegradedPatterns(compileFilesystemPolicy(config, ctx.cwd).degraded);
        if (degraded) state.warnings.push(degraded);
      }
      state.availableModelSpecs = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);

      for (const warning of state.warnings) ctx.ui.notify(warning, "warning");

      if (disabledByFlag) {
        state.enabled = false;
        state.disabledForNextAgent = false;
        state.backend = new NoneBackend();
        ctx.ui.notify("Pi Rail disabled by --no-rail; bash will run without the rail.", "warning");
        return;
      }

      if (!config.enabled) {
        state.enabled = false;
        state.disabledForNextAgent = false;
        state.backend = new NoneBackend();
        ctx.ui.notify("Rail disabled by config; bash will run without the rail.", "info");
        return;
      }

      try {
        await enableRail(ctx);
        ctx.ui.notify(`Rail initialized with ${state.backend?.name ?? config.backend} backend.`, "info");
        // In a pi-subagents child, prove to the parent that the rail is enforcing here.
        acknowledgeRailInSubagentChild(pi, state);
      } catch (error) {
        state.initialized = false;
        state.lastError = formatError(error);
        ctx.ui.notify(`Rail initialization failed; bash will be blocked: ${state.lastError}`, "error");
      }
    } finally {
      updateRailStatus(ctx, state);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    try {
      if (!state.disabledForNextAgent) return;
      state.disabledForNextAgent = false;
      if (!state.config?.enabled) return;
      try {
        await enableRail(ctx);
        ctx.ui.notify("Pi Rail re-enabled after one turn without the rail.", "info");
      } catch (error) {
        state.enabled = false;
        state.initialized = false;
        state.lastError = formatError(error);
        ctx.ui.notify(`Could not re-enable Pi Rail: ${state.lastError}`, "error");
      }
    } finally {
      updateRailStatus(ctx, state);
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // Quit and reload really end this extension instance; a session switch
    // (/new) does not, and the mailbox deliberately survives it.
    const reason = (event as { reason?: string }).reason;
    if (reason === "quit" || reason === "reload") {
      state.approvalMailbox?.stop();
      state.approvalMailbox = undefined;
    }
    state.liveView?.close();
    if (state.backend && state.initialized) {
      try {
        await state.backend.shutdown();
      } catch (error) {
        ctx.ui.notify(`Rail shutdown warning: ${formatError(error)}`, "warning");
      }
    }
    state.initialized = false;
    ctx.ui.setStatus("rail", undefined);
  });

  const runRailSmoke = createRailSmoke({ state, sandboxedOps });
  const runCritique = createCritiqueRunner({ state });
  const railCommand = createRailCommand({
    state,
    enableRail,
    disableRail,
    runRailSmoke,
    runCritique,
    // Custom messages participate in LLM context; nextTurn queues for the next
    // prompt so the notice never interrupts the current turn.
    postRailNotice: (content) => pi.sendMessage({ customType: "pi-rail", content, display: true }, { deliverAs: "nextTurn" }),
  });
  const { toggleForTurn } = railCommand;

  pi.registerCommand("rail", {
    description: "Pi Rail control panel; or: status|policy [rules]|set <class> [disposition]|explain|test|why|on|off|off session|readonly|model|smoke|critique",
    getArgumentCompletions: railCommand.getArgumentCompletions,
    handler: railCommand.handler,
  });

  // No built-in binding uses these. Conflicts with other extensions are
  // reported by pi's extension runner as shortcut diagnostics.
  // (ctrl+shift+d is hardcoded in pi-tui to write a debug log, so it is
  // avoided; ctrl+shift+t is free of any default or hardcoded binding.)
  pi.registerShortcut("ctrl+shift+t", {
    description: "Toggle rail read-only mode",
    handler: (ctx) => railCommand.handler("readonly", ctx),
  });

  pi.registerShortcut("ctrl+shift+r", {
    description: "Toggle Pi Rail on/off for this turn",
    handler: (ctx) => toggleForTurn(ctx),
  });
}
