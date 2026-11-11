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
  parseGrant,
  parseOp,
  removeSessionGrant as removeGrantFromLayer,
  serializeGrant,
  sessionPolicyLayer,
  type FileLayerName,
  type Grant,
  type PolicyOp,
  type SessionLayer,
} from "./policy-store.ts";
import type { RuntimeState } from "./state.ts";

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
 * grant whose sandbox-list op is refused. index.ts surfaces these once at
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

/** Runs one mutation of the session layer and persists the result. */
function change(state: RuntimeState, mutate: (session: SessionLayer) => void): void {
  mutate(state.sessionPolicy);
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
    op.op === "add-class" ? [{ id: op.id, name: op.name ?? op.id, definition: op.definition, default: op.disposition ?? "ask" }] : [],
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

// ── Named session grants (API only for now; no UI) ───────────────────────────

/**
 * Adds or replaces a named session grant and returns the diagnostics folding
 * it produced — a refused op (unknown class, a sandbox list) is reported to
 * the caller instead of only appearing in the engine tab.
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
 * Promotes a named session grant into a config file's `grants` array, and
 * folds it into the live base under that file's provenance — the same "no
 * effective value moves" rule Ctrl+S follows, so promotion never changes what
 * the rail decides this session. `write` is injectable for tests.
 */
export function promoteSessionGrant(
  state: RuntimeState,
  id: string,
  target: GrantFileTarget,
  write: (file: string, grant: Grant) => void = addGrantToConfigFile,
): string | undefined {
  const grant = state.sessionPolicy.grants.find((entry) => entry.id === id);
  if (!grant) return `No session grant "${id}".`;
  write(target.file, grant);
  removeSessionGrant(state, id);
  const base = state.baseConfig;
  if (base) {
    applyOpsInPlace(base, grant.ops, { layer: target.layer, grantId: id, file: target.file }, `${target.file} grant ${id} ops`);
    base.grants.push({ layer: target.layer, id, request: grant.request, file: target.file });
    state.config = base;
  }
  return undefined;
}

/**
 * Demotes a config file's grant to the session layer. The live base keeps the
 * grant's effects (and their file provenance) until the config is next loaded
 * — refolding needs the file layers, which the session does not keep — so the
 * effective policy does not move now either; on the next load it is the
 * session copy alone that applies.
 */
export function demoteGrantToSession(
  state: RuntimeState,
  source: GrantFileTarget,
  id: string,
  remove: (file: string, id: string) => Record<string, unknown> | undefined = removeGrantFromConfigFile,
): string | undefined {
  if (state.sessionPolicy.grants.some((entry) => entry.id === id)) return `This session already has a grant "${id}".`;
  const raw = remove(source.file, id);
  if (!raw) return `${source.file} has no grant "${id}".`;
  const diagnostics: string[] = [];
  const grant = parseGrant(raw, `${source.file} grant`, diagnostics);
  if (!grant) return diagnostics.join("; ") || `${source.file} grant "${id}" did not parse.`;
  addSessionGrant(state, grant);
  return undefined;
}
