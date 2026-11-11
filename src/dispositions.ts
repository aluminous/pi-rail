/**
 * The view model behind the disposition settings page: one row per capability
 * class, resolved against the folded policy (config files plus the session
 * layer of src/policy-store.ts) and any session preset. The TUI page and the
 * RPC select degradation both read it, so the two surfaces describe the same
 * table in the same words.
 */
import {
  CUSTOM_CLASS_ID_PATTERN,
  DISPOSITIONS,
  capabilityRegistry,
  getEffectiveDisposition,
  isBuiltinCapabilityId,
  type BuiltinCapabilityId,
  type CapabilityClass,
  type CapabilityId,
  type CapabilityStats,
  type Disposition,
  type EffectiveDisposition,
} from "./capabilities.ts";
import { globalRailConfigPath, type ResolvedRailConfig } from "./config.ts";
import {
  appendPersistentBaseOps,
  updatePersistentCapabilityClass,
  updatePersistentCapabilityDefinition,
  updatePersistentDisposition,
  type PersistedCapabilityClass,
} from "./persistent-settings.ts";
import {
  applyOpsInPlace,
  baseConfigOf,
  invalidateSessionCache,
  provenanceLabel,
  withSessionLayer,
  withoutSessionEdits,
  type PolicyOp,
} from "./policy-store.ts";
import {
  addSessionClass,
  clearSessionDisposition,
  clearSessionPolicyEdits,
  deleteSessionClass,
  sessionAddedClasses,
  sessionDispositionEdit,
  sessionEditedDefinitions,
  setSessionDefinition,
  setSessionDisposition,
} from "./session-policy.ts";
import { syncCapabilityPreset, type RuntimeState } from "./state.ts";

/** One-line help per disposition, for select labels and completions. */
export const DISPOSITION_HELP: Record<Disposition, string> = {
  allow: "run without review",
  judge: "let the strong model decide, one action at a time",
  ask: "bring me in before it runs",
  deny: "refuse outright",
};

/**
 * First sentence of a class definition, capped. The definitions are prompt
 * text written for the namer; the page footer wants a line, not a prompt dump.
 */
function shortDefinition(definition: string): string {
  const sentence = definition.match(/^.*?\.(?=\s|$)/)?.[0] ?? definition;
  return sentence.length > 150 ? `${sentence.slice(0, 149).trimEnd()}…` : sentence;
}

export interface DispositionRow {
  id: CapabilityId;
  name: string;
  /** Short form of the class definition, for the page footer and select descriptions. */
  definition: string;
  /** The row the user edits: the folded table value, session layer included, before any preset. */
  value: Disposition;
  /** What the row would be with this session's edit undone: config files and named session grants. */
  persisted: Disposition;
  /** A session edit moved this row off its persisted value — the page highlights these, and Ctrl+S writes them. */
  modified: boolean;
  /** What actually decides, including a session preset tightening the row. */
  effective: EffectiveDisposition;
  /** The preset tightened this row past `value`, so the effective value is stricter than the row. */
  presetTightened: boolean;
  stats: CapabilityStats | undefined;
  /** "3 hits · 1 allowed · 1 asked · 1 denied"; empty when the class was never named. */
  statsLabel: string;
  /** Built-ins can be edited but never deleted; the page uses this for the `d` refusal. */
  builtin: boolean;
  /** This session added the class — it is not in any config file yet. */
  sessionNew: boolean;
  /** This session changed the class definition. */
  sessionEdited: boolean;
  /** The full definition text, for the edit form (`definition` is the shortened footer form). */
  fullDefinition: string;
  /** Custom classes: the built-in this one extends, which is how presets reach it. */
  extends?: BuiltinCapabilityId;
}

/** Buckets that partition the seven outcomes: auto-allowed, brought to the user, auto-denied. */
function statsLabel(stats: CapabilityStats | undefined): string {
  if (!stats || stats.hits === 0) return "";
  const outcomes = stats.outcomes;
  const parts = [`${stats.hits} hit${stats.hits === 1 ? "" : "s"}`];
  const allowed = outcomes.allow + outcomes["judge-allow"];
  const asked = outcomes["ask-approved"] + outcomes["ask-denied"] + outcomes["judge-ask"];
  const denied = outcomes.deny + outcomes["judge-deny"];
  if (allowed > 0) parts.push(`${allowed} allowed`);
  if (asked > 0) parts.push(`${asked} asked`);
  if (denied > 0) parts.push(`${denied} denied`);
  return parts.join(" · ");
}

/**
 * Every class in registry order. Recomputed on each refresh, so live stats, class edits, and preset changes land without extra plumbing.
 * `config` may be the base or the effective config; the session layer comes from `state` either way.
 */
export function dispositionRows(config: ResolvedRailConfig | undefined, state: RuntimeState): DispositionRow[] {
  // The preset is derived from state.readOnly; sync here so a read-only toggle
  // while the page is open shows up on the next refresh.
  syncCapabilityPreset(state);
  const effective = config ? withSessionLayer(config, state.sessionPolicy) : undefined;
  const inherited = config ? withoutSessionEdits(config, state.sessionPolicy) : undefined;
  const sessionAdded = new Set(sessionAddedClasses(state).map((entry) => entry.id));
  const definitionEdits = sessionEditedDefinitions(state);
  return capabilityRegistry(effective).map((entry) => {
    const persisted = getEffectiveDisposition(inherited, undefined, entry.id).disposition;
    const value = getEffectiveDisposition(effective, undefined, entry.id).disposition;
    const edit = sessionDispositionEdit(state, entry.id);
    const resolved = getEffectiveDisposition(effective, state.capabilities, entry.id);
    const stats = state.capabilities.stats[entry.id];
    return {
      id: entry.id,
      name: entry.name,
      definition: shortDefinition(entry.definition),
      value,
      persisted,
      modified: edit !== undefined && edit !== persisted,
      effective: resolved,
      presetTightened: resolved.scope === "preset",
      stats,
      statsLabel: statsLabel(stats),
      builtin: isBuiltinCapabilityId(entry.id),
      sessionNew: sessionAdded.has(entry.id),
      // A session-added class carries its edits inside its own add-class op,
      // so only a set-definition edit counts as editing something that already existed.
      sessionEdited: definitionEdits.has(entry.id),
      fullDefinition: entry.definition,
      ...(entry.extends ? { extends: entry.extends } : {}),
    };
  });
}

export function dispositionRow(config: ResolvedRailConfig | undefined, state: RuntimeState, id: CapabilityId): DispositionRow {
  return dispositionRows(config, state).find((row) => row.id === id)!;
}

/** Next disposition in allow → judge → ask → deny order; step -1 walks back. */
export function cycleDisposition(current: Disposition, step: 1 | -1): Disposition {
  const index = DISPOSITIONS.indexOf(current);
  const next = (index + step + DISPOSITIONS.length) % DISPOSITIONS.length;
  return DISPOSITIONS[next]!;
}

/**
 * Applies a row edit at session scope (an op in session-edits). Landing back
 * on the persisted value drops the edit instead of recording a no-op one, so
 * Ctrl+S only ever writes rows the user actually changed.
 */
export function setRowDisposition(config: ResolvedRailConfig | undefined, state: RuntimeState, id: CapabilityId, disposition: Disposition): void {
  const inherited = config ? withoutSessionEdits(config, state.sessionPolicy) : undefined;
  const persisted = getEffectiveDisposition(inherited, undefined, id).disposition;
  if (disposition === persisted) clearSessionDisposition(state, id);
  else setSessionDisposition(state, id, disposition);
}

export interface SaveResult {
  saved: CapabilityId[];
  /** Rows a project config owns: the global write lands, but that config wins again next session. */
  shadowed: CapabilityId[];
  /** Custom classes this save created in the global config. */
  added: CapabilityId[];
  /** Classes whose definition this save rewrote (built-in overrides and custom-class edits alike). */
  edited: CapabilityId[];
  /** Custom classes this save removed from the global config. */
  removed: CapabilityId[];
}

/** The persist boundary Ctrl+S writes through; injectable so tests never touch the real config file. */
export interface DispositionPersistence {
  disposition(id: CapabilityId, disposition: Disposition | undefined): void;
  capabilityClass(id: string, entry: PersistedCapabilityClass | undefined): void;
  capabilityDefinition(id: string, definition: string | undefined): void;
  /** Every other op kind (classify rules, command allowances, list edits), written into base keys. */
  baseOps(ops: PolicyOp[]): void;
}

export const DEFAULT_DISPOSITION_PERSISTENCE: DispositionPersistence = {
  disposition: updatePersistentDisposition,
  capabilityClass: updatePersistentCapabilityClass,
  capabilityDefinition: updatePersistentCapabilityDefinition,
  baseOps: (ops) => appendPersistentBaseOps(ops),
};

/**
 * Ctrl+S: promotes the session-edits grant into the global config's base keys
 * — disposition rows, added classes, definition edits, removed classes, and
 * anything else it holds — then folds the same ops into the in-memory base
 * under global provenance and empties session-edits. Everything is persisted
 * now, so the modified/new/edited markers go away and no effective value
 * moves. Named session grants are untouched: they promote as grants, not as
 * base keys. The base is edited in place because the policy page and the
 * select flow hold it across the save.
 */
export function saveDispositions(
  config: ResolvedRailConfig | undefined,
  state: RuntimeState,
  persist: Partial<DispositionPersistence> = DEFAULT_DISPOSITION_PERSISTENCE,
): SaveResult {
  const writer: DispositionPersistence = { ...DEFAULT_DISPOSITION_PERSISTENCE, ...persist };
  const result: SaveResult = { saved: [], shadowed: [], added: [], edited: [], removed: [] };
  const edits = [...state.sessionPolicy.edits];
  if (edits.length === 0) return result;
  const globalPath = globalRailConfigPath();
  const base = config ? baseConfigOf(config) : undefined;

  // Classes first: a disposition row for a class added in the same session has
  // to land in a config that already declares the class.
  for (const op of edits) {
    if (op.op !== "add-class") continue;
    writer.capabilityClass(op.id, {
      id: op.id,
      ...(op.name ? { name: op.name } : {}),
      definition: op.definition,
      disposition: op.disposition ?? "ask",
      ...(op.extends ? { extends: op.extends } : {}),
    });
    result.added.push(op.id);
  }
  for (const op of edits) {
    if (op.op !== "set-definition") continue;
    if (isBuiltinCapabilityId(op.capability)) {
      writer.capabilityDefinition(op.capability, op.definition);
    } else {
      // A persisted custom class stores its definition inline, so editing it is
      // a rewrite of the class entry rather than a definitions-map override.
      const existing = base?.capabilities.classes.find((entry) => entry.id === op.capability);
      if (existing) writer.capabilityClass(op.capability, toPersistedClass({ ...existing, definition: op.definition }));
    }
    result.edited.push(op.capability);
  }
  for (const op of edits) {
    if (op.op !== "remove-class") continue;
    writer.capabilityClass(op.id, undefined);
    result.removed.push(op.id);
  }
  for (const op of edits) {
    if (op.op !== "set-disposition") continue;
    writer.disposition(op.capability, op.disposition);
    result.saved.push(op.capability);
    if (base?.provenance.dispositions[op.capability]?.layer === "project") result.shadowed.push(op.capability);
  }
  const rest = edits.filter((op) => !["add-class", "set-definition", "remove-class", "set-disposition"].includes(op.op));
  if (rest.length > 0) writer.baseOps(rest);

  if (base) {
    applyOpsInPlace(base, edits, { layer: "global", file: globalPath }, `${globalPath} (saved session edits)`);
    invalidateSessionCache(base);
  }
  clearSessionPolicyEdits(state);
  return result;
}

function toPersistedClass(entry: CapabilityClass): PersistedCapabilityClass {
  return {
    id: entry.id,
    ...(entry.name && entry.name !== entry.id ? { name: entry.name } : {}),
    definition: entry.definition,
    disposition: entry.default,
    ...(entry.extends ? { extends: entry.extends } : {}),
  };
}

/** True when Ctrl+S has anything to write. */
export function hasUnsavedChanges(state: RuntimeState): boolean {
  return state.sessionPolicy.edits.length > 0;
}

// ── Class editing (session scope until Ctrl+S) ───────────────────────────────

/** New classes default to ask — see PERMISSIONS_PLAN: a newly named intent is exactly what the user wants to be asked about. */
export const NEW_CLASS_DISPOSITION: Disposition = "ask";

/**
 * Validates and adds a class at session scope. Returns an error message when
 * the id is malformed or taken; the caller keeps the user in the form so the
 * typed definition is not lost.
 */
export function addClass(
  config: ResolvedRailConfig | undefined,
  state: RuntimeState,
  input: { id: string; definition: string; name?: string },
): string | undefined {
  const id = input.id.trim().toLowerCase();
  const definition = input.definition.trim();
  if (!id) return "A class id is required.";
  if (isBuiltinCapabilityId(id)) return `${id} is a built-in class. Edit its definition instead of redefining it.`;
  if (!CUSTOM_CLASS_ID_PATTERN.test(id)) return "Ids are kebab-case: a letter, then letters, digits, or hyphens (2-41 characters).";
  if (capabilityRegistry(effectiveOf(config, state)).some((entry) => entry.id === id)) return `${id} already exists.`;
  if (!definition) return "A definition is required — it is the prompt text the namer reads.";
  addSessionClass(state, {
    id,
    name: input.name?.trim() || id,
    definition,
    default: NEW_CLASS_DISPOSITION,
  });
  return undefined;
}

/** Edits a class definition at session scope. Any class may be edited, including built-ins. */
export function editClassDefinition(
  config: ResolvedRailConfig | undefined,
  state: RuntimeState,
  id: CapabilityId,
  definition: string,
): string | undefined {
  const trimmed = definition.trim();
  if (!trimmed) return "A definition is required — it is the prompt text the namer reads.";
  if (!capabilityRegistry(effectiveOf(config, state)).some((entry) => entry.id === id)) return `Unknown capability class: ${id}.`;
  setSessionDefinition(state, id, trimmed);
  return undefined;
}

/**
 * Deletes a custom class at session scope. Built-ins are editable but not
 * deletable: deterministic mappers and the read-only preset name them as
 * literals, so removing one would leave those paths pointing at nothing.
 */
export function deleteClass(state: RuntimeState, id: CapabilityId): string | undefined {
  if (isBuiltinCapabilityId(id)) return `${id} is built-in and cannot be deleted — set it to deny, or edit its definition.`;
  // The edit helper drops the class's row and definition edits with it.
  deleteSessionClass(state, id);
  return undefined;
}

/** The effective config for (config, state), whichever of base or effective the caller holds. */
function effectiveOf(config: ResolvedRailConfig | undefined, state: RuntimeState): ResolvedRailConfig | undefined {
  return config ? withSessionLayer(config, state.sessionPolicy) : undefined;
}

/**
 * "built-in default", "global config", "project config (grant x)", "this
 * session", "session grant x", "read-only preset".
 */
export function describeDispositionSource(effective: EffectiveDisposition): string {
  if (effective.scope === "default") return "built-in default";
  if (effective.scope === "preset") return `${effective.source} preset`;
  const provenance = effective.provenance;
  const label = provenanceLabel(provenance);
  if (effective.scope === "session") return label === "session" ? "this session" : `session grant ${provenance?.grantId}`;
  return provenance?.grantId ? `${provenance.layer} config (grant ${provenance.grantId})` : `${label} config`;
}

/** Banner for an active session preset; undefined when none is active. */
export function presetBanner(state: RuntimeState): string | undefined {
  const preset = state.capabilities.preset;
  if (!preset) return undefined;
  return `${preset.name} preset active: modify/destructive rows tightened to deny (marked *)`;
}

/** "allow", or "allow → deny*" when the preset tightens the row past what it says. */
export function dispositionCell(row: DispositionRow): string {
  return row.presetTightened ? `${row.value} → ${row.effective.disposition}*` : row.value;
}

/** Stats-bearing one-liner for select labels: "off-machine-effects  ask  3 hits · 1 denied". */
export function dispositionSummary(row: DispositionRow): string {
  const parts = [row.id, dispositionCell(row)];
  if (row.modified) parts.push("(modified)");
  if (row.statsLabel) parts.push(row.statsLabel);
  return parts.join("  ");
}
