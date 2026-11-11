import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_CAPABILITY_IDS, DEFAULT_DISPOSITIONS, type CapabilityClass, type CapabilityId, type Disposition } from "./capabilities.ts";
import { DEFAULT_COMMAND_ALLOW_FLAGS, DEFAULT_COMMAND_ALLOWLIST, type CommandCapabilityRule } from "./command-allowlist.ts";
import {
  applyLayer,
  compileConfigLayer,
  DEFAULT_PROVENANCE,
  foldPolicy,
  type AppliedGrant,
  type FileLayerName,
  type PolicyLayer,
  type PolicyProvenance,
  type Provenance,
} from "./policy-store.ts";
import { formatError } from "./util.ts";

export type RailBackendName = "seatbelt" | "none" | "container";

/** When the rail statusline is visible: always, never, or auto (only when the rail is off/erroring or something was denied since the last user message). */
export type StatusLineMode = "always" | "never" | "auto";

export interface ClassifierConfig {
  enabled?: boolean;
  model?: string;
  /** Model for the `judge` disposition's escalation review; "current" uses the session model. */
  judgeModel?: string;
  /** Model for the grant configurator (`/rail grant <text>`); same grammar as `model`, default "auto". */
  grantModel?: string;
  timeoutMs?: number;
  failClosed?: boolean;
  /** Decision telemetry written to pi's session log: off, minimal (truncated), or full. */
  telemetry?: "off" | "minimal" | "full";
}

export interface ResolvedClassifierConfig {
  enabled: boolean;
  model: string;
  judgeModel: string;
  grantModel: string;
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
  /** A built-in class id this class narrows: presets that deny the parent deny it too. */
  extends?: unknown;
  /** false keeps the class out of the namer's vocabulary: only classify rules reach it. */
  namer?: unknown;
}

export interface CapabilitiesConfig {
  /** Custom classes that join the taxonomy. Merged by id across layers. */
  classes?: CapabilityClassConfig[];
  /** Replacement prompt text for built-in classes, keyed by built-in class id. */
  definitions?: Record<string, string>;
}

/**
 * The object form of a config list. Lists only append (GRANTS_PLAN, "The
 * layered store"): `add` extends what the layer inherited and `remove` drops
 * inherited entries explicitly, so nothing a lower layer set disappears
 * because a higher one forgot to restate it.
 */
export interface ConfigListEdit {
  add?: string[];
  remove?: string[];
}

/** One list in a config file. A bare array means "add these to what is inherited". */
export type ConfigList = string[] | ConfigListEdit;

/** One `commands.classify` entry as written in config: a template, the class it resolves to, and optionally a flags allowlist. */
export interface CommandClassifyConfig {
  template?: unknown;
  capability?: unknown;
  flags?: unknown;
}

/** A `commands.allow` entry with a flags allowlist; a plain string entry accepts any flags. */
export interface CommandAllowConfig {
  template: string;
  flags: string[];
}

/** `commands.allow`: a list whose added entries may also be `{template, flags}` objects. */
export type ConfigAllowList = Array<string | CommandAllowConfig> | { add?: Array<string | CommandAllowConfig>; remove?: string[] };

/** `commands.classify` as a bare array or `{"add": [...]}`; the entries are objects rather than strings. */
export type ConfigRuleList = CommandClassifyConfig[] | { add?: CommandClassifyConfig[] };

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
    allow?: ConfigAllowList;
    classify?: ConfigRuleList;
  };
  /** Capability disposition table: class id → allow | judge | ask | deny. Omitted classes keep their default. */
  dispositions?: Record<string, string>;
  /** Custom capability classes and built-in definition overrides — the editable half of the taxonomy. */
  capabilities?: CapabilitiesConfig;
  classifier?: ClassifierConfig;
  /** The local replay corpus (src/replay-corpus.ts): full decision inputs, redacted, outside the session file. */
  corpus?: { enabled?: boolean };
  seatbelt?: Record<string, unknown>;
  container?: Record<string, unknown>;
  /** Named grants applied after this file's base keys (src/policy-store.ts); kept verbatim when moved. */
  grants?: unknown[];
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
    /**
     * Flags allowlists for `allow` entries, keyed by template. A template is
     * the identity of an allow entry (as for classify rules), so it has at
     * most one flags list; a template absent here accepts any flags.
     */
    allowFlags: Record<string, string[]>;
    /** User template → capability mappings. Order is only the last tiebreak: the most specific matching rule wins. */
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
  corpus: { enabled: boolean };
  seatbelt: Record<string, unknown>;
  container: Record<string, unknown>;
  diagnostics: string[];
  /** Config files folded in, in order, plus "session" while the session layer holds anything. */
  sources: string[];
  /** Every named grant the fold applied, in fold order. */
  grants: AppliedGrant[];
  /** Layer and grant behind every effective entry (src/policy-store.ts). */
  provenance: PolicyProvenance;
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

function listProvenance(entries: string[]): Record<string, Provenance> {
  return Object.fromEntries(entries.map((entry) => [entry, DEFAULT_PROVENANCE]));
}

function defaultProvenance(config: Omit<ResolvedRailConfig, "provenance">): PolicyProvenance {
  return {
    lists: {
      "filesystem.allowRead": listProvenance(config.filesystem.allowRead),
      "filesystem.denyRead": listProvenance(config.filesystem.denyRead),
      "filesystem.allowWrite": listProvenance(config.filesystem.allowWrite),
      "filesystem.denyWrite": listProvenance(config.filesystem.denyWrite),
      "environment.allow": listProvenance(config.environment.allow),
      "environment.unset": listProvenance(config.environment.unset),
      "network.allowedDomains": listProvenance(config.network.allowedDomains),
      "network.deniedDomains": listProvenance(config.network.deniedDomains),
      "commands.allow": listProvenance(config.commands.allow),
      "commands.classify": listProvenance(config.commands.classify.map((rule) => rule.template)),
    },
    dispositions: Object.fromEntries(BUILTIN_CAPABILITY_IDS.map((id) => [id, DEFAULT_PROVENANCE])) as Record<CapabilityId, Provenance>,
    classes: {},
    definitions: {},
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
    // Empty: blacklist mode. Every variable not matched by `unset` reaches
    // sandboxed commands. A whitelist breaks toolchains in ways nobody can
    // enumerate up front (JAVA_HOME, GOPATH, NVM_DIR, SSH_AUTH_SOCK, CA
    // bundles, …); the secrets worth stripping follow naming conventions the
    // unset patterns below catch. A non-empty allow switches to whitelist mode.
    allow: [],
    unset: [
      // Explicit AWS credential vars rather than a broad AWS_* glob, which would
      // also strip AWS_CA_BUNDLE, AWS_PROFILE, AWS_REGION and the rest of the
      // non-secret AWS configuration; the generic globs below are the backstop
      // for unknown AWS_* secrets.
      "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "AWS_WEB_IDENTITY_TOKEN_FILE",
      "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
      // Naming conventions for secrets. Matching is case-sensitive and `*`
      // stops at nothing but "/", so `*_KEY` takes MY_API_KEY but not
      // LESSKEY or SSH_AUTH_SOCK.
      "*_TOKEN", "*_SECRET", "*_KEY", "*_API_KEY", "*_PASSWORD", "*_PASSWD",
      // Secrets with no suffix to match: libpq's and mysql's password vars, and
      // npm's lowercase auth config.
      "PGPASSWORD", "MYSQL_PWD", "npm_config__auth*", "NPM_CONFIG__AUTH*",
      // The subagent approval mailbox's `<dir>#<token>`. pi-subagents children
      // inherit it from the extension process's own environment, never through
      // bash; a sandboxed command holding it could forge an approval
      // (src/approval-mailbox.ts).
      "PI_RAIL_APPROVAL_MAILBOX",
      // rg reads extra flags from this file, and `--pre <cmd>` runs a program
      // per searched file: a variable pointing it anywhere writable would get
      // past the built-in rg flags allowlist (src/command-allowlist.ts).
      "RIPGREP_CONFIG_PATH",
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
    // The built-ins' own flags allowlists (src/command-allowlist.ts audit).
    allowFlags: structuredClone(DEFAULT_COMMAND_ALLOW_FLAGS),
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
    grantModel: "auto",
    timeoutMs: 8000,
    failClosed: true,
    telemetry: "minimal",
  },
  // On by default: replay of a policy change is only as good as the history
  // behind it, and the store is local, private (0600), and redacted.
  corpus: { enabled: true },
  seatbelt: {},
  container: {},
  diagnostics: [],
  sources: ["defaults"],
  grants: [],
};

export const DEFAULT_CONFIG: ResolvedRailConfig = { ...DEFAULTS_SANS_PROVENANCE, provenance: defaultProvenance(DEFAULTS_SANS_PROVENANCE) };

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

export const RAIL_CONFIG_FILENAME = "rail.json";

/** The directory holding the global config. */
export function globalRailConfigDir(): string {
  return path.join(getAgentDir(), "extensions");
}

/** The global config file: what loadConfig reads first and what Ctrl+S writes. */
export function globalRailConfigPath(): string {
  return path.join(globalRailConfigDir(), RAIL_CONFIG_FILENAME);
}

/** The project config file for a working directory. */
export function projectRailConfigPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, RAIL_CONFIG_FILENAME);
}

/** Short display label for a source in config.sources: "default", "global", "project", "session", or the raw path. */
export function configSourceLabel(source: string): string {
  if (source === "default" || source === "defaults") return "default";
  if (source === "session") return "session";
  if (source === globalRailConfigPath()) return "global";
  if (source.endsWith(path.join(CONFIG_DIR_NAME, RAIL_CONFIG_FILENAME))) return "project";
  return source;
}

/**
 * Which file layer a path is, for callers that fold a file without loadConfig
 * (tests, examples). Anything that is not a project config counts as global.
 */
function layerForSource(source: string): FileLayerName {
  return configSourceLabel(source) === "project" ? "project" : "global";
}

/**
 * Folds one config file's raw JSON over an already-resolved config, as layer
 * `layer` (inferred from the path when omitted). loadConfig is this applied
 * to the global then the project file; tests and examples call it directly.
 */
export function mergeConfig(base: ResolvedRailConfig, override: Partial<RailConfig>, source: string, layer: FileLayerName = layerForSource(source)): ResolvedRailConfig {
  return applyLayer(base, compileConfigLayer(override, layer, source));
}

/**
 * The file layers in fold order: global, then project when the project is
 * trusted. Read errors and an untrusted project file become diagnostics on
 * the first layer rather than failing the load.
 */
export function loadPolicyLayers(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): { layers: PolicyLayer[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const layers: PolicyLayer[] = [];
  const globalPath = globalRailConfigPath();
  const projectPath = projectRailConfigPath(ctx.cwd);

  const globalConfig = readJson(globalPath, diagnostics);
  if (globalConfig) layers.push(compileConfigLayer(globalConfig, "global", globalPath));

  if (ctx.isProjectTrusted()) {
    const projectConfig = readJson(projectPath, diagnostics);
    if (projectConfig) layers.push(compileConfigLayer(projectConfig, "project", projectPath));
  } else if (existsSync(projectPath)) {
    diagnostics.push(`Ignoring untrusted project config: ${projectPath}`);
  }
  return { layers, diagnostics };
}

export function loadConfig(ctx: ExtensionContext): ResolvedRailConfig {
  const { layers, diagnostics } = loadPolicyLayers(ctx);
  const config = foldPolicy(DEFAULT_CONFIG, layers);
  config.diagnostics.push(...diagnostics);
  return config;
}
