// Deterministic trust for linked git worktrees of the session repo.
//
// The policy engine's notion of "in project" is isInside(cwd, path), which
// misses the other checkouts of the same repository: `git worktree add
// /tmp/my-worktree` produces a directory that is the project in every sense
// that matters — same history, same remotes, managed by the session repo's own
// .git — yet every file operation inside it looked "outside cwd" and rode the
// approval/classifier path. This module recognizes those checkouts without
// shelling out to git, from the on-disk worktree registry alone.
//
// The trust argument is the bidirectional link. A linked worktree carries a
// `.git` FILE (`gitdir: <path>`) pointing into `<common>/worktrees/<name>`,
// and the registry entry points back: `<common>/worktrees/<name>/gitdir`
// holds the path of that same `.git` file. The forward pointer alone proves
// nothing — anything able to write /tmp/evil/.git could aim it at the real
// repo — but the reverse pointer lives inside the session repo's own .git
// directory, so it can only exist because `git worktree add` (an operation
// the rail already governs) registered exactly this checkout. We therefore
// require both pointers to canonicalize to each other before trusting a path.
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { existingRealPath } from "./paths.ts";

/** Reads a `.git` gitfile and returns its canonicalized `gitdir:` target, or undefined when the file is not a well-formed gitfile. */
function gitfileTarget(gitfilePath: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(gitfilePath, "utf8");
  } catch {
    return undefined;
  }
  const match = content.split("\n")[0]?.match(/^gitdir:\s*(.+?)\s*$/);
  if (!match) return undefined;
  // A relative gitdir is relative to the directory containing the gitfile.
  return existingRealPath(path.resolve(path.dirname(gitfilePath), match[1]!));
}

/** The deepest existing ancestor of the path (or the path itself), canonicalized. Lets not-yet-written paths participate: their enclosing worktree is what matters. */
function canonicalExistingAncestor(candidatePath: string): string | undefined {
  let current = path.resolve(candidatePath);
  for (;;) {
    const canonical = existingRealPath(current);
    if (canonical !== undefined) return canonical;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The root of the session-repo checkout containing candidatePath, or
 * undefined when no ancestor is a verified checkout of that repo. Two cases
 * qualify:
 *
 * - A linked worktree REGISTERED BY the session repo, verified bidirectionally:
 *   the ancestor's `.git` file must point into `<sessionGitDir>/worktrees/<name>`
 *   (forward), and that registry entry's `gitdir` file must point back at the
 *   very `.git` file we found (reverse — the security boundary; see the module
 *   comment). Every path segment is canonicalized so symlinks cannot alias a
 *   foreign directory into looking registered.
 *
 * - The main checkout itself: an ancestor whose `.git` DIRECTORY is the
 *   session git dir. This is what makes the main tree trusted when the
 *   session cwd is one of its linked worktrees.
 *
 * A `.git` that fails verification does not end the walk: a forged or foreign
 * `.git` nested inside a real worktree must not shadow the enclosing trusted
 * root, mirroring how isInside(cwd, …) trusts everything under cwd.
 */
export function linkedWorktreeRoot(sessionGitDir: string, candidatePath: string): string | undefined {
  const commonDir = existingRealPath(sessionGitDir);
  if (commonDir === undefined) return undefined;
  const registryDir = path.join(commonDir, "worktrees");
  let dir = canonicalExistingAncestor(candidatePath);
  if (dir === undefined) return undefined;
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let kind: "file" | "dir" | undefined;
    try {
      const stat = statSync(dotGit);
      kind = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : undefined;
    } catch {
      kind = undefined;
    }
    if (kind === "dir") {
      const canonical = existingRealPath(dotGit);
      if (canonical !== undefined && canonical === commonDir) return dir;
    } else if (kind === "file") {
      const gitdir = gitfileTarget(dotGit);
      // Forward: the gitfile must target a direct registry entry — exactly
      // <commonDir>/worktrees/<name>, nothing deeper or elsewhere.
      if (gitdir !== undefined && path.dirname(gitdir) === registryDir) {
        // Reverse: the registry entry must name this very gitfile. The entry
        // is inside the session repo's .git, so only a governed
        // `git worktree add` could have written it.
        let registered: string | undefined;
        try {
          registered = readFileSync(path.join(gitdir, "gitdir"), "utf8").trim();
        } catch {
          registered = undefined;
        }
        if (registered !== undefined && registered !== "") {
          const registeredCanonical = existingRealPath(path.resolve(gitdir, registered));
          if (registeredCanonical !== undefined && registeredCanonical === existingRealPath(dotGit)) return dir;
        }
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The session repo's COMMON git dir, resolved by walking up from cwd. When
 * cwd is (inside) the main checkout that is its `.git` directory; when cwd is
 * itself inside a linked worktree, the gitfile's target is unwrapped past
 * `worktrees/<name>` to the shared dir, so sibling worktrees and the main
 * checkout all anchor on the same registry and trust each other. Cached per
 * cwd: the repo a session runs in does not move mid-session, and a cwd that
 * is not a repo stays not-a-repo for trust purposes.
 */
const sessionGitDirCache = new Map<string, string | undefined>();

export function sessionGitCommonDir(cwd: string): string | undefined {
  if (sessionGitDirCache.has(cwd)) return sessionGitDirCache.get(cwd);
  const result = resolveSessionGitCommonDir(cwd);
  sessionGitDirCache.set(cwd, result);
  return result;
}

function resolveSessionGitCommonDir(cwd: string): string | undefined {
  let dir = existingRealPath(cwd);
  if (dir === undefined) return undefined;
  for (;;) {
    const dotGit = path.join(dir, ".git");
    try {
      const stat = statSync(dotGit);
      if (stat.isDirectory()) return realpathSync.native(dotGit);
      if (stat.isFile()) {
        const gitdir = gitfileTarget(dotGit);
        if (gitdir !== undefined) {
          // A worktree's gitdir is <common>/worktrees/<name>; anchoring on
          // <common> is what lets checkouts of the same repo trust each
          // other. Any other gitfile target (e.g. a submodule's gitdir under
          // .git/modules) is itself the common dir for that checkout.
          return path.basename(path.dirname(gitdir)) === "worktrees" ? path.dirname(path.dirname(gitdir)) : gitdir;
        }
      }
    } catch {
      // No .git at this level; keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface SessionCheckout {
  /** Canonical root of the verified checkout containing the candidate. */
  root: string;
  /** True for a linked worktree (gitfile), false for the main checkout (.git directory). */
  linked: boolean;
}

/**
 * The verified session-repo checkout containing candidatePath, when that
 * checkout is a DIFFERENT one than the checkout cwd itself occupies. The
 * same-checkout case stays undefined on purpose: paths inside cwd are covered
 * by the plain isInside trust with cwd anchoring, and a cwd that is a
 * SUBDIRECTORY of its checkout may be a deliberate narrowing — worktree trust
 * must not quietly widen it to the whole repo. Only sibling checkouts (linked
 * worktrees, or the main checkout when cwd lives in a worktree) qualify.
 */
export function sessionCheckoutRoot(cwd: string, candidatePath: string): SessionCheckout | undefined {
  const commonDir = sessionGitCommonDir(cwd);
  if (commonDir === undefined) return undefined;
  const root = linkedWorktreeRoot(commonDir, candidatePath);
  if (root === undefined) return undefined;
  const canonicalCwd = existingRealPath(cwd);
  if (canonicalCwd !== undefined) {
    const rel = path.relative(root, canonicalCwd);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return undefined;
  }
  let linked = false;
  try {
    linked = statSync(path.join(root, ".git")).isFile();
  } catch {
    // Verified a moment ago; treat a race as the main-checkout wording.
  }
  return { root, linked };
}
