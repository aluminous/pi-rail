import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ResolvedRailConfig } from "./config.ts";
import { expandHome } from "./paths.ts";
import { formatError, textPrefix, unique } from "./util.ts";
import { sessionCheckoutRoot } from "./worktrees.ts";

export type AccessKind = "read" | "write";

export type PolicyDenialCode = "denied-by-pattern" | "outside-roots" | "unresolvable";

export type PolicyDecision =
  | { allowed: true; normalizedPath: string; matchedRoot?: string; worktreeRoot?: string }
  | { allowed: false; code: PolicyDenialCode; reason: string; normalizedPath: string };

function stripAtPrefix(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

/** The one home-expansion + cwd-resolution used for every configured path, in both engines. */
export function resolveConfigPath(cwd: string, value: string): string {
  return path.resolve(cwd, expandHome(value));
}

export function normalizeUserPath(cwd: string, inputPath: string): string {
  return resolveConfigPath(cwd, stripAtPrefix(inputPath));
}

function canonicalizeExistingPath(normalizedPath: string): { ok: true; path: string } | { ok: false; reason: string } {
  try {
    return { ok: true, path: realpathSync.native(normalizedPath) };
  } catch (error) {
    return { ok: false, reason: formatError(error) };
  }
}

function canonicalizeWritePath(normalizedPath: string): { ok: true; path: string } | { ok: false; reason: string } {
  try {
    lstatSync(normalizedPath);
    return canonicalizeExistingPath(normalizedPath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      return { ok: false, reason: formatError(error) };
    }
  }

  const parts: string[] = [];
  let current = normalizedPath;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return { ok: false, reason: `no existing parent for ${normalizedPath}` };
    parts.unshift(path.basename(current));
    current = parent;
  }

  const parent = canonicalizeExistingPath(current);
  if (!parent.ok) return parent;
  return { ok: true, path: path.join(parent.path, ...parts) };
}

function hasGlob(pattern: string): boolean {
  return /[*?\[\]{}]/.test(pattern);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  const normalized = pattern.split(path.sep).join("/");
  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const next = normalized[i + 1];
    if (ch === "*" && next === "*") {
      out += ".*";
      i++;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch ?? "");
    }
  }
  return new RegExp(`^${out}$`);
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * How the policy engine interprets a config pattern, plus `sandboxPath` — the
 * one literal a Seatbelt profile can hold for it. Classified in a single place
 * so patternMatches and compileFilesystemPolicy cannot drift apart: only
 * "root" patterns mean exactly subpath(sandboxPath); glob and bare-name
 * matching have no literal-path equivalent.
 */
export type ClassifiedPattern =
  | { kind: "glob"; scope: "path" | "relative" | "basename"; glob: string; sandboxPath: string }
  | { kind: "root"; sandboxPath: string }
  | { kind: "basename"; name: string; sandboxPath: string };

export function classifyPattern(cwd: string, pattern: string): ClassifiedPattern {
  const expanded = expandHome(pattern);
  const sandboxPath = path.resolve(cwd, expanded);
  if (hasGlob(pattern)) {
    if (path.isAbsolute(expanded) || expanded.startsWith("~")) {
      return { kind: "glob", scope: "path", glob: sandboxPath.split(path.sep).join("/"), sandboxPath };
    }
    const normalized = expanded.split(path.sep).join("/");
    if (normalized.includes("/")) return { kind: "glob", scope: "relative", glob: normalized, sandboxPath };
    return { kind: "glob", scope: "basename", glob: normalized, sandboxPath };
  }
  if (pattern.includes("/") || path.isAbsolute(expanded) || expanded.startsWith("~") || pattern === ".") {
    return { kind: "root", sandboxPath };
  }
  return { kind: "basename", name: pattern, sandboxPath };
}

function patternMatches(cwd: string, candidate: string, pattern: string): boolean {
  const classified = classifyPattern(cwd, pattern);
  const relativeCandidate = path.relative(cwd, candidate).split(path.sep).join("/");
  const basename = path.basename(candidate);
  if (classified.kind === "glob") {
    const regex = globToRegex(classified.glob);
    if (classified.scope === "path") return regex.test(candidate.split(path.sep).join("/"));
    return regex.test(classified.scope === "relative" ? relativeCandidate : basename);
  }
  if (classified.kind === "root") {
    const root = existsSync(classified.sandboxPath) ? realpathSync.native(classified.sandboxPath) : classified.sandboxPath;
    return isInside(root, candidate);
  }
  return basename === classified.name || relativeCandidate === classified.name || relativeCandidate.startsWith(`${classified.name}/`);
}

export type FilesystemListName = "allowRead" | "denyRead" | "allowWrite" | "denyWrite";

const FILESYSTEM_LISTS: FilesystemListName[] = ["allowRead", "denyRead", "allowWrite", "denyWrite"];

/** A config pattern whose sandbox literal is weaker than the policy engine's match. */
export interface DegradedPattern {
  list: FilesystemListName;
  pattern: string;
  /** The literal path the sandbox receives in place of the pattern. */
  sandboxPath: string;
  /** What the literal cannot express: glob matching, or match-any-basename. */
  cause: "glob" | "basename";
}

export interface CompiledFilesystemPolicy {
  /** The pattern lists exactly as decidePathAccess matches them. */
  patterns: Record<FilesystemListName, string[]>;
  /** Home-expanded, cwd-resolved literals — the only form a Seatbelt profile accepts. */
  sandboxPaths: Record<FilesystemListName, string[]>;
  degraded: DegradedPattern[];
}

/**
 * The single translation of config.filesystem into what each engine consumes.
 * Non-root patterns keep their literal in sandboxPaths as best effort but are
 * reported in `degraded` rather than silently losing their wider
 * policy-engine semantics in the sandbox.
 */
export function compileFilesystemPolicy(config: ResolvedRailConfig, cwd: string): CompiledFilesystemPolicy {
  const patterns: Record<FilesystemListName, string[]> = {
    allowRead: [...config.filesystem.allowRead],
    denyRead: [...config.filesystem.denyRead],
    allowWrite: [...config.filesystem.allowWrite],
    denyWrite: [...config.filesystem.denyWrite],
  };
  const sandboxPaths: Record<FilesystemListName, string[]> = { allowRead: [], denyRead: [], allowWrite: [], denyWrite: [] };
  const degraded: DegradedPattern[] = [];
  for (const list of FILESYSTEM_LISTS) {
    for (const pattern of patterns[list]) {
      const classified = classifyPattern(cwd, pattern);
      sandboxPaths[list].push(classified.sandboxPath);
      if (classified.kind !== "root") {
        degraded.push({ list, pattern, sandboxPath: classified.sandboxPath, cause: classified.kind });
      }
    }
    sandboxPaths[list] = unique(sandboxPaths[list]);
  }
  return { patterns, sandboxPaths, degraded };
}

/** One warning line naming the patterns the sandbox cannot hold bash to, or undefined when it is faithful. */
export function summarizeDegradedPatterns(degraded: DegradedPattern[]): string | undefined {
  if (degraded.length === 0) return undefined;
  const names = unique(degraded.map((entry) => entry.pattern));
  return `Filesystem patterns enforced for file tools but not for bash (Seatbelt takes literal paths only): ${names.join(", ")}`;
}

function matchingRoot(cwd: string, candidate: string, roots: string[]): string | undefined {
  return roots.find((root) => patternMatches(cwd, candidate, root));
}

/** The first configured pattern that matches the candidate path under policy-engine semantics, if any. */
export function findMatchingPattern(cwd: string, candidate: string, patterns: string[]): string | undefined {
  return patterns.find((pattern) => patternMatches(cwd, candidate, pattern));
}

function isDenied(cwd: string, candidate: string, patterns: string[]): string | undefined {
  return findMatchingPattern(cwd, candidate, patterns);
}

export function decidePathAccess(config: ResolvedRailConfig, cwd: string, inputPath: string, kind: AccessKind): PolicyDecision {
  const normalizedPath = normalizeUserPath(cwd, inputPath);
  if (!config.filesystem.enabled) return { allowed: true, normalizedPath };

  const canonical = kind === "write" ? canonicalizeWritePath(normalizedPath) : canonicalizeExistingPath(normalizedPath);
  if (!canonical.ok) {
    return { allowed: false, code: "unresolvable", normalizedPath, reason: `${kind} path could not be resolved: ${canonical.reason}` };
  }

  const canonicalCwd = canonicalizeExistingPath(cwd);
  if (!canonicalCwd.ok) {
    return { allowed: false, code: "unresolvable", normalizedPath, reason: `cwd could not be resolved: ${canonicalCwd.reason}` };
  }

  const checkedPath = canonical.path;
  const checkedCwd = canonicalCwd.path;
  // A path inside a verified sibling checkout of the session repo (a linked
  // worktree, or the main checkout when cwd is a worktree) is judged as if
  // cwd were that checkout's root: relative patterns — allow roots like "."
  // and deny entries like "src/**" — re-anchor there, so the worktree gets
  // exactly the decisions the project directory itself would get, no wider
  // and no narrower. Absolute patterns are unaffected by the anchor.
  const checkout = sessionCheckoutRoot(checkedCwd, checkedPath);
  const anchor = checkout?.root ?? checkedCwd;
  const denyPatterns = kind === "read" ? config.filesystem.denyRead : config.filesystem.denyWrite;
  const allowRoots = kind === "read" ? config.filesystem.allowRead : config.filesystem.allowWrite;
  const deniedBy = isDenied(anchor, checkedPath, denyPatterns);
  if (deniedBy) {
    return { allowed: false, code: "denied-by-pattern", normalizedPath: checkedPath, reason: `${kind} denied by pattern ${deniedBy}` };
  }
  if (kind === "write" || allowRoots.length > 0) {
    const root = matchingRoot(anchor, checkedPath, allowRoots);
    if (root === undefined) {
      return { allowed: false, code: "outside-roots", normalizedPath: checkedPath, reason: `${kind} outside allowed roots (${textPrefix(allowRoots.join(", "), 160) || "none configured"})` };
    }
    return { allowed: true, normalizedPath: checkedPath, matchedRoot: root, worktreeRoot: checkout?.root };
  }
  return { allowed: true, normalizedPath: checkedPath, worktreeRoot: checkout?.root };
}

/**
 * Whether a read of this path may skip classifier review entirely: the
 * canonical path is inside the session cwd, inside a verified checkout of the
 * session repo (a registered linked worktree, or the main checkout when cwd
 * is a worktree), or matches an explicit allowRead entry, and does not match
 * denyRead. Evaluated regardless of
 * filesystem.enabled — the configured lists express user trust even when
 * enforcement is off. Reads only: the rail's read projection never carries
 * file content, so an allowlisted path is the whole action; write/edit
 * content still needs review no matter how trusted the path is.
 */
export function isClassifierExemptRead(config: ResolvedRailConfig, cwd: string, inputPath: string): boolean {
  return classifierExemptReadReason(config, cwd, inputPath) !== undefined;
}

/**
 * The denyRead pattern this path matches, if any. Evaluated regardless of
 * filesystem.enabled, like the exemption routing: the list expresses "these
 * are secrets" even when blocking is off, and capability mode uses it as the
 * deterministic `credentials` label rather than as a hard block.
 */
export function denyReadMatch(config: ResolvedRailConfig, cwd: string, inputPath: string): string | undefined {
  const canonical = canonicalizeExistingPath(normalizeUserPath(cwd, inputPath));
  const canonicalCwd = canonicalizeExistingPath(cwd);
  if (!canonical.ok || !canonicalCwd.ok) return undefined;
  // Same worktree re-anchoring as decidePathAccess: a denyRead of `.env` or
  // `secrets/**` names project-relative secrets, and another checkout of the
  // project has them at the same relative spots.
  const checkout = sessionCheckoutRoot(canonicalCwd.path, canonical.path);
  return isDenied(checkout?.root ?? canonicalCwd.path, canonical.path, config.filesystem.denyRead);
}

/** Which exemption condition applies ("in session cwd" / "in linked worktree of session repo" / "matches allowRead '…'"), or undefined when the read is not exempt. */
export function classifierExemptReadReason(config: ResolvedRailConfig, cwd: string, inputPath: string): string | undefined {
  const normalizedPath = normalizeUserPath(cwd, inputPath);
  const canonical = canonicalizeExistingPath(normalizedPath);
  if (!canonical.ok) return undefined;
  const canonicalCwd = canonicalizeExistingPath(cwd);
  if (!canonicalCwd.ok) return undefined;
  const checkout = sessionCheckoutRoot(canonicalCwd.path, canonical.path);
  if (isDenied(checkout?.root ?? canonicalCwd.path, canonical.path, config.filesystem.denyRead)) return undefined;
  if (isInside(canonicalCwd.path, canonical.path)) return "in session cwd";
  // A verified checkout of the session repo is the project under another
  // path, so its reads are trusted exactly like in-cwd reads. Trust here
  // rests on the bidirectional registry check in sessionCheckoutRoot, not on
  // the candidate's own say-so; see src/worktrees.ts.
  if (checkout !== undefined) return checkout.linked ? "in linked worktree of session repo" : "in main checkout of session repo";
  const root = matchingRoot(canonicalCwd.path, canonical.path, config.filesystem.allowRead);
  return root === undefined ? undefined : `matches allowRead '${root}'`;
}

function wildcardMatches(value: string, pattern: string): boolean {
  return globToRegex(pattern).test(value);
}

export function scrubEnvironment(env: NodeJS.ProcessEnv | undefined, config: ResolvedRailConfig): Record<string, string> {
  const source = env ?? process.env;
  const result: Record<string, string> = {};
  const allow = config.environment.allow;
  const unset = config.environment.unset;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (unset.some((pattern) => wildcardMatches(key, pattern))) continue;
    if (allow.length > 0 && !allow.some((pattern) => wildcardMatches(key, pattern))) continue;
    result[key] = value;
  }
  return result;
}

export function summarizePolicy(config: ResolvedRailConfig): string[] {
  const network = !config.network.enabled
    ? "disabled (unrestricted)"
    : config.network.allowedDomains.length > 0
      ? `enabled (${config.network.allowedDomains.length} allowed domains)`
      : "enabled (deny all)";
  const summary = [
    `Backend: ${config.backend}`,
    `Network restrictions: ${network}`,
    `Filesystem restrictions: ${config.filesystem.enabled ? "enabled" : "disabled (unrestricted)"}`,
  ];
  if (!config.filesystem.enabled) return summary;
  return [
    ...summary,
    `Read mode: ${config.filesystem.allowRead.length === 0 ? "blacklist (all paths except denyRead)" : `whitelist (${config.filesystem.allowRead.join(", ")})`}`,
    `Write roots: ${config.filesystem.allowWrite.join(", ") || "(none)"}`,
    `Deny read: ${config.filesystem.denyRead.join(", ") || "(none)"}`,
    `Deny write: ${config.filesystem.denyWrite.join(", ") || "(none)"}`,
  ];
}
