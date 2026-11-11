import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import type { ReviewerSeat, SeatValue } from "../reviewer-seats.ts";
import type { PanelTheme, PanelTui } from "./report-panel.ts";
import type { Keybindings, SelectItem } from "./select-list.ts";

const MAX_VISIBLE = 10;

/** Everything one tab renders, re-read on every refresh so a pick lands at once. */
export interface SeatView {
  seat: ReviewerSeat;
  /** "judge: current → anthropic/claude-opus-4-5" — the effective setting and what it calls. */
  summary: string;
  /** The session value differs from the persisted one. */
  unsaved: boolean;
  /** What the persisted value is, for the unsaved note. */
  persisted: SeatValue;
  note: string;
  items: SelectItem<SeatValue>[];
}

export interface ReviewerModelPageParams {
  tui: PanelTui;
  theme: PanelTheme;
  keybindings: Keybindings;
  seats(): SeatView[];
  /** Sets one seat for this session; returns a refusal to show instead. */
  pick(seat: ReviewerSeat, value: SeatValue): string | undefined;
  /** Ctrl+S: writes the unsaved seats to the global config and notifies. */
  save(): void;
  done(value: undefined): void;
  /** Which tab to open on. */
  initialSeat?: ReviewerSeat;
}

/**
 * The reviewer-model picker: pi's own /model chooser in look and keys (search
 * box, `→` cursor, `id [provider]` rows, ✓ on the active choice, the model
 * name under the list), with a tab per reviewer seat and the disposition
 * page's session contract on top. Enter sets the highlighted entry for THIS
 * session and stays open, so all three seats can be set in one visit; a tab
 * whose session value differs from the persisted one carries a `*`, Ctrl+S
 * saves every marked seat to the global config and clears the marks, and Esc
 * closes leaving the session values in force until pi restarts.
 */
export class ReviewerModelPage extends Container {
  private _focused = false;
  private params: ReviewerModelPageParams;
  private header = new Container();
  private list = new Container();
  private search = new Input();
  private tabIndex = 0;
  private selectedIndex = 0;
  private filtered: SelectItem<SeatValue>[] = [];
  private message: { text: string; level: "warning" | "error" } | undefined;

  get focused(): boolean {
    return this._focused;
  }

  /** Focus goes to the search box, as in pi's chooser, so the IME cursor lands there. */
  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  constructor(params: ReviewerModelPageParams) {
    super();
    this.params = params;
    const seats = params.seats();
    const initial = params.initialSeat ? seats.findIndex((view) => view.seat === params.initialSeat) : -1;
    this.tabIndex = initial >= 0 ? initial : 0;
    // jiti caveat: pi's DynamicBorder default color reads a global theme that
    // extensions may not share — always pass the explicit color function.
    const border = () => new DynamicBorder((text) => params.theme.fg("border", text));
    this.addChild(border());
    this.addChild(this.header);
    this.addChild(this.search);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(border());
    this.resetSelection();
    this.refresh();
  }

  /** The active tab's seat, for callers driving the page. */
  activeSeat(): ReviewerSeat {
    return this.view().seat;
  }

  /** The highlighted entry's value. */
  selectedValue(): SeatValue | undefined {
    return this.filtered[this.selectedIndex]?.value;
  }

  private view(): SeatView {
    const seats = this.params.seats();
    return seats[Math.min(this.tabIndex, seats.length - 1)]!;
  }

  /** Back to the seat's effective entry, unfiltered: what a fresh tab shows. */
  private resetSelection(): void {
    this.search.setValue("");
    this.filtered = this.view().items;
    const current = this.filtered.findIndex((item) => item.current);
    this.selectedIndex = current >= 0 ? current : 0;
  }

  /** Re-reads the seat (a pick or a save changed it), keeping the query and the highlighted value. */
  refresh(): void {
    const keep = this.selectedValue();
    this.applyFilter();
    if (keep !== undefined) {
      const at = this.filtered.findIndex((item) => item.value === keep);
      if (at >= 0) this.selectedIndex = at;
    }
    this.renderHeader();
    this.renderList();
    this.params.tui.requestRender();
  }

  private applyFilter(): void {
    const query = this.search.getValue();
    const items = this.view().items;
    this.filtered = query ? fuzzyFilter(items, query, (item) => item.searchText) : items;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
  }

  private renderHeader(): void {
    const theme = this.params.theme;
    const seats = this.params.seats();
    const view = this.view();
    this.header.clear();
    this.header.addChild(new Spacer(1));
    this.header.addChild(new Text(theme.fg("accent", theme.bold("Rail reviewer models")), 0, 0));
    const tabs = seats.map((seat, index) => {
      const name = theme.fg(index === this.tabIndex ? "accent" : "muted", seat.seat);
      return seat.unsaved ? `${name}${theme.fg("warning", "*")}` : name;
    });
    this.header.addChild(new Text(`${theme.fg("muted", "Tab:")} ${tabs.join(theme.fg("muted", " | "))}`, 0, 0));
    this.header.addChild(new Text(theme.fg("muted", view.note), 0, 0));
    const unsaved = view.unsaved ? theme.fg("warning", `  (this session; saved: ${view.persisted})`) : "";
    this.header.addChild(new Text(`${view.summary}${unsaved}`, 0, 0));
    this.header.addChild(new Spacer(1));
  }

  private renderList(): void {
    const theme = this.params.theme;
    this.list.clear();
    const total = this.filtered.length;
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), total - MAX_VISIBLE));
    const end = Math.min(start + MAX_VISIBLE, total);
    for (let i = start; i < end; i++) {
      const item = this.filtered[i]!;
      const selected = i === this.selectedIndex;
      const prefix = selected ? theme.fg("accent", "→ ") : "  ";
      const label = selected ? theme.fg("accent", item.label) : item.label;
      const suffix = item.suffix ? ` ${theme.fg("muted", item.suffix)}` : "";
      const check = item.current ? theme.fg("success", " ✓") : "";
      this.list.addChild(new Text(`${prefix}${label}${suffix}${check}`, 0, 0));
    }
    if (start > 0 || end < total) this.list.addChild(new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${total})`), 0, 0));
    if (total === 0) this.list.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
    const description = this.filtered[this.selectedIndex]?.description;
    this.list.addChild(new Spacer(1));
    if (description) this.list.addChild(new Text(theme.fg("muted", `  ${description}`), 0, 0));
    if (this.message) this.list.addChild(new Text(theme.fg(this.message.level, `  ${this.message.text}`), 0, 0));
    this.list.addChild(new Text(theme.fg("muted", "  Type to search · Tab/Shift+Tab seat · Enter sets for this session · Ctrl+S saves · Esc closes"), 0, 0));
  }

  private switchTab(step: 1 | -1): void {
    const count = this.params.seats().length;
    this.tabIndex = (this.tabIndex + step + count) % count;
    this.message = undefined;
    this.resetSelection();
    this.refresh();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "shift+tab")) return this.switchTab(-1);
    if (this.params.keybindings.matches(data, "tui.input.tab")) return this.switchTab(1);
    if (this.params.keybindings.matches(data, "tui.select.up")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
      this.renderList();
      this.params.tui.requestRender();
      return;
    }
    if (this.params.keybindings.matches(data, "tui.select.down")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
      this.renderList();
      this.params.tui.requestRender();
      return;
    }
    if (this.params.keybindings.matches(data, "tui.select.confirm")) {
      const value = this.selectedValue();
      if (value === undefined) return;
      const refusal = this.params.pick(this.activeSeat(), value);
      this.message = refusal ? { text: refusal, level: "warning" } : undefined;
      this.refresh();
      return;
    }
    if (matchesKey(data, "ctrl+s")) {
      this.message = undefined;
      this.params.save();
      this.refresh();
      return;
    }
    if (this.params.keybindings.matches(data, "tui.select.cancel")) {
      this.params.done(undefined);
      return;
    }
    this.search.handleInput(data);
    // A new query starts at the best match, as in pi's chooser.
    this.selectedIndex = 0;
    this.applyFilter();
    this.renderList();
    this.params.tui.requestRender();
  }
}
