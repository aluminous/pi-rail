import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Editor, Input, matchesKey, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { CapabilityId } from "../capabilities.ts";
import { dispositionCell, type DispositionRow } from "../dispositions.ts";
import type { PanelTheme, PanelTui } from "./report-panel.ts";
import type { Keybindings } from "./select-list.ts";

// Two clear columns: the longest class id is 20 wide, so 22 keeps a gutter.
const ID_WIDTH = 22;
const DISPOSITION_WIDTH = 16;

/** List mode edits rows; the two form modes replace the list inside the same panel body. */
type PageMode = "list" | "add" | "edit";

export interface DispositionPageParams {
  tui: PanelTui;
  theme: PanelTheme;
  keybindings: Keybindings;
  /** Current rows, re-read on every refresh so live stats and preset changes land. */
  rows(): DispositionRow[];
  /** Cycles one row's disposition at session scope; the page re-reads rows() after. */
  cycle(id: CapabilityId, step: 1 | -1): void;
  /** Ctrl+S: promotes the session edits to the global config and notifies. */
  save(): void;
  /** One-line note about an active session preset, when there is one. */
  banner(): string | undefined;
  /** Adds a class at session scope; returns a validation error to keep the user in the form. */
  addClass(input: { id: string; definition: string }): string | undefined;
  /** Edits a class definition at session scope; returns a validation error. */
  editDefinition(id: CapabilityId, definition: string): string | undefined;
  /** Deletes a custom class at session scope; returns a refusal for built-ins. */
  deleteClass(id: CapabilityId): string | undefined;
  /** Page-level notifications (class added, deletion refused). */
  notify(message: string, level?: "info" | "warning" | "error"): void;
  done(value: undefined): void;
}

/**
 * Renders a labelled single-line field by borrowing Input's own rendering, the
 * same trick InlineCommentRow uses: give Input the remaining columns plus its
 * two-column prompt, then strip the prompt so the cursor still lands right.
 */
class FormField implements Component {
  private label: string;
  private input: Input;
  private theme: PanelTheme;
  private active: boolean;

  constructor(label: string, input: Input, theme: PanelTheme, active: boolean) {
    this.label = label;
    this.input = input;
    this.theme = theme;
    this.active = active;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const marker = this.active ? this.theme.fg("accent", "→ ") : "  ";
    const label = this.active ? this.theme.fg("accent", this.label) : this.theme.fg("muted", this.label);
    const prefix = `${marker}${label}  `;
    const available = width - visibleWidth(prefix);
    if (available <= 0) return [prefix];
    const line = this.input.render(available + 2)[0] ?? "> ";
    return [prefix + line.slice(2)];
  }
}

/** Structural slice of pi-tui's Component, so the panel does not depend on the full type. */
interface Component {
  invalidate(): void;
  render(width: number): string[];
}

/**
 * The definition editor is pi-tui's Editor — the same component behind pi's
 * chat input — styled to match it: borderMuted rules above and below, no
 * horizontal padding (the chat default), wrapping and growing with the text.
 * Editor's constructor asks for a full TUI, but everything it touches at
 * runtime is requestRender() and terminal.rows — exactly the PanelTui slice —
 * so the one cast below keeps the page drivable with the same structural
 * fakes the tests already use.
 */
function createDefinitionEditor(tui: PanelTui, theme: PanelTheme): Editor {
  const accent = (text: string) => theme.fg("accent", text);
  const muted = (text: string) => theme.fg("muted", text);
  const editor = new Editor(tui as unknown as TUI, {
    borderColor: (text) => theme.fg("borderMuted", text),
    // Required by EditorTheme but only rendered by autocomplete, which never
    // activates here: no provider is attached.
    selectList: { selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: muted, noMatch: muted },
  });
  // Enter is the page's commit gesture; the editor must never submit-and-clear
  // on its own if a stray Enter reaches it.
  editor.disableSubmit = true;
  return editor;
}

/**
 * The disposition settings page: THE policy surface, and only that. The
 * resolved mechanism rules moved to the status page's policy tab, since they
 * are evidence to read rather than rows to edit. Docked in the editor area like
 * the other rail views (DynamicBorder chrome, non-overlay custom UI, agent
 * streaming above).
 *
 * Every edit — a disposition, a new class, a definition rewrite, a deletion —
 * applies immediately at session scope, since classes like local-destructive
 * are meant to be re-scoped per session. Rows moved off their persisted value
 * are coloured and new/edited classes are tagged; Ctrl+S persists everything
 * (and the marks clear), Esc just closes and leaves the session state in force.
 */
export class DispositionPage extends Container {
  /** Focusable: set by the TUI when focus changes. */
  focused = false;

  private params: DispositionPageParams;
  private body = new Container();
  private selected = 0;
  private mode: PageMode = "list";
  /** Add-form fields; reused across openings so a cancelled form starts clean. */
  private idInput = new Input();
  private definitionEditor: Editor;
  private formField: "id" | "definition" = "id";
  private formError: string | undefined;
  private editingId: CapabilityId | undefined;

  constructor(params: DispositionPageParams) {
    super();
    this.params = params;
    this.definitionEditor = createDefinitionEditor(params.tui, params.theme);
    // jiti caveat: pi's DynamicBorder default color reads a global theme that
    // extensions may not share — always pass the explicit color function.
    const border = () => new DynamicBorder((text) => params.theme.fg("border", text));
    this.addChild(border());
    this.addChild(this.body);
    this.addChild(border());
    this.refresh();
  }

  /** The highlighted class, for callers driving the page (tests, key handling). */
  selectedId(): CapabilityId | undefined {
    return this.params.rows()[this.selected]?.id;
  }

  refresh(): void {
    const theme = this.params.theme;
    this.body.clear();
    this.body.addChild(new Text(theme.fg("accent", theme.bold("Capability policy")), 0, 0));
    if (this.mode === "list") this.renderList();
    else this.renderForm();
    this.params.tui.requestRender();
  }

  private renderList(): void {
    const theme = this.params.theme;
    const rows = this.params.rows();
    if (this.selected > rows.length) this.selected = rows.length;
    const banner = this.params.banner();
    if (banner) this.body.addChild(new Text(theme.fg("warning", `  ${banner}`), 0, 0));

    // The add row is a virtual last entry, so index rows.length is "＋ Add class…".
    const total = rows.length + 1;
    const maxVisible = Math.max(4, this.params.tui.terminal.rows - 13);
    const start = Math.max(0, Math.min(this.selected - Math.floor(maxVisible / 2), total - maxVisible));
    const end = Math.min(start + maxVisible, total);
    for (let i = start; i < end; i++) {
      if (i === rows.length) {
        const selected = i === this.selected;
        const label = "＋ Add class…";
        this.body.addChild(new Text(`${selected ? theme.fg("accent", "→ ") : "  "}${selected ? theme.fg("accent", label) : theme.fg("muted", label)}`, 0, 0));
        continue;
      }
      const row = rows[i];
      if (!row) continue;
      this.body.addChild(new Text(this.renderRow(row, i === this.selected), 0, 0));
    }
    if (start > 0 || end < total) {
      this.body.addChild(new Text(theme.fg("muted", `  (${this.selected + 1}/${total})`), 0, 0));
    }

    const current = rows[this.selected];
    if (current) this.body.addChild(new Text(theme.fg("muted", `  ${current.definition}`), 0, 0));
    this.body.addChild(new Text(theme.fg("muted", "  ↑↓ row · ←→/Enter cycle · a add · e edit · d delete · Ctrl+S saves · Esc closes"), 0, 0));
    this.body.addChild(new Text(theme.fg("muted", "  the resolved filesystem/network rules are /rail policy rules"), 0, 0));
  }

  /**
   * Selection colours the class id, modification colours the disposition cell:
   * two different segments, so a modified row stays visibly modified while it
   * is highlighted. Session-scoped class changes get their own warning tag.
   */
  private renderRow(row: DispositionRow, selected: boolean): string {
    const theme = this.params.theme;
    const prefix = selected ? theme.fg("accent", "→ ") : "  ";
    const id = row.id.padEnd(ID_WIDTH);
    const cell = dispositionCell(row).padEnd(DISPOSITION_WIDTH);
    const tag = row.sessionNew ? " (new)" : row.sessionEdited ? " (edited)" : "";
    return [
      prefix,
      selected ? theme.fg("accent", id) : id,
      row.modified ? theme.fg("warning", cell) : cell,
      tag ? theme.fg("warning", tag) : "",
      row.statsLabel ? theme.fg("muted", ` ${row.statsLabel}`) : "",
    ].join("");
  }

  private renderForm(): void {
    const theme = this.params.theme;
    const adding = this.mode === "add";
    const definitionActive = !adding || this.formField === "definition";
    this.body.addChild(new Text(theme.fg("accent", `  ${adding ? "New capability class" : `Edit ${this.editingId}`}`), 0, 0));
    if (adding) {
      this.idInput.focused = !definitionActive;
      this.body.addChild(new FormField("id", this.idInput, theme, !definitionActive));
    }
    // The definition gets the chat-input treatment: a labelled full-width
    // Editor box that wraps and grows with the text, instead of a single
    // Input line scrolling a sliver of a paragraph past the caret.
    this.definitionEditor.focused = definitionActive;
    const marker = definitionActive ? theme.fg("accent", "→ ") : "  ";
    this.body.addChild(new Text(`${marker}${definitionActive ? theme.fg("accent", "definition") : theme.fg("muted", "definition")}`, 0, 0));
    this.body.addChild(this.definitionEditor);
    if (this.formError) this.body.addChild(new Text(theme.fg("error", `  ${this.formError}`), 0, 0));
    this.body.addChild(new Text(theme.fg("muted", "  The definition is prompt text the namer reads verbatim; write it as a decision boundary."), 0, 0));
    // Enter commits, matching the chat input's submit gesture and working on
    // terminals without extended keys. Newlines are an editing convenience
    // ("\"+Enter and ctrl+j continue on the next line, chat-style); the commit
    // joins them back to spaces because the definition serializes as one
    // string. Ctrl+S commits too, so "save" means the same thing in both modes.
    this.body.addChild(new Text(theme.fg("muted", `  ${adding ? "Tab switches field · " : ""}Enter or Ctrl+S commits (session scope) · Esc cancels`), 0, 0));
  }

  handleInput(data: string): void {
    if (this.mode !== "list") return this.handleFormInput(data);

    const rows = this.params.rows();
    const total = rows.length + 1;
    if (this.params.keybindings.matches(data, "tui.select.up")) {
      this.selected = this.selected === 0 ? total - 1 : this.selected - 1;
      this.refresh();
      return;
    }
    if (this.params.keybindings.matches(data, "tui.select.down")) {
      this.selected = this.selected === total - 1 ? 0 : this.selected + 1;
      this.refresh();
      return;
    }
    const onAddRow = this.selected === rows.length;
    if (this.params.keybindings.matches(data, "tui.select.confirm")) {
      if (onAddRow) return this.openAddForm();
      return this.cycle(1);
    }
    if (matchesKey(data, "left")) return onAddRow ? undefined : this.cycle(-1);
    if (matchesKey(data, "right")) return onAddRow ? undefined : this.cycle(1);
    if (data === "a") return this.openAddForm();
    if (data === "e") return this.openEditForm();
    if (data === "d") return this.deleteSelected();
    if (matchesKey(data, "ctrl+s")) {
      this.params.save();
      this.refresh();
      return;
    }
    if (this.params.keybindings.matches(data, "tui.select.cancel")) {
      this.params.done(undefined);
    }
  }

  private handleFormInput(data: string): void {
    if (this.params.keybindings.matches(data, "tui.select.cancel")) {
      this.closeForm();
      return;
    }
    if (this.mode === "add" && this.params.keybindings.matches(data, "tui.input.tab")) {
      this.formField = this.formField === "id" ? "definition" : "id";
      this.refresh();
      return;
    }
    const definitionActive = this.mode === "edit" || this.formField === "definition";
    if (this.params.keybindings.matches(data, "tui.select.confirm")) {
      // Chat parity for terminals without shift+enter: "\" then Enter deletes
      // the backslash and continues on the next line instead of committing.
      if (definitionActive && this.caretFollowsBackslash()) {
        this.definitionEditor.handleInput("\x7f");
        this.definitionEditor.handleInput("\n");
        this.refresh();
        return;
      }
      this.commitForm();
      return;
    }
    if (matchesKey(data, "ctrl+s")) {
      this.commitForm();
      return;
    }
    if (definitionActive) this.definitionEditor.handleInput(data);
    else this.idInput.handleInput(data);
    this.refresh();
  }

  /** Whether the character immediately before the definition caret is a backslash. */
  private caretFollowsBackslash(): boolean {
    const cursor = this.definitionEditor.getCursor();
    const line = this.definitionEditor.getLines()[cursor.line] ?? "";
    return cursor.col > 0 && line[cursor.col - 1] === "\\";
  }

  private openAddForm(): void {
    this.mode = "add";
    this.formField = "id";
    this.formError = undefined;
    this.idInput.setValue("");
    this.definitionEditor.setText("");
    this.refresh();
  }

  private openEditForm(): void {
    const row = this.params.rows()[this.selected];
    if (!row) return;
    this.mode = "edit";
    this.editingId = row.id;
    this.formField = "definition";
    this.formError = undefined;
    // Definition only, for built-ins and custom classes alike: the id is the
    // namer's vocabulary and the name is cosmetic, while the definition is the
    // thing that actually changes how actions get labelled. setText, unlike
    // Input.setValue, leaves the caret at the end of the seeded text.
    this.definitionEditor.setText(row.fullDefinition);
    this.refresh();
  }

  private closeForm(): void {
    this.mode = "list";
    this.formError = undefined;
    this.editingId = undefined;
    this.refresh();
  }

  /**
   * The committed definition: one line, since it lands in the namer prompt as
   * a single JSON string. Newlines picked up while editing (ctrl+j, "\"+Enter,
   * pasted paragraphs) join back to single spaces; getExpandedText restores
   * any pastes the editor collapsed into markers.
   */
  private definitionText(): string {
    return this.definitionEditor.getExpandedText().replace(/\s*\n\s*/g, " ").trim();
  }

  private commitForm(): void {
    if (this.mode === "add") {
      const id = this.idInput.getValue().trim();
      const error = this.params.addClass({ id, definition: this.definitionText() });
      if (error) {
        this.formError = error;
        this.refresh();
        return;
      }
      this.params.notify(`${id} added for this session, default ask. Ctrl+S saves it.`);
      this.closeForm();
      return;
    }
    const id = this.editingId;
    if (!id) return this.closeForm();
    const error = this.params.editDefinition(id, this.definitionText());
    if (error) {
      this.formError = error;
      this.refresh();
      return;
    }
    this.params.notify(`${id} definition updated for this session. Ctrl+S saves it.`);
    this.closeForm();
  }

  private deleteSelected(): void {
    const row = this.params.rows()[this.selected];
    if (!row) return;
    const error = this.params.deleteClass(row.id);
    if (error) {
      this.params.notify(error, "warning");
      this.refresh();
      return;
    }
    this.params.notify(`${row.id} removed for this session. Ctrl+S saves it.`);
    this.refresh();
  }

  private cycle(step: 1 | -1): void {
    const row = this.params.rows()[this.selected];
    if (!row) return;
    this.params.cycle(row.id, step);
    this.refresh();
  }
}
