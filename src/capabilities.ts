/**
 * The capability taxonomy and the disposition table that turns names into
 * outcomes. Twelve classes, deliberately capped: growing the list is how
 * edge-case disease comes back (PERMISSIONS_PLAN, "Architecture B"). Commands
 * are unbounded but intents are few, and `unclassified` is the completeness
 * valve rather than a reason to add a thirteenth class.
 *
 * The `definition` strings are prompt text — the namer receives them verbatim
 * as the entire description of each class, so they are written as decision
 * boundaries ("X, but Y is class Z instead"), not as marketing copy. Edit them
 * as you would edit a prompt.
 */
import type { ResolvedRailConfig } from "./config.ts";

export const BUILTIN_CAPABILITY_IDS = [
  "read-project",
  "read-system",
  "run-dev-tools",
  "modify-project",
  "install-dependencies",
  "off-machine-effects",
  "modify-system",
  "credentials",
  "local-destructive",
  "persistence",
  "network-fetch",
  "unclassified",
] as const;

/** The twelve classes that ship with the rail; deterministic code paths reference these ids as literals. */
export type BuiltinCapabilityId = (typeof BUILTIN_CAPABILITY_IDS)[number];

/**
 * Any class id. Custom classes make the vocabulary open, so this is a plain
 * string: an id reaching the table may be a built-in, a config-defined class, a
 * class this session added, or — briefly — one a session deletion just removed.
 * Use isBuiltinCapabilityId when a code path genuinely needs a built-in.
 */
export type CapabilityId = string;

/**
 * What the user wants to happen to a class. `judge` delegates the decision to
 * a strong model for this one action; it is the user saying "think about this
 * class", parallel to `ask` = "bring me in".
 */
export type Disposition = "allow" | "judge" | "ask" | "deny";

export const DISPOSITIONS: Disposition[] = ["allow", "judge", "ask", "deny"];

/** Severity-max order: a multi-label action takes the strictest disposition among its labels. */
const SEVERITY: Record<Disposition, number> = { allow: 0, judge: 1, ask: 2, deny: 3 };

export interface CapabilityClass {
  id: CapabilityId;
  /** Short human label for panels, traces, and block reasons. */
  name: string;
  /** Prompt text: the namer's entire description of this class. */
  definition: string;
  default: Disposition;
}

export const BUILTIN_CAPABILITY_CLASSES: CapabilityClass[] = [
  {
    id: "read-project",
    name: "Read project",
    definition:
      "Reading, listing, or searching files, directories, and version-control history inside the session working directory. Read-only: the action produces output and changes nothing. Reading a credential file that happens to sit in the project is credentials instead.",
    default: "allow",
  },
  {
    id: "read-system",
    name: "Read system",
    definition:
      "Reading files, listing directories, or querying machine state outside the project — system paths, home-directory configuration, installed packages and toolchain versions, environment variables, processes, OS information. Still read-only. Credential stores and key material are credentials instead.",
    default: "allow",
  },
  {
    id: "run-dev-tools",
    name: "Run dev tools",
    definition:
      "Running this project's own development tooling: tests, builds, linters, formatters, type checks, code generators, and scripts already declared in its manifests or build configuration — including the files those tools write into the project and its build/dependency caches. Publishing, deploying, or anything reaching off this machine is off-machine-effects instead.",
    default: "allow",
  },
  {
    id: "modify-project",
    name: "Modify project",
    definition:
      "Creating, editing, or appending files inside the session working directory, together with the content being written. Ordinary source, test, documentation, and configuration edits. Deleting or overwriting existing work is local-destructive instead; content that grants standing permissions, addresses future reviewers, or installs hooks is persistence instead. Managing git worktrees — add, remove, prune — is this class when the worktree directory is inside the session working directory or a temp directory: the checkout is scratch space the project owns, and an unforced remove cannot discard work because git refuses it while the worktree holds modified or untracked files. A worktree placed anywhere else is modify-system, and a forced remove is local-destructive.",
    default: "allow",
  },
  {
    id: "install-dependencies",
    name: "Install dependencies",
    definition:
      "Installing, upgrading, or removing packages and language toolchains for this project through a package manager (npm/pnpm/yarn, pip/uv/poetry, cargo, go, gem, bundler, maven, gradle, brew, apt, and similar), including the manifest and lockfile changes and the registry downloads that installation implies.",
    default: "allow",
  },
  {
    id: "off-machine-effects",
    name: "Off-machine effects",
    definition:
      "Any effect that leaves this machine: pushing, publishing, or otherwise writing to a remote; filing, commenting on, merging, or closing issues and pull requests; sending mail or chat messages; deploying; calling a remote API that changes state; changing remote infrastructure or cloud accounts. Only a CHANGE to remote state counts: viewing, listing, diffing, or checking the status of an issue or pull request changes nothing and is network-fetch, not this. The MACHINE BOUNDARY decides the rest, not the tool name: kubectl, docker, and similar tools pointed at a LOCAL cluster or daemon (kind, minikube, k3d, docker-desktop, colima, rancher-desktop, a localhost/127.0.0.1 context) stay local and are NOT off-machine-effects; the same commands against a remote or cloud context are. Retrieving remote data without changing it is network-fetch instead.",
    default: "ask",
  },
  {
    id: "modify-system",
    name: "Modify system",
    definition:
      "Writing, moving, or changing files and settings on this machine but outside the project: home-directory files, system directories, package-manager-owned locations, OS or user preferences, local services and daemons — where no more specific class applies. Startup and hook surfaces are persistence instead.",
    default: "ask",
  },
  {
    id: "credentials",
    name: "Credentials",
    definition:
      "Handling secret material: reading, searching, listing, printing, copying, decoding, or passing along private keys, tokens, API keys, passwords, cloud/cluster credential files, keychains and keyrings, browser profiles, .env files, and credential stores — and writing content that contains such material. A plain read of a credential file counts; so does a command that merely embeds one in an argument.",
    default: "judge",
  },
  {
    id: "local-destructive",
    name: "Local destructive",
    definition:
      "Destroying or irreversibly overwriting local state: deleting or truncating existing files and directories, git operations that discard or rewrite work (reset --hard, clean, checkout over changes, rebase, amend, branch -D), dropping local databases, containers, or volumes. Stashing and reapplying work (git stash / stash push / pop / apply) is modify-project rather than this: entries persist in the stash reflog and an apply that would clobber changes fails, while `git stash drop` and `git stash clear` discard those entries and ARE this class. Creating a local git commit is also this class: it is a local state change the user is expected to re-scope per session. Removing or pruning a git worktree under the session working directory is modify-project rather than this, because git refuses an unforced remove that would delete modified or untracked files — a FORCED remove (--force/-f) overrides exactly that refusal and is this class.",
    default: "judge",
  },
  {
    id: "persistence",
    name: "Persistence",
    definition:
      "Establishing something that keeps acting after this action ends: shell profiles and rc files, cron/launchd/systemd/scheduled tasks, git hooks, package lifecycle scripts (preinstall, postinstall, prepare, and friends), SSH authorized keys, login and startup items, editor or agent configuration loaded on startup — and file content that asserts standing approvals, records consent that was never given, or instructs future automated reviewers, whatever kind of file it lives in.",
    default: "judge",
  },
  {
    id: "network-fetch",
    name: "Network fetch",
    definition:
      "Reaching the network to retrieve something without changing remote state: HTTP GETs, curl/wget downloads, cloning or fetching a repository, pulling a container image, querying a read-only API. If the retrieved content is then written to disk or executed, name that consequence too.",
    default: "judge",
  },
  {
    id: "unclassified",
    name: "Unclassified",
    definition:
      "The action does not fit any class above. This is the completeness valve for genuinely unanticipated intents — not a hedge when two named classes both partly apply (name both of those instead).",
    default: "judge",
  },
];

const BUILTIN_BY_ID = new Map<CapabilityId, CapabilityClass>(BUILTIN_CAPABILITY_CLASSES.map((entry) => [entry.id, entry]));

/**
 * Built-in membership. This is the check for code that must reason about the
 * twelve shipped classes specifically — config validation refusing to let a
 * custom class shadow one, and the "built-ins cannot be deleted" rule. Naming
 * and table lookups go through the registry instead, since those must see
 * custom classes too.
 */
export function isBuiltinCapabilityId(value: unknown): value is BuiltinCapabilityId {
  return typeof value === "string" && BUILTIN_BY_ID.has(value);
}

/** Custom class ids are kebab-case and cannot collide with a built-in; the namer sees them verbatim. */
export const CUSTOM_CLASS_ID_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;

export function isDisposition(value: unknown): value is Disposition {
  return value === "allow" || value === "judge" || value === "ask" || value === "deny";
}

/** Human label for a class: the registry's name when it is known, else the raw id (labels outlive deleted classes). */
export function capabilityName(id: CapabilityId, registry?: CapabilityClass[]): string {
  const found = registry?.find((entry) => entry.id === id);
  return found?.name ?? BUILTIN_BY_ID.get(id)?.name ?? id;
}

/** The strictest of the given dispositions (deny > ask > judge > allow); allow when the list is empty. */
export function strictestDisposition(dispositions: Disposition[]): Disposition {
  let winner: Disposition = "allow";
  for (const disposition of dispositions) {
    if (SEVERITY[disposition] > SEVERITY[winner]) winner = disposition;
  }
  return winner;
}

export function isStricter(a: Disposition, b: Disposition): boolean {
  return SEVERITY[a] > SEVERITY[b];
}

/** Exhaustive over the built-ins: adding a class to the tuple without a default is a type error. */
export const DEFAULT_DISPOSITIONS: Record<BuiltinCapabilityId, Disposition> = Object.fromEntries(
  BUILTIN_CAPABILITY_CLASSES.map((entry) => [entry.id, entry.default]),
) as Record<BuiltinCapabilityId, Disposition>;

// ── Session scope and per-class stats ────────────────────────────────────────

export type CapabilityOutcome =
  | "allow"
  | "ask-approved"
  | "ask-denied"
  /** The user stopped the turn at the ask instead of answering it — not a refusal of this class. */
  | "ask-stopped"
  | "deny"
  | "judge-allow"
  | "judge-ask"
  | "judge-deny";

export const CAPABILITY_OUTCOMES: CapabilityOutcome[] = [
  "allow",
  "ask-approved",
  "ask-denied",
  "ask-stopped",
  "deny",
  "judge-allow",
  "judge-ask",
  "judge-deny",
];

export interface CapabilityStats {
  /** Times this class appeared among an action's labels. */
  hits: number;
  /**
   * Times this class was the label that actually produced the winning
   * disposition. Outcomes are recorded on every label of a multi-label action,
   * so an allow-set class shows ask outcomes it did not cause; `decided` is the
   * column that says which class was in charge.
   */
  decided: number;
  outcomes: Record<CapabilityOutcome, number>;
  /** Content-screen verdicts on actions that carried this label. */
  screenTripped: number;
  screenClean: number;
}

/**
 * Session-scoped capability state. Lives in RuntimeState and is reset per
 * session: overrides are "for this session" by construction, which is how
 * local-destructive and friends are meant to be re-scoped.
 */
export interface CapabilityState {
  overrides: Partial<Record<CapabilityId, Disposition>>;
  /**
   * Session preset flipping a set of classes to deny; read-only mode sets
   * this. A preset can only tighten — it is severity-maxed against whatever
   * the config and session overrides resolved to.
   */
  preset?: { name: string; deny: BuiltinCapabilityId[] };
  stats: Partial<Record<CapabilityId, CapabilityStats>>;
  /**
   * Classes added this session. Like disposition overrides these are live
   * immediately — the namer sees them on the next call — and stay session-local
   * until Ctrl+S writes them to the global config.
   */
  customClasses: CapabilityClass[];
  /** Session edits to any class's definition (built-in or custom), keyed by id. */
  definitionEdits: Record<string, string>;
  /** Persisted custom classes this session removed; they drop out of the registry until saved or the session ends. */
  deletedCustom: string[];
}

export function createCapabilityState(): CapabilityState {
  return { overrides: {}, stats: {}, customClasses: [], definitionEdits: {}, deletedCustom: [] };
}

export function createCapabilityStats(): CapabilityStats {
  return {
    hits: 0,
    decided: 0,
    outcomes: { allow: 0, "ask-approved": 0, "ask-denied": 0, "ask-stopped": 0, deny: 0, "judge-allow": 0, "judge-ask": 0, "judge-deny": 0 },
    screenTripped: 0,
    screenClean: 0,
  };
}

/**
 * Classes read-only mode denies. Writes and edits are already blocked
 * deterministically; this covers bash. Built-in ids by construction: the preset
 * is a fixed guarantee about read-only mode, so it cannot depend on classes a
 * user may rename or delete.
 */
export const READ_ONLY_PRESET_DENY: BuiltinCapabilityId[] = [
  "modify-project",
  "modify-system",
  "local-destructive",
  "off-machine-effects",
  "persistence",
];

export function applyReadOnlyPreset(state: CapabilityState): void {
  state.preset = { name: "read-only", deny: READ_ONLY_PRESET_DENY };
}

export function clearPreset(state: CapabilityState): void {
  state.preset = undefined;
}

export function setSessionDisposition(state: CapabilityState, id: CapabilityId, disposition: Disposition): void {
  state.overrides[id] = disposition;
}

export function clearSessionDisposition(state: CapabilityState, id: CapabilityId): void {
  delete state.overrides[id];
}

// ── The class registry ───────────────────────────────────────────────────────

/**
 * Every class the rail currently knows, in a deterministic order: the twelve
 * built-ins in tuple order, then config-defined custom classes, then classes
 * this session added. Definition edits layer session-over-config-over-built-in;
 * custom classes this session deleted are dropped.
 *
 * Order is load-bearing beyond tidiness: this array is what
 * capabilityDefinitionsForPrompt serializes into the reviewers' system prompts,
 * which Anthropic's system-prompt cache breakpoint covers. Same registry ⇒
 * byte-identical system prompt. Editing the taxonomy therefore invalidates the
 * provider's prompt cache once, which is the accepted cost of an editable
 * vocabulary.
 */
export function capabilityRegistry(
  config: { capabilities?: { classes: CapabilityClass[]; definitions: Record<string, string> } } | undefined,
  state: CapabilityState | undefined,
): CapabilityClass[] {
  const configDefinitions = config?.capabilities?.definitions ?? {};
  const sessionDefinitions = state?.definitionEdits ?? {};
  const withDefinition = (entry: CapabilityClass): CapabilityClass => {
    const definition = sessionDefinitions[entry.id] ?? configDefinitions[entry.id] ?? entry.definition;
    return definition === entry.definition ? entry : { ...entry, definition };
  };

  const deleted = new Set(state?.deletedCustom ?? []);
  const registry = BUILTIN_CAPABILITY_CLASSES.map(withDefinition);
  const seen = new Set(registry.map((entry) => entry.id));
  for (const entry of config?.capabilities?.classes ?? []) {
    if (deleted.has(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    registry.push(withDefinition(entry));
  }
  for (const entry of state?.customClasses ?? []) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    registry.push(withDefinition(entry));
  }
  return registry;
}

/** The id set the namer's labels are validated against. */
export function capabilityRegistryIds(registry: CapabilityClass[]): Set<string> {
  return new Set(registry.map((entry) => entry.id));
}

export type DispositionScope = "default" | "config" | "session" | "preset";

export interface EffectiveDisposition {
  id: CapabilityId;
  disposition: Disposition;
  scope: DispositionScope;
  /** For scope "config": the config file path that set it (see configSourceLabel). For "preset": the preset name. */
  source?: string;
}

/**
 * Effective disposition for one class: session override beats persisted
 * config (global then project, already merged) beats the class default; an
 * active preset then applies severity-max on top, so a session preset can
 * tighten but never loosen what the user configured.
 */
/**
 * The class default for an id, mirroring capabilityRegistry's precedence
 * (built-in, then config class, then session-added class). `known: false` means
 * the id is in no layer at all — a label naming a class that was just deleted.
 */
function classDefault(
  config: ResolvedRailConfig | undefined,
  state: CapabilityState | undefined,
  id: CapabilityId,
): { disposition: Disposition; known: boolean } {
  if (isBuiltinCapabilityId(id)) return { disposition: DEFAULT_DISPOSITIONS[id], known: true };
  if (!state?.deletedCustom.includes(id)) {
    const fromConfig = config?.capabilities.classes.find((entry) => entry.id === id);
    if (fromConfig) return { disposition: fromConfig.default, known: true };
  }
  const fromSession = state?.customClasses.find((entry) => entry.id === id);
  if (fromSession) return { disposition: fromSession.default, known: true };
  return { disposition: "ask", known: false };
}

export function getEffectiveDisposition(
  config: ResolvedRailConfig | undefined,
  state: CapabilityState | undefined,
  id: CapabilityId,
): EffectiveDisposition {
  const base = classDefault(config, state, id);
  // A label can outlive its class: deleting a custom class mid-session leaves
  // in-flight labels pointing at nothing. Resolve those to ask rather than
  // inheriting a stale override — the safe direction is to bring the user in.
  if (!base.known) return { id, disposition: "ask", scope: "default" };
  let resolved: EffectiveDisposition = { id, disposition: base.disposition, scope: "default" };
  const source = config?.provenance.dispositions[id];
  const configured = config?.dispositions[id];
  if (configured && source && source !== "default") {
    resolved = { id, disposition: configured, scope: "config", source };
  }
  const override = state?.overrides[id];
  if (override) resolved = { id, disposition: override, scope: "session" };
  const preset = state?.preset;
  if (preset && isBuiltinCapabilityId(id) && preset.deny.includes(id) && isStricter("deny", resolved.disposition)) {
    resolved = { id, disposition: "deny", scope: "preset", source: preset.name };
  }
  return resolved;
}

export interface CapabilityResolution {
  labels: CapabilityId[];
  /** Per-label effective dispositions, in label order. */
  effective: EffectiveDisposition[];
  /** Severity-max across the labels. */
  disposition: Disposition;
  /** The label that produced the winning disposition (first one at max severity). */
  decidedBy: EffectiveDisposition;
}

/** Severity-max resolution across an action's labels. An empty label set resolves as `unclassified`. */
export function resolveCapabilities(
  config: ResolvedRailConfig | undefined,
  state: CapabilityState | undefined,
  labels: CapabilityId[],
): CapabilityResolution {
  const ids = labels.length > 0 ? labels : (["unclassified"] as CapabilityId[]);
  const effective = ids.map((id) => getEffectiveDisposition(config, state, id));
  const disposition = strictestDisposition(effective.map((entry) => entry.disposition));
  const decidedBy = effective.find((entry) => entry.disposition === disposition) ?? effective[0]!;
  return { labels: ids, effective, disposition, decidedBy };
}

// ── Stats accessors ──────────────────────────────────────────────────────────

export function capabilityStats(state: CapabilityState, id: CapabilityId): CapabilityStats {
  const existing = state.stats[id];
  if (existing) return existing;
  const created = createCapabilityStats();
  state.stats[id] = created;
  return created;
}

/**
 * Read-only view for panels: only classes seen this session, in registry order.
 * Stats-bearing ids the registry no longer lists (a class deleted after it was
 * already named) trail at the end rather than vanishing — the hits happened.
 */
export function usedCapabilityStats(state: CapabilityState, registry: CapabilityClass[]): Array<{ id: CapabilityId; stats: CapabilityStats }> {
  const ordered = registry.filter((entry) => state.stats[entry.id]).map((entry) => ({ id: entry.id, stats: state.stats[entry.id]! }));
  const listed = new Set(ordered.map((entry) => entry.id));
  const orphaned = Object.keys(state.stats)
    .filter((id) => !listed.has(id) && state.stats[id])
    .map((id) => ({ id, stats: state.stats[id]! }));
  return [...ordered, ...orphaned];
}

// ── Session class edits ──────────────────────────────────────────────────────

/** Adds a class at session scope. The namer sees it on the very next call; Ctrl+S makes it persistent. */
export function addSessionClass(state: CapabilityState, entry: CapabilityClass): void {
  state.deletedCustom = state.deletedCustom.filter((id) => id !== entry.id);
  state.customClasses = [...state.customClasses.filter((existing) => existing.id !== entry.id), entry];
}

/** Edits any class's definition at session scope. Editing back to the original text drops the edit. */
export function setSessionDefinition(state: CapabilityState, id: CapabilityId, definition: string): void {
  const session = state.customClasses.find((entry) => entry.id === id);
  if (session) {
    session.definition = definition;
    return;
  }
  state.definitionEdits = { ...state.definitionEdits, [id]: definition };
}

/**
 * Removes a custom class at session scope. A class this session added is simply
 * forgotten; a persisted one is recorded as deleted so Ctrl+S can remove it
 * from the config too.
 */
export function deleteSessionClass(state: CapabilityState, id: CapabilityId): void {
  const wasSessionAdded = state.customClasses.some((entry) => entry.id === id);
  state.customClasses = state.customClasses.filter((entry) => entry.id !== id);
  const { [id]: _dropped, ...rest } = state.definitionEdits;
  state.definitionEdits = rest;
  if (!wasSessionAdded && !state.deletedCustom.includes(id)) state.deletedCustom = [...state.deletedCustom, id];
}

export function recordCapabilityHits(state: CapabilityState, labels: CapabilityId[]): void {
  for (const id of labels) capabilityStats(state, id).hits++;
}

/** The one label of an action that resolveCapabilities named as decidedBy; never more than one per decision. */
export function recordCapabilityDecided(state: CapabilityState, id: CapabilityId): void {
  capabilityStats(state, id).decided++;
}

export function recordCapabilityOutcome(state: CapabilityState, labels: CapabilityId[], outcome: CapabilityOutcome): void {
  for (const id of labels) capabilityStats(state, id).outcomes[outcome]++;
}

export function recordScreenVerdict(state: CapabilityState, labels: CapabilityId[], tripped: boolean): void {
  for (const id of labels) {
    const stats = capabilityStats(state, id);
    if (tripped) stats.screenTripped++;
    else stats.screenClean++;
  }
}

/**
 * The taxonomy block sent to the namer and the judge, inside their system
 * prompts so provider caches cover it. Fixed for a given registry; editing the
 * taxonomy is the one thing that moves it (see capabilityRegistry on the
 * accepted cache cost).
 */
export function capabilityDefinitionsForPrompt(registry: CapabilityClass[]): Array<{ id: CapabilityId; definition: string }> {
  return registry.map((entry) => ({ id: entry.id, definition: entry.definition }));
}
