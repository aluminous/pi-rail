/**
 * The layered policy store (GRANTS_PLAN, "The layered store"). Every layer is
 * a list of operations, and one fold turns the stack into the
 * ResolvedRailConfig every pipeline consumer already reads:
 *
 *   defaults → global base → global grants → project base → project grants → session grants
 *
 * A config file's ordinary top-level keys (`dispositions`, `commands`,
 * `filesystem`, …) are its hand-written base policy and compile to that
 * layer's anonymous base ops; its `grants` array holds named grants that apply
 * after the base. The session layer has no base: it is named session grants,
 * then the implicit `session-edits` grant the /rail policy page writes into.
 * One shape at every layer is what makes "try it this session, keep it later"
 * a move between arrays instead of a per-key special case.
 *
 * Pure: no file or session I/O lives here. config.ts reads files and hands the
 * parsed JSON in; persistent-settings.ts and session-policy.ts write.
 */
import {
  CUSTOM_CLASS_ID_PATTERN,
  BUILTIN_CAPABILITY_IDS,
  getEffectiveDisposition,
  isBuiltinCapabilityId,
  isDisposition,
  isStricter,
  type BuiltinCapabilityId,
  type CapabilityClass,
  type CapabilityId,
  type Disposition,
  type EffectiveDisposition,
} from "./capabilities.ts";
import {
  capabilityForTemplate,
  DEFAULT_COMMAND_ALLOWLIST,
  commandFlagsProblem,
  commandTemplateProblem,
  type CommandCapabilityRule,
  type CommandRule,
  type CommandRuleSet,
} from "./command-allowlist.ts";
import type { ProvenanceListKey, RailBackendName, RailConfig, ResolvedClassifierConfig, ResolvedRailConfig, StatusLineMode } from "./config.ts";

// ── Layers and provenance ────────────────────────────────────────────────────

export type PolicyLayerName = "default" | "global" | "project" | "session";

/** The layers a config file can be: global (the agent dir) or project (`.pi/rail.json`). */
export type FileLayerName = "global" | "project";

/**
 * Where one effective entry came from. `grantId` is absent for a file's base
 * keys and for the built-in defaults; `file` is absent for defaults and the
 * session layer. Provenance answers "what would I edit or revoke to change
 * this", so it names the grant, not just the file.
 */
export interface Provenance {
  layer: PolicyLayerName;
  grantId?: string;
  file?: string;
}

/** Provenance for every effective entry, keyed the way each entry is identified. */
export interface PolicyProvenance {
  /** Per list, entry text → who introduced it. Classify rules are keyed by template. */
  lists: Record<ProvenanceListKey, Record<string, Provenance>>;
  /** Class id → who set the table row; built-ins start at the default layer. */
  dispositions: Record<CapabilityId, Provenance>;
  /** Custom class id → who declared (or last redeclared) it. */
  classes: Record<string, Provenance>;
  /** Class id → who last replaced its definition, built-in or custom. */
  definitions: Record<string, Provenance>;
}

export const DEFAULT_PROVENANCE: Provenance = { layer: "default" };

/** The string lists ops can address. Classify rules are objects and have their own op. */
export type StringListKey = Exclude<ProvenanceListKey, "commands.classify">;

export const STRING_LIST_KEYS: StringListKey[] = [
  "filesystem.allowRead",
  "filesystem.denyRead",
  "filesystem.allowWrite",
  "filesystem.denyWrite",
  "environment.allow",
  "environment.unset",
  "network.allowedDomains",
  "network.deniedDomains",
  "commands.allow",
];

function isStringListKey(value: unknown): value is StringListKey {
  return typeof value === "string" && (STRING_LIST_KEYS as string[]).includes(value);
}

// ── Ops and grants ───────────────────────────────────────────────────────────

/**
 * The closed op vocabulary. Each op is validated on its own: a bad op is
 * skipped with a diagnostic and the rest of its grant still applies, the same
 * per-entry tolerance config loading has always had.
 */
export type PolicyOp =
  | { op: "set-disposition"; capability: CapabilityId; disposition: Disposition }
  | { op: "add-class"; id: string; name?: string; definition: string; disposition?: Disposition; extends?: BuiltinCapabilityId; namer?: boolean }
  | { op: "remove-class"; id: string }
  | { op: "set-definition"; capability: CapabilityId; definition: string }
  | { op: "classify"; template: string; capability: CapabilityId; flags?: string[] }
  | { op: "allow-command"; template: string; flags?: string[] }
  | { op: "add-to-list"; list: StringListKey; values: string[] }
  | { op: "remove-from-list"; list: StringListKey; values: string[] };

export type PolicyOpName = PolicyOp["op"];

/** Fields each op accepts beyond `op`. Anything else is an error for that op; a missing required field fails its own check below. */
const OP_FIELDS: Record<PolicyOpName, { required: string[]; optional: string[] }> = {
  "set-disposition": { required: ["capability", "disposition"], optional: [] },
  "add-class": { required: ["id", "definition"], optional: ["name", "disposition", "extends", "namer"] },
  "remove-class": { required: ["id"], optional: [] },
  "set-definition": { required: ["capability", "definition"], optional: [] },
  classify: { required: ["template", "capability"], optional: ["flags"] },
  "allow-command": { required: ["template"], optional: ["flags"] },
  "add-to-list": { required: ["list", "values"], optional: [] },
  "remove-from-list": { required: ["list", "values"], optional: [] },
};

export const POLICY_OP_NAMES = Object.keys(OP_FIELDS) as PolicyOpName[];

/** One stored example: the grant's own test. Parsed and kept, not yet executed (GRANTS_PLAN phase 3). */
export interface GrantExample {
  tool: string;
  input: Record<string, unknown>;
  /** Acceptable outcomes; any one of them passes. */
  expect: Disposition[];
  why?: string;
}

/** The unit of policy change: the request in the user's words and the ops it produced. */
export interface Grant {
  id: string;
  request: string;
  created: string;
  ops: PolicyOp[];
  examples?: GrantExample[];
}

/** Grant ids are kebab-case, like class ids, and name the grant in provenance labels. */
export const GRANT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const GRANT_ID_MAX = 64;

/**
 * The implicit grant the policy page and `/rail set` edit. Reserved: no file
 * grant may take the id, so promoting `session-edits` into a file's base keys
 * and promoting a named grant into its `grants` array can never collide.
 */
export const SESSION_EDITS_GRANT_ID = "session-edits";

/** A grant as the fold reports it: which layer applied it, for listing and provenance displays. */
export interface AppliedGrant {
  layer: Exclude<PolicyLayerName, "default">;
  id: string;
  request: string;
  file?: string;
}

/** An op plus the path its diagnostics name, so a skipped op points at the line that wrote it. */
export interface LocatedOp {
  op: PolicyOp;
  where: string;
}

/** The non-op half of a config file: scalars that are settings, not policy entries. */
export interface LayerSettings {
  enabled?: boolean;
  backend?: RailBackendName;
  statusLine?: StatusLineMode;
  filesystemEnabled?: boolean;
  networkEnabled?: boolean;
  classifier?: Partial<ResolvedClassifierConfig>;
  corpusEnabled?: boolean;
  seatbelt?: Record<string, unknown>;
  container?: Record<string, unknown>;
}

export interface PolicyLayer {
  name: Exclude<PolicyLayerName, "default">;
  file?: string;
  settings: LayerSettings;
  /** The base ops a file's top-level keys compiled to; always empty at the session layer. */
  base: LocatedOp[];
  grants: Grant[];
  /** Parse-time diagnostics, carried into the folded config's diagnostics. */
  diagnostics: string[];
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function unexpectedKeys(value: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function keyList(keys: string[]): string {
  return `key${keys.length > 1 ? "s" : ""} ${keys.join(", ")}`;
}

const DISPOSITION_SHAPE = `"allow", "judge", "ask", or "deny"`;

/**
 * Validates one op on its own. Unknown fields are an error rather than
 * ignored, so a field from a later phase is refused loudly instead of loading
 * as a broader rule than its author wrote — the reason a `flags` this build
 * did not understand could never have quietly meant "any flags".
 */
export function parseOp(raw: unknown, where: string, diagnostics: string[]): PolicyOp | undefined {
  const fail = (message: string): undefined => {
    diagnostics.push(`Ignoring ${where}: ${message}`);
    return undefined;
  };
  if (!isObject(raw)) return fail("expected an op object");
  const name = raw.op;
  if (typeof name !== "string" || !(name in OP_FIELDS)) {
    return fail(`unknown op ${JSON.stringify(name)} — expected one of ${POLICY_OP_NAMES.join(", ")}`);
  }
  const fields = OP_FIELDS[name as PolicyOpName];
  const extra = unexpectedKeys(raw, ["op", ...fields.required, ...fields.optional]);
  if (extra.length > 0) return fail(`unexpected ${keyList(extra)} on ${name}`);

  const nonEmpty = (key: string): string | undefined => (typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string).trim() : undefined);

  switch (name as PolicyOpName) {
    case "set-disposition": {
      const capability = nonEmpty("capability");
      if (!capability) return fail("capability must be a non-empty string");
      if (!isDisposition(raw.disposition)) return fail(`disposition must be ${DISPOSITION_SHAPE}`);
      return { op: "set-disposition", capability, disposition: raw.disposition };
    }
    case "add-class": {
      const id = raw.id;
      if (typeof id !== "string" || !CUSTOM_CLASS_ID_PATTERN.test(id)) return fail("id must be kebab-case, 2-41 characters, starting with a letter");
      if (isBuiltinCapabilityId(id)) return fail(`"${id}" is a built-in class — use set-definition to change its wording`);
      const definition = nonEmpty("definition");
      if (!definition) return fail("definition must be a non-empty string");
      if (raw.name !== undefined && typeof raw.name !== "string") return fail("name must be a string");
      if (raw.disposition !== undefined && !isDisposition(raw.disposition)) return fail(`disposition must be ${DISPOSITION_SHAPE}`);
      // Built-in parents only: a preset is a fixed guarantee over the
      // built-ins, and a chain through custom classes could be removed or
      // redeclared out from under it.
      if (raw.extends !== undefined && !isBuiltinCapabilityId(raw.extends)) return fail(`extends must be a built-in class id (${BUILTIN_CAPABILITY_IDS.join(", ")})`);
      if (raw.namer !== undefined && typeof raw.namer !== "boolean") return fail("namer must be true or false");
      const label = typeof raw.name === "string" ? raw.name.trim() : "";
      return {
        op: "add-class",
        id,
        ...(label ? { name: label } : {}),
        definition,
        ...(raw.disposition !== undefined ? { disposition: raw.disposition as Disposition } : {}),
        ...(raw.extends !== undefined ? { extends: raw.extends as BuiltinCapabilityId } : {}),
        ...(raw.namer !== undefined ? { namer: raw.namer as boolean } : {}),
      };
    }
    case "remove-class": {
      const id = raw.id;
      if (typeof id !== "string" || !CUSTOM_CLASS_ID_PATTERN.test(id)) return fail("id must be a custom class id");
      if (isBuiltinCapabilityId(id)) return fail(`"${id}" is built-in and cannot be removed — set it to deny instead`);
      return { op: "remove-class", id };
    }
    case "set-definition": {
      const capability = nonEmpty("capability");
      if (!capability) return fail("capability must be a non-empty string");
      const definition = nonEmpty("definition");
      if (!definition) return fail("definition must be a non-empty string");
      return { op: "set-definition", capability, definition };
    }
    case "classify": {
      if (typeof raw.template !== "string") return fail("template must be a string");
      const problem = commandTemplateProblem(raw.template);
      if (problem) return fail(problem);
      const capability = nonEmpty("capability");
      if (!capability) return fail("capability must be a non-empty string");
      const flags = parseFlags(raw.template, raw.flags);
      if (typeof flags === "string") return fail(flags);
      return { op: "classify", template: normalizeTemplate(raw.template), capability, ...(flags ? { flags } : {}) };
    }
    case "allow-command": {
      if (typeof raw.template !== "string") return fail("template must be a string");
      const problem = commandTemplateProblem(raw.template);
      if (problem) return fail(problem);
      const flags = parseFlags(raw.template, raw.flags);
      if (typeof flags === "string") return fail(flags);
      return { op: "allow-command", template: normalizeTemplate(raw.template), ...(flags ? { flags } : {}) };
    }
    case "add-to-list":
    case "remove-from-list": {
      if (!isStringListKey(raw.list)) return fail(`list must be one of ${STRING_LIST_KEYS.join(", ")}`);
      if (!isStringArray(raw.values)) return fail("values must be an array of strings");
      return { op: name as "add-to-list" | "remove-from-list", list: raw.list, values: [...raw.values] };
    }
  }
}

/** A validated copy of an op's `flags`, undefined when absent, or the problem as a string. */
function parseFlags(template: string, raw: unknown): string[] | undefined | string {
  if (raw === undefined) return undefined;
  const problem = commandFlagsProblem(template, raw);
  if (problem) return problem;
  // Duplicates say nothing extra; dropping them keeps restatement checks exact.
  return [...new Set(raw as string[])];
}

/** Templates are a rule's identity as written, trimmed (the matcher splits on whitespace either way). */
function normalizeTemplate(template: string): string {
  return template.trim();
}

const EXAMPLE_KEYS = ["tool", "input", "expect", "why"];

/**
 * Shape-checks one stored example. Phase 1 keeps examples verbatim and does
 * not run them; validating now means the file format is settled before the
 * gates that execute them exist.
 */
function parseExample(raw: unknown, where: string, diagnostics: string[]): GrantExample | undefined {
  const fail = (message: string): undefined => {
    diagnostics.push(`Ignoring ${where}: ${message}`);
    return undefined;
  };
  if (!isObject(raw)) return fail("expected an example object");
  const extra = unexpectedKeys(raw, EXAMPLE_KEYS);
  if (extra.length > 0) return fail(`unexpected ${keyList(extra)}`);
  if (typeof raw.tool !== "string" || !raw.tool.trim()) return fail("tool must be a non-empty string");
  if (!isObject(raw.input)) return fail("input must be an object");
  if (!Array.isArray(raw.expect) || raw.expect.length === 0 || !raw.expect.every(isDisposition)) {
    return fail(`expect must be a non-empty array of ${DISPOSITION_SHAPE}`);
  }
  if (raw.why !== undefined && typeof raw.why !== "string") return fail("why must be a string");
  return {
    tool: raw.tool,
    input: structuredClone(raw.input),
    expect: [...raw.expect] as Disposition[],
    ...(raw.why !== undefined ? { why: raw.why as string } : {}),
  };
}

const GRANT_KEYS = ["id", "request", "created", "ops", "examples"];

/**
 * Validates one grant. A malformed envelope (bad id, unknown key, ops not an
 * array) skips the whole grant: without a trustworthy id it could not be
 * revoked or attributed. Inside a good envelope, each op and each example
 * stands alone.
 */
export function parseGrant(raw: unknown, where: string, diagnostics: string[]): Grant | undefined {
  const fail = (message: string): undefined => {
    diagnostics.push(`Ignoring ${where}: ${message}`);
    return undefined;
  };
  if (!isObject(raw)) return fail("expected a grant object");
  const extra = unexpectedKeys(raw, GRANT_KEYS);
  if (extra.length > 0) return fail(`unexpected ${keyList(extra)}`);
  const id = raw.id;
  if (typeof id !== "string" || id.length > GRANT_ID_MAX || !GRANT_ID_PATTERN.test(id)) return fail(`grant id must be kebab-case, at most ${GRANT_ID_MAX} characters`);
  if (id === SESSION_EDITS_GRANT_ID) return fail(`"${SESSION_EDITS_GRANT_ID}" is reserved for this session's /rail policy edits`);
  if (typeof raw.request !== "string") return fail("request must be a string");
  if (typeof raw.created !== "string") return fail("created must be a string");
  if (!Array.isArray(raw.ops)) return fail("ops must be an array");
  const ops: PolicyOp[] = [];
  raw.ops.forEach((entry, index) => {
    const op = parseOp(entry, `${where} (${id}).ops[${index}]`, diagnostics);
    if (op) ops.push(op);
  });
  const grant: Grant = { id, request: raw.request, created: raw.created, ops };
  if (raw.examples !== undefined) {
    if (!Array.isArray(raw.examples)) {
      diagnostics.push(`Ignoring ${where} (${id}).examples: expected an array`);
    } else {
      const examples: GrantExample[] = [];
      raw.examples.forEach((entry, index) => {
        const example = parseExample(entry, `${where} (${id}).examples[${index}]`, diagnostics);
        if (example) examples.push(example);
      });
      grant.examples = examples;
    }
  }
  return grant;
}

/** A layer's `grants` array; ids are unique within the layer, and a repeat is skipped. */
export function parseGrants(raw: unknown, where: string, diagnostics: string[]): Grant[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    diagnostics.push(`Ignoring ${where}: expected an array of grants`);
    return [];
  }
  const grants: Grant[] = [];
  raw.forEach((entry, index) => {
    const grant = parseGrant(entry, `${where}[${index}]`, diagnostics);
    if (!grant) return;
    if (grants.some((existing) => existing.id === grant.id)) {
      diagnostics.push(`Ignoring ${where}[${index}]: grant id "${grant.id}" is already used in this layer`);
      return;
    }
    grants.push(grant);
  });
  return grants;
}

/** The on-disk form of a grant: exactly what parseGrant accepts, so it round-trips. */
export function serializeGrant(grant: Grant): Record<string, unknown> {
  return {
    id: grant.id,
    request: grant.request,
    created: grant.created,
    ops: grant.ops.map((op) => structuredClone(op)),
    ...(grant.examples !== undefined ? { examples: structuredClone(grant.examples) } : {}),
  };
}

// ── Compiling a config file into a layer ─────────────────────────────────────

const LIST_SHAPE = `expected an array of strings, or {"add": [...], "remove": [...]}`;
const RULE_SHAPE = `expected an array of {"template": "…", "capability": "…"} entries, or {"add": [...]}`;

/**
 * The removed `{replace, values}` form gets one clear sentence and leaves the
 * list as inherited: half-applying a list is worse than not applying it, and a
 * silent reinterpretation of `replace: true` as "add" would quietly widen
 * every list that used it to narrow.
 */
function legacyListDiagnostic(where: string): string {
  return `Ignoring ${where}: the {"replace", "values"} form has been removed — lists only append. A bare array adds entries; {"add": [...], "remove": [...]} adds and drops them.`;
}

/** One string list in either form, as add/remove ops. Malformed means "leave it as inherited". */
function compileList(list: StringListKey, raw: unknown, where: string, diagnostics: string[], out: LocatedOp[]): void {
  if (raw === undefined) return;
  if (Array.isArray(raw)) {
    if (!isStringArray(raw)) {
      diagnostics.push(`Ignoring ${where}: ${LIST_SHAPE}`);
      return;
    }
    out.push({ op: { op: "add-to-list", list, values: [...raw] }, where });
    return;
  }
  if (!isObject(raw)) {
    diagnostics.push(`Ignoring ${where}: ${LIST_SHAPE}`);
    return;
  }
  if ("replace" in raw || "values" in raw) {
    diagnostics.push(legacyListDiagnostic(where));
    return;
  }
  const extra = unexpectedKeys(raw, ["add", "remove"]);
  if (extra.length > 0) {
    diagnostics.push(`Ignoring ${where}: unexpected ${keyList(extra)} — ${LIST_SHAPE}`);
    return;
  }
  if ((raw.add !== undefined && !isStringArray(raw.add)) || (raw.remove !== undefined && !isStringArray(raw.remove))) {
    diagnostics.push(`Ignoring ${where}: ${LIST_SHAPE}`);
    return;
  }
  // Removes before adds, so {"remove": [x], "add": [x]} moves an inherited
  // entry to the end of the list and makes it this layer's own.
  if (raw.remove) out.push({ op: { op: "remove-from-list", list, values: [...raw.remove] }, where: `${where}.remove` });
  if (raw.add) out.push({ op: { op: "add-to-list", list, values: [...raw.add] }, where: `${where}.add` });
}

const ALLOW_SHAPE = `expected an array of templates (a string, or {"template": "…", "flags": [...]}), or {"add": [...], "remove": [...]}`;

/**
 * The added entries of `commands.allow`, which may mix plain templates with
 * `{template, flags}` objects. Plain strings stay one add-to-list op (exactly
 * what the list compiled to before flags existed); each object becomes its
 * own allow-command op, so one bad object costs only itself. A non-string,
 * non-object entry still drops the whole list, as for every other list.
 */
function compileAllowEntries(entries: unknown[], where: string, diagnostics: string[], out: LocatedOp[]): void {
  let pending: string[] = [];
  const flush = () => {
    if (pending.length > 0) out.push({ op: { op: "add-to-list", list: "commands.allow", values: pending }, where });
    pending = [];
  };
  entries.forEach((entry, index) => {
    if (typeof entry === "string") {
      pending.push(entry);
      return;
    }
    flush();
    const at = `${where}[${index}]`;
    const entryObject = entry as Record<string, unknown>;
    const extra = unexpectedKeys(entryObject, ["template", "flags"]);
    if (extra.length > 0) {
      diagnostics.push(`Ignoring ${at}: unexpected ${keyList(extra)} — an entry is a template string or {"template": "…", "flags": [...]}`);
      return;
    }
    const op = parseOp({ op: "allow-command", ...entryObject }, at, diagnostics);
    if (op) out.push({ op, where: at });
  });
  flush();
}

/** commands.allow in either list form, with object entries allowed among the adds. */
function compileAllowList(raw: unknown, where: string, diagnostics: string[], out: LocatedOp[]): void {
  if (raw === undefined) return;
  const entriesOk = (value: unknown): value is unknown[] => Array.isArray(value) && value.every((entry) => typeof entry === "string" || isObject(entry));
  if (Array.isArray(raw)) {
    if (!entriesOk(raw)) {
      diagnostics.push(`Ignoring ${where}: ${ALLOW_SHAPE}`);
      return;
    }
    compileAllowEntries(raw, where, diagnostics, out);
    return;
  }
  if (!isObject(raw)) {
    diagnostics.push(`Ignoring ${where}: ${ALLOW_SHAPE}`);
    return;
  }
  if ("replace" in raw || "values" in raw) {
    diagnostics.push(legacyListDiagnostic(where));
    return;
  }
  const extra = unexpectedKeys(raw, ["add", "remove"]);
  if (extra.length > 0) {
    diagnostics.push(`Ignoring ${where}: unexpected ${keyList(extra)} — ${ALLOW_SHAPE}`);
    return;
  }
  if ((raw.add !== undefined && !entriesOk(raw.add)) || (raw.remove !== undefined && !isStringArray(raw.remove))) {
    diagnostics.push(`Ignoring ${where}: ${ALLOW_SHAPE}`);
    return;
  }
  // Removes before adds, as compileList: see there.
  if (raw.remove) out.push({ op: { op: "remove-from-list", list: "commands.allow", values: [...raw.remove] }, where: `${where}.remove` });
  if (raw.add) compileAllowEntries(raw.add, `${where}.add`, diagnostics, out);
}

/** commands.classify: each entry becomes its own classify op, so one bad entry costs only itself. */
function compileClassify(raw: unknown, where: string, diagnostics: string[], out: LocatedOp[]): void {
  if (raw === undefined) return;
  let entries: unknown[];
  let base = where;
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (isObject(raw)) {
    if ("replace" in raw || "values" in raw) {
      diagnostics.push(legacyListDiagnostic(where));
      return;
    }
    const extra = unexpectedKeys(raw, ["add"]);
    if (extra.length > 0 || !Array.isArray(raw.add)) {
      diagnostics.push(`Ignoring ${where}: ${extra.includes("remove") ? "classify rules cannot be removed by a later layer — " : ""}${RULE_SHAPE}`);
      return;
    }
    entries = raw.add;
    base = `${where}.add`;
  } else {
    diagnostics.push(`Ignoring ${where}: ${RULE_SHAPE}`);
    return;
  }
  entries.forEach((entry, index) => {
    const at = `${base}[${index}]`;
    if (!isObject(entry)) {
      diagnostics.push(`Ignoring ${at}: ${RULE_SHAPE}`);
      return;
    }
    const extra = unexpectedKeys(entry, ["template", "capability", "flags"]);
    if (extra.length > 0) {
      diagnostics.push(`Ignoring ${at}: unexpected ${keyList(extra)} — an entry is {"template": "…", "capability": "…", "flags"?: [...]}`);
      return;
    }
    const op = parseOp({ op: "classify", ...entry }, at, diagnostics);
    if (op) out.push({ op, where: at });
  });
}

/** capabilities.classes entries, in the wording config users already know. */
function compileClasses(raw: unknown, where: string, diagnostics: string[], out: LocatedOp[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    diagnostics.push(`Ignoring ${where}: expected an array`);
    return;
  }
  raw.forEach((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isObject(entry)) {
      diagnostics.push(`Ignoring ${at}: expected an object`);
      return;
    }
    const op = parseOp({ ...entry, op: "add-class" }, at, diagnostics);
    if (op) out.push({ op, where: at });
  });
}

/**
 * Compiles one config file into its layer: validated settings, the base ops
 * its top-level keys mean, and its grants. Base ops are ordered taxonomy →
 * lists → classify rules → table, so a file may declare a class, classify into
 * it, and set its row in any key order and have it work.
 */
export function compileConfigLayer(rawConfig: Partial<RailConfig>, name: FileLayerName, file: string): PolicyLayer {
  const diagnostics: string[] = [];
  const settings: LayerSettings = {};
  const base: LocatedOp[] = [];
  const raw = rawConfig as Record<string, unknown> & Partial<RailConfig>;

  if (typeof raw.enabled === "boolean") settings.enabled = raw.enabled;
  if (raw.mode !== undefined) diagnostics.push(`Ignoring ${file}.mode: report-only mode has been removed`);

  if (raw.backend === "seatbelt" || raw.backend === "none" || raw.backend === "container") settings.backend = raw.backend;
  else if (raw.backend !== undefined) diagnostics.push(`Ignoring ${file}.backend: unsupported backend`);

  if (raw.statusLine === "always" || raw.statusLine === "never" || raw.statusLine === "auto") settings.statusLine = raw.statusLine;
  else if (raw.statusLine !== undefined) diagnostics.push(`Ignoring ${file}.statusLine: expected "always", "never", or "auto"`);

  // Taxonomy first: see the function comment.
  if (isObject(raw.capabilities)) {
    const capabilities = raw.capabilities as Record<string, unknown>;
    compileClasses(capabilities.classes, `${file}.capabilities.classes`, diagnostics, base);
    if (capabilities.definitions !== undefined) {
      if (!isObject(capabilities.definitions)) {
        diagnostics.push(`Ignoring ${file}.capabilities.definitions: expected an object of class id → definition`);
      } else {
        for (const [key, value] of Object.entries(capabilities.definitions)) {
          const at = `${file}.capabilities.definitions.${key}`;
          if (!isBuiltinCapabilityId(key)) {
            diagnostics.push(`Ignoring ${at}: not a built-in capability class`);
            continue;
          }
          if (typeof value !== "string" || !value.trim()) {
            diagnostics.push(`Ignoring ${at}: expected a non-empty string`);
            continue;
          }
          base.push({ op: { op: "set-definition", capability: key, definition: value.trim() }, where: at });
        }
      }
    }
  } else if (raw.capabilities !== undefined) {
    diagnostics.push(`Ignoring ${file}.capabilities: expected an object`);
  }

  if (isObject(raw.filesystem)) {
    const filesystem = raw.filesystem as Record<string, unknown>;
    if (typeof filesystem.enabled === "boolean") settings.filesystemEnabled = filesystem.enabled;
    for (const key of ["allowRead", "denyRead", "allowWrite", "denyWrite"] as const) {
      compileList(`filesystem.${key}`, filesystem[key], `${file}.filesystem.${key}`, diagnostics, base);
    }
  }
  if (isObject(raw.environment)) {
    const environment = raw.environment as Record<string, unknown>;
    for (const key of ["allow", "unset"] as const) compileList(`environment.${key}`, environment[key], `${file}.environment.${key}`, diagnostics, base);
  }
  if (isObject(raw.network)) {
    const network = raw.network as Record<string, unknown>;
    if (typeof network.enabled === "boolean") settings.networkEnabled = network.enabled;
    for (const key of ["allowedDomains", "deniedDomains"] as const) compileList(`network.${key}`, network[key], `${file}.network.${key}`, diagnostics, base);
  }
  if (isObject(raw.commands)) {
    const commands = raw.commands as Record<string, unknown>;
    compileAllowList(commands.allow, `${file}.commands.allow`, diagnostics, base);
    compileClassify(commands.classify, `${file}.commands.classify`, diagnostics, base);
  }

  if (isObject(raw.dispositions)) {
    for (const [key, value] of Object.entries(raw.dispositions)) {
      const at = `${file}.dispositions.${key}`;
      if (!isDisposition(value)) {
        diagnostics.push(`Ignoring ${at}: expected ${DISPOSITION_SHAPE}`);
        continue;
      }
      base.push({ op: { op: "set-disposition", capability: key, disposition: value }, where: at });
    }
  } else if (raw.dispositions !== undefined) {
    diagnostics.push(`Ignoring ${file}.dispositions: expected an object of class → disposition`);
  }

  if (isObject(raw.classifier)) {
    const classifier = raw.classifier as Record<string, unknown>;
    const next: Partial<ResolvedClassifierConfig> = {};
    if (typeof classifier.enabled === "boolean") next.enabled = classifier.enabled;
    if (typeof classifier.model === "string" && classifier.model.trim()) next.model = classifier.model.trim();
    if (typeof classifier.judgeModel === "string" && classifier.judgeModel.trim()) next.judgeModel = classifier.judgeModel.trim();
    if (typeof classifier.grantModel === "string" && classifier.grantModel.trim()) next.grantModel = classifier.grantModel.trim();
    if (typeof classifier.timeoutMs === "number" && Number.isFinite(classifier.timeoutMs) && classifier.timeoutMs > 0) {
      next.timeoutMs = Math.floor(classifier.timeoutMs);
    } else if (classifier.timeoutMs !== undefined) {
      diagnostics.push(`Ignoring ${file}.classifier.timeoutMs: expected a positive number`);
    }
    if (typeof classifier.failClosed === "boolean") next.failClosed = classifier.failClosed;
    if (classifier.telemetry !== undefined) {
      if (classifier.telemetry === "off" || classifier.telemetry === "minimal" || classifier.telemetry === "full") next.telemetry = classifier.telemetry;
      else diagnostics.push(`Ignoring ${file}.classifier.telemetry: expected "off", "minimal", or "full"`);
    }
    // Retired: the prose rule tiers are neither parsed nor merged. Old configs
    // still load, with one diagnostic pointing at what replaced them.
    if (classifier.rules !== undefined) {
      diagnostics.push(
        `Ignoring ${file}.classifier.rules: the prose rule tiers are gone. Capability mode names actions from the class taxonomy and decides via the disposition table — use "dispositions" and "capabilities.definitions" instead.`,
      );
    }
    settings.classifier = next;
  }

  if (isObject(raw.corpus)) {
    const corpus = raw.corpus as Record<string, unknown>;
    if (typeof corpus.enabled === "boolean") settings.corpusEnabled = corpus.enabled;
    else if (corpus.enabled !== undefined) diagnostics.push(`Ignoring ${file}.corpus.enabled: expected true or false`);
  } else if (raw.corpus !== undefined) {
    diagnostics.push(`Ignoring ${file}.corpus: expected an object`);
  }

  if (isObject(raw.seatbelt)) settings.seatbelt = { ...raw.seatbelt };
  if (isObject(raw.container)) settings.container = { ...raw.container };

  const grants = parseGrants(raw.grants, `${file}.grants`, diagnostics);
  return { name, file, settings, base, grants, diagnostics };
}

// ── The fold ─────────────────────────────────────────────────────────────────

/** A copy of `config` deep enough that applying ops to it never reaches back into `config`. */
function cloneForApply(config: ResolvedRailConfig): ResolvedRailConfig {
  return {
    ...config,
    filesystem: { ...config.filesystem, allowRead: [...config.filesystem.allowRead], denyRead: [...config.filesystem.denyRead], allowWrite: [...config.filesystem.allowWrite], denyWrite: [...config.filesystem.denyWrite] },
    environment: { allow: [...config.environment.allow], unset: [...config.environment.unset] },
    network: { ...config.network, allowedDomains: [...config.network.allowedDomains], deniedDomains: [...config.network.deniedDomains] },
    commands: {
      allow: [...config.commands.allow],
      allowFlags: Object.fromEntries(Object.entries(config.commands.allowFlags).map(([template, flags]) => [template, [...flags]])),
      classify: config.commands.classify.map((rule) => ({ ...rule, ...(rule.flags ? { flags: [...rule.flags] } : {}) })),
    },
    dispositions: { ...config.dispositions },
    capabilities: { classes: config.capabilities.classes.map((entry) => ({ ...entry })), definitions: { ...config.capabilities.definitions } },
    classifier: { ...config.classifier },
    corpus: { ...config.corpus },
    seatbelt: { ...config.seatbelt },
    container: { ...config.container },
    diagnostics: [...config.diagnostics],
    sources: [...config.sources],
    grants: [...config.grants],
    provenance: structuredClone(config.provenance),
  };
}

function getList(config: ResolvedRailConfig, list: StringListKey): string[] {
  switch (list) {
    case "filesystem.allowRead": return config.filesystem.allowRead;
    case "filesystem.denyRead": return config.filesystem.denyRead;
    case "filesystem.allowWrite": return config.filesystem.allowWrite;
    case "filesystem.denyWrite": return config.filesystem.denyWrite;
    case "environment.allow": return config.environment.allow;
    case "environment.unset": return config.environment.unset;
    case "network.allowedDomains": return config.network.allowedDomains;
    case "network.deniedDomains": return config.network.deniedDomains;
    case "commands.allow": return config.commands.allow;
  }
}

function setList(config: ResolvedRailConfig, list: StringListKey, values: string[]): void {
  switch (list) {
    case "filesystem.allowRead": config.filesystem.allowRead = values; return;
    case "filesystem.denyRead": config.filesystem.denyRead = values; return;
    case "filesystem.allowWrite": config.filesystem.allowWrite = values; return;
    case "filesystem.denyWrite": config.filesystem.denyWrite = values; return;
    case "environment.allow": config.environment.allow = values; return;
    case "environment.unset": config.environment.unset = values; return;
    case "network.allowedDomains": config.network.allowedDomains = values; return;
    case "network.deniedDomains": config.network.deniedDomains = values; return;
    case "commands.allow": config.commands.allow = values; return;
  }
}

/**
 * Whether an add-class op without an explicit `namer` leaves the class in the
 * namer's vocabulary. A class a named grant adds is rules-only (GRANTS_PLAN
 * decision "Grant-added classes are rules-only by default"): seen live, the
 * namer labelled `git worktree remove --force` with both worktree-cleanup and
 * local-destructive, and only severity-max kept it from being allowed. A class
 * from a file's base `capabilities.classes`, or added on the policy page (the
 * implicit session-edits grant), is a vocabulary entry the user wrote for the
 * namer, and keeps the namer default.
 */
export function addClassNamerDefault(provenance: Provenance): boolean {
  return provenance.grantId === undefined || provenance.grantId === SESSION_EDITS_GRANT_ID;
}

function knownClass(config: ResolvedRailConfig, id: string): boolean {
  return isBuiltinCapabilityId(id) || config.capabilities.classes.some((entry) => entry.id === id);
}

/**
 * Applies one op to `config` in place. Semantic checks — does the class this
 * op names exist yet — happen here rather than at parse time, because the
 * answer depends on everything folded before it: a session classify rule may
 * name a class a session grant added one op earlier.
 */
function applyOp(config: ResolvedRailConfig, op: PolicyOp, provenance: Provenance, where: string): void {
  const skip = (message: string) => void config.diagnostics.push(`Ignoring ${where}: ${message}`);
  switch (op.op) {
    case "set-disposition": {
      if (!knownClass(config, op.capability)) return skip(`unknown capability class "${op.capability}"`);
      config.dispositions[op.capability] = op.disposition;
      config.provenance.dispositions[op.capability] = provenance;
      return;
    }
    case "add-class": {
      const entry: CapabilityClass = {
        id: op.id,
        name: op.name ?? op.id,
        definition: op.definition,
        // New classes default to ask: an unnamed intent the user cared enough to
        // name is exactly the case for bringing them in, and it is the one default
        // that cannot silently widen what the agent may do.
        default: op.disposition ?? "ask",
        ...(op.extends ? { extends: op.extends } : {}),
        ...((op.namer ?? addClassNamerDefault(provenance)) ? {} : { namer: false }),
      };
      const at = config.capabilities.classes.findIndex((existing) => existing.id === op.id);
      // Same-id redeclaration keeps its position, so the namer payload order
      // (and with it the cacheable prefix) does not shuffle when a later layer
      // refines a class an earlier one declared.
      if (at === -1) config.capabilities.classes.push(entry);
      else config.capabilities.classes[at] = entry;
      config.provenance.classes[op.id] = provenance;
      return;
    }
    case "remove-class": {
      if (!config.capabilities.classes.some((entry) => entry.id === op.id)) return skip(`no custom class "${op.id}" to remove`);
      config.capabilities.classes = config.capabilities.classes.filter((entry) => entry.id !== op.id);
      // The row goes with the class. Classify rules naming it stay and resolve
      // to ask (getEffectiveDisposition's unknown-class rule): the safe
      // direction for a rule whose target vanished is to bring the user in.
      delete config.dispositions[op.id];
      delete config.provenance.dispositions[op.id];
      delete config.provenance.classes[op.id];
      delete config.provenance.definitions[op.id];
      return;
    }
    case "set-definition": {
      if (isBuiltinCapabilityId(op.capability)) {
        config.capabilities.definitions[op.capability] = op.definition;
      } else {
        // A custom class carries its definition inline; editing it rewrites the entry.
        const at = config.capabilities.classes.findIndex((entry) => entry.id === op.capability);
        if (at === -1) return skip(`unknown capability class "${op.capability}"`);
        config.capabilities.classes[at] = { ...config.capabilities.classes[at]!, definition: op.definition };
      }
      config.provenance.definitions[op.capability] = provenance;
      return;
    }
    case "classify": {
      if (!knownClass(config, op.capability)) {
        return skip(`"${op.capability}" is not a known capability class — declare it (capabilities.classes or an add-class op) first`);
      }
      const rule: CommandCapabilityRule = { template: op.template, capability: op.capability, ...(op.flags ? { flags: [...op.flags] } : {}) };
      const rules = config.commands.classify;
      const at = rules.findIndex((existing) => existing.template === op.template);
      // A restatement credits the layer that introduced the rule; a template
      // pointed at a different class or given different flags is a real
      // change, replaced whole (an op states the entire rule) and credited to
      // this layer, which is also what ranks it.
      if (at !== -1 && rules[at]!.capability === op.capability && sameFlags(rules[at]!.flags, op.flags)) return;
      if (at === -1) rules.push(rule);
      else rules[at] = rule;
      config.provenance.lists["commands.classify"][op.template] = provenance;
      return;
    }
    case "allow-command": {
      const current = config.commands.allowFlags[op.template];
      const present = config.commands.allow.includes(op.template);
      // Same flags (or a new entry): an ordinary list add, restatement rules
      // and all. Different flags on an entry already present: the op states
      // the whole rule, so its flags replace the old ones — absent flags
      // included, which means "any flags" — and the entry becomes this
      // layer's, since its meaning is now this layer's.
      if (op.flags) config.commands.allowFlags[op.template] = [...op.flags];
      else delete config.commands.allowFlags[op.template];
      if (present && !sameFlags(current, op.flags)) {
        config.provenance.lists["commands.allow"][op.template] = provenance;
        return;
      }
      return applyListAdd(config, "commands.allow", [op.template], provenance);
    }
    case "add-to-list":
    case "remove-from-list": {
      // Every list, sandbox-backed ones included, applies at every layer. The
      // session layer moves filesystem/network/environment lists mid-session;
      // the sandbox follows in the same step (src/session-policy.ts,
      // commitPolicyChange), or the change is undone.
      if (op.op === "add-to-list") applyListAdd(config, op.list, op.values, provenance);
      else {
        const drop = new Set(op.values);
        setList(config, op.list, getList(config, op.list).filter((value) => !drop.has(value)));
        for (const value of op.values) delete config.provenance.lists[op.list][value];
        // A dropped allow entry takes its flags with it, so re-adding the
        // template later starts from "any flags" as written, not a stale list.
        if (op.list === "commands.allow") for (const value of op.values) delete config.commands.allowFlags[value];
      }
      return;
    }
  }
}

/** Two flags allowlists say the same thing: both absent, or the same set. */
export function sameFlags(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((flag) => b.includes(flag));
}

/**
 * Appends what the list lacks. A value already present keeps its position;
 * its provenance moves only when it was a built-in default. Under append-only
 * lists nobody has to restate a default to keep it, so a layer that does is
 * claiming it — and the claim matters: Seatbelt's keychain read-back lifts
 * only default-provenance denyRead entries, so `"denyRead":
 * ["~/Library/Keychains"]` makes that deny the user's own. A restatement of an
 * entry an earlier non-default layer introduced still credits the introducer,
 * so revoking the later grant cannot look like it would drop the entry.
 */
function applyListAdd(config: ResolvedRailConfig, list: StringListKey, values: string[], provenance: Provenance): void {
  const current = getList(config, list);
  const sources = config.provenance.lists[list];
  for (const value of values) {
    if (current.includes(value)) {
      if (provenance.layer !== "default" && (sources[value]?.layer ?? "default") === "default") sources[value] = provenance;
      continue;
    }
    current.push(value);
    sources[value] = provenance;
  }
}

/** Applies ops to `config` in place under one provenance. Exposed for Ctrl+S, which folds a promotion into the live config. */
export function applyOpsInPlace(config: ResolvedRailConfig, ops: readonly PolicyOp[], provenance: Provenance, where = "op"): void {
  ops.forEach((op, index) => applyOp(config, op, provenance, `${where}[${index}] (${op.op})`));
}

function grantWhere(layer: PolicyLayer, grant: Grant): string {
  return `${layer.file ?? layer.name} grant ${grant.id}`;
}

/** One layer over an already-resolved config: settings, base ops, then grants in order. Returns a new config. */
export function applyLayer(base: ResolvedRailConfig, layer: PolicyLayer): ResolvedRailConfig {
  const next = cloneForApply(base);
  next.sources.push(layer.file ?? layer.name);
  next.diagnostics.push(...layer.diagnostics);

  const settings = layer.settings;
  if (settings.enabled !== undefined) next.enabled = settings.enabled;
  if (settings.backend !== undefined) next.backend = settings.backend;
  if (settings.statusLine !== undefined) next.statusLine = settings.statusLine;
  if (settings.filesystemEnabled !== undefined) next.filesystem.enabled = settings.filesystemEnabled;
  if (settings.networkEnabled !== undefined) next.network.enabled = settings.networkEnabled;
  if (settings.classifier) next.classifier = { ...next.classifier, ...settings.classifier };
  if (settings.corpusEnabled !== undefined) next.corpus.enabled = settings.corpusEnabled;
  if (settings.seatbelt) next.seatbelt = { ...next.seatbelt, ...settings.seatbelt };
  if (settings.container) next.container = { ...next.container, ...settings.container };

  const fileProvenance = (grantId?: string): Provenance => ({
    layer: layer.name,
    ...(grantId ? { grantId } : {}),
    ...(layer.file ? { file: layer.file } : {}),
  });
  const baseProvenance = fileProvenance();
  for (const { op, where } of layer.base) applyOp(next, op, baseProvenance, where);
  for (const grant of layer.grants) {
    const provenance = fileProvenance(grant.id);
    const where = grantWhere(layer, grant);
    grant.ops.forEach((op, index) => applyOp(next, op, provenance, `${where} ops[${index}] (${op.op})`));
    next.grants.push({ layer: layer.name, id: grant.id, request: grant.request, ...(layer.file ? { file: layer.file } : {}) });
  }
  return next;
}

/** The whole stack, in order: defaults, then each layer. Same layers in, same config out. */
export function foldPolicy(defaults: ResolvedRailConfig, layers: readonly PolicyLayer[]): ResolvedRailConfig {
  let config = cloneForApply(defaults);
  for (const layer of layers) config = applyLayer(config, layer);
  return config;
}

// ── The session layer ────────────────────────────────────────────────────────

/**
 * Session-scoped grants. `edits` is the implicit `session-edits` grant, kept
 * as a bare op list because only the editing helpers below write it and Ctrl+S
 * promotes it into base keys rather than as a grant. `revision` changes on
 * every mutation; the effective-config cache keys on it.
 */
export interface SessionLayer {
  grants: Grant[];
  edits: PolicyOp[];
  revision: number;
}

export function createSessionLayer(): SessionLayer {
  return { grants: [], edits: [], revision: 0 };
}

export function sessionLayerIsEmpty(session: SessionLayer): boolean {
  return session.edits.length === 0 && session.grants.length === 0;
}

export function sessionEditsGrant(session: SessionLayer): Grant {
  return { id: SESSION_EDITS_GRANT_ID, request: "Edits made this session with /rail policy and /rail set", created: "", ops: session.edits };
}

/**
 * The session layer as a fold layer. Named grants apply first and the page
 * edits last: an edit on the policy page is the most direct statement of what
 * the user wants right now, so it is what wins.
 */
export function sessionPolicyLayer(session: SessionLayer, options: { includeEdits?: boolean } = {}): PolicyLayer {
  const includeEdits = options.includeEdits ?? true;
  return {
    name: "session",
    settings: {},
    base: [],
    grants: includeEdits && session.edits.length > 0 ? [...session.grants, sessionEditsGrant(session)] : [...session.grants],
    diagnostics: [],
  };
}

// The effective config is the base (files folded) with the session layer on
// top. Derived configs remember their base, so code that is handed either one
// can always get back to the persisted view — dispositions.ts needs both, and
// a caller re-assigning state.config with a derived object must not stack the
// session layer twice.
const baseOfDerived = new WeakMap<ResolvedRailConfig, ResolvedRailConfig>();
const sessionCache = new WeakMap<ResolvedRailConfig, { session: SessionLayer; revision: number; value: ResolvedRailConfig }>();

/** The persisted (file-folded) config behind `config`: itself unless it was derived by withSessionLayer. */
export function baseConfigOf(config: ResolvedRailConfig): ResolvedRailConfig {
  return baseOfDerived.get(config) ?? config;
}

/**
 * `config` with the session layer applied, cached per (base, session,
 * revision). Cheap on the hot path: every tool call reads state.config, and
 * it only refolds when the session layer actually changed. An empty session
 * returns the base object itself.
 */
export function withSessionLayer(config: ResolvedRailConfig, session: SessionLayer | undefined): ResolvedRailConfig {
  const base = baseConfigOf(config);
  if (!session || sessionLayerIsEmpty(session)) return base;
  const cached = sessionCache.get(base);
  if (cached && cached.session === session && cached.revision === session.revision) return cached.value;
  const value = applyLayer(base, sessionPolicyLayer(session));
  baseOfDerived.set(value, base);
  sessionCache.set(base, { session, revision: session.revision, value });
  return value;
}

/** Drops the cached derived config of `base`; call after mutating a base in place. */
export function invalidateSessionCache(base: ResolvedRailConfig): void {
  sessionCache.delete(baseConfigOf(base));
}

/** `config` with only the named session grants, not the page edits: what a row would be with its edit undone. */
export function withoutSessionEdits(config: ResolvedRailConfig, session: SessionLayer | undefined): ResolvedRailConfig {
  const base = baseConfigOf(config);
  if (!session || session.grants.length === 0) return base;
  return applyLayer(base, sessionPolicyLayer(session, { includeEdits: false }));
}

function bump(session: SessionLayer): void {
  session.revision++;
}

/**
 * Sets (or with undefined clears) this session's edit of one table row. A row
 * has at most one edit, so the op list never grows by cycling a row back and
 * forth.
 */
export function editSessionDisposition(session: SessionLayer, id: CapabilityId, disposition: Disposition | undefined): void {
  const at = session.edits.findIndex((op) => op.op === "set-disposition" && op.capability === id);
  if (disposition === undefined) {
    if (at !== -1) session.edits = session.edits.filter((_, index) => index !== at);
  } else if (at === -1) {
    session.edits = [...session.edits, { op: "set-disposition", capability: id, disposition }];
  } else {
    session.edits = session.edits.map((op, index) => (index === at ? { op: "set-disposition", capability: id, disposition } : op));
  }
  bump(session);
}

/** Adds a class at session scope; re-adding a class this session removed un-removes it. */
export function editSessionAddClass(session: SessionLayer, entry: CapabilityClass): void {
  const op: PolicyOp = {
    op: "add-class",
    id: entry.id,
    ...(entry.name && entry.name !== entry.id ? { name: entry.name } : {}),
    definition: entry.definition,
    disposition: entry.default,
    ...(entry.extends ? { extends: entry.extends } : {}),
    ...(entry.namer !== undefined ? { namer: entry.namer } : {}),
  };
  const kept = session.edits.filter((existing) => !((existing.op === "remove-class" || existing.op === "add-class") && existing.id === entry.id));
  // Class ops lead the list so a row edit for the class (which validates
  // against the classes folded so far) never precedes the class itself.
  session.edits = [op, ...kept];
  bump(session);
}

/**
 * Edits any class's definition at session scope. A class this session added
 * carries the edit inside its own add-class op, the way it will be persisted.
 */
export function editSessionDefinition(session: SessionLayer, id: CapabilityId, definition: string): void {
  const added = session.edits.findIndex((op) => op.op === "add-class" && op.id === id);
  if (added !== -1) {
    session.edits = session.edits.map((op, index) => (index === added && op.op === "add-class" ? { ...op, definition } : op));
  } else {
    const kept = session.edits.filter((op) => !(op.op === "set-definition" && op.capability === id));
    session.edits = [...kept, { op: "set-definition", capability: id, definition }];
  }
  bump(session);
}

/**
 * Removes a custom class at session scope. A class this session added is
 * simply forgotten, with its row and definition edits; a persisted one gets a
 * remove-class op so Ctrl+S removes it from the config too.
 */
export function editSessionDeleteClass(session: SessionLayer, id: CapabilityId): void {
  const wasSessionAdded = session.edits.some((op) => op.op === "add-class" && op.id === id);
  const kept = session.edits.filter((op) => {
    if ((op.op === "add-class" || op.op === "remove-class") && op.id === id) return false;
    if ((op.op === "set-definition" || op.op === "set-disposition") && op.capability === id) return false;
    return true;
  });
  session.edits = wasSessionAdded ? kept : [...kept, { op: "remove-class", id }];
  bump(session);
}

export function clearSessionEdits(session: SessionLayer): void {
  session.edits = [];
  bump(session);
}

/** Adds a named session grant, replacing one with the same id. */
export function addSessionGrant(session: SessionLayer, grant: Grant): void {
  session.grants = [...session.grants.filter((existing) => existing.id !== grant.id), grant];
  bump(session);
}

export function removeSessionGrant(session: SessionLayer, id: string): boolean {
  const before = session.grants.length;
  session.grants = session.grants.filter((grant) => grant.id !== id);
  if (session.grants.length === before) return false;
  bump(session);
  return true;
}

// ── Promotion, demotion, revocation ──────────────────────────────────────────

/** The grants arrays of every layer that has one. */
export interface LayeredGrants {
  global: Grant[];
  project: Grant[];
  session: Grant[];
}

export type GrantLayerName = keyof LayeredGrants;

export type GrantMoveResult = { ok: true; grants: LayeredGrants } | { ok: false; error: string };

/**
 * Moves a grant between layers unchanged — promotion and demotion rewrite
 * nothing, which is what keeps a grant's examples and provenance meaningful
 * wherever it lives. Pure: returns new arrays and leaves the input alone.
 */
export function moveGrant(grants: LayeredGrants, id: string, from: GrantLayerName, to: GrantLayerName): GrantMoveResult {
  if (from === to) return { ok: false, error: `${id} is already in the ${to} layer` };
  const grant = grants[from].find((entry) => entry.id === id);
  if (!grant) return { ok: false, error: `no grant "${id}" in the ${from} layer` };
  if (grants[to].some((entry) => entry.id === id)) return { ok: false, error: `the ${to} layer already has a grant "${id}"` };
  return {
    ok: true,
    grants: { ...grants, [from]: grants[from].filter((entry) => entry.id !== id), [to]: [...grants[to], grant] },
  };
}

/** Session → a config file's grants. */
export function promoteGrant(grants: LayeredGrants, id: string, to: FileLayerName): GrantMoveResult {
  return moveGrant(grants, id, "session", to);
}

/** A config file's grants → session, e.g. to try running without it saved. */
export function demoteGrant(grants: LayeredGrants, id: string, from: FileLayerName): GrantMoveResult {
  return moveGrant(grants, id, from, "session");
}

/** Revoking is deleting the grant: nothing else in the layer is rewritten. */
export function revokeGrant(grants: LayeredGrants, id: string, layer: GrantLayerName): GrantMoveResult {
  if (!grants[layer].some((entry) => entry.id === id)) return { ok: false, error: `no grant "${id}" in the ${layer} layer` };
  return { ok: true, grants: { ...grants, [layer]: grants[layer].filter((entry) => entry.id !== id) } };
}

// ── Writing ops back as base keys ────────────────────────────────────────────

/**
 * Rewrites a raw config object so its base keys also say what `ops` say — the
 * Ctrl+S promotion of `session-edits` for op kinds the policy page does not
 * produce itself (its own three kinds go through the narrower writers in
 * persistent-settings.ts). Lists stay in whichever form the file used; a
 * remove turns a bare array into the object form, since an array can only add.
 */
export function applyOpsToRawConfig(raw: RailConfig, ops: readonly PolicyOp[]): RailConfig {
  const next = structuredClone(raw) as RailConfig & Record<string, unknown>;
  const section = (key: string): Record<string, unknown> => {
    const existing = next[key];
    if (isObject(existing)) return existing;
    const created: Record<string, unknown> = {};
    next[key] = created;
    return created;
  };
  // Entries are strings, except that commands.allow may hold {template, flags}
  // objects; both compare by template. `replace` is allow-command's "this op
  // states the whole rule" (an existing entry is rewritten, flags and all),
  // against add-to-list's restatement, which leaves an existing entry alone.
  type Entry = string | { template: string; flags: string[] };
  const entryKey = (entry: unknown): unknown => (isObject(entry) && typeof entry.template === "string" ? entry.template : entry);
  const editList = (list: StringListKey, add: Entry[], remove: string[], replace = false) => {
    const [top, key] = list.split(".") as [string, string];
    const holder = section(top);
    const current = holder[key];
    let form: { add?: Entry[]; remove?: string[] } = Array.isArray(current) ? { add: [...(current as Entry[])] } : isObject(current) ? { ...(current as { add?: Entry[]; remove?: string[] }) } : {};
    if (remove.length > 0) {
      form.add = (form.add ?? []).filter((value) => !remove.includes(entryKey(value) as string));
      form.remove = [...(form.remove ?? []), ...remove.filter((value) => !(form.remove ?? []).includes(value))];
    }
    if (add.length > 0) {
      const addKeys = add.map(entryKey);
      form.remove = form.remove?.filter((value) => !addKeys.includes(value));
      const kept = [...(form.add ?? [])];
      for (const entry of add) {
        const at = kept.findIndex((existing) => entryKey(existing) === entryKey(entry));
        if (at === -1) kept.push(entry);
        else if (replace) kept[at] = entry;
      }
      form.add = kept;
    }
    if (form.remove && form.remove.length === 0) delete form.remove;
    if (form.add && form.add.length === 0 && !form.remove) form = {};
    holder[key] = form.remove ? form : (form.add ?? []);
  };

  for (const op of ops) {
    switch (op.op) {
      case "set-disposition":
        section("dispositions")[op.capability] = op.disposition;
        break;
      case "add-class": {
        const capabilities = section("capabilities");
        const classes = Array.isArray(capabilities.classes) ? [...capabilities.classes] : [];
        const entry = {
          id: op.id,
          ...(op.name ? { name: op.name } : {}),
          definition: op.definition,
          ...(op.disposition ? { disposition: op.disposition } : {}),
          ...(op.extends ? { extends: op.extends } : {}),
          ...(op.namer !== undefined ? { namer: op.namer } : {}),
        };
        const at = classes.findIndex((existing) => isObject(existing) && existing.id === op.id);
        if (at === -1) classes.push(entry);
        else classes[at] = entry;
        capabilities.classes = classes;
        break;
      }
      case "remove-class": {
        const capabilities = section("capabilities");
        if (Array.isArray(capabilities.classes)) capabilities.classes = capabilities.classes.filter((existing) => !(isObject(existing) && existing.id === op.id));
        break;
      }
      case "set-definition": {
        const capabilities = section("capabilities");
        if (isBuiltinCapabilityId(op.capability)) {
          capabilities.definitions = { ...(isObject(capabilities.definitions) ? capabilities.definitions : {}), [op.capability]: op.definition };
        } else if (Array.isArray(capabilities.classes)) {
          capabilities.classes = capabilities.classes.map((existing) => (isObject(existing) && existing.id === op.capability ? { ...existing, definition: op.definition } : existing));
        }
        break;
      }
      case "classify": {
        const commands = section("commands");
        const current = commands.classify;
        const rules = Array.isArray(current) ? [...current] : isObject(current) && Array.isArray(current.add) ? [...current.add] : [];
        const at = rules.findIndex((rule) => isObject(rule) && rule.template === op.template);
        const rule = { template: op.template, capability: op.capability, ...(op.flags ? { flags: [...op.flags] } : {}) };
        if (at === -1) rules.push(rule);
        else rules[at] = rule;
        commands.classify = rules;
        break;
      }
      case "allow-command":
        editList("commands.allow", [op.flags ? { template: op.template, flags: [...op.flags] } : op.template], [], true);
        break;
      case "add-to-list":
        editList(op.list, op.values, []);
        break;
      case "remove-from-list":
        editList(op.list, [], op.values);
        break;
    }
  }
  return next;
}

// ── Labels ───────────────────────────────────────────────────────────────────

/**
 * "default", "global", "project · worktree-cleanup", "session". The implicit
 * session-edits grant reads as plain "session": it is not a grant anyone named.
 */
export function provenanceLabel(provenance: Provenance | undefined): string {
  if (!provenance || provenance.layer === "default") return "default";
  if (!provenance.grantId || provenance.grantId === SESSION_EDITS_GRANT_ID) return provenance.layer;
  return `${provenance.layer} · ${provenance.grantId}`;
}

/** Where an effective disposition came from, in provenance-label form; a preset reads "read-only preset". */
export function effectiveDispositionLabel(entry: EffectiveDisposition): string {
  if (entry.scope === "preset") return `${entry.source} preset`;
  if (entry.scope === "default") return "default";
  return provenanceLabel(entry.provenance);
}

// ── Command rules for the matcher ────────────────────────────────────────────

const LAYER_ORDER: Record<PolicyLayerName, number> = { default: 0, global: 1, project: 2, session: 3 };

/**
 * A rule's fold position as the matcher's ranking step (d) reads it:
 * [layer, grant], where grant is 0 for a layer's base keys and 1 + the
 * grant's index in the fold for a named grant (session-edits included, which
 * the session layer applies last). Fold order is exactly "later overrides
 * earlier", so ranking by it keeps that meaning without the matcher knowing
 * anything about layers.
 */
export function provenanceRank(config: ResolvedRailConfig, provenance: Provenance | undefined): [number, number] {
  if (!provenance) return [0, 0];
  const layer = LAYER_ORDER[provenance.layer];
  if (!provenance.grantId) return [layer, 0];
  const at = config.grants.findIndex((grant) => grant.layer === provenance.layer && grant.id === provenance.grantId);
  return [layer, at === -1 ? 0 : at + 1];
}

/**
 * The matcher's rule pool for a resolved config: every classify rule and
 * every allow entry, each with its flags, its fold rank, and a provenance
 * label for explanations. `disposition` resolves a class for ranking step (e);
 * by default the folded table without any session preset — the interceptor
 * passes one that includes the preset.
 */
export function commandRulesOf(config: ResolvedRailConfig, disposition?: (capability: CapabilityId) => Disposition): CommandRuleSet {
  const rules: CommandRule[] = [];
  const classifyProvenance = config.provenance.lists["commands.classify"];
  for (const rule of config.commands.classify) {
    const provenance = classifyProvenance[rule.template];
    rules.push({
      template: rule.template,
      capability: rule.capability,
      ...(rule.flags ? { flags: rule.flags } : {}),
      source: "classify",
      // No classify rule is built in, so one without provenance (a config
      // assembled in code rather than folded) still ranks above the defaults.
      rank: provenance ? provenanceRank(config, provenance) : [LAYER_ORDER.global, 0],
      ...(provenance ? { origin: provenanceLabel(provenance) } : {}),
      ...(namedGrantOf(provenance) ? { grant: namedGrantOf(provenance) } : {}),
    });
  }
  const allowProvenance = config.provenance.lists["commands.allow"];
  for (const template of config.commands.allow) {
    const provenance = allowProvenance[template];
    const flags = config.commands.allowFlags[template];
    rules.push({
      template,
      capability: capabilityForTemplate(template),
      ...(flags ? { flags } : {}),
      source: "allow",
      rank: provenance ? provenanceRank(config, provenance) : [DEFAULT_COMMAND_ALLOWLIST.includes(template) ? LAYER_ORDER.default : LAYER_ORDER.global, 0],
      ...(provenance ? { origin: provenanceLabel(provenance) } : {}),
      ...(namedGrantOf(provenance) ? { grant: namedGrantOf(provenance) } : {}),
    });
  }
  return { rules, disposition: disposition ?? ((capability) => getEffectiveDisposition(config, undefined, capability).disposition) };
}

/** The named grant behind an entry: its grant id, unless that is the implicit session-edits grant or there is none. */
export function namedGrantOf(provenance: Provenance | undefined): string | undefined {
  const id = provenance?.grantId;
  return id && id !== SESSION_EDITS_GRANT_ID ? id : undefined;
}

/**
 * The named grant that produced a decision, for the `grant` field on review
 * records and for /rail explain: the grant whose classify/allow rule produced
 * the deciding label when a rule did, else the grant that set the deciding
 * class's table row, else the grant that declared the class (its default is
 * the row). A preset-decided label belongs to no grant — read-only mode
 * decided, whatever wrote the label. `segments` are the matched command
 * segments when a command rule labelled the action.
 */
export function decidingGrant(
  config: ResolvedRailConfig,
  decidedBy: EffectiveDisposition,
  segments?: ReadonlyArray<{ capability?: CapabilityId; grant?: string }>,
): string | undefined {
  if (decidedBy.scope === "preset") return undefined;
  const rule = segments?.find((segment) => segment.capability === decidedBy.id && segment.grant);
  if (rule?.grant) return rule.grant;
  const row = namedGrantOf(decidedBy.provenance);
  if (row) return row;
  if (decidedBy.scope === "default" && !isBuiltinCapabilityId(decidedBy.id)) return namedGrantOf(config.provenance.classes[decidedBy.id]);
  return undefined;
}

// ── Direction ────────────────────────────────────────────────────────────────

export type OpDirection = "widening" | "tightening" | "neutral";

/** Every command `older` accepts, `newer` accepts too: no flags list (any flags), or a superset. */
function flagsCover(newer: readonly string[] | undefined, older: readonly string[] | undefined): boolean {
  if (newer === undefined) return true;
  if (older === undefined) return false;
  return older.every((flag) => newer.includes(flag));
}

const DENY_LISTS: StringListKey[] = ["filesystem.denyRead", "filesystem.denyWrite", "network.deniedDomains", "environment.unset"];

/**
 * Whether `op`, applied over `before`, can only loosen, can only tighten, or
 * changes nothing. Conservative by construction: anything not provably
 * tightening or neutral is widening, so a later gate that auto-applies
 * tightening ops can never be talked into a loosening one. The grant gates
 * (src/grant-eval.ts) read it: a widening op needs a negative example.
 */
export function opDirection(op: PolicyOp, before: ResolvedRailConfig, provenance?: Provenance): OpDirection {
  switch (op.op) {
    case "set-disposition": {
      const current = getEffectiveDisposition(before, undefined, op.capability).disposition;
      if (op.disposition === current) return "neutral";
      return isStricter(op.disposition, current) ? "tightening" : "widening";
    }
    case "add-class": {
      const existing = before.capabilities.classes.find((entry) => entry.id === op.id);
      const disposition = op.disposition ?? "ask";
      if (!existing) {
        // Severity-max: a label resolving to deny can only make an action
        // stricter, whatever other labels it carries. Any other disposition
        // could pull an action the namer used to put somewhere stricter.
        return disposition === "deny" ? "tightening" : "widening";
      }
      // A redeclaration with new wording moves the namer's boundaries, which
      // is never provably one direction — and so does moving the class into or
      // out of the namer's vocabulary (`provenance`, where the op will apply,
      // decides the default when the op does not say; without it an op that
      // does not say is taken to keep the class's current visibility).
      if (existing.definition !== op.definition) return "widening";
      const namer = op.namer ?? (provenance ? addClassNamerDefault(provenance) : existing.namer !== false);
      if ((existing.namer !== false) !== namer) return "widening";
      if (existing.extends !== op.extends) {
        // Dropping the parent can only bring presets down on the class (a
        // parentless class is a writing class to every preset); any other
        // change of parent may take a preset's deny away.
        if (op.extends !== undefined) return "widening";
        return disposition === existing.default || isStricter(disposition, existing.default) ? "tightening" : "widening";
      }
      if (disposition === existing.default) return "neutral";
      return isStricter(disposition, existing.default) ? "tightening" : "widening";
    }
    case "remove-class": {
      const existing = before.capabilities.classes.find((entry) => entry.id === op.id);
      if (!existing) return "neutral";
      // Removing an allow class pushes its actions into classes that are at
      // least as strict; removing anything stricter might push them to allow.
      return getEffectiveDisposition(before, undefined, op.id).disposition === "allow" ? "tightening" : "widening";
    }
    case "set-definition": {
      const current = isBuiltinCapabilityId(op.capability)
        ? before.capabilities.definitions[op.capability]
        : before.capabilities.classes.find((entry) => entry.id === op.capability)?.definition;
      return current === op.definition ? "neutral" : "widening";
    }
    case "classify": {
      const existing = before.commands.classify.find((rule) => rule.template === op.template);
      if (existing && existing.capability === op.capability && sameFlags(existing.flags, op.flags)) return "neutral";
      // A deterministic deny label is the strictest outcome there is — for the
      // commands the new rule matches. Replacing a rule whose flags matched
      // MORE commands hands the difference to whatever ranks next, which may
      // be an allow, so that is only tightening when the new flags cover the
      // old ones.
      const deny = getEffectiveDisposition(before, undefined, op.capability).disposition === "deny";
      return deny && (!existing || flagsCover(op.flags, existing.flags)) ? "tightening" : "widening";
    }
    case "allow-command":
      // Narrowing an allow entry's flags is not provably tightening either:
      // the commands it stops matching fall to the next-ranked rule, which
      // may be looser than the namer would have been.
      return before.commands.allow.includes(op.template) && sameFlags(before.commands.allowFlags[op.template], op.flags) ? "neutral" : "widening";
    case "add-to-list": {
      const current = getList(before, op.list);
      if (op.values.every((value) => current.includes(value))) {
        // A pure restatement changes no list, but restating a built-in default
        // claims it (applyListAdd), and on a deny list that claim can only
        // tighten: Seatbelt's keychain read-back stands down for a claimed
        // ~/Library/Keychains deny. Never widening either way.
        const sources = before.provenance.lists[op.list];
        const claimsDefault = op.values.some((value) => (sources[value]?.layer ?? "default") === "default");
        return DENY_LISTS.includes(op.list) && claimsDefault ? "tightening" : "neutral";
      }
      if (DENY_LISTS.includes(op.list)) return "tightening";
      // An empty allowRead is blacklist mode (read anything not denied); its
      // first entry switches to whitelist mode, which only narrows. An empty
      // environment.allow likewise passes every variable not unset.
      if ((op.list === "filesystem.allowRead" || op.list === "environment.allow") && current.length === 0) return "tightening";
      return "widening";
    }
    case "remove-from-list": {
      const current = getList(before, op.list);
      const removed = op.values.filter((value) => current.includes(value));
      if (removed.length === 0) return "neutral";
      if (DENY_LISTS.includes(op.list)) return "widening";
      // Emptying allowRead flips back to blacklist mode: the widest read
      // policy. Emptying environment.allow passes the whole environment.
      if ((op.list === "filesystem.allowRead" || op.list === "environment.allow") && current.every((value) => removed.includes(value))) return "widening";
      return "tightening";
    }
  }
}
