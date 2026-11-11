import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import { confirmationLines, type GrantReport, type SensitiveItem } from "../grant-eval.ts";
import type { GrantLayerName } from "../policy-store.ts";
import type { PanelTheme, PanelTui } from "./report-panel.ts";
import type { Keybindings } from "./select-list.ts";

/** Where an approved grant goes. */
export type GrantAnswer = "session" | "global" | "project" | "discard";

export interface GrantAnswerOption {
  value: GrantAnswer;
  label: string;
}

/** The answers a passing grant offers; project only when a trusted project config dir exists. */
export function grantAnswerOptions(projectAvailable: boolean): GrantAnswerOption[] {
  return [
    { value: "session", label: "Apply for this session" },
    { value: "global", label: "Apply and save to global" },
    ...(projectAvailable ? [{ value: "project" as const, label: "Apply and save to project" }] : []),
    { value: "discard", label: "Discard" },
  ];
}

/** The sensitive items grouped per op, in op order: one toggle each. */
export function sensitiveOpGroups(sensitive: readonly SensitiveItem[]): Array<{ opIndex: number; reasons: string[] }> {
  const groups = new Map<number, string[]>();
  for (const item of sensitive) groups.set(item.opIndex, [...(groups.get(item.opIndex) ?? []), item.reason]);
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([opIndex, reasons]) => ({ opIndex, reasons }));
}

/** The key that toggles a sensitive op. Deliberately not Enter, the dialog's default. */
export const SENSITIVE_TOGGLE_KEY = " ";

export interface GrantConfirmParams {
  tui: PanelTui;
  theme: PanelTheme;
  keybindings: Keybindings;
  report: GrantReport;
  /** Whether a trusted project config dir exists, for the project answer. */
  projectAvailable: boolean;
  /**
   * Lines shown above the report — the configurator's rationale for a grant it
   * proposed. Display only: nothing in them approves anything.
   */
  preface?: string[];
  /**
   * Applies the grant with the approved sensitive ops (indexes into the
   * grant's ops); returns an error to keep the panel open and show it — e.g.
   * the grant fails its gates once unapproved sensitive ops are dropped.
   */
  apply(answer: Exclude<GrantAnswer, "discard">, approved: ReadonlySet<number>): Promise<string | undefined> | string | undefined;
  /** Discard or Esc. */
  discard(): void;
  done(value: undefined): void;
}

/**
 * The grant confirmation, docked like the policy page. Rows are the sensitive
 * ops (each with its own toggle, off by default, toggled with Space — never
 * Enter) and then the answers. Enter on an answer applies the non-sensitive
 * ops plus exactly the sensitive ones toggled on; nothing typed approves
 * anything, since the page takes no text at all. A grant that fails its gates
 * has no apply answer, only Discard, and says why.
 */
export class GrantConfirmPage extends Container {
  focused = false;

  private params: GrantConfirmParams;
  private body = new Container();
  private selected: number;
  private approved = new Set<number>();
  private message: { text: string; level: "error" | "muted" } | undefined;
  private groups: Array<{ opIndex: number; reasons: string[] }>;
  private answers: GrantAnswerOption[];

  constructor(params: GrantConfirmParams) {
    super();
    this.params = params;
    this.groups = params.report.ok ? sensitiveOpGroups(params.report.sensitive) : [];
    this.answers = params.report.ok ? grantAnswerOptions(params.projectAvailable) : [{ value: "discard", label: "Discard" }];
    // The first answer, not a toggle: Enter right away applies the
    // non-sensitive remainder, never a sensitive op.
    this.selected = this.groups.length;
    const border = () => new DynamicBorder((text) => params.theme.fg("border", text));
    this.addChild(border());
    this.addChild(this.body);
    this.addChild(border());
    this.refresh();
  }

  /** Sensitive op indexes currently toggled on (for tests and callers). */
  approvedOps(): number[] {
    return [...this.approved].sort((a, b) => a - b);
  }

  /** The highlighted row: a sensitive op's index, or an answer. */
  selectedRow(): { kind: "sensitive"; opIndex: number } | { kind: "answer"; value: GrantAnswer } {
    if (this.selected < this.groups.length) return { kind: "sensitive", opIndex: this.groups[this.selected]!.opIndex };
    return { kind: "answer", value: this.answers[this.selected - this.groups.length]!.value };
  }

  refresh(): void {
    const theme = this.params.theme;
    const report = this.params.report;
    this.body.clear();
    this.body.addChild(new Text(theme.fg("accent", theme.bold(`Rail grant · ${report.ok ? "passes its gates" : "rejected"}`)), 0, 0));
    for (const line of this.params.preface ?? []) this.body.addChild(new Text(theme.fg("muted", line), 0, 0));
    const lines = confirmationLines(report);
    const rows = this.groups.length + this.answers.length;
    const room = Math.max(6, this.params.tui.terminal.rows - rows - 10 - (this.params.preface?.length ?? 0));
    for (const line of lines.slice(0, room)) this.body.addChild(new Text(line.startsWith("✗") ? theme.fg("error", line) : line, 0, 0));
    if (lines.length > room) this.body.addChild(new Text(theme.fg("muted", `  … ${lines.length - room} more lines — /rail grant check <file> prints the full report`), 0, 0));
    if (!report.ok) this.body.addChild(new Text(theme.fg("warning", "  This grant cannot be applied: fix what failed above and run /rail grant add again."), 0, 0));
    if (this.groups.length > 0) {
      this.body.addChild(new Text(theme.fg("warning", "Sensitive ops — each needs its own approval (Space toggles; off means it is dropped):"), 0, 0));
      this.groups.forEach((group, index) => {
        const selected = index === this.selected;
        const box = this.approved.has(group.opIndex) ? "[x]" : "[ ]";
        const text = `${box} op ${group.opIndex + 1}: ${group.reasons.join("; ")}`;
        this.body.addChild(new Text(`${selected ? theme.fg("accent", "→ ") : "  "}${selected ? theme.fg("accent", text) : text}`, 0, 0));
      });
    }
    this.answers.forEach((answer, index) => {
      const selected = index + this.groups.length === this.selected;
      this.body.addChild(new Text(`${selected ? theme.fg("accent", "→ ") : "  "}${selected ? theme.fg("accent", answer.label) : answer.label}`, 0, 0));
    });
    if (this.message) this.body.addChild(new Text(theme.fg(this.message.level, `  ${this.message.text}`), 0, 0));
    const help = this.groups.length > 0 ? "↑↓ row · Space toggles a sensitive op · Enter picks an answer · Esc discards" : "↑↓ row · Enter picks an answer · Esc discards";
    this.body.addChild(new Text(theme.fg("muted", `  ${help}`), 0, 0));
    this.params.tui.requestRender();
  }

  handleInput(data: string): void {
    const total = this.groups.length + this.answers.length;
    const keys = this.params.keybindings;
    if (keys.matches(data, "tui.select.up")) {
      this.selected = this.selected === 0 ? total - 1 : this.selected - 1;
      this.refresh();
      return;
    }
    if (keys.matches(data, "tui.select.down")) {
      this.selected = this.selected === total - 1 ? 0 : this.selected + 1;
      this.refresh();
      return;
    }
    if (keys.matches(data, "tui.select.cancel")) {
      this.params.discard();
      this.params.done(undefined);
      return;
    }
    const row = this.selectedRow();
    if (data === SENSITIVE_TOGGLE_KEY || matchesKey(data, "space")) {
      if (row.kind !== "sensitive") return;
      if (this.approved.has(row.opIndex)) this.approved.delete(row.opIndex);
      else this.approved.add(row.opIndex);
      this.message = undefined;
      this.refresh();
      return;
    }
    if (keys.matches(data, "tui.select.confirm")) {
      if (row.kind === "sensitive") {
        this.message = { text: "Space toggles a sensitive op; Enter picks an answer below.", level: "muted" };
        this.refresh();
        return;
      }
      if (row.value === "discard") {
        this.params.discard();
        this.params.done(undefined);
        return;
      }
      if (this.applying) return;
      this.applying = true;
      this.message = { text: "Applying…", level: "muted" };
      this.refresh();
      void Promise.resolve(this.params.apply(row.value, new Set(this.approved)))
        .then((error) => {
          this.applying = false;
          if (error) {
            this.message = { text: error, level: "error" };
            this.refresh();
            return;
          }
          this.params.done(undefined);
        })
        .catch((error: unknown) => {
          this.applying = false;
          this.message = { text: error instanceof Error ? error.message : String(error), level: "error" };
          this.refresh();
        });
    }
  }

  /** True while an apply is in flight, so a second Enter cannot apply twice. */
  private applying = false;
}

// ── The grants view ──────────────────────────────────────────────────────────

export interface GrantRow {
  id: string;
  request: string;
  layer: GrantLayerName;
  file?: string;
  ops: number;
  examples: number;
  /** Decisions it decided this session (live counter). */
  session: number;
  /** Decisions it decided across the corpus. */
  corpus: number;
  /** ISO date of the newest corpus decision it decided, if any. */
  lastDecided?: string;
}

export type GrantAction = "revoke" | "promote-global" | "promote-project" | "demote";

export interface GrantsPageParams {
  tui: PanelTui;
  theme: PanelTheme;
  keybindings: Keybindings;
  rows(): GrantRow[];
  projectAvailable: boolean;
  /** Runs an action; returns the message to show (success or refusal). */
  act(row: GrantRow, action: GrantAction): { message: string; level: "info" | "warning" | "error" };
  done(value: undefined): void;
}

/** "last decided 2026-11-03" or "never decided". */
export function lastDecidedLabel(row: Pick<GrantRow, "lastDecided">): string {
  return row.lastDecided ? `last decided ${row.lastDecided.slice(0, 10)}` : "never decided";
}

/** The actions a row offers: promote from the session, demote from a file, revoke anywhere. */
export function grantActions(row: Pick<GrantRow, "layer">, projectAvailable: boolean): GrantAction[] {
  if (row.layer === "session") return ["promote-global", ...(projectAvailable ? (["promote-project"] as const) : []), "revoke"];
  return ["demote", "revoke"];
}

/**
 * Every named grant across the layers: id, request, layer, op count, what it
 * decided this session and in the corpus, and when it last decided anything.
 * r revokes (press twice: it deletes the grant), g / p promote a session grant
 * to the global / project file, d demotes a file grant to the session. Each
 * takes effect on the next tool call.
 */
export class GrantsPage extends Container {
  focused = false;

  private params: GrantsPageParams;
  private body = new Container();
  private selected = 0;
  private pendingRevoke: string | undefined;
  private message: { text: string; level: string } | undefined;

  constructor(params: GrantsPageParams) {
    super();
    this.params = params;
    const border = () => new DynamicBorder((text) => params.theme.fg("border", text));
    this.addChild(border());
    this.addChild(this.body);
    this.addChild(border());
    this.refresh();
  }

  selectedId(): string | undefined {
    return this.params.rows()[this.selected]?.id;
  }

  refresh(): void {
    const theme = this.params.theme;
    const rows = this.params.rows();
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
    this.body.clear();
    this.body.addChild(new Text(theme.fg("accent", theme.bold("Grants")), 0, 0));
    if (rows.length === 0) this.body.addChild(new Text(theme.fg("muted", "  No grants. /rail grant add <file> adds one."), 0, 0));
    rows.forEach((row, index) => {
      const selected = index === this.selected;
      const head = `${row.id.padEnd(24)} ${row.layer.padEnd(8)} ${String(row.ops).padStart(2)} op${row.ops === 1 ? " " : "s"}  ${row.session} this session · ${row.corpus} in corpus · ${lastDecidedLabel(row)}`;
      this.body.addChild(new Text(`${selected ? theme.fg("accent", "→ ") : "  "}${selected ? theme.fg("accent", head) : head}`, 0, 0));
    });
    const current = rows[this.selected];
    if (current) this.body.addChild(new Text(theme.fg("muted", `  ${current.request}${current.file ? ` · ${current.file}` : ""}`), 0, 0));
    if (this.message) this.body.addChild(new Text(theme.fg(this.message.level, `  ${this.message.text}`), 0, 0));
    const promote = this.params.projectAvailable ? "g/p promote to global/project" : "g promote to global";
    this.body.addChild(new Text(theme.fg("muted", `  ↑↓ grant · ${promote} · d demote to session · r r revoke · Esc closes`), 0, 0));
    this.params.tui.requestRender();
  }

  handleInput(data: string): void {
    const rows = this.params.rows();
    const keys = this.params.keybindings;
    if (keys.matches(data, "tui.select.cancel")) {
      this.params.done(undefined);
      return;
    }
    if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
      if (rows.length > 0) {
        const step = keys.matches(data, "tui.select.up") ? -1 : 1;
        this.selected = (this.selected + step + rows.length) % rows.length;
      }
      this.pendingRevoke = undefined;
      this.message = undefined;
      this.refresh();
      return;
    }
    const row = rows[this.selected];
    if (!row) return;
    const action: GrantAction | undefined = data === "r" ? "revoke" : data === "g" ? "promote-global" : data === "p" ? "promote-project" : data === "d" ? "demote" : undefined;
    if (!action) return;
    if (!grantActions(row, this.params.projectAvailable).includes(action)) {
      this.message = { text: row.layer === "session" ? "A session grant can be promoted or revoked." : "A file grant can be demoted to the session or revoked.", level: "warning" };
      this.refresh();
      return;
    }
    if (action === "revoke" && this.pendingRevoke !== row.id) {
      this.pendingRevoke = row.id;
      this.message = { text: `Press r again to revoke ${row.id} — it is deleted from the ${row.layer} layer.`, level: "warning" };
      this.refresh();
      return;
    }
    this.pendingRevoke = undefined;
    const result = this.params.act(row, action);
    this.message = { text: result.message, level: result.level === "info" ? "muted" : result.level };
    this.refresh();
  }
}
