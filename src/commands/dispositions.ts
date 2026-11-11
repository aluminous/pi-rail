import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DISPOSITIONS, capabilityRegistry, isDisposition, type CapabilityId, type Disposition } from "../capabilities.ts";
import { loadConfig, type ResolvedRailConfig } from "../config.ts";
import {
  DEFAULT_DISPOSITION_PERSISTENCE,
  addClass,
  classDetailPrefix,
  cycleDisposition,
  deleteClass,
  describeDispositionSource,
  dispositionCell,
  dispositionRow,
  dispositionRows,
  dispositionSummary,
  DISPOSITION_HELP,
  editClassDefinition,
  presetBanner,
  saveDispositions,
  setRowDisposition,
  type DispositionPersistence,
  type SaveResult,
} from "../dispositions.ts";
import type { RuntimeState } from "../state.ts";
import { toggleRailPanel } from "../live-view.ts";
import { DispositionPage } from "../tui/disposition-page.ts";
import { pickFromList, type SelectItem } from "../tui/select-list.ts";
import { formatError } from "../util.ts";

export interface DispositionCommandDeps {
  state: RuntimeState;
  /** Persist boundary; injectable so tests never touch the real config file. */
  persist?: Partial<DispositionPersistence>;
  notify(ctx: ExtensionContext, message: string, level?: "info" | "warning" | "error"): void;
}

/**
 * "Dispositions saved: 2 rows · 1 class added." — only the non-zero parts, plus
 * the honest note when a project config still owns one of the saved rows.
 */
function saveMessage(result: SaveResult): string {
  const parts: string[] = [];
  if (result.saved.length > 0) parts.push(`${result.saved.length} row${result.saved.length === 1 ? "" : "s"}`);
  if (result.added.length > 0) parts.push(`${result.added.length} class${result.added.length === 1 ? "" : "es"} added`);
  if (result.edited.length > 0) parts.push(`${result.edited.length} edited`);
  if (result.removed.length > 0) parts.push(`${result.removed.length} removed`);
  if (parts.length === 0) return "No session changes to save.";
  const base = `Dispositions saved: ${parts.join(" · ")}.`;
  if (result.shadowed.length === 0) return base;
  return `${base} Project config still sets ${result.shadowed.join(", ")} and wins next session.`;
}

export function createDispositionCommands(deps: DispositionCommandDeps) {
  const { state, notify } = deps;
  const persist: DispositionPersistence = { ...DEFAULT_DISPOSITION_PERSISTENCE, ...deps.persist };

  /**
   * The effective config (session layer included). Read fresh at every use
   * rather than captured: a session edit or a Ctrl+S changes what state.config
   * returns, and a stale copy would show rows from before the edit.
   */
  function config(ctx: ExtensionContext): ResolvedRailConfig {
    if (!state.config) state.config = loadConfig(ctx);
    return state.config!;
  }

  function save(ctx: ExtensionContext): void {
    try {
      notify(ctx, saveMessage(saveDispositions(state.config, state, persist)));
    } catch (error) {
      notify(ctx, `Could not save dispositions: ${formatError(error)}`, "error");
    }
  }

  /**
   * `/rail policy`: the interactive page in the TUI, a select flow over RPC, an
   * error headless. Re-invoking it while it is open toggles the panel shut.
   */
  async function openSettings(ctx: ExtensionContext): Promise<void> {
    const resolved = config(ctx);
    // The page outlives this call, so it reads state.config each refresh (a new
    // session reloads it; a session edit refolds it) and falls back to the base
    // resolved here only if the config was cleared.
    const fallback = state.baseConfig ?? resolved;
    const current = () => state.config ?? fallback;
    const opened = toggleRailPanel(ctx, state, "policy", (host) => new DispositionPage({
      ...host,
      rows: () => dispositionRows(current(), state),
      cycle: (id, step) => setRowDisposition(current(), state, id, cycleDisposition(dispositionRow(current(), state, id).value, step)),
      save: () => save(ctx),
      banner: () => presetBanner(state),
      addClass: (input) => addClass(current(), state, input),
      editDefinition: (id, definition) => editClassDefinition(current(), state, id, definition),
      deleteClass: (id) => deleteClass(state, id),
      notify: (message, level) => notify(ctx, message, level),
    }));
    if (opened) return;
    if (!ctx.hasUI) {
      console.error("The disposition page requires an interactive session (TUI or RPC).");
      return;
    }
    await runSelectFlow(ctx, current);
  }

  /**
   * RPC degradation: pick a class (labels carry the current disposition and
   * this session's stats), then pick a disposition; the choice applies at
   * session scope and the class list comes back so several rows can be edited
   * in a row. "Save persistently" is the Ctrl+S equivalent; cancel exits.
   */
  async function runSelectFlow(ctx: ExtensionContext, current: () => ResolvedRailConfig): Promise<void> {
    for (;;) {
      const rows = dispositionRows(current(), state);
      const banner = presetBanner(state);
      const items: SelectItem<CapabilityId | "save" | "add">[] = rows.map((row) => ({
        value: row.id,
        label: dispositionSummary(row),
        searchText: `${row.id} ${row.value} ${row.name}`,
        description: `${classDetailPrefix(row)}${row.definition}`,
      }));
      items.push({
        value: "add",
        label: "Add new class…",
        searchText: "add new class capability create custom",
        description: "Define a custom capability class the namer can use from the next action on",
      });
      items.push({
        value: "save",
        label: "Save persistently",
        searchText: "save persist write global config dispositions classes",
        description: "Write every session change — rows, added classes, edits, deletions — to the global rail config",
      });
      const picked = await pickFromList<CapabilityId | "save" | "add">(ctx, {
        title: "Capability dispositions (changes apply to this session)",
        headerLines: banner ? [banner] : undefined,
        items,
      });
      if (!picked) return;
      if (picked.value === "save") {
        save(ctx);
        continue;
      }
      if (picked.value === "add") {
        await runAddClass(ctx, current());
        continue;
      }
      await runClassMenu(ctx, current(), picked.value);
    }
  }

  /** Prompts for id then definition; validation failures report and drop back to the list. */
  async function runAddClass(ctx: ExtensionContext, resolved: ResolvedRailConfig): Promise<void> {
    const id = await ctx.ui.input("New capability class id (kebab-case, e.g. touches-customer-data)");
    if (!id?.trim()) return;
    const definition = await ctx.ui.input(`Definition for ${id.trim()} — prompt text the namer reads verbatim`);
    if (!definition?.trim()) return;
    const error = addClass(resolved, state, { id: id.trim(), definition: definition.trim() });
    if (error) {
      notify(ctx, error, "warning");
      return;
    }
    notify(ctx, `${id.trim()} added for this session, default ask. Save persistently to keep it.`);
  }

  /** Disposition choices for one class, plus the definition edit and (for custom classes) deletion. */
  async function runClassMenu(ctx: ExtensionContext, resolved: ResolvedRailConfig, id: CapabilityId): Promise<void> {
    const row = dispositionRow(resolved, state, id);
    const items: SelectItem<Disposition | "edit" | "delete">[] = DISPOSITIONS.map((disposition) => ({
      value: disposition,
      label: disposition,
      searchText: `${disposition} ${DISPOSITION_HELP[disposition]}`,
      description: DISPOSITION_HELP[disposition],
      current: disposition === row.value,
    }));
    items.push({
      value: "edit",
      label: "Edit definition…",
      searchText: "edit definition prompt text wording namer",
      description: "Rewrite the prompt text the namer reads for this class",
    });
    if (!row.builtin) {
      items.push({
        value: "delete",
        label: "Delete class",
        searchText: "delete remove custom class",
        description: "Remove this custom class for the session (Save persistently makes it permanent)",
      });
    }
    const choice = await pickFromList<Disposition | "edit" | "delete">(ctx, {
      title: `${id} — currently ${dispositionCell(row)}`,
      items,
    });
    if (!choice) return;
    if (choice.value === "edit") {
      // The select seam has no prefilled-input affordance, so the current text
      // goes in the prompt title instead of the field.
      const definition = await ctx.ui.input(`New definition for ${id}`, row.fullDefinition);
      if (!definition?.trim()) return;
      const error = editClassDefinition(resolved, state, id, definition.trim());
      notify(ctx, error ?? `${id} definition updated for this session.`, error ? "warning" : "info");
      return;
    }
    if (choice.value === "delete") {
      const error = deleteClass(state, id);
      notify(ctx, error ?? `${id} removed for this session.`, error ? "warning" : "info");
      return;
    }
    setRowDisposition(resolved, state, id, choice.value);
    notify(ctx, `${id} → ${choice.value} for this session.`);
  }

  /** `/rail set <class> [disposition]`: scripting/RPC parity with the page. */
  function runSet(args: string, ctx: ExtensionContext): void {
    const resolved = config(ctx);
    const [id = "", disposition = "", ...extra] = args.trim().split(/\s+/).filter((part) => part !== "");
    if (!id || extra.length > 0) {
      notify(ctx, "Usage: /rail set <class> [allow|judge|ask|deny]", "warning");
      return;
    }
    // Registry, not the built-in set: a custom class is settable the moment it exists.
    const known = capabilityRegistry(resolved).map((entry) => entry.id);
    if (!known.includes(id)) {
      notify(ctx, `Unknown capability class: ${id}. Known classes: ${known.join(", ")}`, "warning");
      return;
    }
    const row = dispositionRow(resolved, state, id);
    if (!disposition) {
      const preset = row.presetTightened ? ` (row says ${row.value})` : "";
      notify(ctx, `${id}: ${row.effective.disposition} — ${describeDispositionSource(row.effective)}${preset}`);
      return;
    }
    if (!isDisposition(disposition)) {
      notify(ctx, `Unknown disposition: ${disposition}. Use allow, judge, ask, or deny.`, "warning");
      return;
    }
    setRowDisposition(resolved, state, id, disposition);
    const after = dispositionRow(config(ctx), state, id);
    const preset = after.presetTightened ? ` (${after.effective.source} preset still forces ${after.effective.disposition})` : "";
    notify(ctx, `${id} → ${disposition} for this session${preset}. /rail policy then Ctrl+S persists it.`);
  }

  /** Completions for "set <class> <disposition>"; null when nothing matches. */
  function setCompletions(rest: string): Array<{ value: string; label: string; description: string }> | null {
    const parts = rest.split(/\s+/);
    if (parts.length <= 1) {
      const partial = (parts[0] ?? "").toLowerCase();
      // Completions come from the registry too, so a class added this session is
      // immediately tab-completable.
      const items = capabilityRegistry(state.config)
        .map((entry) => entry.id)
        .filter((id) => id.includes(partial))
        .map((id) => ({
          value: `set ${id}`,
          label: id,
          description: `currently ${dispositionRow(state.config, state, id).effective.disposition}`,
        }));
      return items.length > 0 ? items : null;
    }
    const id = parts[0]!.toLowerCase();
    const partial = (parts[1] ?? "").toLowerCase();
    const items = DISPOSITIONS.filter((disposition) => disposition.startsWith(partial)).map((disposition) => ({
      value: `set ${id} ${disposition}`,
      label: disposition,
      description: DISPOSITION_HELP[disposition],
    }));
    return items.length > 0 ? items : null;
  }

  return { openSettings, runSet, setCompletions };
}
