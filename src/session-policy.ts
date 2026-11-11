// The session layer of the policy store, on RuntimeState: the edit API the
// policy page and /rail set call, named session grants, and the persistence
// that lets the layer survive resume.
//
// Persistence is deliberately NOT session replay (src/session-replay.ts).
// Replay derives the rail's memory from the current BRANCH, because memory —
// what the judge saw, what the user denied — belongs to a timeline and must
// rewind with /tree. The session layer is a setting the user chose (GRANTS_PLAN
// decision 2026-11-11): navigating the tree must not silently undo a grant, and
// navigating back must not resurrect one the user revoked. So every change
// writes a full snapshot as its own record kind, and restore reads the LAST
// snapshot in the whole session file — getEntries(), file order — whichever
// branch it was written on. A snapshot (not a delta log) means one bad or
// missing record costs at most that change, and restore is a single read.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CapabilityClass, CapabilityId, Disposition } from "./capabilities.ts";
import { addGrantToConfigFile, removeGrantFromConfigFile } from "./persistent-settings.ts";
import {
  addSessionGrant as addGrantToLayer,
  applyLayer,
  applyOpsInPlace,
  baseConfigOf,
  clearSessionEdits,
  createSessionLayer,
  editSessionAddClass,
  editSessionDefinition,
  editSessionDeleteClass,
  editSessionDisposition,
  invalidateSessionCache,
  parseGrant,
  parseOp,
  removeSessionGrant as removeGrantFromLayer,
  serializeGrant,
  sessionPolicyLayer,
  type FileLayerName,
  type Grant,
  type GrantLayerName,
  type PolicyOp,
  type SessionLayer,
} from "./policy-store.ts";
import { SandboxStaleError, type RailBackend } from "./backends/types.ts";
import type { ResolvedRailConfig } from "./config.ts";
import type { RuntimeState } from "./state.ts";
import { formatError } from "./util.ts";

/** The custom entry type session snapshots are written under. */
export const RAIL_SESSION_POLICY_TYPE = "rail-session-policy";

export interface SessionPolicySnapshot {
  version: 1;
  grants: Array<Record<string, unknown>>;
  edits: PolicyOp[];
}

export function sessionPolicySnapshot(session: SessionLayer): SessionPolicySnapshot {
  return { version: 1, grants: session.grants.map(serializeGrant), edits: session.edits.map((op) => ({ ...op })) };
}

/**
 * Writes the whole session layer as one session entry. Skipped for ephemeral
 * sessions (nothing would ever read it back) and wherever appendEntry is not
 * wired (tests).
 */
export function persistSessionPolicy(state: RuntimeState): void {
  if (!state.sessionPolicyPersistent || !state.appendEntry) return;
  state.appendEntry(RAIL_SESSION_POLICY_TYPE, sessionPolicySnapshot(state.sessionPolicy));
}

/**
 * Parses a snapshot back into a session layer, validating every grant and op
 * exactly as a config file's would be: a snapshot is data from disk, and an op
 * from a future phase must be refused here too rather than half-applied.
 */
export function parseSessionPolicySnapshot(data: unknown, diagnostics: string[]): SessionLayer | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const raw = data as Record<string, unknown>;
  if (raw.version !== 1) return undefined;
  const layer = createSessionLayer();
  if (Array.isArray(raw.grants)) {
    raw.grants.forEach((entry, index) => {
      const grant = parseGrant(entry, `session grants[${index}]`, diagnostics);
      if (grant && !layer.grants.some((existing) => existing.id === grant.id)) layer.grants.push(grant);
    });
  }
  if (Array.isArray(raw.edits)) {
    raw.edits.forEach((entry, index) => {
      const op = parseOp(entry, `session edits[${index}]`, diagnostics);
      if (op) layer.edits.push(op);
    });
  }
  return layer;
}

/**
 * Restores the session layer from the last snapshot in `entries` — pass
 * sessionManager.getEntries(), the whole file, never getBranch(). A session
 * with no snapshot (a new session) keeps the empty layer resetSessionState
 * installed. Returns the diagnostics of anything the snapshot held that no
 * longer validates.
 *
 * No approval is asked: every grant in a snapshot was approved (sensitive
 * ops one by one) when it entered the session layer, and filesystem /
 * network / environment ops in it take effect like any other. index.ts calls
 * this at session start, before the backend initializes, so the sandbox is
 * compiled from the restored layer rather than re-pointed at it.
 */
export function restoreSessionPolicy(state: RuntimeState, entries: readonly SessionEntry[]): string[] {
  const diagnostics: string[] = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type !== "custom" || entry.customType !== RAIL_SESSION_POLICY_TYPE) continue;
    const layer = parseSessionPolicySnapshot(entry.data, diagnostics);
    if (!layer) continue;
    state.sessionPolicy = layer;
    return diagnostics;
  }
  return diagnostics;
}

/**
 * What folding the session layer over the base reported — e.g. a restored
 * grant naming a class that no longer exists. index.ts surfaces these once at
 * session start next to the config files' own diagnostics, so a resumed grant
 * that no longer fully applies is announced rather than found later in the
 * engine tab.
 */
export function sessionPolicyDiagnostics(state: RuntimeState): string[] {
  const base = state.baseConfig;
  const effective = state.config;
  if (!base || !effective || effective === base) return [];
  return effective.diagnostics.slice(base.diagnostics.length);
}

// ── Keeping the sandbox and the file tools on one policy ─────────────────────

/**
 * What the backend compiles from a config: the sandbox-backed lists, the
 * switches and overrides it fixes at start, and which denyRead entries a
 * layer claimed (Seatbelt's keychain read-back depends on it). Two configs
 * with the same key get the same profile.
 */
export function sandboxInputsKey(config: ResolvedRailConfig): string {
  const sources = config.provenance.lists["filesystem.denyRead"];
  return JSON.stringify({
    filesystem: config.filesystem,
    network: config.network,
    environment: config.environment,
    seatbelt: config.seatbelt,
    claimedDenyRead: config.filesystem.denyRead.filter((entry) => (sources[entry]?.layer ?? "default") !== "default"),
  });
}

/** Per backend instance, the sandbox inputs it was last given (initialize or applyPolicy). */
const appliedInputs = new WeakMap<RailBackend, string>();

/** Records that `backend` enforces `config` — index.ts calls it right after initialize. */
export function markPolicyApplied(backend: RailBackend, config: ResolvedRailConfig): void {
  appliedInputs.set(backend, sandboxInputsKey(config));
}

/**
 * Runs one policy change so that the two engines can never disagree. The JS
 * path policy (src/policy.ts) is not compiled ahead of time: decidePathAccess
 * and scrubEnvironment read state.config on every call, so `mutate` moves it.
 * The sandbox follows in the same synchronous step via
 * backend.applyPolicy(state.config) — no command can be wrapped in between:
 * src/tools/bash.ts scrubs with state.config and sandbox-runtime compiles the
 * profile's filesystem and environment parts in the same tick. When the
 * backend refuses, `rollback` undoes the mutation, so both engines keep the
 * previous policy (fail closed: the file tools are never left wider than the
 * sandbox, nor the sandbox wider than the file tools), and the error is
 * thrown for the caller to show. If the backend could not even restore its
 * previous profile, bash is blocked (initialized = false) until restart.
 *
 * A command already running keeps the profile it started with (see
 * SeatbeltBackend.applyPolicy for the network exception).
 *
 * Skipped while no backend is initialized: initialize compiles the effective
 * config (index.ts enableRail), whatever the layers hold by then.
 */
export function commitPolicyChange(state: RuntimeState, mutate: () => void, rollback: () => void): void {
  const before = state.config ? sandboxInputsKey(state.config) : undefined;
  mutate();
  const backend = state.backend;
  const config = state.config;
  if (!backend || !state.initialized || !config) return;
  const key = sandboxInputsKey(config);
  if (key === (appliedInputs.get(backend) ?? before)) return;
  try {
    backend.applyPolicy(config);
  } catch (error) {
    rollback();
    if (error instanceof SandboxStaleError) {
      state.initialized = false;
      state.lastError = `${error.message}; bash is blocked until the rail restarts`;
      throw new Error(`${error.message}. The change was undone for the file tools, and bash is blocked until the rail restarts.`);
    }
    throw new Error(`The sandbox could not be re-pointed, so the change was undone: ${formatError(error)}. The previous policy stays in force for bash and the file tools alike.`);
  }
  appliedInputs.set(backend, key);
}

/**
 * Runs one mutation of the session layer through commitPolicyChange and
 * persists the result. Every mutator below replaces the layer's arrays rather
 * than editing them, so a shallow copy is a complete undo.
 */
function change(state: RuntimeState, mutate: (session: SessionLayer) => void): void {
  const session = state.sessionPolicy;
  const saved = { grants: session.grants, edits: session.edits };
  commitPolicyChange(
    state,
    () => mutate(session),
    () => {
      session.grants = saved.grants;
      session.edits = saved.edits;
      session.revision++;
    },
  );
  persistSessionPolicy(state);
}

// ── session-edits: what the policy page and /rail set write ──────────────────

export function setSessionDisposition(state: RuntimeState, id: CapabilityId, disposition: Disposition): void {
  change(state, (session) => editSessionDisposition(session, id, disposition));
}

export function clearSessionDisposition(state: RuntimeState, id: CapabilityId): void {
  if (!sessionDispositionEdit(state, id)) return;
  change(state, (session) => editSessionDisposition(session, id, undefined));
}

export function addSessionClass(state: RuntimeState, entry: CapabilityClass): void {
  change(state, (session) => editSessionAddClass(session, entry));
}

export function setSessionDefinition(state: RuntimeState, id: CapabilityId, definition: string): void {
  change(state, (session) => editSessionDefinition(session, id, definition));
}

export function deleteSessionClass(state: RuntimeState, id: CapabilityId): void {
  change(state, (session) => editSessionDeleteClass(session, id));
}

/** Empties session-edits (after Ctrl+S promoted it); named session grants stay. */
export function clearSessionPolicyEdits(state: RuntimeState): void {
  change(state, clearSessionEdits);
}

/** This session's edit of one table row, if it has one. */
export function sessionDispositionEdit(state: RuntimeState, id: CapabilityId): Disposition | undefined {
  for (const op of state.sessionPolicy.edits) if (op.op === "set-disposition" && op.capability === id) return op.disposition;
  return undefined;
}

/** Every row this session edited, id → disposition, in edit order. */
export function sessionDispositionEdits(state: RuntimeState): Record<CapabilityId, Disposition> {
  const rows: Record<CapabilityId, Disposition> = {};
  for (const op of state.sessionPolicy.edits) if (op.op === "set-disposition") rows[op.capability] = op.disposition;
  return rows;
}

/** Custom classes this session added (not yet saved), in edit order. */
export function sessionAddedClasses(state: RuntimeState): CapabilityClass[] {
  return state.sessionPolicy.edits.flatMap((op) =>
    op.op === "add-class" ? [{ id: op.id, name: op.name ?? op.id, definition: op.definition, default: op.disposition ?? "ask", ...(op.extends ? { extends: op.extends } : {}) }] : [],
  );
}

/** Class ids whose definition this session edited (classes it added carry their edits inline instead). */
export function sessionEditedDefinitions(state: RuntimeState): Set<CapabilityId> {
  return new Set(state.sessionPolicy.edits.flatMap((op) => (op.op === "set-definition" ? [op.capability] : [])));
}

/** Persisted custom classes this session removed. */
export function sessionRemovedClasses(state: RuntimeState): CapabilityId[] {
  return state.sessionPolicy.edits.flatMap((op) => (op.op === "remove-class" ? [op.id] : []));
}

// ── Named session grants (/rail grant add and the /rail grants view) ─────────

/**
 * Adds or replaces a named session grant and returns the diagnostics folding
 * it produced — a refused op (an unknown class, say) is reported to the
 * caller instead of only appearing in the engine tab. Throws, with the
 * grant not added, when a sandbox-list op cannot be applied to the sandbox
 * (commitPolicyChange).
 */
export function addSessionGrant(state: RuntimeState, grant: Grant): string[] {
  change(state, (session) => addGrantToLayer(session, grant));
  const base = state.baseConfig;
  if (!base) return [];
  const before = base.diagnostics.length;
  const folded = applyLayer(baseConfigOf(base), sessionPolicyLayer(state.sessionPolicy));
  return folded.diagnostics.slice(before).filter((line) => line.includes(`grant ${grant.id} `));
}

export function removeSessionGrant(state: RuntimeState, id: string): boolean {
  if (!state.sessionPolicy.grants.some((grant) => grant.id === id)) return false;
  change(state, (session) => void removeGrantFromLayer(session, id));
  return true;
}

export function listSessionGrants(state: RuntimeState): Grant[] {
  return [...state.sessionPolicy.grants];
}

// ── Moving named grants between the session and a config file ───────────────

export interface GrantFileTarget {
  layer: FileLayerName;
  file: string;
}

/**
 * Refolds the base config from the files, in place, after a file-layer
 * change (a grant promoted, demoted, revoked, or saved), so the change is in
 * force on the very next tool call. `load` is loadConfig bound to the
 * session's ctx; tests pass their own.
 *
 * In place: the base object keeps its identity (anything holding it sees the
 * new policy) and the session-layer cache is dropped. The sandbox-backed
 * lists (filesystem, network, environment) move too, through
 * commitPolicyChange, so the sandbox is re-pointed in the same step; if it
 * refuses, those lists keep their previous values in both engines and the
 * returned note says they apply at restart. What the refold does not move:
 *
 * - `enabled`, which /rail on and /rail off set on the live base;
 * - `filesystem.enabled`, `network.enabled` and the `seatbelt` overrides:
 *   whether the sandbox filters at all (and whether its proxy runs) is fixed
 *   when it starts, so a change to them is kept on disk and reported as
 *   applying at restart.
 *
 * A refold also picks up any other edit made to the config files since the
 * session loaded them — it is a reload, not a patch.
 */
export function reloadBaseConfig(state: RuntimeState, load: () => ResolvedRailConfig): string[] {
  const old = state.baseConfig;
  const fresh = load();
  if (!old) {
    state.config = fresh;
    return [];
  }
  const notes: string[] = [];
  fresh.enabled = old.enabled;
  const restartOnly = [
    ...(old.filesystem.enabled !== fresh.filesystem.enabled ? ["filesystem.enabled"] : []),
    ...(old.network.enabled !== fresh.network.enabled ? ["network.enabled"] : []),
    ...(JSON.stringify(old.seatbelt) !== JSON.stringify(fresh.seatbelt) ? ["seatbelt"] : []),
  ];
  if (restartOnly.length > 0) {
    notes.push(`${restartOnly.join(", ")} changed on disk and apply when the rail next starts — whether the sandbox filters at all is fixed when it starts.`);
  }
  fresh.filesystem.enabled = old.filesystem.enabled;
  fresh.network.enabled = old.network.enabled;
  fresh.seatbelt = old.seatbelt;
  // Shallow is enough: replacing the base swaps its top-level objects and
  // never edits the old ones.
  const previous = { ...old };
  const replace = (next: ResolvedRailConfig) => {
    for (const key of Object.keys(old) as Array<keyof ResolvedRailConfig>) delete old[key];
    Object.assign(old, next);
    invalidateSessionCache(old);
  };
  try {
    commitPolicyChange(
      state,
      () => replace(fresh),
      () => {
        // Keep everything else the refold brought, but hold the sandbox lists
        // where they were: the policy the sandbox still enforces.
        fresh.filesystem = previous.filesystem;
        fresh.network = previous.network;
        fresh.environment = previous.environment;
        for (const list of SANDBOX_LISTS) fresh.provenance.lists[list] = previous.provenance.lists[list];
        replace(fresh);
      },
    );
  } catch (error) {
    notes.push(`${formatError(error)} The filesystem, network and environment lists on disk apply when the rail next starts.`);
  }
  state.config = old;
  return notes;
}

/** The lists the sandbox is compiled from. */
const SANDBOX_LISTS = ["filesystem.allowRead", "filesystem.denyRead", "filesystem.allowWrite", "filesystem.denyWrite", "network.allowedDomains", "network.deniedDomains", "environment.allow", "environment.unset"] as const;

/** How grant moves reach files and the live base; the defaults write the real config files. */
export interface GrantFileOps {
  write?: (file: string, grant: Grant) => void;
  remove?: (file: string, id: string) => Record<string, unknown> | undefined;
  /**
   * Refolds the base from the files after a change. Given (the /rail grants
   * view always passes it), the change is live at once; absent, the older
   * in-place fold below is all that happens and a demoted or revoked file
   * grant keeps its effects until the next load.
   */
  reload?: () => ResolvedRailConfig;
  /** Collects what the refold could not apply live (restart-only settings, a refused sandbox update), for the caller to show. */
  notes?: string[];
}

/**
 * Promotes a named session grant into a config file's `grants` array. With a
 * `reload`, the base is refolded from the files; without one, the grant's ops
 * fold into the live base under that file's provenance — the same "no
 * effective value moves" rule Ctrl+S follows. Either way promotion never
 * changes what the rail decides this session.
 *
 * Promotion asks for no new approval, widening or not: the grant's ops were
 * approved, sensitive ones one by one, when it was applied to the session,
 * and promotion moves it unchanged. `write` is injectable for tests.
 */
export function promoteSessionGrant(
  state: RuntimeState,
  id: string,
  target: GrantFileTarget,
  write: ((file: string, grant: Grant) => void) | GrantFileOps = addGrantToConfigFile,
): string | undefined {
  const ops: GrantFileOps = typeof write === "function" ? { write } : write;
  const grant = state.sessionPolicy.grants.find((entry) => entry.id === id);
  if (!grant) return `No session grant "${id}".`;
  try {
    (ops.write ?? addGrantToConfigFile)(target.file, grant);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  // Either way the base takes the grant before the session gives it up, so
  // the session removal's commit sees the net effect (none, for the sandbox
  // lists) and never re-points the sandbox at a policy without the grant.
  if (ops.reload) {
    ops.notes?.push(...reloadBaseConfig(state, ops.reload));
    removeSessionGrant(state, id);
    return undefined;
  }
  const base = state.baseConfig;
  if (base) {
    applyOpsInPlace(base, grant.ops, { layer: target.layer, grantId: id, file: target.file }, `${target.file} grant ${id} ops`);
    base.grants.push({ layer: target.layer, id, request: grant.request, file: target.file });
    state.config = base;
  }
  removeSessionGrant(state, id);
  return undefined;
}

/**
 * Demotes a config file's grant to the session layer. With a `reload` (what
 * the grants view passes) the base is refolded without the file grant, so
 * from the next tool call only the session copy applies — sandbox-list ops
 * included, which the session layer applies like any other. Without one, the
 * live base keeps the grant's effects until the config is next loaded.
 */
export function demoteGrantToSession(
  state: RuntimeState,
  source: GrantFileTarget,
  id: string,
  remove: ((file: string, id: string) => Record<string, unknown> | undefined) | GrantFileOps = removeGrantFromConfigFile,
): string | undefined {
  const ops: GrantFileOps = typeof remove === "function" ? { remove } : remove;
  if (state.sessionPolicy.grants.some((entry) => entry.id === id)) return `This session already has a grant "${id}".`;
  const raw = (ops.remove ?? removeGrantFromConfigFile)(source.file, id);
  if (!raw) return `${source.file} has no grant "${id}".`;
  const diagnostics: string[] = [];
  const grant = parseGrant(raw, `${source.file} grant`, diagnostics);
  if (!grant) return diagnostics.join("; ") || `${source.file} grant "${id}" did not parse.`;
  try {
    addSessionGrant(state, grant);
  } catch (error) {
    // The sandbox refused the session copy: put the grant back where it was
    // rather than lose it.
    (ops.write ?? addGrantToConfigFile)(source.file, grant);
    return formatError(error);
  }
  if (ops.reload) ops.notes?.push(...reloadBaseConfig(state, ops.reload));
  return undefined;
}

/**
 * Revokes a grant: deletes it from its layer and nothing else. A session
 * grant leaves the session layer (persisted at once); a file grant leaves its
 * file and, with a `reload`, the live base too.
 */
export function revokeGrant(state: RuntimeState, layer: GrantLayerName, id: string, file?: string, ops: GrantFileOps = {}): string | undefined {
  if (layer === "session") return removeSessionGrant(state, id) ? undefined : `No session grant "${id}".`;
  if (!file) return `No ${layer} config file to revoke "${id}" from.`;
  const raw = (ops.remove ?? removeGrantFromConfigFile)(file, id);
  if (!raw) return `${file} has no grant "${id}".`;
  if (ops.reload) ops.notes?.push(...reloadBaseConfig(state, ops.reload));
  return undefined;
}
