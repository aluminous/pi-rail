import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { classifierEnabled, resolveClassifierModel } from "./classifier.ts";
import { type ResolvedRailConfig, type StatusLineMode } from "./config.ts";
import { anySeatUnsaved } from "./reviewer-seats.ts";
import type { RuntimeState } from "./state.ts";

function formatCompactCount(label: string, total: number, turn: number): string {
  return turn > 0 ? `${label}${total}(+${turn})` : `${label}${total}`;
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

export function networkPolicyLabel(config: ResolvedRailConfig): string {
  if (!config.network.enabled) return "network unrestricted";
  return config.network.allowedDomains.length > 0 ? `${config.network.allowedDomains.length} domains` : "network blocked";
}

/**
 * Compact classifier label: "classifier off", "auto (provider/id)",
 * "provider/id", or "model unavailable (spec)" — the session's effective namer.
 * A trailing "*" marks a session value /rail model has not saved yet (any
 * seat, the same marker as the picker's tabs).
 */
export function classifierModelLabel(ctx: ExtensionContext, config: ResolvedRailConfig | undefined, state: RuntimeState): string {
  const unsaved = config && anySeatUnsaved(config, state.classifier) ? "*" : "";
  if (!config || !classifierEnabled(config, state.classifier)) return `classifier off${unsaved}`;
  const spec = state.classifier.modelOverride ?? config.classifier.model;
  const model = resolveClassifierModel(ctx, config, state.classifier);
  if (!model) return `model unavailable (${spec})${unsaved}`;
  return `${spec === "auto" ? `auto (${model.provider}/${model.id})` : `${model.provider}/${model.id}`}${unsaved}`;
}

/** In "auto" mode the statusline appears only when something needs attention: the rail is off or erroring, or a call was denied/blocked since the last user message. */
export function statusLineVisible(mode: StatusLineMode, state: RuntimeState): boolean {
  if (mode === "never") return false;
  if (mode === "always") return true;
  return !state.enabled || state.lastError !== undefined || state.stats.turnClassifierDenials > 0 || state.stats.turnBlocked > 0;
}

export function updateRailStatus(ctx: ExtensionContext, state: RuntimeState): void {
  state.liveView?.refresh();
  if (!statusLineVisible(state.config?.statusLine ?? "always", state)) {
    ctx.ui.setStatus("rail", undefined);
    return;
  }
  const theme = ctx.ui.theme;
  const muted = (text: string) => theme.fg("muted", text);
  const warning = (text: string) => theme.fg("warning", text);
  const error = (text: string) => theme.fg("error", text);
  const config = state.config;
  const stats = state.stats;
  const compact = [
    formatCompactCount("R", stats.ruleHits, stats.turnRuleHits),
    formatCompactCount("C", stats.classifierHits, stats.turnClassifierHits),
    formatCompactCount("D", stats.classifierDenials, stats.turnClassifierDenials),
    `↑${formatCompactTokens(stats.classifierInputTokens)}`,
    `↓${formatCompactTokens(stats.classifierOutputTokens)}`,
  ].join(" ");
  if (state.lastError) {
    ctx.ui.setStatus("rail", error(`Rail: error ${compact}`));
    return;
  }
  if (!state.enabled) {
    const label = state.disabledForNextAgent && !ctx.isIdle() ? "off this turn" : state.disabledForNextAgent ? "off next turn" : "disabled";
    ctx.ui.setStatus("rail", warning(`Rail: ${label} ${compact}`));
    return;
  }
  const backend = `${state.backend?.name ?? config?.backend ?? "unknown"}${state.readOnly ? " RO" : ""}`;
  const network = config ? networkPolicyLabel(config) : "network unknown";
  const hasImportantStats = stats.classifierDenials > 0 || stats.blocked > 0 || stats.errors > 0;
  ctx.ui.setStatus("rail", `${muted(`Rail: ${backend}, ${network}, ${classifierModelLabel(ctx, config, state)} `)}${hasImportantStats ? warning(compact) : muted(compact)}`);
}

interface RailLineTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

/** Styles one line of a rail report (status or policy) for terminal display. */
export function styleRailLine(line: string, theme: RailLineTheme): string {
  if (line.startsWith("# ")) return theme.fg("accent", theme.bold(line.slice(2)));
  if (line.startsWith("## ")) return theme.fg("toolTitle", theme.bold(`─ ${line.slice(3)} `));
  if (line.includes("[ALLOW]")) return theme.fg("success", line);
  if (line.includes("[DENY]") || line.includes("[BLOCK]")) return theme.fg("error", line);
  if (line.includes("[ASK]") || line.includes("[ERROR]") || line.trimStart().startsWith("! ")) return theme.fg("warning", line);
  if (/^[-\w ]+  [-\w ]+  [-\w ]+/.test(line) || /^-+  -+/.test(line)) return theme.fg("muted", line);
  if (line.trimStart().startsWith("•") || line.trimStart().startsWith("…")) return theme.fg("dim", line);
  return line;
}

/**
 * Renders pi-rail custom messages in the transcript. Nothing posts new
 * rail messages anymore (reports were dropped from the conversation because
 * custom messages enter agent context); this stays registered so sessions
 * recorded before that change still render their reports. "pi-guard" is the
 * renderer name those older sessions recorded, so it is registered too — the
 * name is a lookup key baked into session files, not something the rename can
 * reach back and change.
 */
export function registerRailMessageRenderer(pi: ExtensionAPI): void {
  const render = (message: { content?: unknown }, _options: unknown, theme: RailLineTheme) => {
    const raw = String(message.content ?? "");
    const rendered = raw
      .split("\n")
      .map((line) => styleRailLine(line, theme))
      .join("\n");
    return new Text(theme.fg("accent", theme.bold("[rail]")) + "\n" + rendered, 0, 0);
  };
  pi.registerMessageRenderer("pi-rail", render);
  pi.registerMessageRenderer("pi-guard", render);
}
