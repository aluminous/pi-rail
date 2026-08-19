import { Container, Input, Spacer, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Keybindings, Theme } from "./select-list.ts";

export interface RailApprovalAnswer {
  approved: boolean;
  /** Optional user comment, recorded as classifier session guidance. */
  comment?: string;
  /**
   * Escape: not a denial. The user reached for the stop key, so callers turn
   * this into an aborted turn rather than a deny the agent would work around.
   */
  cancelled?: boolean;
}

interface ApprovalOption {
  label: string;
  approved: boolean;
}

export const APPROVAL_OPTIONS: ApprovalOption[] = [
  { label: "Allow", approved: true },
  { label: "Deny", approved: false },
];

/**
 * Renders the highlighted option with the shared comment inline, so the row
 * doubles as a text box: "→ Allow — staging is fine█". Wraps pi-tui's Input
 * for editing, horizontal scrolling, and IME cursor positioning, but strips
 * its "> " prompt so the label and the comment stay on one line.
 */
class InlineCommentRow implements Component {
  private label: string;
  private input: Input;
  private theme: Theme;

  constructor(label: string, input: Input, theme: Theme) {
    this.label = label;
    this.input = input;
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const separator = this.input.getValue() ? this.theme.fg("muted", " — ") : " ";
    const prefix = `${this.theme.fg("accent", "→ ")}${this.theme.fg("accent", this.label)}${separator}`;
    const available = width - visibleWidth(prefix);
    if (available <= 0) return [prefix];
    // Input renders one line as "> text…" padded to the width it is given;
    // grant it the remaining columns plus its two-column prompt, then strip
    // the prompt. The cursor (and IME marker, when focused) come along.
    const line = this.input.render(available + 2)[0] ?? "> ";
    return [prefix + line.slice(2)];
  }
}

/**
 * Two-way approval dialog for rail prompts: Allow / Deny, with a shared
 * inline comment. Typing while either option is highlighted edits a comment
 * rendered directly on that row; arrowing between the options keeps the
 * typed text. Enter resolves the highlighted option (attaching the trimmed
 * comment when non-empty, as classifier session guidance); Escape resolves
 * as a cancelled non-answer ({ approved: false, cancelled: true }), which
 * the interceptor turns into a stopped turn rather than a denial.
 */
export class RailApprovalDialog extends Container {
  private commentInput = new Input();
  private dynamic = new Container();
  private selectedIndex = 0;
  private _focused = false;
  private decided = false;
  /** Input arriving before this instant is dropped (see `inputGraceMs`). */
  private readyAt = 0;
  private theme: Theme;
  private keybindings: Keybindings;
  private done: (answer: RailApprovalAnswer) => void;

  get focused() {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.commentInput.focused = value;
  }

  constructor(params: {
    title: string;
    message: string;
    theme: Theme;
    keybindings: Keybindings;
    done: (answer: RailApprovalAnswer) => void;
    /** Start with Deny highlighted — for dialogs popped by background work, where a stray Enter must not approve. */
    defaultDeny?: boolean;
    /** Drop input for this long after mount, so a keystroke aimed at the editor can't decide a dialog that stole focus. */
    inputGraceMs?: number;
    /** Hands the caller a cancel that resolves the dialog as a plain deny (e.g. when the requester died). */
    onCancelHandle?: (cancel: () => void) => void;
  }) {
    super();
    this.theme = params.theme;
    this.keybindings = params.keybindings;
    this.done = params.done;
    if (params.defaultDeny) {
      const deny = APPROVAL_OPTIONS.findIndex((option) => !option.approved);
      if (deny >= 0) this.selectedIndex = deny;
    }
    if (params.inputGraceMs) this.readyAt = Date.now() + params.inputGraceMs;
    params.onCancelHandle?.(() => this.finish({ approved: false }));
    this.addChild(new Text(params.theme.fg("accent", params.title), 0, 0));
    this.addChild(new Text(params.message, 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.dynamic);
    this.addChild(new Spacer(1));
    this.addChild(new Text(params.theme.fg("muted", "Enter decides · type to attach a comment · Esc stops the turn"), 0, 0));
    // Safety net: raw Enter reaching the Input (via its own keybindings)
    // decides too, instead of vanishing.
    this.commentInput.onSubmit = () => this.decide();
    this.update();
  }

  /** All exits funnel through here so a late cancel can't double-resolve. */
  private finish(answer: RailApprovalAnswer): void {
    if (this.decided) return;
    this.decided = true;
    this.done(answer);
  }

  private decide(): void {
    const option = APPROVAL_OPTIONS[this.selectedIndex];
    if (!option) return;
    const comment = this.commentInput.getValue().trim();
    this.finish(comment ? { approved: option.approved, comment } : { approved: option.approved });
  }

  private update(): void {
    this.dynamic.clear();
    for (let i = 0; i < APPROVAL_OPTIONS.length; i++) {
      const option = APPROVAL_OPTIONS[i];
      if (!option) continue;
      if (i === this.selectedIndex) {
        this.dynamic.addChild(new InlineCommentRow(option.label, this.commentInput, this.theme));
      } else {
        this.dynamic.addChild(new Text(`  ${option.label}`, 0, 0));
      }
    }
  }

  handleInput(keyData: string): void {
    if (Date.now() < this.readyAt) return;
    if (this.keybindings.matches(keyData, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? APPROVAL_OPTIONS.length - 1 : this.selectedIndex - 1;
      this.update();
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === APPROVAL_OPTIONS.length - 1 ? 0 : this.selectedIndex + 1;
      this.update();
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.confirm")) {
      this.decide();
      return;
    }
    if (this.keybindings.matches(keyData, "tui.select.cancel")) {
      this.finish({ approved: false, cancelled: true });
      return;
    }
    // Everything else edits the shared inline comment: printable characters,
    // backspace, cursor movement, paste.
    this.commentInput.handleInput(keyData);
  }
}
