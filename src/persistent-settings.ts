import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CapabilityId, Disposition } from "./capabilities.ts";
import { globalRailConfigPath, type CapabilitiesConfig, type RailConfig, type StatusLineMode } from "./config.ts";
import { applyOpsToRawConfig, type Grant, type PolicyOp } from "./policy-store.ts";

/** The on-disk shape of a custom class: exactly what capabilities.classes entries look like. */
export interface PersistedCapabilityClass {
  id: string;
  name?: string;
  definition: string;
  disposition?: Disposition;
}

/** The global config file, resolved per call so a redirected agent dir (tests) is honoured. */
function configPath(): string {
  return globalRailConfigPath();
}

function lockPath(filePath: string): string {
  return `${filePath}.lock`;
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function withConfigLock<T>(filePath: string, fn: () => T): T {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const lock = lockPath(filePath);
  let acquired = false;
  let lastError: unknown;

  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      mkdirSync(lock);
      acquired = true;
      break;
    } catch (error) {
      lastError = error;
      sleepSync(20 + attempt * 5);
    }
  }

  if (!acquired) throw lastError instanceof Error ? lastError : new Error(`Could not acquire config lock: ${lock}`);

  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function readConfigUnlocked(filePath: string): RailConfig {
  if (!existsSync(filePath)) return {};
  const text = readFileSync(filePath, "utf8");
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RailConfig) : {};
}

/**
 * Write-then-rename, so a crash mid-write leaves the previous file rather than
 * a truncated one. The lock serializes writers; the rename makes each write
 * all-or-nothing for readers (loadConfig takes no lock).
 */
function writeConfigUnlocked(filePath: string, config: RailConfig): void {
  const temp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2), "utf8");
  renameSync(temp, filePath);
}

/** Read-modify-write of one config file under its lock. Every writer below goes through here. */
function updateConfigFile(filePath: string, update: (current: RailConfig) => RailConfig): void {
  withConfigLock(filePath, () => writeConfigUnlocked(filePath, update(readConfigUnlocked(filePath))));
}

export function updatePersistentClassifierSettings(update: { enabled?: boolean; model?: string; judgeModel?: string }): void {
  updateConfigFile(configPath(), (current) => ({ ...current, classifier: { ...(current.classifier ?? {}), ...update } }));
}

/** Writes one disposition row to the global config; `undefined` deletes the row so the class falls back to its default. */
export function updatePersistentDisposition(id: CapabilityId, disposition: Disposition | undefined): void {
  updateConfigFile(configPath(), (current) => {
    const dispositions = { ...(current.dispositions ?? {}) };
    if (disposition === undefined) delete dispositions[id];
    else dispositions[id] = disposition;
    const next: RailConfig = { ...current, dispositions };
    if (Object.keys(dispositions).length === 0) delete next.dispositions;
    return next;
  });
}

/**
 * Writes one custom class to the global config; `undefined` removes it. Mirrors
 * updatePersistentDisposition: read-modify-write under the same lock, and the
 * section disappears once it is empty so the file does not accumulate husks.
 */
export function updatePersistentCapabilityClass(id: string, entry: PersistedCapabilityClass | undefined): void {
  updateConfigFile(configPath(), (current) => {
    const capabilities: CapabilitiesConfig = { ...(current.capabilities ?? {}) };
    const classes = [...(capabilities.classes ?? [])];
    const at = classes.findIndex((existing) => isObjectRecord(existing) && existing.id === id);
    if (entry === undefined) {
      if (at !== -1) classes.splice(at, 1);
    } else if (at === -1) {
      classes.push(entry);
    } else {
      classes[at] = entry;
    }
    if (classes.length > 0) capabilities.classes = classes;
    else delete capabilities.classes;
    return pruneCapabilities({ ...current, capabilities });
  });
}

/** Writes one built-in definition override; `undefined` restores the shipped wording. */
export function updatePersistentCapabilityDefinition(id: string, definition: string | undefined): void {
  updateConfigFile(configPath(), (current) => {
    const capabilities: CapabilitiesConfig = { ...(current.capabilities ?? {}) };
    const definitions = { ...(capabilities.definitions ?? {}) };
    if (definition === undefined) delete definitions[id];
    else definitions[id] = definition;
    if (Object.keys(definitions).length > 0) capabilities.definitions = definitions;
    else delete capabilities.definitions;
    return pruneCapabilities({ ...current, capabilities });
  });
}

/**
 * Writes ops into the global config's base keys — the Ctrl+S path for op
 * kinds the three writers above do not cover (classify rules, command
 * allowances, list edits). Unrelated keys and the file's grants are kept.
 */
export function appendPersistentBaseOps(ops: readonly PolicyOp[], filePath = configPath()): void {
  if (ops.length === 0) return;
  updateConfigFile(filePath, (current) => applyOpsToRawConfig(current, ops));
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Drops an empty capabilities section, so removing the last class leaves no stub behind. */
function pruneCapabilities(config: RailConfig): RailConfig {
  const next = { ...config };
  if (next.capabilities && Object.keys(next.capabilities).length === 0) delete next.capabilities;
  return next;
}

export function updatePersistentStatusLine(mode: StatusLineMode): void {
  updateConfigFile(configPath(), (current) => ({ ...current, statusLine: mode }));
}

export function getPersistentConfigPath(): string {
  return configPath();
}

// ── Grants in config files ───────────────────────────────────────────────────
// These move grant objects between files untouched: the raw object is what
// travels, so fields this version does not interpret (examples today, the
// phase-2 fields later) survive a promotion or demotion byte-for-byte.

/** A grant to write: a parsed Grant, or a raw object lifted out of another file. */
export type GrantRecord = Grant | Record<string, unknown>;

function grantId(record: unknown): string | undefined {
  return isObjectRecord(record) && typeof record.id === "string" ? record.id : undefined;
}

/** The raw grant objects in a config file, in file order; [] when there are none. */
export function readConfigFileGrants(filePath: string): Array<Record<string, unknown>> {
  const grants = readConfigUnlocked(filePath).grants;
  return Array.isArray(grants) ? grants.filter(isObjectRecord) : [];
}

/**
 * Appends a grant to a file's `grants` array. Refuses an id the file already
 * has, rather than overwriting it: two grants with one id would make revoke
 * and provenance ambiguous.
 */
export function addGrantToConfigFile(filePath: string, grant: GrantRecord): void {
  const id = grantId(grant);
  if (!id) throw new Error("A grant needs an id");
  // Cloned as given, not re-serialized: a raw object lifted from another file
  // may carry fields this version does not model, and they must travel too.
  const record = structuredClone(grant) as Record<string, unknown>;
  updateConfigFile(filePath, (current) => {
    const grants = Array.isArray(current.grants) ? [...current.grants] : [];
    if (grants.some((existing) => grantId(existing) === id)) throw new Error(`${filePath} already has a grant "${id}"`);
    return { ...current, grants: [...grants, record] };
  });
}

/**
 * Removes a grant from a file and returns the raw object it held (revoke
 * discards it; demotion hands it to the session layer). Undefined when the
 * file has no such grant. The `grants` key goes once it is empty.
 */
export function removeGrantFromConfigFile(filePath: string, id: string): Record<string, unknown> | undefined {
  let removed: Record<string, unknown> | undefined;
  updateConfigFile(filePath, (current) => {
    const grants = Array.isArray(current.grants) ? [...current.grants] : [];
    const at = grants.findIndex((existing) => grantId(existing) === id);
    if (at === -1) return current;
    removed = grants[at] as Record<string, unknown>;
    grants.splice(at, 1);
    const next: RailConfig = { ...current, grants };
    if (grants.length === 0) delete next.grants;
    return next;
  });
  return removed;
}

/**
 * Moves a grant between two config files (global ↔ project). The target is
 * written first: a failure between the two writes leaves the grant in both
 * files, which the duplicate-id check on the next move reports, rather than in
 * neither.
 */
export function moveGrantBetweenConfigFiles(fromFile: string, toFile: string, id: string): void {
  const record = readConfigFileGrants(fromFile).find((entry) => grantId(entry) === id);
  if (!record) throw new Error(`${fromFile} has no grant "${id}"`);
  addGrantToConfigFile(toFile, record);
  removeGrantFromConfigFile(fromFile, id);
}
