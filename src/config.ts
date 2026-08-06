import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_CAPABILITY_IDS,
  CUSTOM_CLASS_ID_PATTERN,
  DEFAULT_DISPOSITIONS,
  isBuiltinCapabilityId,
  isDisposition,
  type CapabilityClass,
  type CapabilityId,
  type Disposition,
} from "./capabilities.ts";
import { commandTemplateProblem, DEFAULT_COMMAND_ALLOWLIST, type CommandCapabilityRule } from "./command-allowlist.ts";
import { formatError } from "./util.ts";

export type RailBackendName = "seatbelt" | "none" | "container";

/** When the rail statusline is visible: always, never, or auto (only when the rail is off/erroring or something was denied since the last user message). */
export type StatusLineMode = "always" | "never" | "auto";

export interface ClassifierConfig {
  enabled?: boolean;
  model?: string;
  /** Model for the `judge` disposition's escalation review; "current" uses the session model. */
  judgeModel?: string;
  timeoutMs?: number;
  failClosed?: boolean;
  /** Decision telemetry written to pi's session log: off, minimal (truncated), or full. */
  telemetry?: "off" | "minimal" | "full";
}

export interface ResolvedClassifierConfig {
  enabled: boolean;
  model: string;
  judgeModel: string;
  timeoutMs: number;
  failClosed: boolean;
  telemetry: "off" | "minimal" | "full";
}

/** One persisted custom capability class. `definition` is prompt text the namer reads verbatim. */
export interface CapabilityClassConfig {
  id?: unknown;
  name?: unknown;
  definition?: unknown;
  disposition?: unknown;
}

export interface CapabilitiesConfig {
  /** Custom classes that join the taxonomy. Merged by id across layers. */
  classes?: CapabilityClassConfig[];
  /** Replacement prompt text for built-in classes, keyed by built-in class id. */
  definitions?: Record<string, string>;
}

/**
 * The object form of a config list, for layers that want to add to the
 * inherited list rather than restate it. `replace: true` is exactly the bare
 * array; `replace: false` appends `values` to whatever the layer inherited.
 */
export interface ConfigListOverride {
  replace: boolean;
  values: string[];
}

/**
 * One list in a config file. A bare array replaces the inherited list wholesale
 * — the original meaning, and still what an array means — so every config
 * written before the object form existed keeps working unchanged.
 */
export type ConfigList = string[] | ConfigListOverride;

/** One `commands.classify` entry as written in config: a template and the class it resolves to. */
export interface CommandClassifyConfig {
  template?: unknown;
  capability?: unknown;
}

/** `commands.classify` in either list form; the entries are objects rather than strings. */
export type ConfigRuleList = CommandClassifyConfig[] | { replace: boolean; values: CommandClassifyConfig[] };

export interface RailConfig {
  enabled?: boolean;
  backend?: RailBackendName;
  statusLine?: StatusLineMode;
  filesystem?: {
    enabled?: boolean;
    allowRead?: ConfigList;
    denyRead?: ConfigList;
    allowWrite?: ConfigList;
    denyWrite?: ConfigList;
  };
  environment?: {
    allow?: ConfigList;
    unset?: ConfigList;
  };
  network?: {
    enabled?: boolean;
    allowedDomains?: ConfigList;
    deniedDomains?: ConfigList;
  };
  commands?: {
    allow?: ConfigList;
    classify?: ConfigRuleList;
  };
  /** Capability disposition table: class id → allow | judge | ask | deny. Omitted classes keep their default. */
  dispositions?: Record<string, string>;
  /** Custom capability classes and built-in definition overrides — the editable half of the taxonomy. */
  capabilities?: CapabilitiesConfig;
  classifier?: ClassifierConfig;
  seatbelt?: Record<string, unknown>;
  container?: Record<string, unknown>;
}

export type ProvenanceListKey =
  | "filesystem.allowRead"
  | "filesystem.denyRead"
  | "filesystem.allowWrite"
  | "filesystem.denyWrite"
  | "environment.allow"
  | "environment.unset"
  | "network.allowedDomains"
  | "network.deniedDomains"
  | "commands.allow"
  /** Keyed by template: a classify entry is an object, and its template is its identity. */
  | "commands.classify";

/** Where each effective config value came from ("default" or a config file path); last writer wins. */
export interface ConfigProvenance {
  /** Entry text → source, per list. An extended list carries one source per entry. */
  lists: Record<ProvenanceListKey, Record<string, string>>;
  /** Capability class id → source; "default" until a config file sets the row. */
  dispositions: Record<CapabilityId, string>;
  /** Custom class id → the config file that defined it. Per-id, like dispositions: classes merge by id, not wholesale. */
  capabilityClasses: Record<string, string>;
  /** Built-in class id → the config file that overrode its definition. */
  capabilityDefinitions: Record<string, string>;
}

export interface ResolvedRailConfig {
  enabled: boolean;
  backend: RailBackendName;
  statusLine: StatusLineMode;
  filesystem: {
    enabled: boolean;
    allowRead: string[];
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  environment: {
    allow: string[];
    unset: string[];
  };
  network: {
    enabled: boolean;
    allowedDomains: string[];
    deniedDomains: string[];
  };
  commands: {
    allow: string[];
    /** User template → capability mappings, in precedence order (first match wins). */
    classify: CommandCapabilityRule[];
  };
  /** Fully resolved disposition table: every capability class has a row. */
  dispositions: Record<CapabilityId, Disposition>;
  /** Resolved taxonomy edits; capabilityRegistry() folds these over the built-ins. */
  capabilities: {
    /** Custom classes in declaration order, already validated and defaulted. */
    classes: CapabilityClass[];
    /** Built-in id → replacement definition. */
    definitions: Record<string, string>;
  };
  classifier: ResolvedClassifierConfig;
  seatbelt: Record<string, unknown>;
  container: Record<string, unknown>;
  diagnostics: string[];
  sources: string[];
  provenance: ConfigProvenance;
}

function defaultDenyReadPaths(): string[] {
  return [
    "~/.ssh",
    "~/.aws",
    "~/.azure",
    "~/.config/gcloud",
    "~/.gnupg",
    "~/.kube",
    "~/.docker",
    "~/.netrc",
    "~/.npmrc",
    "~/.pypirc",
    "~/.gem/credentials",
    "~/.password-store",
    "~/.local/share/keyrings",
    "~/.mozilla/firefox",
    "~/.config/google-chrome",
    "~/.config/chromium",
    "~/.config/BraveSoftware",
    "~/Library/Keychains",
    "~/Library/Application Support/Google/Chrome",
    "~/Library/Application Support/Chromium",
    "~/Library/Application Support/BraveSoftware",
    "~/Library/Application Support/Firefox",
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
  ];
}

function defaultAllowedNetworkDomains(): string[] {
  return [
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
    "gitlab.com",
    "*.gitlab.com",
    "bitbucket.org",
    "*.bitbucket.org",
    "codeberg.org",
    "*.codeberg.org",
    "sr.ht",
    "*.sr.ht",
    "ghcr.io",
    "*.ghcr.io",
    "docker.io",
    "*.docker.io",
    "registry-1.docker.io",
    "auth.docker.io",
    "production.cloudflare.docker.com",
    "quay.io",
    "*.quay.io",
    "gcr.io",
    "*.gcr.io",
    "*.pkg.dev",
    "registry.k8s.io",
    "mcr.microsoft.com",
    "public.ecr.aws",
  ];
}

function defaultAllowWritePaths(): string[] {
  return [
    ".",
    "/tmp",
    "/private/tmp",
    os.tmpdir(),
    "~/.cache",
    "~/Library/Caches",
    "~/.npm",
    "~/.pnpm-store",
    "~/.yarn",
    "~/.cache/yarn",
    "~/.cache/pnpm",
    "~/.cargo/registry",
    "~/.cargo/git",
    "~/.gradle/caches",
    "~/.gradle/wrapper",
    "~/.m2/repository",
    "~/go/pkg/mod",
    "~/.cache/go-build",
    "~/.cache/pip",
    "~/Library/Caches/pip",
    "~/.nuget/packages",
    "~/.ivy2/cache",
    "~/.cache/coursier",
    "~/.cache/bazel",
    "~/.cache/uv",
    "~/.cache/ruff",
    "~/.cache/pre-commit",
  ];
}

function listProvenance(entries: string[], source: string): Record<string, string> {
  return Object.fromEntries(entries.map((entry) => [entry, source]));
}

function defaultProvenance(config: Omit<ResolvedRailConfig, "provenance">): ConfigProvenance {
  return {
    lists: {
      "filesystem.allowRead": listProvenance(config.filesystem.allowRead, "default"),
      "filesystem.denyRead": listProvenance(config.filesystem.denyRead, "default"),
      "filesystem.allowWrite": listProvenance(config.filesystem.allowWrite, "default"),
      "filesystem.denyWrite": listProvenance(config.filesystem.denyWrite, "default"),
      "environment.allow": listProvenance(config.environment.allow, "default"),
      "environment.unset": listProvenance(config.environment.unset, "default"),
      "network.allowedDomains": listProvenance(config.network.allowedDomains, "default"),
      "network.deniedDomains": listProvenance(config.network.deniedDomains, "default"),
      "commands.allow": listProvenance(config.commands.allow, "default"),
      "commands.classify": listProvenance(config.commands.classify.map((rule) => rule.template), "default"),
    },
    dispositions: Object.fromEntries(BUILTIN_CAPABILITY_IDS.map((id) => [id, "default"])) as Record<CapabilityId, string>,
    capabilityClasses: {},
    capabilityDefinitions: {},
  };
}

const DEFAULTS_SANS_PROVENANCE: Omit<ResolvedRailConfig, "provenance"> = {
  enabled: true,
  backend: "seatbelt",
  statusLine: "always",
  filesystem: {
    enabled: true,
    allowRead: [],
    denyRead: defaultDenyReadPaths(),
    allowWrite: defaultAllowWritePaths(),
    denyWrite: [".pi", ".env", ".env.*", "*.pem", "*.key", "~/.ssh", "~/.aws", "~/.azure", "~/.gnupg", "~/.kube", "~/.docker", "~/.netrc"],
  },
  environment: {
    allow: [
      "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "CI", "TERM", "SHELL", "LANG", "LC_*",
      // CA-certificate configuration, so a private CA reaches curl/python/node/aws/git/npm/cargo/deno
      // tooling inside the sandbox (JAVA_TOOL_OPTIONS is how java picks up a custom trust store).
      "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
      "AWS_CA_BUNDLE", "PIP_CERT", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "NPM_CONFIG_CAFILE",
      "CARGO_HTTP_CAINFO", "DENO_CERT", "JAVA_TOOL_OPTIONS",
    ],
    unset: [
      // Explicit AWS credential vars rather than a broad AWS_* glob, so AWS_CA_BUNDLE in the
      // allow list is not scrubbed (unset is applied before allow). Tradeoff: future unknown
      // AWS_* secrets are no longer auto-unset; the *_TOKEN/*_SECRET/*_KEY globs are the backstop.
      "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "AWS_WEB_IDENTITY_TOKEN_FILE",
      "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "*_TOKEN", "*_SECRET", "*_KEY",
    ],
  },
  network: {
    enabled: true,
    allowedDomains: defaultAllowedNetworkDomains(),
    // Deliberately empty: sandbox-runtime checks denies BEFORE allows, so a
    // "*" backstop here vetoes the entire allowlist (every sandboxed CONNECT
    // 403s). Default-deny for unmatched hosts comes from strictAllowlist in
    // the seatbelt runtime config instead; this list is for users carving
    // explicit denials out of an allowed wildcard.
    deniedDomains: [],
  },
  commands: {
    allow: [...DEFAULT_COMMAND_ALLOWLIST],
    // No built-in classify rules: the whole point of the list is that the
    // classes it reaches are the ones this user decided to name.
    classify: [],
  },
  dispositions: { ...DEFAULT_DISPOSITIONS },
  capabilities: { classes: [], definitions: {} },
  classifier: {
    enabled: false,
    model: "auto",
    judgeModel: "current",
    timeoutMs: 8000,
    failClosed: true,
    telemetry: "minimal",
  },
  seatbelt: {},
  container: {},
  diagnostics: [],
  sources: ["defaults"],
};

export const DEFAULT_CONFIG: ResolvedRailConfig = { ...DEFAULTS_SANS_PROVENANCE, provenance: defaultProvenance(DEFAULTS_SANS_PROVENANCE) };

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown, name: string, diagnostics: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    diagnostics.push(`Ignoring ${name}: expected an array of strings`);
    return undefined;
  }
  return value;
}

const LIST_SHAPE = `expected an array of strings, or {"replace": true|false, "values": [...]}`;
const RULE_LIST_SHAPE = `expected an array of {"template": "…", "capability": "…"} entries, or {"replace": true|false, "values": [...]}`;

/** A list's envelope, before its entries are validated. `where` names the array for entry-level diagnostics. */
interface ListEnvelope {
  replace: boolean;
  values: unknown;
  where: string;
}

/**
 * Reads the replace/extend envelope both list forms share and says what the
 * layer meant by it. Returning undefined means "leave the inherited list
 * alone" — for an absent key, and equally for a malformed one, since a list is
 * policy and a half-read one is worse than the one already in force.
 */
function readListEnvelope(value: unknown, name: string, diagnostics: string[], shape: string): ListEnvelope | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return { replace: true, values: value, where: name };
  if (!isObject(value)) {
    diagnostics.push(`Ignoring ${name}: ${shape}`);
    return undefined;
  }
  const unknownKeys = Object.keys(value).filter((key) => key !== "replace" && key !== "values");
  if (unknownKeys.length > 0) {
    diagnostics.push(`Ignoring ${name}: unexpected key${unknownKeys.length > 1 ? "s" : ""} ${unknownKeys.join(", ")} — ${shape}`);
    return undefined;
  }
  if (typeof value.replace !== "boolean") {
    diagnostics.push(`Ignoring ${name}: "replace" must be true or false`);
    return undefined;
  }
  if (value.values === undefined) {
    diagnostics.push(`Ignoring ${name}: "values" is required`);
    return undefined;
  }
  return { replace: value.replace, values: value.values, where: `${name}.values` };
}

/** Reads one string list in either form. */
function readConfigList(value: unknown, name: string, diagnostics: string[]): ConfigListOverride | undefined {
  const envelope = readListEnvelope(value, name, diagnostics, LIST_SHAPE);
  if (!envelope) return undefined;
  const values = asStringArray(envelope.values, envelope.where, diagnostics);
  return values === undefined ? undefined : { replace: envelope.replace, values };
}

/**
 * Validates one classify entry. A bad entry is skipped and the rest of the list
 * loads, unlike a string list where one bad element voids the whole thing: each
 * rule is an independent mapping (the capabilities.classes precedent), and the
 * likely mistake — naming a class this config does not declare — should cost
 * the user that rule, not their whole classification table.
 */
function parseClassifyRule(
  entry: unknown,
  where: string,
  diagnostics: string[],
  knownClassId: (id: string) => boolean,
): CommandCapabilityRule | undefined {
  if (!isObject(entry)) {
    diagnostics.push(`Ignoring ${where}: ${RULE_LIST_SHAPE}`);
    return undefined;
  }
  const unknownKeys = Object.keys(entry).filter((key) => key !== "template" && key !== "capability");
  if (unknownKeys.length > 0) {
    diagnostics.push(`Ignoring ${where}: unexpected key${unknownKeys.length > 1 ? "s" : ""} ${unknownKeys.join(", ")} — an entry is {"template": "…", "capability": "…"}`);
    return undefined;
  }
  const { template, capability } = entry as CommandClassifyConfig;
  if (typeof template !== "string") {
    diagnostics.push(`Ignoring ${where}: template must be a string`);
    return undefined;
  }
  const problem = commandTemplateProblem(template);
  if (problem) {
    diagnostics.push(`Ignoring ${where}: ${problem}`);
    return undefined;
  }
  if (typeof capability !== "string" || !capability.trim()) {
    diagnostics.push(`Ignoring ${where}: capability must be a non-empty string`);
    return undefined;
  }
  if (!knownClassId(capability.trim())) {
    // Config loads before the session exists, so a class this session added
    // with /rail policy is not referenceable here — declare it in
    // capabilities.classes to classify commands into it.
    diagnostics.push(`Ignoring ${where}: "${capability.trim()}" is not a known capability class — declare it in capabilities.classes first`);
    return undefined;
  }
  return { template: template.trim(), capability: capability.trim() };
}

function readJson(filePath: string, diagnostics: string[]): Partial<RailConfig> | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isObject(parsed)) {
      diagnostics.push(`Ignoring ${filePath}: expected a JSON object`);
      return undefined;
    }
    return parsed as Partial<RailConfig>;
  } catch (error) {
    diagnostics.push(`Ignoring ${filePath}: ${formatError(error)}`);
    return undefined;
  }
}

/**
 * Validates one custom class entry. Invalid entries are skipped with a
 * diagnostic rather than failing the load: a typo in one class must not cost
 * the user their whole rail config.
 */
function parseCapabilityClass(entry: unknown, index: number, source: string, diagnostics: string[]): CapabilityClass | undefined {
  const where = `${source}.capabilities.classes[${index}]`;
  if (!isObject(entry)) {
    diagnostics.push(`Ignoring ${where}: expected an object`);
    return undefined;
  }
  const { id, name, definition, disposition } = entry as CapabilityClassConfig;
  if (typeof id !== "string" || !CUSTOM_CLASS_ID_PATTERN.test(id)) {
    diagnostics.push(`Ignoring ${where}: id must be kebab-case, 2-41 characters, starting with a letter`);
    return undefined;
  }
  if (isBuiltinCapabilityId(id)) {
    diagnostics.push(`Ignoring ${where}: "${id}" is a built-in class — use capabilities.definitions to change its wording`);
    return undefined;
  }
  if (typeof definition !== "string" || !definition.trim()) {
    diagnostics.push(`Ignoring ${where}: definition must be a non-empty string`);
    return undefined;
  }
  if (disposition !== undefined && !isDisposition(disposition)) {
    diagnostics.push(`Ignoring ${where}: disposition must be "allow", "judge", "ask", or "deny"`);
    return undefined;
  }
  if (name !== undefined && typeof name !== "string") {
    diagnostics.push(`Ignoring ${where}: name must be a string`);
    return undefined;
  }
  return {
    id,
    name: typeof name === "string" && name.trim() ? name.trim() : id,
    definition: definition.trim(),
    // New classes default to ask: an unnamed intent the user cared enough to
    // name is exactly the case for bringing them in, and it is the one default
    // that cannot silently widen what the agent may do.
    default: (disposition as Disposition | undefined) ?? "ask",
  };
}

/** Merges the capabilities section by id, so a project config adding one class keeps the global ones. */
function mergeCapabilities(next: ResolvedRailConfig, override: CapabilitiesConfig, source: string, diagnostics: string[]): void {
  if (override.classes !== undefined) {
    if (!Array.isArray(override.classes)) {
      diagnostics.push(`Ignoring ${source}.capabilities.classes: expected an array`);
    } else {
      override.classes.forEach((raw, index) => {
        const parsed = parseCapabilityClass(raw, index, source, diagnostics);
        if (!parsed) return;
        const at = next.capabilities.classes.findIndex((entry) => entry.id === parsed.id);
        // Same-id override keeps its position, so the namer payload order (and
        // with it the cacheable prefix) does not shuffle when a project config
        // refines a class the global config already declared.
        if (at === -1) next.capabilities.classes.push(parsed);
        else next.capabilities.classes[at] = parsed;
        next.provenance.capabilityClasses[parsed.id] = source;
      });
    }
  }

  if (override.definitions === undefined) return;
  if (!isObject(override.definitions)) {
    diagnostics.push(`Ignoring ${source}.capabilities.definitions: expected an object of class id → definition`);
    return;
  }
  for (const [key, value] of Object.entries(override.definitions)) {
    if (!isBuiltinCapabilityId(key)) {
      diagnostics.push(`Ignoring ${source}.capabilities.definitions.${key}: not a built-in capability class`);
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      diagnostics.push(`Ignoring ${source}.capabilities.definitions.${key}: expected a non-empty string`);
      continue;
    }
    next.capabilities.definitions[key] = value.trim();
    next.provenance.capabilityDefinitions[key] = source;
  }
}

export function mergeConfig(base: ResolvedRailConfig, override: Partial<RailConfig>, source: string): ResolvedRailConfig {
  const diagnostics = [...base.diagnostics];
  const next: ResolvedRailConfig = {
    ...base,
    filesystem: { ...base.filesystem },
    environment: { ...base.environment },
    network: { ...base.network },
    commands: { ...base.commands },
    dispositions: { ...base.dispositions },
    capabilities: { classes: [...base.capabilities.classes], definitions: { ...base.capabilities.definitions } },
    classifier: { ...base.classifier },
    seatbelt: { ...base.seatbelt },
    container: { ...base.container },
    diagnostics,
    sources: [...base.sources, source],
    provenance: structuredClone(base.provenance),
  };

  /**
   * Applies one list from this layer. A replacement re-labels every entry's
   * provenance with this source; an extension appends the entries the
   * inherited list does not already have and labels only those, so an entry
   * this layer restates still reads as coming from the layer that introduced
   * it.
   */
  const setList = (listKey: ProvenanceListKey, raw: unknown, name: string, current: string[]): string[] => {
    const incoming = readConfigList(raw, name, diagnostics);
    if (!incoming) return current;
    if (incoming.replace) {
      next.provenance.lists[listKey] = listProvenance(incoming.values, source);
      return incoming.values;
    }
    const merged = [...current];
    const sources = next.provenance.lists[listKey];
    for (const value of incoming.values) {
      if (merged.includes(value)) continue;
      merged.push(value);
      sources[value] = source;
    }
    return merged;
  };

  if (typeof override.enabled === "boolean") next.enabled = override.enabled;
  if ((override as Record<string, unknown>).mode !== undefined) diagnostics.push(`Ignoring ${source}.mode: report-only mode has been removed`);

  if (override.backend === "seatbelt" || override.backend === "none" || override.backend === "container") next.backend = override.backend;
  else if (override.backend !== undefined) diagnostics.push(`Ignoring ${source}.backend: unsupported backend`);

  if (override.statusLine === "always" || override.statusLine === "never" || override.statusLine === "auto") next.statusLine = override.statusLine;
  else if (override.statusLine !== undefined) diagnostics.push(`Ignoring ${source}.statusLine: expected "always", "never", or "auto"`);

  if (isObject(override.filesystem)) {
    if (typeof override.filesystem.enabled === "boolean") next.filesystem.enabled = override.filesystem.enabled;
    next.filesystem.allowRead = setList("filesystem.allowRead", override.filesystem.allowRead, `${source}.filesystem.allowRead`, next.filesystem.allowRead);
    next.filesystem.denyRead = setList("filesystem.denyRead", override.filesystem.denyRead, `${source}.filesystem.denyRead`, next.filesystem.denyRead);
    next.filesystem.allowWrite = setList("filesystem.allowWrite", override.filesystem.allowWrite, `${source}.filesystem.allowWrite`, next.filesystem.allowWrite);
    next.filesystem.denyWrite = setList("filesystem.denyWrite", override.filesystem.denyWrite, `${source}.filesystem.denyWrite`, next.filesystem.denyWrite);
  }

  if (isObject(override.environment)) {
    next.environment.allow = setList("environment.allow", override.environment.allow, `${source}.environment.allow`, next.environment.allow);
    next.environment.unset = setList("environment.unset", override.environment.unset, `${source}.environment.unset`, next.environment.unset);
  }

  if (isObject(override.network)) {
    if (typeof override.network.enabled === "boolean") next.network.enabled = override.network.enabled;
    next.network.allowedDomains = setList("network.allowedDomains", override.network.allowedDomains, `${source}.network.allowedDomains`, next.network.allowedDomains);
    next.network.deniedDomains = setList("network.deniedDomains", override.network.deniedDomains, `${source}.network.deniedDomains`, next.network.deniedDomains);
  }

  // Taxonomy before the table and before classify rules: a config may define a
  // custom class, classify commands into it, and set its disposition all in the
  // same file, so the class has to exist by the time those are validated.
  if (isObject(override.capabilities)) {
    mergeCapabilities(next, override.capabilities as CapabilitiesConfig, source, diagnostics);
  } else if (override.capabilities !== undefined) {
    diagnostics.push(`Ignoring ${source}.capabilities: expected an object`);
  }

  const knownClassId = (key: string) => isBuiltinCapabilityId(key) || next.capabilities.classes.some((entry) => entry.id === key);

  /**
   * commands.classify, whose entries are objects keyed by template. Extension
   * follows the string lists — an entry the inherited list already has is
   * dropped, so a restatement still credits the layer that introduced it — with
   * one addition they cannot have: a template pointed at a *different* class is
   * a real change, so this layer re-maps it in place and takes its provenance.
   */
  const setClassifyList = (raw: unknown, name: string, current: CommandCapabilityRule[]): CommandCapabilityRule[] => {
    const envelope = readListEnvelope(raw, name, diagnostics, RULE_LIST_SHAPE);
    if (!envelope) return current;
    if (!Array.isArray(envelope.values)) {
      diagnostics.push(`Ignoring ${envelope.where}: ${RULE_LIST_SHAPE}`);
      return current;
    }
    const incoming: CommandCapabilityRule[] = [];
    envelope.values.forEach((entry, index) => {
      const rule = parseClassifyRule(entry, `${envelope.where}[${index}]`, diagnostics, knownClassId);
      if (rule) incoming.push(rule);
    });
    if (envelope.replace) {
      next.provenance.lists["commands.classify"] = listProvenance(incoming.map((rule) => rule.template), source);
      return incoming;
    }
    const merged = [...current];
    const sources = next.provenance.lists["commands.classify"];
    for (const rule of incoming) {
      const at = merged.findIndex((entry) => entry.template === rule.template);
      if (at !== -1 && merged[at]!.capability === rule.capability) continue;
      if (at === -1) merged.push(rule);
      else merged[at] = rule;
      sources[rule.template] = source;
    }
    return merged;
  };

  if (isObject(override.commands)) {
    next.commands.allow = setList("commands.allow", override.commands.allow, `${source}.commands.allow`, next.commands.allow);
    next.commands.classify = setClassifyList(override.commands.classify, `${source}.commands.classify`, next.commands.classify);
  }

  // Per-row merge, unlike the wholesale lists: the disposition table is the
  // user-facing policy surface, so a project config that sets one row must not
  // silently reset the eleven it did not mention.
  if (isObject(override.dispositions)) {
    for (const [key, value] of Object.entries(override.dispositions)) {
      if (!knownClassId(key)) {
        diagnostics.push(`Ignoring ${source}.dispositions.${key}: unknown capability class`);
        continue;
      }
      if (!isDisposition(value)) {
        diagnostics.push(`Ignoring ${source}.dispositions.${key}: expected "allow", "judge", "ask", or "deny"`);
        continue;
      }
      next.dispositions[key] = value;
      next.provenance.dispositions[key] = source;
    }
  } else if (override.dispositions !== undefined) {
    diagnostics.push(`Ignoring ${source}.dispositions: expected an object of class → disposition`);
  }

  if (isObject(override.classifier)) {
    if (typeof override.classifier.enabled === "boolean") next.classifier.enabled = override.classifier.enabled;
    if (typeof override.classifier.model === "string" && override.classifier.model.trim()) next.classifier.model = override.classifier.model.trim();
    if (typeof override.classifier.judgeModel === "string" && override.classifier.judgeModel.trim()) next.classifier.judgeModel = override.classifier.judgeModel.trim();
    if (typeof override.classifier.timeoutMs === "number" && Number.isFinite(override.classifier.timeoutMs) && override.classifier.timeoutMs > 0) {
      next.classifier.timeoutMs = Math.floor(override.classifier.timeoutMs);
    } else if (override.classifier.timeoutMs !== undefined) {
      diagnostics.push(`Ignoring ${source}.classifier.timeoutMs: expected a positive number`);
    }
    if (typeof override.classifier.failClosed === "boolean") next.classifier.failClosed = override.classifier.failClosed;
    if (override.classifier.telemetry !== undefined) {
      if (override.classifier.telemetry === "off" || override.classifier.telemetry === "minimal" || override.classifier.telemetry === "full") {
        next.classifier.telemetry = override.classifier.telemetry;
      } else {
        diagnostics.push(`Ignoring ${source}.classifier.telemetry: expected "off", "minimal", or "full"`);
      }
    }
    // Retired: the prose rule tiers are neither parsed nor merged. Old configs
    // still load, with one diagnostic pointing at what replaced them.
    if ((override.classifier as Record<string, unknown>).rules !== undefined) {
      diagnostics.push(
        `Ignoring ${source}.classifier.rules: the prose rule tiers are gone. Capability mode names actions from the class taxonomy and decides via the disposition table — use "dispositions" and "capabilities.definitions" instead.`,
      );
    }
  }

  if (isObject(override.seatbelt)) next.seatbelt = { ...next.seatbelt, ...override.seatbelt };
  if (isObject(override.container)) next.container = { ...next.container, ...override.container };

  return next;
}

export const RAIL_CONFIG_FILENAME = "rail.json";
/** What this extension's config file was called before the pi-guard → pi-rail rename. */
export const LEGACY_RAIL_CONFIG_FILENAME = "guard.json";

/** Which of the two filenames one config layer resolves to, and what to say about it. */
export interface ResolvedConfigFile {
  /** The file to read — and the file persistent writers must write back to. */
  path: string;
  /** True when the legacy guard.json was chosen because no rail.json sits beside it. */
  legacy: boolean;
  /** Set when a guard.json exists at this layer but lost to rail.json. */
  ignoredLegacyPath?: string;
}

/**
 * Picks the config file for one layer. rail.json always wins; a lone guard.json
 * is read exactly as it was before the rename, so upgrading does not silently
 * drop a user's live configuration. With neither present the rail.json path
 * comes back, which is what a writer should create.
 */
export function resolveConfigFile(dir: string): ResolvedConfigFile {
  const railPath = path.join(dir, RAIL_CONFIG_FILENAME);
  const legacyPath = path.join(dir, LEGACY_RAIL_CONFIG_FILENAME);
  const hasLegacy = existsSync(legacyPath);
  if (existsSync(railPath)) return hasLegacy ? { path: railPath, legacy: false, ignoredLegacyPath: legacyPath } : { path: railPath, legacy: false };
  if (hasLegacy) return { path: legacyPath, legacy: true };
  return { path: railPath, legacy: false };
}

/**
 * The advisory for a layer where a legacy guard.json exists: it either was the
 * file loaded, or it was shadowed by a rail.json and did nothing. Undefined
 * when there is no guard.json to talk about.
 */
export function legacyConfigDiagnostic(file: ResolvedConfigFile): string | undefined {
  if (file.legacy) return `Loaded legacy ${file.path} — rename it to ${RAIL_CONFIG_FILENAME} (pi-guard is now pi-rail).`;
  if (file.ignoredLegacyPath) return `Ignored ${file.ignoredLegacyPath}: ${file.path} takes precedence (pi-guard is now pi-rail). Delete the legacy file once its settings are merged.`;
  return undefined;
}

/** The directory holding the global config, whichever of the two filenames is in it. */
export function globalRailConfigDir(): string {
  return path.join(getAgentDir(), "extensions");
}

/** The global config file in effect: rail.json, or a legacy guard.json when that is all there is. */
export function globalRailConfigPath(): string {
  return resolveConfigFile(globalRailConfigDir()).path;
}

/** Short display label for a provenance source: "default", "global", "project", or the raw path when unrecognized. */
export function configSourceLabel(source: string): string {
  if (source === "default") return "default";
  const base = path.basename(source);
  if (base === RAIL_CONFIG_FILENAME || base === LEGACY_RAIL_CONFIG_FILENAME) {
    if (source === path.join(globalRailConfigDir(), base)) return "global";
    if (source.endsWith(path.join(CONFIG_DIR_NAME, base))) return "project";
  }
  return source;
}

export function loadConfig(ctx: ExtensionContext): ResolvedRailConfig {
  const diagnostics: string[] = [];
  let config: ResolvedRailConfig = structuredClone(DEFAULT_CONFIG);
  config.diagnostics = [];
  config.sources = ["defaults"];

  const globalFile = resolveConfigFile(globalRailConfigDir());
  const projectFile = resolveConfigFile(path.join(ctx.cwd, CONFIG_DIR_NAME));

  // The advisory is about which files are on disk, so it is emitted even when
  // the chosen file turns out to be unparseable — that is when knowing a
  // shadowed guard.json is sitting there matters most.
  const globalAdvisory = legacyConfigDiagnostic(globalFile);
  if (globalAdvisory) diagnostics.push(globalAdvisory);

  const globalConfig = readJson(globalFile.path, diagnostics);
  if (globalConfig) config = mergeConfig(config, globalConfig, globalFile.path);

  if (ctx.isProjectTrusted()) {
    const projectAdvisory = legacyConfigDiagnostic(projectFile);
    if (projectAdvisory) diagnostics.push(projectAdvisory);
    const projectConfig = readJson(projectFile.path, diagnostics);
    if (projectConfig) config = mergeConfig(config, projectConfig, projectFile.path);
  } else if (existsSync(projectFile.path)) {
    diagnostics.push(`Ignoring untrusted project config: ${projectFile.path}`);
  }

  config.diagnostics.push(...diagnostics);
  return config;
}
