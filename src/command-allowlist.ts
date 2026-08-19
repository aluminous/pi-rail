import type { CapabilityId } from "./capabilities.ts";
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
 * in where the capability tag comes from and in which is consulted first.
 */

/** A command template plus the capability class a match deterministically resolves to. */
export interface CommandCapabilityRule {
  template: string;
  capability: CapabilityId;
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

/**
 * A rule is whitespace-separated words plus an optional trailing `*`:
 * "pwd" matches exactly that word with no args, "git status *" matches the
 * two-word head with any (or no) further args. Head words compare verbatim —
 * "/usr/bin/grep" does not match "grep".
 */
function matchesRule(argv: string[], ruleTokens: string[]): boolean {
  const anyArgs = ruleTokens.at(-1) === "*";
  const literals = anyArgs ? ruleTokens.slice(0, -1) : ruleTokens;
  if (anyArgs ? argv.length < literals.length : argv.length !== literals.length) return false;
  return literals.every((token, index) => argv[index] === token);
}

/**
 * Why this string cannot serve as a template, or undefined when it can. Used at
 * config load: a rule that can never match is a silent no-op, and the two ways
 * to write one — a misplaced `*`, and a bare `*` — are worth a diagnostic. The
 * bare `*` is rejected rather than supported: it would match every segment of
 * every command, which turns the namer off for bash without ever saying so.
 */
export function commandTemplateProblem(template: string): string | undefined {
  const tokens = template.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return "template must be a non-empty command template";
  if (tokens[0] === "*") return "a template must name a command head before `*` — a bare `*` would match every command";
  const star = tokens.indexOf("*");
  if (star !== -1 && star !== tokens.length - 1) return "`*` only means \"any arguments\" as the last word; anywhere else it matches literally";
  return undefined;
}

/** Which rule list a segment matched. User `commands.classify` rules are consulted before the allowlist. */
export type CommandRuleSource = "classify" | "allow";

/**
 * The rule lists one command is matched against. `classify` carries explicit
 * capabilities the user wrote; `allow` is the allowlist's plain templates,
 * whose capability comes from capabilityForTemplate.
 */
export interface CommandRules {
  classify?: CommandCapabilityRule[];
  allow: string[];
}

/** One simple command's verdict: the matched rule and its tag, or why it can never match. */
export interface CommandSegmentVerdict {
  command: string;
  rule?: string;
  /** Capability the matched rule tags this segment with. */
  capability?: CapabilityId;
  /** Which list the matched rule came from. */
  source?: CommandRuleSource;
  refusal?: string;
}

/** Whole-command verdict: `matched` means every simple command in it matched some rule. */
export type CommandMatchExplanation =
  | { matched: true; segments: CommandSegmentVerdict[] }
  | { matched: false; reason: string; segments?: CommandSegmentVerdict[] };

interface PreparedRule {
  text: string;
  tokens: string[];
  capability: CapabilityId;
  source: CommandRuleSource;
}

/**
 * Rule precedence: user classify rules first, then allowlist templates. The
 * order is load-bearing rather than arbitrary — every allowlist template
 * resolves to allow by default, so consulting the allowlist first would make a
 * classify rule unable to tighten any template the user had also allowlisted,
 * and re-classifying a built-in template (`git *` as something stricter than
 * read-project) would be impossible. Within a list the first match wins, so
 * declaration order is the tiebreaker between two rules that both match.
 */
function prepareRules(rules: CommandRules): PreparedRule[] {
  const prepared: PreparedRule[] = [];
  const add = (template: string, capability: CapabilityId, source: CommandRuleSource) => {
    const text = template.trim();
    const tokens = text.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length > 0) prepared.push({ text, tokens, capability, source });
  };
  for (const rule of rules.classify ?? []) add(rule.template, rule.capability, "classify");
  for (const template of rules.allow) add(template, capabilityForTemplate(template), "allow");
  return prepared;
}

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

function segmentVerdict(command: ShellCommand, rules: PreparedRule[], noMatch: string): CommandSegmentVerdict {
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
  const matched = rules.find((rule) => matchesRule(argv, rule.tokens));
  if (!matched) return { command: text, refusal: noMatch };
  return { command: text, rule: matched.text, capability: matched.capability, source: matched.source };
}

/**
 * Full per-segment verdict for a command, for the interceptor, decision traces,
 * and /rail test. The conservatism is the allowlist's, unchanged: every simple
 * command in every chain and pipeline must match, and anything this layer
 * cannot judge — expansions, redirects, subshells, background jobs — makes its
 * segment unmatchable no matter which list the rule would have come from.
 */
export function explainCommandMatch(command: string, rules: CommandRules): CommandMatchExplanation {
  const parsedRules = prepareRules(rules);
  if (parsedRules.length === 0) return { matched: false, reason: "no command rules are configured" };
  const noMatch = (rules.classify?.length ?? 0) > 0 ? "no classify or allowlist rule matches" : "no allowlist rule matches";
  const parsed = parseShellCommand(command);
  if (!parsed.ok) return { matched: false, reason: `does not parse under the allowlist grammar: ${parsed.error}` };
  if (parsed.script.chains.length === 0) return { matched: false, reason: "empty command" };
  const segments: CommandSegmentVerdict[] = [];
  let background = false;
  for (const chain of parsed.script.chains) {
    if (chain.background) background = true;
    for (const pipeline of chain.pipelines) {
      for (const cmd of pipeline.commands) segments.push(segmentVerdict(cmd, parsedRules, noMatch));
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

/** Trace and report form of one matched segment: "`git status` → rule `git status *` (read-project)". */
export function describeSegmentMatch(segment: CommandSegmentVerdict): string {
  const kind = segment.source === "classify" ? "classify rule" : "rule";
  return `\`${segment.command}\` → ${kind} \`${segment.rule}\` (${segment.capability})`;
}
