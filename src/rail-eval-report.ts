// The one renderer for eval results: this run (when there is one) and the
// history, as plain lines. The docked panel, RPC widget, headless output,
// `/rail eval history`, and `npm run eval -- --quick` all print exactly this,
// so a number never reads differently depending on where you looked.
//
// Pure: the clock and width come in as arguments, so tests pin both.
import type { EvalRunError, RailEvalRecord, RailEvalSeatStats } from "./rail-eval.ts";
import { layoutTable, type TableColumn } from "./tui/table.ts";

export interface EvalReportInput {
  /** The run just finished; undefined for `/rail eval history`. */
  run?: RailEvalRecord;
  /** The run's errors with case, seat and reason (runErrors). Kept out of the history, so only a fresh run has them. */
  errors?: readonly EvalRunError[];
  /** Every stored record (the run included, when it was written). */
  history: readonly RailEvalRecord[];
  /** The current quick suite's id: records of any other id are not comparable. */
  suite: string;
  /** Epoch ms, for the relative times. */
  now: number;
  /** Render width; 100 keeps every column whole for typical model ids. */
  width?: number;
}

/** Same-suite rows shown before the rest are summarised; enough to see a trend, short enough to read. */
const PAST_ROWS = 20;
const OLDER_ROWS = 10;

/**
 * "now" is reserved for the run this report is about; every other run reads
 * at least "1m ago", so a run from a minute earlier is never mistaken for the
 * one just finished.
 */
export function formatAgo(at: number, now: number, current = false): string {
  if (current) return "now";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  const minutes = Math.max(1, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** "21k", "0.4k": tokens are for comparing magnitudes between runs. */
function kiloTokens(tokens: number): string {
  // Below a hundred, "0k" would hide whether anything was sent at all.
  if (tokens < 100) return String(tokens);
  const value = (tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1);
  return `${value.endsWith(".0") ? value.slice(0, -2) : value}k`;
}

/** "$0.011", "$0.0042", "≥$0.0041" when some call failed (a lower bound), "—" when unpriced. */
export function formatEvalCost(usd: number | undefined, partial = false): string {
  if (usd === undefined) return "—";
  const amount = usd >= 1 ? usd.toFixed(2) : usd >= 0.01 ? usd.toFixed(3) : usd.toFixed(4);
  return `${partial ? "≥" : ""}$${amount}`;
}

function recordCost(record: RailEvalRecord): string {
  return formatEvalCost(record.cost, record.costPartial === true);
}

/** "21k/0.4k tokens", or "19k in (17k cached) / 0.6k out" when the prompt cache served part of the input. */
function tokenSummary(stats: RailEvalSeatStats): string {
  const cached = stats.cacheRead ?? 0;
  if (cached === 0) return `${kiloTokens(stats.tokensIn)}/${kiloTokens(stats.tokensOut)} tokens`;
  return `${kiloTokens(stats.tokensIn)} in (${kiloTokens(cached)} cached) / ${kiloTokens(stats.tokensOut)} out`;
}

function splitSpec(spec: string): { provider: string; id: string } {
  const slash = spec.indexOf("/");
  return slash > 0 ? { provider: spec.slice(0, slash), id: spec.slice(slash + 1) } : { provider: "", id: spec };
}

/**
 * Model ids without the provider when no other model in the same table shares
 * the id under a different provider — the column is for telling runs apart,
 * and "anthropic/" on every row only pushes the numbers off the edge.
 */
function shortener(specs: Iterable<string>): (spec: string) => string {
  const providersById = new Map<string, Set<string>>();
  for (const spec of specs) {
    const { provider, id } = splitSpec(spec);
    const set = providersById.get(id) ?? new Set<string>();
    set.add(provider);
    providersById.set(id, set);
  }
  return (spec) => {
    const { id } = splitSpec(spec);
    return (providersById.get(id)?.size ?? 0) > 1 ? spec : id;
  };
}

function seatLabel(model: string, spec: string | undefined, short: (spec: string) => string): string {
  return spec ? `${spec} (${short(model)})` : short(model);
}

function fullSeatLabel(model: string, spec: string | undefined): string {
  return spec ? `${spec} (${model})` : model;
}

/** One line per seat; the numbers drop to an indented second line when a long model id would push them past the width. */
function seatLines(seat: "namer" | "judge", label: string, labelWidth: number, stats: RailEvalSeatStats, width: number): string[] {
  const work = stats.calls === 0 && stats.decided === 0
    ? "not called"
    : `decided ${stats.decided} · ${stats.correct}/${stats.decided} correct · median ${seconds(stats.medianMs)} · max ${seconds(stats.maxMs)} · ${tokenSummary(stats)}`;
  const line = `${seat.padEnd(5)}  ${label.padEnd(labelWidth)}  ${work}`;
  return line.length <= width ? [line] : [`${seat.padEnd(5)}  ${label}`, `       ${work}`];
}

function criticalCell(record: RailEvalRecord): string {
  if (record.criticalMisses === 0) return "0";
  const seats = [...new Set((record.failing ?? []).filter((entry) => entry.critical).map((entry) => entry.seat))];
  return `${record.criticalMisses} ✗${seats.length > 0 ? ` ${seats.join("+")}` : ""}`;
}

function correctCell(record: RailEvalRecord): string {
  return `${record.passed}/${record.cases}${record.incomplete ? "*" : ""}`;
}

/** Newest first, with every run of a pair pulled up beside that pair's newest run. */
function groupByPair(records: readonly RailEvalRecord[]): RailEvalRecord[] {
  const newestFirst = [...records].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const groups = new Map<string, RailEvalRecord[]>();
  for (const record of newestFirst) {
    const key = `${record.namer}\u0000${record.judge}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.values()].flat();
}

function runSummary(run: RailEvalRecord, width: number, errors: readonly EvalRunError[] | undefined): string[] {
  const failing = run.failing ?? [];
  const critical = failing.filter((entry) => entry.critical);
  const lines = [`# Rail eval · quick suite ${run.suite} · ${run.cases} case${run.cases === 1 ? "" : "s"} · default policy · ${seconds(run.wallMs)} · ${recordCost(run)}`];
  // Critical misses first: an allowed exfiltration outranks every other number here.
  if (critical.length > 0) lines.push(`! CRITICAL MISS: ${critical.map((entry) => `${entry.name} (allowed by the ${entry.seat})`).join(", ")}`);
  const namerLabel = fullSeatLabel(run.namer, run.namerSpec);
  const judgeLabel = fullSeatLabel(run.judge, run.judgeSpec);
  const labelWidth = Math.max(namerLabel.length, judgeLabel.length);
  lines.push(
    ...seatLines("namer", namerLabel, labelWidth, run.namerStats, width),
    ...seatLines("judge", judgeLabel, labelWidth, run.judgeStats, width),
    `${run.passed}/${run.cases} correct · ${run.criticalMisses} critical miss${run.criticalMisses === 1 ? "" : "es"} · ${run.deterministic} deterministic (no model call)`,
  );
  // Errored cases get their own line below, with the reason.
  const errored = new Set((errors ?? []).map((error) => error.name));
  const other = failing.filter((entry) => !entry.critical && !errored.has(entry.name));
  if (other.length > 0) lines.push(`Failing: ${other.map((entry) => `${entry.name} (${entry.seat})`).join(", ")}`);
  if (errors && errors.length > 0) {
    for (const error of errors) lines.push(`! ${error.seat} error on ${error.name}: ${error.detail}`);
  } else if (run.errors > 0) {
    const kinds = Object.entries(run.errorKinds ?? {}).map(([kind, count]) => `${kind} ${count}`).join(", ");
    lines.push(`! ${run.errors} error${run.errors === 1 ? "" : "s"}${kinds ? `: ${kinds}` : ""}`);
  }
  if (run.incomplete) {
    const ran = run.namerStats.decided + run.judgeStats.decided + run.deterministic;
    lines.push(`! incomplete: ${run.cases - ran} of ${run.cases} cases did not run`);
  }
  return lines;
}

export function renderEvalReport(input: EvalReportInput): string[] {
  const width = input.width ?? 100;
  const now = input.now;
  const sameSuite = input.history.filter((record) => record.suite === input.suite);
  const older = input.history.filter((record) => record.suite !== input.suite);
  const lines: string[] = input.run
    ? runSummary(input.run, width, input.errors)
    : [`# Rail eval history · quick suite ${input.suite}`];

  const shownSame = groupByPair(sameSuite).slice(0, PAST_ROWS);
  const shownOlder = [...older].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, OLDER_ROWS);
  const current = input.run;
  const isCurrent = (record: RailEvalRecord) =>
    current !== undefined && (record === current || (record.at === current.at && record.suite === current.suite && record.namer === current.namer && record.judge === current.judge));
  const short = shortener([...shownSame, ...shownOlder].flatMap((record) => [record.namer, record.judge]));

  lines.push("", "## Past runs (same suite)");
  if (shownSame.length === 0) {
    lines.push("No runs of this suite yet. /rail eval runs it.");
  } else {
    const columns: TableColumn[] = [
      { header: "when", min: 6 },
      { header: "namer", min: 10 },
      { header: "judge", min: 10 },
      { header: "correct" },
      { header: "critical" },
      { header: "namer med", align: "right" },
      { header: "judge med", align: "right" },
      { header: "wall", align: "right" },
      { header: "cost", align: "right" },
    ];
    const rows = shownSame.map((record) => [
      formatAgo(Date.parse(record.at), now, isCurrent(record)),
      seatLabel(record.namer, record.namerSpec, short),
      seatLabel(record.judge, record.judgeSpec, short),
      correctCell(record),
      criticalCell(record),
      record.namerStats.calls === 0 ? "—" : seconds(record.namerStats.medianMs),
      record.judgeStats.calls === 0 ? "—" : seconds(record.judgeStats.medianMs),
      seconds(record.wallMs),
      recordCost(record),
    ]);
    // Flush left, as in the plan: nine columns need the whole width.
    const table = layoutTable(columns, rows, width);
    lines.push(table.header, ...table.lines);
    if (sameSuite.length > shownSame.length) lines.push(`… ${sameSuite.length - shownSame.length} older run${sameSuite.length - shownSame.length === 1 ? "" : "s"} of this suite not shown`);
    if (shownSame.some((record) => record.incomplete)) lines.push("* incomplete run: some cases did not finish");

    // The pair this report is about: the run's, or the newest one's.
    const anchor = input.run ?? shownSame[0]!;
    const pair = sameSuite.filter((record) => record.namer === anchor.namer && record.judge === anchor.judge);
    const passed = pair.map((record) => record.passed);
    const walls = pair.map((record) => record.wallMs);
    const low = Math.min(...passed);
    const high = Math.max(...passed);
    const fastest = Math.min(...walls);
    const slowest = Math.max(...walls);
    const correctRange = low === high ? `${low}/${anchor.cases}` : `${low}/${anchor.cases}–${high}/${anchor.cases}`;
    const wallRange = seconds(fastest) === seconds(slowest) ? seconds(fastest) : `${seconds(fastest).slice(0, -1)}–${seconds(slowest)}`;
    lines.push(`this pair: ${pair.length} run${pair.length === 1 ? "" : "s"} · ${correctRange} · wall ${wallRange}`);
  }

  if (shownOlder.length > 0) {
    lines.push("", "## Older suites — not comparable");
    const columns: TableColumn[] = [
      { header: "when", min: 6 },
      { header: "suite" },
      { header: "namer", min: 10 },
      { header: "judge", min: 10 },
      { header: "correct" },
      { header: "critical" },
      { header: "wall", align: "right" },
      { header: "cost", align: "right" },
    ];
    const rows = shownOlder.map((record) => [
      formatAgo(Date.parse(record.at), now, isCurrent(record)),
      record.suite,
      seatLabel(record.namer, record.namerSpec, short),
      seatLabel(record.judge, record.judgeSpec, short),
      correctCell(record),
      criticalCell(record),
      seconds(record.wallMs),
      recordCost(record),
    ]);
    // "• " dims each row in the report panel (styleRailLine): these are
    // context, not comparisons.
    const table = layoutTable(columns, rows, width - 2);
    lines.push(`  ${table.header}`, ...table.lines.map((line) => `• ${line}`));
    if (older.length > shownOlder.length) lines.push(`  … ${older.length - shownOlder.length} more`);
  }
  return lines;
}

/** The in-flight view: what is running and how far along. */
export function renderEvalProgress(params: { suite: string; namer: string; judge: string; spend: string; started: number; done: number; total: number; elapsedMs: number }): string[] {
  return [
    `# Rail eval · quick suite ${params.suite} · running`,
    `namer  ${params.namer}`,
    `judge  ${params.judge}`,
    params.spend,
    "",
    `case ${Math.max(1, params.started)}/${params.total} · ${params.done} done · ${seconds(params.elapsedMs)}`,
    "",
    "Default policy, two cases at a time. The main agent is not held up.",
    "Esc hides this panel; /rail eval cancel stops the run (finished cases are kept).",
  ];
}
