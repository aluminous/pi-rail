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
export const DEFAULT_COMMAND_ALLOW_RULES: CommandCapabilityRule[] = [
  // File and text inspection (stdout-only)
  { template: "grep *", capability: "read-project" },
  { template: "rg *", capability: "read-project" },
  { template: "ls *", capability: "read-project" },
  { template: "cat *", capability: "read-project" },
  { template: "head *", capability: "read-project" },
  { template: "tail *", capability: "read-project" },
  { template: "wc *", capability: "read-project" },
  { template: "pwd", capability: "read-project" },
  { template: "which *", capability: "read-system" },
  { template: "type *", capability: "read-system" },
  { template: "file *", capability: "read-project" },
  { template: "stat *", capability: "read-project" },
  { template: "echo *", capability: "read-project" },
  { template: "du *", capability: "read-project" },
  { template: "df *", capability: "read-system" },
  { template: "diff *", capability: "read-project" },
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
  { template: "git log *", capability: "read-project" },
  { template: "git diff *", capability: "read-project" },
  { template: "git show *", capability: "read-project" },
  { template: "git branch *", capability: "read-project" },
  { template: "git blame *", capability: "read-project" },
  { template: "git grep *", capability: "read-project" },
  { template: "git shortlog *", capability: "read-project" },
  { template: "git describe *", capability: "read-project" },
  { template: "git rev-parse *", capability: "read-project" },
  { template: "git ls-files *", capability: "read-project" },
  { template: "git merge-base *", capability: "read-project" },
  { template: "git show-ref *", capability: "read-project" },
  { template: "git remote", capability: "read-project" },
  { template: "git remote -v", capability: "read-project" },
  { template: "git stash list", capability: "read-project" },
  { template: "git stash show *", capability: "read-project" },
  { template: "git stash", capability: "modify-project" },
  { template: "git stash push *", capability: "modify-project" },
  { template: "git stash pop *", capability: "modify-project" },
  { template: "git stash apply *", capability: "modify-project" },
  { template: "git worktree list", capability: "read-project" },
  { template: "git tag", capability: "read-project" },
  { template: "git tag -l *", capability: "read-project" },
  { template: "git tag --list *", capability: "read-project" },
  { template: "git config --list", capability: "read-project" },
  { template: "git config -l", capability: "read-project" },
  { template: "git config --get *", capability: "read-project" },
  { template: "git reflog", capability: "read-project" },
  { template: "git reflog show *", capability: "read-project" },
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
 * A word carrying glob or brace characters is refused too, whatever it
 * starts with: the parser keeps quote-removed text and cannot say whether
 * `*` or `{a,b}` was quoted, and unquoted the shell expands them — `*` in a
 * directory holding a file named `--force`, or `{--force,x}`, becomes a
 * flag the allowlist never saw. After `--` an expansion can only produce
 * positionals, so the check stops there like the flag check does.
 */
export function flagRejection(words: readonly string[], flags: ReadonlySet<string>): string | undefined {
  for (const word of words) {
    if (word === "--") return undefined;
    if (/[*?[{]/.test(word)) return word;
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
    const flags = lists.allowFlags?.[template.trim()];
    const builtin = DEFAULT_TEMPLATE_CAPABILITIES.has(template.trim()) && !flags;
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
function matchRule(argv: string[], rule: PreparedRule): { matched: boolean; flag?: string } {
  const { literals, anyArgs } = rule;
  if (anyArgs ? argv.length < literals.length : argv.length !== literals.length) return { matched: false };
  if (!literals.every((token, index) => argv[index] === token)) return { matched: false };
  if (!rule.flags) return { matched: true };
  const flag = flagRejection(argv.slice(literals.length), rule.flags);
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
  for (const word of command.argv) {
    const literal = literalWordText(word);
    if (literal === undefined) return { command: text, refusal: "expansions ($VAR, $(…), `…`) are never allowlisted" };
    argv.push(literal);
  }
  if (argv.length === 0) return { command: text, refusal: "bare assignments have no command head to judge" };

  const matching: PreparedRule[] = [];
  const flagMisses: FlagMiss[] = [];
  for (const rule of rules) {
    const result = matchRule(argv, rule);
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
