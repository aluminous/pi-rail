import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { RailViewKind, RuntimeState } from "./state.ts";
import { styleRailLine } from "./status.ts";
import { RailReportPanel, type PanelTheme, type PanelTui } from "./tui/report-panel.ts";
import type { Keybindings } from "./tui/select-list.ts";

/** What ctx.ui.custom hands a docked panel, narrowed to the structural slices the rail panels use. */
export interface RailPanelHost {
  tui: PanelTui;
  theme: PanelTheme;
  keybindings: Keybindings;
  done(value: undefined): void;
}

/** A docked panel the live view can refresh in place. */
export type RailPanelFactory = (host: RailPanelHost) => Container & { refresh(): void };

/**
 * TUI presentation: a bordered panel docked in the editor area, exactly like
 * pi's model chooser (non-overlay custom UI). The agent keeps streaming above
 * it and content refreshes live from updateRailStatus; typing resumes when
 * it closes.
 */
function openPanel(ctx: ExtensionContext, state: RuntimeState, kind: RailViewKind, factory: RailPanelFactory): void {
  let panel: (Container & { refresh(): void }) | undefined;
  let doneFn: ((value: undefined) => void) | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    doneFn?.(undefined);
  };
  const entry = { kind, refresh: () => panel?.refresh(), close };
  state.liveView = entry;

  ctx.ui
    .custom<undefined>((tui, theme, keybindings, done) => {
      doneFn = done;
      if (closed) {
        done(undefined);
        return new Text("", 0, 0);
      }
      panel = factory({ tui, theme, keybindings, done });
      return panel;
    })
    .finally(() => {
      closed = true;
      if (state.liveView === entry) state.liveView = undefined;
    })
    .catch(() => undefined);
}

/** The read-only report panel, as a panel factory. */
function reportPanel(lines: () => string[]): RailPanelFactory {
  return (host) => new RailReportPanel({ ...host, lines, styleLine: styleRailLine });
}

/**
 * RPC presentation: the same report as a live widget above the editor via the
 * fire-and-forget setWidget extension-UI request. Re-setting the key updates
 * it in place (updateRailStatus drives refreshes; age labels only tick on
 * events since there is no client-side timer); clearing the key closes it.
 */
function openWidget(ctx: ExtensionContext, state: RuntimeState, kind: RailViewKind, lines: () => string[]): void {
  const key = `rail-${kind}`;
  // refresh() fires on every rail event while the view is open; skip the
  // protocol round-trip when content is unchanged (also collapses the
  // open-then-updateRailStatus double send into one setWidget).
  let lastSent: string | undefined;
  const entry = {
    kind,
    refresh: () => {
      try {
        const next = lines();
        const joined = next.join("\n");
        if (joined === lastSent) return;
        lastSent = joined;
        ctx.ui.setWidget(key, next);
      } catch {
        // Widget updates are cosmetic; never let a stale UI context break a rail event.
      }
    },
    close: () => {
      try {
        ctx.ui.setWidget(key, undefined);
      } catch {
        // Same: closing a widget after the session UI is gone is a no-op.
      }
      if (state.liveView === entry) state.liveView = undefined;
    },
  };
  state.liveView = entry;
  entry.refresh();
}

/**
 * Shows a rail report, replacing any open view: an overlay popup in the TUI,
 * a live widget over RPC. This is the ONLY output path for rail reports —
 * they are never posted into the conversation, because pi delivers custom
 * messages to the LLM as user messages and rail reports map the rail's
 * rules, approvals, and guidance for a possibly compromised agent. The agent
 * only ever sees tool-call block reasons. Headless modes have no user to
 * show a view to (or to invoke these commands); that is an error, not a
 * fallback path.
 */
export function showRailView(ctx: ExtensionContext, state: RuntimeState, kind: RailViewKind, lines: () => string[]): void {
  state.liveView?.close();
  if (ctx.mode === "tui" && ctx.hasUI) return openPanel(ctx, state, kind, reportPanel(lines));
  if (ctx.hasUI) return openWidget(ctx, state, kind, lines);
  console.error("Rail views require an interactive session (TUI or RPC).");
}

/** Toggle variant for the recurring status/policy views: the same kind closes, anything else shows. */
export function toggleRailView(ctx: ExtensionContext, state: RuntimeState, kind: RailViewKind, lines: () => string[]): void {
  if (state.liveView?.kind === kind) {
    state.liveView.close();
    return;
  }
  showRailView(ctx, state, kind, lines);
}

/**
 * Toggles an interactive docked panel as the live view. Custom components are
 * TUI-only, so this returns false everywhere else and the caller degrades
 * (the disposition page falls back to select dialogs over RPC).
 */
export function toggleRailPanel(ctx: ExtensionContext, state: RuntimeState, kind: RailViewKind, factory: RailPanelFactory): boolean {
  if (ctx.mode !== "tui" || !ctx.hasUI) return false;
  if (state.liveView?.kind === kind) {
    state.liveView.close();
    return true;
  }
  state.liveView?.close();
  openPanel(ctx, state, kind, factory);
  return true;
}

/**
 * Opens an interactive docked panel, replacing any open view (never toggling
 * it shut): for one-shot dialogs such as the grant confirmation, where a
 * second invocation means "show me this one". False outside the TUI, as for
 * toggleRailPanel.
 */
export function showRailPanel(ctx: ExtensionContext, state: RuntimeState, kind: RailViewKind, factory: RailPanelFactory): boolean {
  if (ctx.mode !== "tui" || !ctx.hasUI) return false;
  state.liveView?.close();
  openPanel(ctx, state, kind, factory);
  return true;
}
