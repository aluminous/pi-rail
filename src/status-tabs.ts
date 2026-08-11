/**
 * The six tabs of the status page, as content renderers. They are plain
 * functions of (state, config, width, theme) so the same code serves the TUI
 * panel, the RPC widget (which concatenates every tab through a no-op theme),
 * and the tests.
 *
 * Everything here is display: no state is mutated, and nothing is ever posted
 * into the conversation — rail reports map the rail's own rules for a possibly
 * compromised agent, so the only consumers are the panel and the widget.
 */
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { EffectivePolicy } from "./backends/types.ts";
import { capabilityRegistry, getEffectiveDisposition, usedCapabilityStats, type CapabilityStats } from "./capabilities.ts";
import { classifierEnabled, judgeModelSpec } from "./classifier.ts";
import { configSourceLabel, type ProvenanceListKey, type ResolvedRailConfig } from "./config.ts";
import { getPersistentConfigPath } from "./persistent-settings.ts";
import { resolveConfigPath } from "./policy.ts";
import { modelUsageRows, type ModelUsageStats, type RailEvent, type RailStats, type RuntimeState } from "./state.ts";
import type { PanelTheme } from "./tui/report-panel.ts";
import { renderTable, type TableColumn } from "./tui/table.ts";

export const STATUS_TABS = ["session", "models", "namer", "judge", "engine", "policy"] as const;

export type StatusTab = (typeof STATUS_TABS)[number];

export function isStatusTab(value: string): value is StatusTab {
  return (STATUS_TABS as readonly string[]).includes(value);
}

/** Everything a tab renders from. `classifierLabel` is resolved by the caller, since resolution needs the ExtensionContext. */
export interface StatusView {
  state: RuntimeState;
  config: ResolvedRailConfig;
  /** "auto (openrouter/anthropic/claude-haiku-4.5)", "classifier off", … */
  classifierLabel: string;
  theme: PanelTheme;
  /** Render width; the tables fit themselves to it. */
  width: number;
}

/** Theme for the plain-text surfaces (the RPC widget, tests): every colour is a no-op. */
export const PLAIN_THEME: PanelTheme = { fg: (_name, text) => text, bold: (text) => text };

// ── Small formatters ─────────────────────────────────────────────────────────

export function formatAge(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** "1.2k" past four digits: token columns are for comparing magnitudes, not for auditing. */
export function formatTokens(tokens: number): string {
  if (tokens < 10_000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * Four decimals: a namer call is worth a few hundredths of a cent, and rounding
 * a session's classification cost to "$0.02" throws away the digit that says
 * whether the cheap model is actually cheap. Dollar amounts past $1 no longer
 * need that resolution.
 */
export function formatCost(usd: number): string {
  if (usd === 0) return "—";
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

function formatArray(value: string[]): string {
  return value.length > 0 ? value.join(", ") : "(none)";
}

function heading(theme: PanelTheme, text: string): string {
  return theme.fg("toolTitle", theme.bold(`─ ${text} `));
}

function line(text: string): string {
  return `  ${text}`;
}

function muted(theme: PanelTheme, text: string): string {
  return `  ${theme.fg("muted", text)}`;
}

/** Prose wraps at the render width rather than leaving the terminal to fold a legend mid-word. */
function paragraph(width: number, text: string, style: (piece: string) => string): string[] {
  return wrapTextWithAnsi(text, Math.max(20, width - 2)).map((piece) => `  ${style(piece)}`);
}

/** A wrapped muted note: the legends under a table. */
function note(theme: PanelTheme, width: number, text: string): string[] {
  return paragraph(width, text, (piece) => theme.fg("muted", piece));
}

/**
 * "12.3k in (61% cached) / 800 out" — hit rate over total prompt tokens (input
 * is normalized to exclude cache activity). Providers that never report cache
 * fields normalize to 0, which is indistinguishable from a real 0% hit rate —
 * so a plain zero only reads "0% cached" while the cache is demonstrably
 * warming (writes but no reads yet); with reviews done and no cache activity at
 * all it reads "cache activity not reported", and before any review the
 * parenthetical is omitted.
 */
export function formatTokensWithCache(stats: RailStats): string {
  const totalPrompt = stats.classifierInputTokens + stats.classifierCacheReadTokens + stats.classifierCacheWriteTokens;
  const cachePart =
    stats.classifierCacheReadTokens > 0
      ? ` (${Math.round((stats.classifierCacheReadTokens / totalPrompt) * 100)}% cached)`
      : stats.classifierCacheWriteTokens > 0
        ? " (0% cached, cache warming)"
        : stats.classifierHits > 0
          ? " (cache activity not reported)"
          : "";
  return `${totalPrompt} in${cachePart} / ${stats.classifierOutputTokens} out`;
}

/** Colours a decision cell the way the rest of the rail colours its verdicts. */
function decisionColor(decision: string): string {
  if (decision === "allow") return "success";
  if (decision === "deny" || decision === "block") return "error";
  return "warning";
}

// ── session ──────────────────────────────────────────────────────────────────

function healthLabel(state: RuntimeState): string {
  if (state.enabled && state.initialized) return "enforcing";
  if (state.enabled) return "enabled, not initialized";
  return state.disabledForNextAgent ? "off next turn" : "disabled";
}

export function networkSummary(config: ResolvedRailConfig, effective: EffectivePolicy | undefined): string {
  if (!config.network.enabled) return "network unrestricted";
  const domains = effective?.network.allowedDomains ?? config.network.allowedDomains;
  return domains.length > 0 ? `${domains.length} allowed domain(s)` : "network blocked (deny all)";
}

/** The one line that answers "is the rail on, and what is it doing": backend · health · network · reviewer model. */
export function headlineLine(view: StatusView): string {
  const { state, config } = view;
  const effective = state.backend?.describeEffectivePolicy(config);
  const backend = `${state.backend?.name ?? config.backend}${state.readOnly ? " (read-only)" : ""}`;
  return [backend, healthLabel(state), networkSummary(config, effective), view.classifierLabel].join(" · ");
}

const COUNTER_COLUMNS: TableColumn[] = [
  { header: "counter", min: 8 },
  { header: "total", align: "right" },
  { header: "turn", align: "right" },
];

function counterRows(stats: RailStats): string[][] {
  const turn = (value: number) => (value > 0 ? String(value) : "");
  return [
    ["deterministic", String(stats.ruleHits), turn(stats.turnRuleHits)],
    ["model reviews", String(stats.classifierHits), turn(stats.turnClassifierHits)],
    ["exempt (no model)", String(stats.classifierSkips), ""],
    ["allowed", String(stats.allowed), ""],
    ["asked", String(stats.asked), ""],
    ["denied", String(stats.denied), turn(stats.turnClassifierDenials)],
    ["policy blocks", String(stats.blocked), turn(stats.turnBlocked)],
    ["errors", String(stats.errors), ""],
  ];
}

const CAPABILITY_COLUMNS: TableColumn[] = [
  { header: "class", min: 10 },
  { header: "disposition", min: 6 },
  { header: "hits", align: "right" },
  { header: "decided", align: "right" },
  { header: "allowed", align: "right" },
  { header: "asked", align: "right" },
  { header: "denied", align: "right" },
];

const SCREEN_COLUMN: TableColumn = { header: "screen ✗/✓", align: "right" };

/**
 * Outcomes are recorded on every label of a multi-label action, so `hits` and
 * the outcome columns count rides along; `decided` counts the times this class
 * was the one that set the disposition.
 */
function capabilityRows(view: StatusView, withScreen: boolean): string[][] {
  const { state, config } = view;
  const used = usedCapabilityStats(state.capabilities, capabilityRegistry(config, state.capabilities));
  return used.map(({ id, stats }) => {
    const effective = getEffectiveDisposition(config, state.capabilities, id);
    const disposition = effective.scope === "default" ? effective.disposition : `${effective.disposition} (${effective.scope === "config" ? configSourceLabel(effective.source ?? "config") : effective.scope})`;
    const row = [
      id,
      disposition,
      String(stats.hits),
      String(stats.decided),
      String(allowedCount(stats)),
      String(askedCount(stats)),
      String(deniedCount(stats)),
    ];
    if (withScreen) row.push(stats.screenTripped + stats.screenClean > 0 ? `${stats.screenTripped}/${stats.screenClean}` : "");
    return row;
  });
}

function allowedCount(stats: CapabilityStats): number {
  return stats.outcomes.allow + stats.outcomes["judge-allow"] + stats.outcomes["ask-approved"];
}

function askedCount(stats: CapabilityStats): number {
  return stats.outcomes["ask-approved"] + stats.outcomes["ask-denied"] + stats.outcomes["judge-ask"];
}

function deniedCount(stats: CapabilityStats): number {
  return stats.outcomes.deny + stats.outcomes["judge-deny"] + stats.outcomes["ask-denied"];
}

const EVENT_COLUMNS: TableColumn[] = [
  { header: "when", min: 5 },
  { header: "tool", min: 4 },
  { header: "what", min: 6 },
  { header: "reason", min: 12 },
];

function sessionTab(view: StatusView): string[] {
  const { state, theme, width } = view;
  const guidance = state.classifier.sessionGuidance ?? [];
  const errorKinds = Object.entries(state.stats.errorsByKind)
    .filter(([, count]) => count > 0)
    .sort(([aKind, aCount], [bKind, bCount]) => bCount - aCount || aKind.localeCompare(bKind))
    .map(([kind, count]) => [kind, String(count)]);
  const withScreen = usedCapabilityStats(state.capabilities, capabilityRegistry(view.config, state.capabilities))
    .some(({ stats }) => stats.screenTripped + stats.screenClean > 0);

  const lines = [
    heading(theme, "Session"),
    ...paragraph(width, headlineLine(view), (piece) => piece),
    ...(state.lastError ? [`  ${theme.fg("error", `Backend error: ${state.lastError}`)}`] : []),
    ...(state.classifier.lastError ? [`  ${theme.fg("warning", `Reviewer error: ${state.classifier.lastError}`)}`] : []),
    "",
    heading(theme, "Decisions"),
    ...renderTable(theme, COUNTER_COLUMNS, counterRows(state.stats), width),
    muted(theme, `tokens ${formatTokensWithCache(state.stats)}`),
    "",
    heading(theme, "Capabilities seen this session"),
    ...renderTable(theme, withScreen ? [...CAPABILITY_COLUMNS, SCREEN_COLUMN] : CAPABILITY_COLUMNS, capabilityRows(view, withScreen), width, {
      empty: "(none yet)",
    }),
    ...note(theme, width, "decided = times this class set the disposition; the other columns count every label of an action"),
    "",
    heading(theme, "Recent events"),
    ...renderTable(theme, EVENT_COLUMNS, recentEventRows(state.recent), width, {
      empty: "(none yet)",
      styleRow: (text, row) => theme.fg(decisionColor(row[2] ?? ""), text),
    }),
    "",
    heading(theme, "Session approvals"),
    ...renderTable(theme, SETTING_COLUMNS, [
      ["read paths", formatArray(state.approvals.read)],
      ["write paths", formatArray(state.approvals.write)],
    ], width),
    "",
    heading(theme, "Session guidance"),
    ...(guidance.length > 0 ? guidance.map((entry) => muted(theme, `• ${entry}`)) : [muted(theme, "(none — /rail guide and approval comments land here)")]),
    "",
    heading(theme, "Errors by kind"),
    ...renderTable(theme, [{ header: "kind", min: 6 }, { header: "count", align: "right" }], errorKinds, width, { empty: "(none)" }),
  ];
  return lines;
}

function recentEventRows(events: RailEvent[]): string[][] {
  return events.map((event) => [formatAge(event.at), event.toolName, event.decision, event.reason]);
}

// ── models ───────────────────────────────────────────────────────────────────

const MODEL_COLUMNS: TableColumn[] = [
  { header: "model", min: 12 },
  { header: "role", min: 5 },
  { header: "calls", align: "right" },
  { header: "in", align: "right" },
  { header: "out", align: "right" },
  { header: "cached", align: "right" },
  { header: "cost", align: "right" },
  { header: "avg ms", align: "right" },
  { header: "max ms", align: "right" },
];

function modelRow(entry: ModelUsageStats): string[] {
  return [
    entry.model,
    entry.role,
    String(entry.calls),
    formatTokens(entry.input),
    formatTokens(entry.output),
    formatTokens(entry.cacheRead),
    formatCost(entry.costUsd),
    String(Math.round(entry.totalLatencyMs / Math.max(1, entry.calls))),
    String(entry.maxLatencyMs),
  ];
}

/** "$0.0214 (2 calls unpriced)" — a cost total that never claims to cover calls the provider did not price. */
export function costSummary(rows: ModelUsageStats[]): string {
  const total = rows.reduce((sum, row) => sum + row.costUsd, 0);
  const unpriced = rows.reduce((sum, row) => sum + row.unpricedCalls, 0);
  if (rows.length === 0) return "no cost reported";
  if (unpriced === 0) return `${formatCost(total)} total`;
  const qualifier = `${unpriced} call${unpriced === 1 ? "" : "s"} unpriced`;
  return total === 0 ? `no cost reported (${qualifier})` : `${formatCost(total)} total (${qualifier})`;
}

function modelsTab(view: StatusView): string[] {
  const { state, theme, width } = view;
  const rows = modelUsageRows(state.stats);
  const cacheWrite = rows.reduce((sum, row) => sum + row.cacheWrite, 0);
  return [
    heading(theme, "Reviewer models"),
    ...renderTable(theme, MODEL_COLUMNS, rows.map(modelRow), width, { empty: "(no reviewer calls yet)" }),
    ...(rows.length === 0
      ? []
      : [
          muted(theme, costSummary(rows)),
          ...note(theme, width, `cache ${formatTokens(rows.reduce((sum, row) => sum + row.cacheRead, 0))} read / ${formatTokens(cacheWrite)} written · in excludes cached tokens`),
        ]),
    "",
    ...note(theme, width, "namer rows are the per-action labelling calls; judge rows are the escalations the table delegated"),
  ];
}

// ── namer ────────────────────────────────────────────────────────────────────

const CLASSIFICATION_COLUMNS: TableColumn[] = [
  { header: "when", min: 5 },
  { header: "tool", min: 4 },
  { header: "labels", min: 10 },
  { header: "table", min: 5 },
  { header: "decision", min: 5 },
  { header: "ms", align: "right" },
  { header: "tokens", align: "right", min: 5 },
];

function namerTab(view: StatusView): string[] {
  const { state, theme, width } = view;
  const rows = state.recentClassifications.map((entry) => [
    formatAge(entry.at),
    entry.toolName,
    entry.labels.join(", "),
    entry.disposition,
    entry.decision,
    entry.latencyMs > 0 ? String(entry.latencyMs) : "—",
    entry.inputTokens + entry.outputTokens > 0 ? `${formatTokens(entry.inputTokens)}/${formatTokens(entry.outputTokens)}` : "—",
  ]);
  return [
    heading(theme, "Recent classifications"),
    ...renderTable(theme, CLASSIFICATION_COLUMNS, rows, width, {
      empty: "(nothing named yet)",
      styleRow: (text, row) => theme.fg(decisionColor(row[4] ?? ""), text),
      // The command or path, wrapped under the row like a judge reason — an
      // eighth column would squeeze the seven that are already there.
      rowNote: (_row, index) => state.recentClassifications[index]?.target || undefined,
    }),
    "",
    ...note(theme, width, "table = what the disposition table resolved over the labels; a `judge` row means the escalation reviewer then decided"),
    ...note(theme, width, "ms and tokens cover the whole review, judge included; a dash means the labels were deterministic"),
  ];
}

// ── judge ────────────────────────────────────────────────────────────────────

const JUDGEMENT_COLUMNS: TableColumn[] = [
  { header: "when", min: 5 },
  { header: "tool", min: 4 },
  { header: "labels", min: 10 },
  { header: "verdict", min: 5 },
  { header: "ms", align: "right" },
  { header: "tokens", align: "right", min: 5 },
];

function judgeTab(view: StatusView): string[] {
  const { state, config, theme, width } = view;
  const judgements = state.recentJudgements;
  const rows = judgements.map((entry) => [
    formatAge(entry.at),
    entry.toolName,
    entry.labels.join(", "),
    entry.verdict,
    String(entry.latencyMs),
    `${formatTokens(entry.inputTokens)}/${formatTokens(entry.outputTokens)}`,
  ]);
  return [
    heading(theme, "Recent judgements"),
    ...renderTable(theme, JUDGEMENT_COLUMNS, rows, width, {
      empty: "(nothing escalated yet)",
      styleRow: (text, row) => theme.fg(decisionColor(row[3] ?? ""), text),
      // The verdict's reason is a sentence, so it gets its own wrapped line
      // under the row rather than a column that would squeeze every other one;
      // the judged command or path leads so the reason has a referent.
      rowNote: (_row, index) => {
        const entry = judgements[index];
        if (!entry) return undefined;
        return entry.target ? `${entry.target} — ${entry.reason}` : entry.reason;
      },
    }),
    "",
    ...note(theme, width, `judge model: ${judgeModelSpec(config, state.classifier)}${judgements[0]?.model ? ` (last call ${judgements[0].model})` : ""}`),
    ...note(theme, width, "classes set to judge delegate one action at a time; a judge failure degrades to ask"),
  ];
}

// ── engine ───────────────────────────────────────────────────────────────────

const SETTING_COLUMNS: TableColumn[] = [{ header: "setting", min: 8 }, { header: "value", min: 10 }];
const LAYER_COLUMNS: TableColumn[] = [{ header: "layer", min: 8 }, { header: "state", min: 7 }, { header: "entries", min: 10 }];

function layerRows(config: ResolvedRailConfig, effective: EffectivePolicy | undefined): string[][] {
  const filesystem = effective?.filesystem ?? config.filesystem;
  const readRoots = config.filesystem.allowRead.length === 0 ? "all paths (blacklist mode)" : `${filesystem.allowRead.length} read root(s)`;
  return [
    [
      "filesystem",
      config.filesystem.enabled ? "enabled" : "disabled",
      `${readRoots} · ${filesystem.allowWrite.length} write root(s) · ${filesystem.denyRead.length} deny read · ${filesystem.denyWrite.length} deny write`,
    ],
    [
      "network",
      config.network.enabled ? "enabled" : "disabled",
      `${(effective?.network.allowedDomains ?? config.network.allowedDomains).length} allowed · ${config.network.deniedDomains.length} denied`,
    ],
    ["environment", config.environment.unset.length > 0 || config.environment.allow.length > 0 ? "scrubbing" : "untouched", `${config.environment.allow.length} allowed · ${config.environment.unset.length} unset`],
    [
      "commands",
      config.commands.allow.length > 0 ? "allowlist" : config.commands.classify.length > 0 ? "classify" : "none",
      `${config.commands.allow.length} rule(s) exempt from review${config.commands.classify.length > 0 ? ` · ${config.commands.classify.length} classify rule(s)` : ""}`,
    ],
  ];
}

function engineTab(view: StatusView): string[] {
  const { state, config, theme, width } = view;
  const effective = state.backend?.describeEffectivePolicy(config);
  const engineRows: string[][] = [
    ["backend", `${state.backend?.name ?? config.backend} · ${state.initialized ? "initialized" : "not initialized"}`],
    ["rail", healthLabel(state)],
    ["read-only mode", state.readOnly ? "on (write/edit blocked, bash restricted)" : "off"],
    ["statusline", config.statusLine],
  ];
  const reviewerRows: string[][] = [
    ["namer", `${classifierEnabled(config, state.classifier) ? "enabled" : "disabled"} · ${view.classifierLabel}`],
    ["namer model setting", state.classifier.modelOverride ? `${state.classifier.modelOverride} (this session)` : config.classifier.model],
    ["judge model setting", state.classifier.judgeModelOverride ? `${state.classifier.judgeModelOverride} (this session)` : config.classifier.judgeModel],
    ["on failure", config.classifier.failClosed ? "fail closed (stop the turn)" : "fail open (warn and continue)"],
    ["timeout", `${config.classifier.timeoutMs}ms per attempt`],
    ["telemetry", config.classifier.telemetry],
  ];
  return [
    heading(theme, "Engine"),
    ...renderTable(theme, SETTING_COLUMNS, engineRows, width),
    "",
    heading(theme, "Restriction layers"),
    ...renderTable(theme, LAYER_COLUMNS, layerRows(config, effective), width),
    ...note(theme, width, "the resolved rules behind these counts are the policy tab"),
    "",
    heading(theme, "Reviewers"),
    ...renderTable(theme, SETTING_COLUMNS, reviewerRows, width),
    "",
    heading(theme, "Config"),
    ...renderTable(theme, SETTING_COLUMNS, [
      ["persistent config", getPersistentConfigPath()],
      ["sources", config.sources.join(" → ")],
    ], width),
    ...(config.diagnostics.length > 0 ? ["", heading(theme, "Config diagnostics"), ...config.diagnostics.map((entry) => `  ${theme.fg("warning", entry)}`)] : []),
    ...(state.warnings.length > 0 ? ["", heading(theme, "Warnings"), ...state.warnings.map((entry) => `  ${theme.fg("warning", `! ${entry}`)}`)] : []),
    ...(state.lastError || state.classifier.lastError
      ? [
          "",
          heading(theme, "Last errors"),
          ...(state.lastError ? [`  ${theme.fg("error", `backend: ${state.lastError}`)}`] : []),
          ...(state.classifier.lastError ? [`  ${theme.fg("warning", `reviewer: ${state.classifier.lastError}`)}`] : []),
        ]
      : []),
  ];
}

// ── policy ───────────────────────────────────────────────────────────────────

const ENTRY_COLUMNS: TableColumn[] = [{ header: "entry", min: 12 }, { header: "source", min: 6 }];

/**
 * Effective (backend) lists hold resolved literals while provenance is keyed by
 * config pattern, so each list's lookup also indexes the resolved form.
 */
function sourceLookup(config: ResolvedRailConfig, listKey: ProvenanceListKey, resolvePaths: boolean, theme: PanelTheme): (entry: string) => string {
  const lookup = new Map<string, string>();
  for (const [entry, source] of Object.entries(config.provenance.lists[listKey])) {
    lookup.set(entry, source);
    if (resolvePaths) lookup.set(resolveConfigPath(process.cwd(), entry), source);
  }
  return (entry: string) => {
    // Built-in defaults render a muted "default" — explicit enough to read
    // without a legend, quiet enough that the handful of entries a config
    // file set still stand out at full strength.
    const source = lookup.get(entry);
    if (!source || source === "default") return theme.fg("muted", "default");
    return configSourceLabel(source);
  };
}

function entryRows(view: StatusView, listKey: ProvenanceListKey, entries: string[], resolvePaths = true): string[][] {
  const source = sourceLookup(view.config, listKey, resolvePaths, view.theme);
  return entries.map((entry) => [entry, source(entry)]);
}

function listSection(view: StatusView, title: string, listKey: ProvenanceListKey, entries: string[], resolvePaths = true): string[] {
  return [
    muted(view.theme, `${title}:`),
    ...renderTable(view.theme, ENTRY_COLUMNS, entryRows(view, listKey, entries, resolvePaths), view.width, { indent: "    ", empty: "(none)" }),
  ];
}

/**
 * User template → capability rules, shown only when there are any: an empty
 * "(none)" table on every policy page would be noise for the many configs that
 * never classify anything.
 */
function classifySection(view: StatusView): string[] {
  const { config, theme, width } = view;
  if (config.commands.classify.length === 0) return [];
  const source = sourceLookup(config, "commands.classify", false, theme);
  return [
    muted(theme, "Classified by template:"),
    ...renderTable(theme, ENTRY_COLUMNS, config.commands.classify.map((rule) => [`${rule.template} → ${rule.capability}`, source(rule.template)]), width, { indent: "    " }),
  ];
}

function policyTab(view: StatusView): string[] {
  const { state, config, theme, width } = view;
  const effective = state.backend?.describeEffectivePolicy(config);
  const degraded = effective?.filesystem.degraded ?? [];
  return [
    ...note(theme, width, "source: default is built in; global/project name the config file that set the entry"),
    "",
    heading(theme, "Filesystem"),
    line(`Restrictions: ${config.filesystem.enabled ? "enabled" : "disabled (lists still route classifier exemptions)"}`),
    line(`Read mode: ${config.filesystem.allowRead.length === 0 ? "blacklist (all paths except deny read)" : "whitelist"}`),
    ...(config.filesystem.allowRead.length > 0
      ? listSection(view, "Allow read", "filesystem.allowRead", effective?.filesystem.allowRead ?? config.filesystem.allowRead)
      : [muted(theme, "Allow read: (all)")]),
    ...listSection(view, "Allow write", "filesystem.allowWrite", effective?.filesystem.allowWrite ?? config.filesystem.allowWrite),
    ...listSection(view, "Deny read", "filesystem.denyRead", effective?.filesystem.denyRead ?? config.filesystem.denyRead),
    ...listSection(view, "Deny write", "filesystem.denyWrite", effective?.filesystem.denyWrite ?? config.filesystem.denyWrite),
    ...(degraded.length > 0
      ? [
          muted(theme, "Enforced for file tools only (the bash sandbox sees literal paths):"),
          ...renderTable(theme, [{ header: "pattern", min: 12 }, { header: "list", min: 6 }], degraded.map((entry) => [entry.pattern, entry.list]), width, { indent: "    " }),
        ]
      : []),
    "",
    heading(theme, "Network"),
    line(`Restrictions: ${config.network.enabled ? "enabled" : "disabled (unrestricted)"}`),
    ...listSection(view, "Allowed domains", "network.allowedDomains", config.network.enabled ? (effective?.network.allowedDomains ?? config.network.allowedDomains) : [], false),
    ...listSection(view, "Denied domains", "network.deniedDomains", config.network.deniedDomains, false),
    "",
    heading(theme, "Environment scrubbing"),
    ...listSection(view, "Allow", "environment.allow", config.environment.allow, false),
    ...listSection(view, "Unset", "environment.unset", config.environment.unset, false),
    "",
    heading(theme, "Command rules"),
    ...listSection(view, "Exempt from review", "commands.allow", config.commands.allow, false),
    ...classifySection(view),
    "",
    heading(theme, "Config sources"),
    ...renderTable(theme, [{ header: "source", min: 12 }, { header: "label", min: 6 }], config.sources.map((source) => [source, configSourceLabel(source)]), width),
    "",
    ...note(theme, width, "the decision policy itself is the disposition table — /rail policy opens it"),
  ];
}

// ── entry points ─────────────────────────────────────────────────────────────

const RENDERERS: Record<StatusTab, (view: StatusView) => string[]> = {
  session: sessionTab,
  models: modelsTab,
  namer: namerTab,
  judge: judgeTab,
  engine: engineTab,
  policy: policyTab,
};

export const TAB_TITLES: Record<StatusTab, string> = {
  session: "Session",
  models: "Reviewer models",
  namer: "Namer",
  judge: "Judge",
  engine: "Engine",
  policy: "Policy rules",
};

export function statusTabLines(view: StatusView, tab: StatusTab): string[] {
  return RENDERERS[tab](view);
}

/**
 * Every tab, one after another under its own title: the RPC widget's
 * degradation, since a widget is a block of lines with no tab affordance.
 */
export function statusReportLines(view: StatusView): string[] {
  const lines = [view.theme.fg("accent", view.theme.bold("Pi Rail"))];
  for (const tab of STATUS_TABS) {
    lines.push("", view.theme.fg("accent", view.theme.bold(`══ ${TAB_TITLES[tab]} `)), "");
    lines.push(...statusTabLines(view, tab));
  }
  return lines;
}
