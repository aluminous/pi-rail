import { DEFAULT_DISPOSITIONS, isBuiltinCapabilityId, isStricter, type CapabilityId, type Disposition } from "./capabilities.ts";
import { literalWordText, parseShellCommand, type ShellCommand, type ShellWord } from "./shell-parse.ts";

/**
 * Deterministic shell-command matching over the parsed AST: a command is
 * matched only when it parses under the minimal shell grammar and EVERY
 * simple command in every chain and pipeline matches a rule template, so
 * "grep a || grep b" passes "grep *" but "grep a; rm x" does not. Anything
 * the grammar cannot model (heredocs, process substitution, unbalanced
 * quotes) is a parse error and never matches; anything it can model but
 * this layer cannot judge — expansions, redirects, subshells, background
 * jobs — parses fine and is conservatively unmatchable.
 *
 * Two rule lists share this machinery and this grammar: the built-in
 * allowlist below (`commands.allow`, whose templates are read-only by
 * construction save the stash carve-out documented there) and user
 * classification rules (`commands.classify`, which map
 * a template to any capability class, including custom ones). They differ only
 * in where the capability tag comes from. Neither list is consulted "first":
 * every rule of every layer goes into one pool and the most specific rule that
 * matches a segment wins (see compareRules), so a narrow carve-out works in
 * either direction — a narrow allow inside a broad strict rule, or a narrow
 * strict rule inside a broad allow — without anyone ordering anything.
 */

/** A command template plus the capability class a match deterministically resolves to. */
export interface CommandCapabilityRule {
  template: string;
  capability: CapabilityId;
  /**
   * Flags allowlist: when present, every argv word after the template's
   * literal prefix that starts with `-` must be accepted by it (see
   * flagRejection) or the rule does not match. Absent means any flags.
   */
  flags?: string[];
}

/**
 * Default allowlist. Inclusion bar: EVERY invocation matching a template must
 * be unable to write files, execute other programs, or reach the network —
 * the sandbox is the outer bound, but these skip the namer entirely, so the
 * templates themselves must be write-proof. That bar is why some obvious
 * candidates are deliberately absent: find (-exec/-delete), sed (-i), awk
 * (in-program `print > file`), sort (-o), uniq (positional outfile), xxd
 * (-r with outfile), tee and tree (-o) write files; env/command/xargs/
 * timeout/time run other programs; date/hostname with args can attempt to
 * set system state, so only their bare forms are listed. Mutating git
 * subcommands (remote add, tag NAME, config KEY VAL, reflog expire) are
 * excluded by pinning those subcommands to their read-only spellings. The one
 * write-capable carve-out is stash create/reapply (stash, push, pop, apply):
 * stashing PRESERVES work rather than discarding it — entries persist in the
 * stash reflog and an apply that would clobber changes fails — while drop and
 * clear, which do discard entries, stay off the list.
 *
 * Each template also carries the capability it resolves to, which is what
 * makes the allowlist a *cache of a label* rather than a cache of a verdict:
 * flipping `read-project` to ask in the disposition table retunes the fast
 * path too. Machine introspection (uname, whoami, printenv) is read-system;
 * toolchain probes are run-dev-tools; stash create/reapply is modify-project;
 * everything else here is read-project.
 */
// ── Flags allowlists for the built-in templates ──────────────────────────────
//
// A wildcard built-in skips the namer for EVERY flag unless it carries a flags
// allowlist, so each one was audited against the inclusion bar above. Where a
// flag writes, deletes, or runs another program, the template lists the flags
// that do not; everything else falls to the namer. Findings:
//
// - rg: --pre / --pre-glob run an arbitrary program per file; -z /
//   --search-zip runs decompressors.
// - git log / show / reflog show / stash show / diff: --output=<file> writes a
//   file; --ext-diff runs an external diff program; --show-signature runs gpg.
// - git grep: -O / --open-files-in-pager runs a pager program; --textconv
//   runs configured filters.
// - git shortlog: accepts log options (--output among them).
// - git branch: -d/-D/--delete, -m/-M/--move, -c/-C/--copy, -f/--force,
//   -u/--set-upstream-to, --unset-upstream, --edit-description all write —
//   and a bare positional (`git branch newname`) CREATES a branch, which no
//   flags allowlist can stop. So `git branch *` is gone: the plain listing
//   forms are exact templates, and only `git branch --list *` / `-l *` (where
//   positionals are patterns) keep a wildcard, with read-only flags.
// - git tag -l / --list and git config --get: pinned to their read spellings
//   already; their flags are now pinned too, so a write flag after the
//   read flag (`git config --get --unset`, `git tag -l -d`) cannot ride along.
// - file: -C compiles a magic file (writes); -z / -Z run decompressors.
// - diff: -l / --paginate pipes through pr (runs a program); -D / --ifdef is
//   output-only but kept off as a destructive-looking flag.
// Everything else (grep, ls, cat, head, tail, wc, stat, du, df, cmp, comm, jq,
// cut, tr, nl, column, od, hexdump, strings, the hashers, the path tools,
// printenv, ps, uname, sw_vers, defaults read, sleep, which, type, echo,
// git status/blame/describe/rev-parse/ls-files/merge-base/show-ref, the git
// stash carve-out, npm ls) has no flag that writes, deletes, or executes, and
// keeps "any flags".

/** `--name=` entries also accept `--name <value>`: the value is a separate positional word. */
function withBareLongForms(flags: readonly string[]): string[] {
  const out = new Set(flags);
  for (const flag of flags) if (flag.startsWith("--") && flag.endsWith("=")) out.add(flag.slice(0, -1));
  return [...out];
}

const DIGIT_FLAGS = ["-0", "-1", "-2", "-3", "-4", "-5", "-6", "-7", "-8", "-9"];

const GIT_DIFF_OUTPUT_FLAGS = [
  "-p", "-u", "--patch", "-s", "--no-patch", "-U", "--unified=", "--stat", "--stat=", "--numstat", "--shortstat", "--dirstat", "--dirstat=",
  "--summary", "--compact-summary", "--name-only", "--name-status", "--raw", "--patch-with-stat", "--patch-with-raw", "-z",
  "--color", "--color=", "--no-color", "--color-words", "--color-words=", "--word-diff", "--word-diff=", "--word-diff-regex=",
  "--color-moved", "--color-moved=", "--no-color-moved", "--no-renames", "-M", "--find-renames", "--find-renames=", "-C", "--find-copies",
  "--find-copies=", "-B", "--break-rewrites", "--diff-filter=", "-S", "-G", "--pickaxe-all", "--pickaxe-regex", "-R", "--relative",
  "--relative=", "--no-relative", "-a", "--text", "-w", "--ignore-all-space", "-b", "--ignore-space-change", "--ignore-blank-lines",
  "--ignore-cr-at-eol", "--ignore-space-at-eol", "--minimal", "--patience", "--histogram", "--diff-algorithm=", "--exit-code", "--quiet",
  "--abbrev", "--abbrev=", "--full-index", "--binary", "--src-prefix=", "--dst-prefix=", "--no-prefix", "--check", "--ws-error-highlight=",
  "-W", "--function-context", "--inter-hunk-context=", "--no-ext-diff", "--no-textconv", "--submodule", "--submodule=",
  "--ignore-submodules", "--ignore-submodules=", "--full-diff",
];

/** git diff: output flags, the comparison modes, and the merge-stage digits. No --output, no --ext-diff. */
export const GIT_DIFF_FLAGS = withBareLongForms([...GIT_DIFF_OUTPUT_FLAGS, "--cached", "--staged", "--merge-base", "--no-index", "--base", "--ours", "--theirs", ...DIGIT_FLAGS]);

/** git log / show / reflog show: revision walking and formatting on top of the diff output flags. No --output, --ext-diff, or --show-signature. */
export const GIT_LOG_FLAGS = withBareLongForms([
  ...GIT_DIFF_OUTPUT_FLAGS,
  "--oneline", "--graph", "--decorate", "--decorate=", "--no-decorate", "--all", "--branches", "--branches=", "--tags", "--tags=", "--remotes",
  "--remotes=", "-n", "--max-count=", "--skip=", "--since=", "--after=", "--until=", "--before=", "--author=", "--committer=", "--grep=",
  "--invert-grep", "-i", "--regexp-ignore-case", "-E", "--extended-regexp", "-F", "--fixed-strings", "-P", "--perl-regexp", "--all-match",
  "--merges", "--no-merges", "--min-parents=", "--max-parents=", "--first-parent", "--reverse", "--follow", "--format=", "--pretty",
  "--pretty=", "--abbrev-commit", "--no-abbrev-commit", "--date=", "--relative-date", "--source", "--left-right", "--cherry-pick",
  "--cherry-mark", "--cherry", "--boundary", "--ancestry-path", "--simplify-by-decoration", "--full-history", "--topo-order",
  "--date-order", "--author-date-order", "--notes", "--notes=", "--no-notes", "--mailmap", "--use-mailmap", "--no-mailmap", "--encoding=",
  "-m", "--cc", "-c", "--no-walk", "--do-walk", "--parents", "--children", "-L", "--log-size", "-g", "--walk-reflogs", ...DIGIT_FLAGS,
]);

/** git stash show: diff output only. */
export const GIT_STASH_SHOW_FLAGS = withBareLongForms([...GIT_DIFF_OUTPUT_FLAGS, "--include-untracked", "-u", "--only-untracked"]);

/** git grep: matching and output flags. No -O / --open-files-in-pager, no --textconv. */
export const GIT_GREP_FLAGS = withBareLongForms([
  "-i", "--ignore-case", "-I", "-w", "--word-regexp", "-v", "--invert-match", "-n", "--line-number", "--column", "-l", "--files-with-matches",
  "--name-only", "-L", "--files-without-match", "-c", "--count", "-h", "-H", "--full-name", "-e", "-E", "--extended-regexp", "-G",
  "--basic-regexp", "-F", "--fixed-strings", "-P", "--perl-regexp", "--and", "--or", "--not", "--all-match", "-q", "--quiet", "--heading",
  "--break", "-p", "--show-function", "-W", "--function-context", "-A", "-B", "-C", "--after-context=", "--before-context=", "--context=",
  "--color", "--color=", "--no-color", "--cached", "--untracked", "--no-index", "--exclude-standard", "--no-exclude-standard",
  "--recurse-submodules", "--max-depth=", "-r", "--recursive", "--no-recursive", "-o", "--only-matching", "-z", "--null", "-m",
  "--max-count=", "--threads=", "-f", "-a", "--text", "--no-textconv", ...DIGIT_FLAGS,
]);

/** git shortlog: grouping and revision limiting. */
export const GIT_SHORTLOG_FLAGS = withBareLongForms([
  "-n", "--numbered", "-s", "--summary", "-e", "--email", "-c", "--committer", "--group=", "--format=", "-w", "--all", "--since=", "--after=",
  "--until=", "--before=", "--no-merges", "--merges", "--author=", "--branches", "--tags", "--remotes", "--first-parent", "--reverse",
]);

/** git branch --list / -l: read-only listing flags (positionals are patterns in list mode). */
export const GIT_BRANCH_LIST_FLAGS = withBareLongForms([
  "-a", "-r", "-v", "--all", "--remotes", "--verbose", "--list", "-l", "--merged", "--no-merged", "--contains", "--no-contains",
  "--points-at", "--sort=", "--format=", "--color", "--color=", "--no-color", "--column", "--column=", "--no-column", "-i", "--ignore-case",
  "--omit-empty", "--abbrev=", "--no-abbrev",
]);

/** git tag -l / --list: listing flags. */
export const GIT_TAG_LIST_FLAGS = withBareLongForms([
  "-l", "--list", "-n", "--sort=", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format=", "--column",
  "--column=", "--no-column", "--color", "--color=", "-i", "--ignore-case", "--omit-empty", ...DIGIT_FLAGS,
]);

/** git config --get: scope and type flags for reading. */
export const GIT_CONFIG_GET_FLAGS = withBareLongForms([
  "--get", "--get-all", "--get-regexp", "--global", "--system", "--local", "--worktree", "--file=", "-f", "--blob=", "--type=", "--bool",
  "--int", "--bool-or-int", "--path", "--expiry-date", "--null", "-z", "--show-origin", "--show-scope", "--default=", "--includes",
  "--no-includes", "--name-only",
]);

/** rg: search and output flags. No --pre / --pre-glob (run a program), no -z / --search-zip (run decompressors). */
export const RG_FLAGS = withBareLongForms([
  "-i", "--ignore-case", "-S", "--smart-case", "-s", "--case-sensitive", "-w", "--word-regexp", "-x", "--line-regexp", "-v",
  "--invert-match", "-n", "--line-number", "-N", "--no-line-number", "-l", "--files-with-matches", "--files-without-match", "-c", "--count",
  "--count-matches", "-o", "--only-matching", "-A", "-B", "-C", "--after-context=", "--before-context=", "--context=", "-e", "--regexp=",
  "-f", "--file=", "-F", "--fixed-strings", "-U", "--multiline", "--multiline-dotall", "-g", "--glob=", "--iglob=",
  "--glob-case-insensitive", "-t", "--type=", "-T", "--type-not=", "--type-list", "--hidden", "-.", "--no-ignore", "--no-ignore-vcs",
  "--no-ignore-dot", "--no-ignore-parent", "--no-ignore-global", "-u", "--unrestricted", "-L", "--follow", "-m", "--max-count=",
  "--max-depth=", "-d", "--max-filesize=", "--files", "--json", "--vimgrep", "--heading", "--no-heading", "-H", "--with-filename", "-I",
  "--no-filename", "--column", "--no-column", "--color=", "--colors=", "-p", "--pretty", "-q", "--quiet", "--sort=", "--sortr=", "-0",
  "--null", "--null-data", "--trim", "-M", "--max-columns=", "--max-columns-preview", "--stats", "-j", "--threads=", "-E", "--encoding=",
  "-P", "--pcre2", "--no-pcre2-unicode", "--no-messages", "-r", "--replace=", "--passthru", "-a", "--text", "-b", "--byte-offset",
  "--line-buffered", "--block-buffered", "--crlf", "--engine=", "--include-zero", "-h", "--help", "-V", "--version",
]);

/** file: identification flags. No -C (compiles a magic file: writes), no -z / -Z (run decompressors). */
export const FILE_FLAGS = withBareLongForms([
  "-b", "--brief", "-i", "-I", "--mime", "--mime-type", "--mime-encoding", "-L", "--dereference", "-h", "--no-dereference", "-s",
  "--special-files", "-k", "--keep-going", "-n", "--no-buffer", "-N", "--no-pad", "-0", "--print0", "-E", "-e", "--exclude=", "--extension",
  "--apple", "-r", "--raw", "-m", "--magic-file=", "-f", "--files-from=", "-F", "--separator=", "-v", "--version", "--help",
]);

/** diff: comparison and output flags. No -l / --paginate (runs pr), no -D / --ifdef. */
export const DIFF_FLAGS = withBareLongForms([
  "-u", "-U", "--unified", "--unified=", "-c", "-C", "--context", "--context=", "-q", "--brief", "-s", "--report-identical-files", "-r",
  "--recursive", "-N", "--new-file", "--unidirectional-new-file", "-i", "--ignore-case", "-w", "--ignore-all-space", "-b",
  "--ignore-space-change", "-B", "--ignore-blank-lines", "-E", "--ignore-tab-expansion", "-Z", "--ignore-trailing-space",
  "--strip-trailing-cr", "-I", "--ignore-matching-lines=", "-a", "--text", "-y", "--side-by-side", "-W", "--width=", "--left-column",
  "--suppress-common-lines", "-t", "--expand-tabs", "-T", "--initial-tab", "--tabsize=", "--color", "--color=", "-x", "--exclude=", "-X",
  "--exclude-from=", "-S", "--starting-file=", "--label=", "-p", "--show-c-function", "-F", "--show-function-line=", "-d", "--minimal",
  "--speed-large-files", "--horizon-lines=", "-e", "--ed", "-n", "--rcs", "--normal", "--from-file=", "--to-file=", "--no-dereference",
  "--ignore-file-name-case", "--no-ignore-file-name-case",
]);

export const DEFAULT_COMMAND_ALLOW_RULES: CommandCapabilityRule[] = [
  // File and text inspection (stdout-only)
  { template: "grep *", capability: "read-project" },
  { template: "rg *", capability: "read-project", flags: RG_FLAGS },
  { template: "ls *", capability: "read-project" },
  { template: "cat *", capability: "read-project" },
  { template: "head *", capability: "read-project" },
  { template: "tail *", capability: "read-project" },
  { template: "wc *", capability: "read-project" },
  { template: "pwd", capability: "read-project" },
  { template: "which *", capability: "read-system" },
  { template: "type *", capability: "read-system" },
  { template: "file *", capability: "read-project", flags: FILE_FLAGS },
  { template: "stat *", capability: "read-project" },
  { template: "echo *", capability: "read-project" },
  { template: "du *", capability: "read-project" },
  { template: "df *", capability: "read-system" },
  { template: "diff *", capability: "read-project", flags: DIFF_FLAGS },
  { template: "cmp *", capability: "read-project" },
  { template: "comm *", capability: "read-project" },
  { template: "basename *", capability: "read-project" },
  { template: "dirname *", capability: "read-project" },
  { template: "realpath *", capability: "read-project" },
  { template: "readlink *", capability: "read-project" },
  { template: "nl *", capability: "read-project" },
  { template: "cut *", capability: "read-project" },
  { template: "tr *", capability: "read-project" },
  { template: "column *", capability: "read-project" },
  { template: "od *", capability: "read-project" },
  { template: "hexdump *", capability: "read-project" },
  { template: "strings *", capability: "read-project" },
  { template: "jq *", capability: "read-project" },
  { template: "shasum *", capability: "read-project" },
  { template: "sha256sum *", capability: "read-project" },
  { template: "md5 *", capability: "read-project" },
  { template: "cksum *", capability: "read-project" },
  // System introspection (read-only forms)
  { template: "printenv *", capability: "read-system" },
  { template: "env", capability: "read-system" },
  { template: "ps *", capability: "read-system" },
  { template: "id", capability: "read-system" },
  { template: "whoami", capability: "read-system" },
  { template: "groups", capability: "read-system" },
  { template: "hostname", capability: "read-system" },
  { template: "date", capability: "read-system" },
  { template: "uname *", capability: "read-system" },
  { template: "sw_vers *", capability: "read-system" },
  { template: "defaults read *", capability: "read-system" },
  { template: "sleep *", capability: "read-system" },
  // Git, read-only spellings only
  { template: "git status *", capability: "read-project" },
  { template: "git log *", capability: "read-project", flags: GIT_LOG_FLAGS },
  { template: "git diff *", capability: "read-project", flags: GIT_DIFF_FLAGS },
  { template: "git show *", capability: "read-project", flags: GIT_LOG_FLAGS },
  // Not `git branch *`: a bare positional creates a branch (see the audit above).
  { template: "git branch", capability: "read-project" },
  { template: "git branch --show-current", capability: "read-project" },
  { template: "git branch -a", capability: "read-project" },
  { template: "git branch -r", capability: "read-project" },
  { template: "git branch -v", capability: "read-project" },
  { template: "git branch -vv", capability: "read-project" },
  { template: "git branch -av", capability: "read-project" },
  { template: "git branch --all", capability: "read-project" },
  { template: "git branch --remotes", capability: "read-project" },
  { template: "git branch --list *", capability: "read-project", flags: GIT_BRANCH_LIST_FLAGS },
  { template: "git branch -l *", capability: "read-project", flags: GIT_BRANCH_LIST_FLAGS },
  { template: "git blame *", capability: "read-project" },
  { template: "git grep *", capability: "read-project", flags: GIT_GREP_FLAGS },
  { template: "git shortlog *", capability: "read-project", flags: GIT_SHORTLOG_FLAGS },
  { template: "git describe *", capability: "read-project" },
  { template: "git rev-parse *", capability: "read-project" },
  { template: "git ls-files *", capability: "read-project" },
  { template: "git merge-base *", capability: "read-project" },
  { template: "git show-ref *", capability: "read-project" },
  { template: "git remote", capability: "read-project" },
  { template: "git remote -v", capability: "read-project" },
  { template: "git stash list", capability: "read-project" },
  { template: "git stash show *", capability: "read-project", flags: GIT_STASH_SHOW_FLAGS },
  { template: "git stash", capability: "modify-project" },
  { template: "git stash push *", capability: "modify-project" },
  { template: "git stash pop *", capability: "modify-project" },
  { template: "git stash apply *", capability: "modify-project" },
  { template: "git worktree list", capability: "read-project" },
  { template: "git tag", capability: "read-project" },
  { template: "git tag -l *", capability: "read-project", flags: GIT_TAG_LIST_FLAGS },
  { template: "git tag --list *", capability: "read-project", flags: GIT_TAG_LIST_FLAGS },
  { template: "git config --list", capability: "read-project" },
  { template: "git config -l", capability: "read-project" },
  { template: "git config --get *", capability: "read-project", flags: GIT_CONFIG_GET_FLAGS },
  { template: "git reflog", capability: "read-project" },
  { template: "git reflog show *", capability: "read-project", flags: GIT_LOG_FLAGS },
  // Toolchain probes
  { template: "git --version", capability: "run-dev-tools" },
  { template: "node --version", capability: "run-dev-tools" },
  { template: "node -v", capability: "run-dev-tools" },
  { template: "npm --version", capability: "run-dev-tools" },
  { template: "npm ls *", capability: "run-dev-tools" },
  { template: "python3 --version", capability: "run-dev-tools" },
  { template: "python --version", capability: "run-dev-tools" },
  { template: "go version", capability: "run-dev-tools" },
  { template: "cargo --version", capability: "run-dev-tools" },
  { template: "rustc --version", capability: "run-dev-tools" },
  { template: "tsc --version", capability: "run-dev-tools" },
];


/** Capability a user-configured template gets: plain strings in `commands.allow` are inspection by convention. */
export const CONFIGURED_TEMPLATE_CAPABILITY: CapabilityId = "read-project";

const DEFAULT_TEMPLATE_CAPABILITIES = new Map<string, CapabilityId>(
  DEFAULT_COMMAND_ALLOW_RULES.map((rule) => [rule.template, rule.capability]),
);

export const DEFAULT_COMMAND_ALLOWLIST: string[] = DEFAULT_COMMAND_ALLOW_RULES.map((rule) => rule.template);

/** The built-in templates' flags allowlists, keyed by template (the shape of `commands.allowFlags`). */
export const DEFAULT_COMMAND_ALLOW_FLAGS: Record<string, string[]> = Object.fromEntries(
  DEFAULT_COMMAND_ALLOW_RULES.flatMap((rule) => (rule.flags ? [[rule.template, [...rule.flags]]] : [])),
);

/** Same flags allowlist (both absent, or the same set). */
function sameFlagSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((flag) => left.has(flag));
}

/**
 * The capability a matched template resolves to. Config keeps `commands.allow`
 * as plain strings (one grammar, no migration); a string that is still one of
 * the built-in templates keeps that template's tag, and anything the user
 * added defaults to read-project.
 */
export function capabilityForTemplate(template: string): CapabilityId {
  return DEFAULT_TEMPLATE_CAPABILITIES.get(template.trim()) ?? CONFIGURED_TEMPLATE_CAPABILITY;
}

function templateTokens(template: string): string[] {
  return template.trim().split(/\s+/).filter((token) => token.length > 0);
}

/**
 * Why this string cannot serve as a template, or undefined when it can. Used at
 * config load: a rule that can never match is a silent no-op, and the two ways
 * to write one — a misplaced `*`, and a bare `*` — are worth a diagnostic. The
 * bare `*` is rejected rather than supported: it would match every segment of
 * every command, which turns the namer off for bash without ever saying so.
 */
export function commandTemplateProblem(template: string): string | undefined {
  const tokens = templateTokens(template);
  if (tokens.length === 0) return "template must be a non-empty command template";
  if (tokens[0] === "*") return "a template must name a command head before `*` — a bare `*` would match every command";
  const star = tokens.indexOf("*");
  if (star !== -1 && star !== tokens.length - 1) return "`*` only means \"any arguments\" as the last word; anywhere else it matches literally";
  return undefined;
}

// ── Flags allowlists ─────────────────────────────────────────────────────────

/**
 * Why `flags` cannot serve as a flags allowlist for `template`, or undefined
 * when it can. An allowlist rather than a denylist because a denylist leaks:
 * git accepts any unambiguous abbreviation of a long option, so excluding
 * `--force` would not stop `--forc`. Matching is therefore exact, and every
 * shape this rejects is one whose meaning would otherwise be a guess:
 *
 * - `--name` accepts exactly `--name`; `--name=` accepts `--name=<any value>`
 *   (and only that form). `--name=value` is refused — list `--name=` instead.
 * - `-x` is one short flag; a single-dash word in a command is a cluster whose
 *   every letter must be listed. A longer single-dash entry (`-name`, for the
 *   tools that spell long options that way) accepts that exact word only.
 *   Attached values for short flags (`-C=`, `-n5`) are not supported: a
 *   cluster with an unlisted letter simply fails, which is the safe answer.
 * - `-` and `--` are never flags (a lone dash is a positional, and `--` always
 *   ends flag checking), so listing them is a mistake worth saying.
 * - A template without a trailing `*` has no words after its literal prefix,
 *   so flags on it would never be consulted — refused rather than silently
 *   ranking it as "narrower" than an identical rule without them.
 */
export function commandFlagsProblem(template: string, flags: unknown): string | undefined {
  if (!Array.isArray(flags)) return "flags must be an array of strings";
  if (templateTokens(template).at(-1) !== "*") return "flags only apply to a template ending in `*` — an exact template has no further words to check";
  for (const entry of flags) {
    if (typeof entry !== "string") return "flags must be an array of strings";
    const shown = JSON.stringify(entry);
    if (!entry.startsWith("-")) return `flag ${shown} must start with "-"`;
    if (/\s/.test(entry)) return `flag ${shown} must not contain whitespace`;
    if (entry === "-" || entry === "--") return `flag ${shown} is not a flag — a lone "-" is positional and "--" always ends flag checking`;
    if (entry.startsWith("--")) {
      const eq = entry.indexOf("=");
      if (eq !== -1 && eq !== entry.length - 1) return `flag ${shown} pins a value — list "${entry.slice(0, eq + 1)}" to accept that flag with any value`;
      if (entry === "--=") return `flag ${shown} has no name`;
    } else if (entry.includes("=")) {
      return `flag ${shown}: attached values for short flags are not supported`;
    }
  }
  return undefined;
}

/**
 * The first word in `words` (argv after the literal prefix) that `flags`
 * does not accept, or undefined when it accepts them all. See
 * commandFlagsProblem for the accepted shapes; anything that starts with `-`
 * and is not `-` or `--` is a flag, so `-1` must be listed to pass.
 *
 * A word carrying UNQUOTED glob or brace characters is refused too,
 * whatever it starts with: the shell expands them — `*` in a directory
 * holding a file named `--force`, or `{--force,x}`, becomes a flag the
 * allowlist never saw. `globbed` says per word whether the parser saw such a
 * character outside quotes (ShellWord.glob); without it every word holding
 * one is refused, quoted or not, which is the safe reading of plain strings.
 * After `--` an expansion can only produce positionals, so the check stops
 * there like the flag check does.
 */
export function flagRejection(words: readonly string[], flags: ReadonlySet<string>, globbed?: readonly boolean[]): string | undefined {
  for (const [index, word] of words.entries()) {
    if (word === "--") return undefined;
    if (globbed ? globbed[index] === true : /[*?[{]/.test(word)) return word;
    if (word === "-" || !word.startsWith("-")) continue;
    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const listed = eq === -1 ? flags.has(word) : flags.has(word.slice(0, eq + 1));
      if (!listed) return word;
      continue;
    }
    if (flags.has(word)) continue;
    for (const letter of word.slice(1)) {
      if (!flags.has(`-${letter}`)) return word;
    }
  }
  return undefined;
}

// ── The rule pool and its ranking ────────────────────────────────────────────

/** Which rule list a rule came from. */
export type CommandRuleSource = "classify" | "allow";

/**
 * One rule in the matching pool. `rank` is the rule's position in the policy
 * fold — [layer, grant] with default (0) < global < project < session and, within
 * a layer, base keys before grants and earlier grants before later ones —
 * compared lexicographically, higher winning. A layer of 0 marks a built-in
 * default, which every user rule outranks regardless of specificity (see
 * compareRules); among user rules rank is only tiebreak (d).
 */
export interface CommandRule {
  template: string;
  capability: CapabilityId;
  flags?: readonly string[];
  source: CommandRuleSource;
  rank: readonly number[];
  /** Where the rule came from, for explanations ("default", "project · worktree-cleanup"). */
  origin?: string;
  /** The named grant that wrote the rule, for attributing a decision to it (absent for base keys and defaults). */
  grant?: string;
}

/**
 * Everything the matcher needs: the pool, and how to resolve a class to its
 * disposition for the last ranking step. The resolver is passed in rather
 * than imported so the matcher stays independent of the interceptor and of
 * session state; the interceptor passes one that includes the read-only
 * preset, so "stricter" means stricter right now.
 */
export interface CommandRuleSet {
  rules: CommandRule[];
  disposition: (capability: CapabilityId) => Disposition;
}

/**
 * The plain list form tests and simple callers use. Ranked as a typical
 * config would be: built-in allowlist templates at the default layer,
 * everything else (classify rules, user allow templates) one layer up.
 */
export interface CommandRuleLists {
  classify?: CommandCapabilityRule[];
  allow: string[];
  /** Flags allowlists for `allow` entries, keyed by template. */
  allowFlags?: Record<string, readonly string[]>;
}

/** Built-in disposition for a class, `ask` for anything else — the resolver when a caller has no config. */
export function defaultDispositionOf(capability: CapabilityId): Disposition {
  return isBuiltinCapabilityId(capability) ? DEFAULT_DISPOSITIONS[capability] : "ask";
}

function ruleSetFromLists(lists: CommandRuleLists): CommandRuleSet {
  const rules: CommandRule[] = [];
  for (const rule of lists.classify ?? []) {
    rules.push({ template: rule.template, capability: rule.capability, ...(rule.flags ? { flags: rule.flags } : {}), source: "classify", rank: [1] });
  }
  for (const template of lists.allow) {
    // A built-in template listed without its own flags keeps the built-in allowlist.
    const flags = lists.allowFlags?.[template.trim()] ?? DEFAULT_COMMAND_ALLOW_FLAGS[template.trim()];
    const builtin = DEFAULT_TEMPLATE_CAPABILITIES.has(template.trim()) && sameFlagSet(flags, DEFAULT_COMMAND_ALLOW_FLAGS[template.trim()]);
    rules.push({ template, capability: capabilityForTemplate(template), ...(flags ? { flags } : {}), source: "allow", rank: [builtin ? 0 : 1] });
  }
  return { rules, disposition: defaultDispositionOf };
}

interface PreparedRule {
  rule: CommandRule;
  text: string;
  /** The template's words without the trailing `*`. */
  literals: string[];
  anyArgs: boolean;
  flags?: ReadonlySet<string>;
  /** Pool position: the final, purely deterministic tiebreaker. */
  index: number;
}

function prepareRules(set: CommandRuleSet): PreparedRule[] {
  const prepared: PreparedRule[] = [];
  set.rules.forEach((rule, index) => {
    const tokens = templateTokens(rule.template);
    if (tokens.length === 0) return;
    const anyArgs = tokens.at(-1) === "*";
    prepared.push({
      rule,
      text: tokens.join(" "),
      literals: anyArgs ? tokens.slice(0, -1) : tokens,
      anyArgs,
      ...(rule.flags ? { flags: new Set(rule.flags) } : {}),
      index,
    });
  });
  return prepared;
}

/**
 * Whether a prepared rule matches argv: the literal prefix verbatim (head words
 * compare as written — "/usr/bin/grep" does not match "grep"), then, for a
 * `*` template with a flags allowlist, every flag word after the prefix.
 * `flag` names the word that stopped a template match that would otherwise
 * have held, so explanations can say why a narrower rule stood down.
 */
function matchRule(argv: string[], rule: PreparedRule, globbed?: readonly boolean[]): { matched: boolean; flag?: string } {
  const { literals, anyArgs } = rule;
  if (anyArgs ? argv.length < literals.length : argv.length !== literals.length) return { matched: false };
  if (!literals.every((token, index) => argv[index] === token)) return { matched: false };
  if (!rule.flags) return { matched: true };
  const flag = flagRejection(argv.slice(literals.length), rule.flags, globbed?.slice(literals.length));
  return flag === undefined ? { matched: true } : { matched: false, flag };
}

/** A rule from any config layer rather than the built-in defaults: rank's layer component is above default (0). */
function isUserRule(rule: CommandRule): boolean {
  return (rule.rank[0] ?? 0) > 0;
}

function compareRank(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Ranks two rules that both match a segment: positive when `a` wins, with the
 * reason it does. The order, and why:
 *
 *  tier first: any rule from a config layer (global, project, session — base
 *      keys or grants) outranks every built-in default that also matches.
 *      Built-in defaults are all allow-tagged inspection, so letting a more
 *      specific default beat a broad user rule (`git *` → something strict)
 *      could only ever loosen what the user wrote. A default a config layer
 *      restated is that layer's (the claim rule in policy-store), which is
 *      how a user keeps `git status *` allowed under their own `git *`.
 *      Specificity below then applies within the tier that won;
 *  (a) more literal words — the rule that names more of the command is the
 *      more deliberate statement about it;
 *  (b) an exact template over one ending in `*`, at equal literal count;
 *  (c) a rule with a flags allowlist over one without — it is the narrower
 *      statement about the same command words;
 *  (d) the later layer (see CommandRule.rank) — today's guarantee that a user
 *      rule on the same template overrides the built-in allowlist tag;
 *  (e) the stricter resolved disposition — two equally specific rules from
 *      the same place disagree, and the safe reading of a contradiction is the
 *      stricter one;
 *  then classify over allowlist and pool order, which only ever separate
 *  rules that resolve the same way and exist so the winner is deterministic.
 */
function compareRules(a: PreparedRule, b: PreparedRule, disposition: (capability: CapabilityId) => Disposition): { order: number; reason: string } {
  const userA = isUserRule(a.rule);
  if (userA !== isUserRule(b.rule)) return { order: userA ? 1 : -1, reason: "built-in default, a user rule matches" };
  if (a.literals.length !== b.literals.length) {
    return { order: a.literals.length - b.literals.length, reason: "more literal words" };
  }
  if (a.anyArgs !== b.anyArgs) return { order: a.anyArgs ? -1 : 1, reason: "an exact template beats one ending in `*`" };
  if (!!a.flags !== !!b.flags) return { order: a.flags ? 1 : -1, reason: "a flags allowlist is the narrower rule" };
  const rank = compareRank(a.rule.rank, b.rule.rank);
  if (rank !== 0) {
    const [later, earlier] = rank > 0 ? [a, b] : [b, a];
    const where = later.rule.origin && earlier.rule.origin ? ` (${later.rule.origin} over ${earlier.rule.origin})` : "";
    return { order: rank, reason: `a later layer${where}` };
  }
  const da = disposition(a.rule.capability);
  const db = disposition(b.rule.capability);
  if (da !== db) return { order: isStricter(da, db) ? 1 : -1, reason: `the stricter disposition (${isStricter(da, db) ? da : db})` };
  if (a.rule.source !== b.rule.source) return { order: a.rule.source === "classify" ? 1 : -1, reason: "a classify rule over an allowlist entry, same disposition" };
  return { order: b.index - a.index, reason: "declared first, same disposition" };
}

/** A rule that also matched a segment but lost, and the first ranking step that decided it. */
export interface OutrankedRule {
  rule: string;
  capability: CapabilityId;
  source: CommandRuleSource;
  origin?: string;
  reason: string;
}

/** A rule whose template matched a segment but whose flags allowlist refused one of its words. */
export interface FlagMiss {
  rule: string;
  flag: string;
}

/** One simple command's verdict: the matched rule and its tag, or why it can never match. */
export interface CommandSegmentVerdict {
  command: string;
  rule?: string;
  /** Capability the matched rule tags this segment with. */
  capability?: CapabilityId;
  /** Which list the matched rule came from. */
  source?: CommandRuleSource;
  /** The winning rule's flags allowlist, when it has one. */
  flags?: readonly string[];
  /** Where the winning rule came from, when the rule set says. */
  origin?: string;
  /** The named grant behind the winning rule, when one wrote it. */
  grant?: string;
  /** Other rules that matched and lost, most specific first. */
  outranked?: OutrankedRule[];
  /** Rules that would have matched but for a flag they do not list. */
  flagMisses?: FlagMiss[];
  refusal?: string;
}

/** Whole-command verdict: `matched` means every simple command in it matched some rule. */
export type CommandMatchExplanation =
  | { matched: true; segments: CommandSegmentVerdict[] }
  | { matched: false; reason: string; segments?: CommandSegmentVerdict[] };

/** Display form of a parsed segment: quote removal already applied, expansions kept verbatim. */
function describeSegment(command: ShellCommand): string {
  if (command.kind === "subshell") return "(…)";
  const words = [
    ...command.assignments.map((assignment) => `${assignment.name}=${wordText(assignment.value)}`),
    ...command.argv.map(wordText),
  ];
  return words.join(" ");
}

function wordText(word: ShellWord): string {
  return word.parts.map((part) => part.text).join("");
}

function flagMissText(misses: readonly FlagMiss[]): string {
  return misses.map((miss) => `\`${miss.rule}\` does not list \`${miss.flag}\``).join("; ");
}

function segmentVerdict(command: ShellCommand, set: CommandRuleSet, rules: PreparedRule[], noMatch: string): CommandSegmentVerdict {
  const text = describeSegment(command);
  if (command.kind === "subshell") return { command: text, refusal: "subshell grouping is never allowlisted" };
  if (command.redirects.length > 0) return { command: text, refusal: "redirects are never allowlisted" };
  if (command.assignments.some((assignment) => literalWordText(assignment.value) === undefined)) {
    return { command: text, refusal: "expansions in assignments are never allowlisted" };
  }
  const argv: string[] = [];
  const globbed: boolean[] = [];
  for (const word of command.argv) {
    const literal = literalWordText(word);
    if (literal === undefined) return { command: text, refusal: "expansions ($VAR, $(…), `…`) are never allowlisted" };
    argv.push(literal);
    globbed.push(word.glob === true);
  }
  if (argv.length === 0) return { command: text, refusal: "bare assignments have no command head to judge" };

  const matching: PreparedRule[] = [];
  const flagMisses: FlagMiss[] = [];
  for (const rule of rules) {
    const result = matchRule(argv, rule, globbed);
    if (result.matched) matching.push(rule);
    else if (result.flag !== undefined) flagMisses.push({ rule: rule.text, flag: result.flag });
  }
  if (matching.length === 0) {
    return { command: text, refusal: flagMisses.length > 0 ? `${noMatch} (${flagMissText(flagMisses)})` : noMatch, ...(flagMisses.length > 0 ? { flagMisses } : {}) };
  }
  matching.sort((a, b) => -compareRules(a, b, set.disposition).order);
  const winner = matching[0]!;
  const outranked = matching.slice(1).map((loser): OutrankedRule => ({
    rule: loser.text,
    capability: loser.rule.capability,
    source: loser.rule.source,
    ...(loser.rule.origin ? { origin: loser.rule.origin } : {}),
    reason: compareRules(winner, loser, set.disposition).reason,
  }));
  return {
    command: text,
    rule: winner.text,
    capability: winner.rule.capability,
    source: winner.rule.source,
    ...(winner.rule.flags ? { flags: winner.rule.flags } : {}),
    ...(winner.rule.origin ? { origin: winner.rule.origin } : {}),
    ...(winner.rule.grant ? { grant: winner.rule.grant } : {}),
    ...(outranked.length > 0 ? { outranked } : {}),
    ...(flagMisses.length > 0 ? { flagMisses } : {}),
  };
}

/**
 * Full per-segment verdict for a command, for the interceptor, decision traces,
 * and /rail test. The conservatism is the allowlist's, unchanged: every simple
 * command in every chain and pipeline must match, and anything this layer
 * cannot judge — expansions, redirects, subshells, background jobs — makes its
 * segment unmatchable no matter which rule would have matched it.
 */
export function explainCommandMatch(command: string, rules: CommandRuleSet | CommandRuleLists): CommandMatchExplanation {
  const set = "rules" in rules ? rules : ruleSetFromLists(rules);
  const prepared = prepareRules(set);
  if (prepared.length === 0) return { matched: false, reason: "no command rules are configured" };
  const noMatch = set.rules.some((rule) => rule.source === "classify") ? "no classify or allowlist rule matches" : "no allowlist rule matches";
  const parsed = parseShellCommand(command);
  if (!parsed.ok) return { matched: false, reason: `does not parse under the allowlist grammar: ${parsed.error}` };
  if (parsed.script.chains.length === 0) return { matched: false, reason: "empty command" };
  const segments: CommandSegmentVerdict[] = [];
  let background = false;
  for (const chain of parsed.script.chains) {
    if (chain.background) background = true;
    for (const pipeline of chain.pipelines) {
      for (const cmd of pipeline.commands) segments.push(segmentVerdict(cmd, set, prepared, noMatch));
    }
  }
  if (background) return { matched: false, reason: "background jobs (&) are never allowlisted", segments };
  const refused = segments.filter((segment) => segment.refusal);
  if (refused.length > 0) {
    return { matched: false, reason: refused.map((segment) => `\`${segment.command}\`: ${segment.refusal}`).join("; "), segments };
  }
  return { matched: true, segments };
}

/** True when the command parses and every simple command in it matches some allowlist rule. */
export function isCommandAllowlisted(command: string, rules: string[]): boolean {
  return explainCommandMatch(command, { allow: rules }).matched;
}

/**
 * Deterministic capability labels for a fully matched command: the union over
 * its segments, so `grep x && git log` is one read-project label and
 * `ls && node --version` carries read-project plus run-dev-tools. A partial
 * match yields nothing — matched segments never pre-seed labels for a command
 * the rules could not cover end to end.
 */
export function matchedCapabilities(explanation: CommandMatchExplanation): CapabilityId[] {
  if (!explanation.matched) return [];
  const seen: CapabilityId[] = [];
  for (const segment of explanation.segments) {
    if (segment.capability && !seen.includes(segment.capability)) seen.push(segment.capability);
  }
  return seen;
}

/** "`--dry-run -n`", or "none" for `flags: []`. */
export function describeFlags(flags: readonly string[]): string {
  return flags.length === 0 ? "none" : flags.join(" ");
}

function ruleLabel(source: CommandRuleSource | undefined, rule: string | undefined, flags: readonly string[] | undefined): string {
  const kind = source === "classify" ? "classify rule" : "rule";
  return `${kind} \`${rule}\`${flags ? ` [flags: ${describeFlags(flags)}]` : ""}`;
}

/**
 * Trace and report form of one matched segment:
 * "`git status` → rule `git status *` (read-project)", followed — when other
 * rules also matched — by which ones it outranked and the ranking step that
 * decided each, and by any narrower rule that stood down over a flag.
 */
export function describeSegmentMatch(segment: CommandSegmentVerdict): string {
  let text = `\`${segment.command}\` → ${ruleLabel(segment.source, segment.rule, segment.flags)} (${segment.capability}${segment.origin && segment.origin !== "default" ? `, ${segment.origin}` : ""})`;
  if (segment.outranked && segment.outranked.length > 0) {
    const losers = segment.outranked.map((loser) => `${ruleLabel(loser.source, loser.rule, undefined)} (${loser.capability}) — ${loser.reason}`);
    text += `; outranks ${losers.join(", ")}`;
  }
  if (segment.flagMisses && segment.flagMisses.length > 0) text += `; skipped ${flagMissText(segment.flagMisses)}`;
  return text;
}

/**
 * Rules that can never win: another rule has the same template, matches at
 * least every command this one does, and outranks it — or, for a built-in
 * default, a user rule without a flags list covers every command it could
 * match (`git *` over `git status *`), since any user rule outranks every
 * default. For the policy page,
 * which lists rules rather than commands — "this entry is dead weight, and
 * here is the rule that decides instead". Partial overlaps (a broader
 * template, a different flags list) are not reported: which rule wins those
 * depends on the command, and /rail test answers that per command.
 */
export function outrankedRules(set: CommandRuleSet): Map<CommandRule, OutrankedRule> {
  const prepared = prepareRules(set);
  const result = new Map<CommandRule, OutrankedRule>();
  for (const rule of prepared) {
    for (const other of prepared) {
      if (other === rule) continue;
      if (other.text !== rule.text) {
        const broader = !isUserRule(rule.rule) && isUserRule(other.rule) && !other.flags && other.anyArgs
          && other.literals.length <= rule.literals.length && other.literals.every((token, index) => rule.literals[index] === token);
        if (!broader) continue;
        result.set(rule.rule, { rule: other.text, capability: other.rule.capability, source: other.rule.source, ...(other.rule.origin ? { origin: other.rule.origin } : {}), reason: "built-in default, a user rule matches" });
        break;
      }
      // A user rule on the same template beats a built-in whatever its flags
      // (tier first), so it shadows the built-in when it accepts at least as much.
      if (!isUserRule(rule.rule) && isUserRule(other.rule) && (!other.flags || (!!rule.flags && [...rule.flags].every((flag) => other.flags!.has(flag))))) {
        result.set(rule.rule, { rule: other.text, capability: other.rule.capability, source: other.rule.source, ...(other.rule.origin ? { origin: other.rule.origin } : {}), reason: "built-in default, a user rule matches" });
        break;
      }
      // `other` must accept everything `rule` does: no flags list, or (when
      // both have one) a superset — a rule with flags never loses to one
      // without, (c), so that pairing cannot be a full shadow.
      const covers = rule.flags ? !!other.flags && [...rule.flags].every((flag) => other.flags!.has(flag)) : !other.flags;
      if (!covers) continue;
      const compared = compareRules(other, rule, set.disposition);
      if (compared.order <= 0) continue;
      result.set(rule.rule, { rule: other.text, capability: other.rule.capability, source: other.rule.source, ...(other.rule.origin ? { origin: other.rule.origin } : {}), reason: compared.reason });
      break;
    }
  }
  return result;
}

// ── Single-rule matching, for the grant gates ────────────────────────────────

/** One simple command's literal argv, with which words hold an unquoted glob character. */
export interface CommandWords {
  argv: string[];
  globbed: boolean[];
}

/**
 * Every simple command of `command` as literal words, in order; undefined
 * when it does not parse, holds a subshell, or any argv word is an expansion —
 * the shapes no rule can match anyway.
 */
export function simpleCommandWords(command: string): CommandWords[] | undefined {
  const parsed = parseShellCommand(command);
  if (!parsed.ok) return undefined;
  const out: CommandWords[] = [];
  for (const chain of parsed.script.chains) {
    for (const pipeline of chain.pipelines) {
      for (const cmd of pipeline.commands) {
        if (cmd.kind !== "command") return undefined;
        const argv: string[] = [];
        const globbed: boolean[] = [];
        for (const word of cmd.argv) {
          const literal = literalWordText(word);
          if (literal === undefined) return undefined;
          argv.push(literal);
          globbed.push(word.glob === true);
        }
        out.push({ argv, globbed });
      }
    }
  }
  return out;
}

/** Whether one rule (template plus optional flags allowlist) matches one simple command, by the matcher's own test. */
export function ruleMatchesWords(template: string, flags: readonly string[] | undefined, words: CommandWords): boolean {
  const [prepared] = prepareRules({ rules: [{ template, capability: "unclassified", ...(flags ? { flags } : {}), source: "classify", rank: [1] }], disposition: defaultDispositionOf });
  return !!prepared && matchRule(words.argv, prepared, words.globbed).matched;
}

/** A template's literal words (without the trailing `*`) and whether it takes further arguments. */
export function templateShape(template: string): { literals: string[]; wildcard: boolean } {
  const tokens = templateTokens(template);
  const wildcard = tokens.at(-1) === "*";
  return { literals: wildcard ? tokens.slice(0, -1) : tokens, wildcard };
}

/**
 * Whether `command` is a near miss of a rule with these literal words: ONE
 * simple command (no chain, pipe, or subshell) whose first words are exactly
 * the literals and that has more after them — other arguments or flags,
 * literal or not, or a redirect. Unparseable text is not a near miss.
 */
export function isNearMiss(command: string, literals: readonly string[]): boolean {
  const parsed = parseShellCommand(command);
  if (!parsed.ok || parsed.script.chains.length !== 1) return false;
  const chain = parsed.script.chains[0]!;
  if (chain.pipelines.length !== 1 || chain.pipelines[0]!.commands.length !== 1) return false;
  const cmd = chain.pipelines[0]!.commands[0]!;
  if (cmd.kind !== "command") return false;
  if (!literals.every((token, index) => cmd.argv[index] !== undefined && literalWordText(cmd.argv[index]!) === token)) return false;
  return cmd.argv.length > literals.length || cmd.redirects.length > 0;
}
