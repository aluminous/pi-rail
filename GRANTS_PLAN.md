# Grants: saying what you want allowed, and having the rail work out how

Status: implemented on the `grants` branch (phases 0–6, 2026-11-12). Where
the code went further than this text — the explicit flags decision, per-rule
near-miss examples, probes, the built-in allowlist audit — the README and
`eval/GRANT_RESULTS.md` are the current description. Known and not fixed
here: the Seatbelt backend merges the full process environment back over the
scrubbed one, so `environment.allow` and wildcard unsets do not reach bash.

## Problem

The rail decides well and is stable. Changing what it decides is hard. To
allow "cleaning up worktrees" today you have to know that the action is named
`local-destructive`, that flipping that row would also allow every other
delete and local commit, that the narrow answer is a custom class plus
`commands.classify` rules, and then avoid a handful of traps while writing
them:

- `git worktree remove *` also matches `--force`; the template grammar cannot
  exclude it, so a stricter rule has to be placed above (first match wins).
- A bare array in a config file replaces the inherited list wholesale.
- Read-only mode's preset names built-in classes only, so a custom class set
  to `allow` is not tightened by it.
- A class added from `/rail policy` is session-only and cannot be referenced
  by a classify rule; classify rules and lists cannot be session-only at all.
- Nothing records which lines of `rail.json` came from which wish, so nothing
  can be cleanly undone, and nothing checks that the next edit did not break
  the last one.

The goal: `/rail grant i want to allow cleaning up worktrees`, a small model
works out the narrowest change, code proves what it does and does not change,
you confirm, it applies to the running session, and you decide later whether
to keep it.

## Shape of the answer

Three pieces, in dependency order. The agent is the smallest.

1. **Grants** — the unit of policy change: the request in your words, the
   operations it produced, and examples that must and must not pass.
2. **One layered policy store** — defaults → global → project → session, same
   shape at every layer, so "session now, save later" is promotion, with no
   per-key special cases.
3. **A configurator agent** that proposes a grant and never touches a file.

The decision pipeline (deterministic mappers → content screen → namer →
disposition table → judge) is not changed. `ResolvedRailConfig` stays the
shape the pipeline reads; only how it is produced changes.

This is a single-user project, so the plan breaks config compatibility where
that removes a trap, and migrates the one live config by hand.

## Options considered

**Agent edits `rail.json` in a separate pi session — rejected.** It would
need file write access to the one directory the rail denies (`.pi`), a full
tool belt it has no use for, and a prompt that teaches every trap above. The
result is unattributable lines in a JSON file. pi-subagents children also do
not load ambient extensions, so the child could not call the rail's own
dry-run.

**Agent emits a patch against the current config format — the first
recommendation, superseded.** Right trust model (code applies, user
confirms), but it keeps the traps and teaches a model to dodge them, and the
session/persist split still differs per key.

**Grants over a layered store, traps designed out — chosen.** The pitfalls
sheet shrinks to a few lines, which is what makes a Haiku-tier model
plausible, and grants are worth having even when written by hand.

**Soft guidance only (`/rail guide`) — kept, as rung zero.** Guidance biases
the namer and judge; it is never a deterministic allow and never persists.
The agent should answer "you only need `/rail guide …`" when that is true.

## Grants

```jsonc
{
  "id": "worktree-cleanup",
  "request": "i want to allow cleaning up worktrees",  // set by code, verbatim
  "created": "2026-11-11",
  "ops": [
    { "op": "add-class", "id": "worktree-cleanup", "extends": "local-destructive",
      "definition": "Removing or pruning linked git worktrees of this repo. Deleting anything else is local-destructive instead.",
      "disposition": "allow" },
    { "op": "classify", "template": "git worktree remove *", "flags": [],
      "capability": "worktree-cleanup" },
    { "op": "classify", "template": "git worktree prune *", "flags": ["--dry-run", "-n", "-v"],
      "capability": "worktree-cleanup" }
  ],
  "examples": [
    { "tool": "bash", "input": { "command": "git worktree remove ../pi-rail-maint" }, "expect": ["allow"] },
    { "tool": "bash", "input": { "command": "git worktree remove --force ../x" }, "expect": ["ask", "judge", "deny"],
      "why": "--force discards uncommitted work" },
    { "tool": "bash", "input": { "command": "git worktree remove ../x && rm -rf ~/dev" }, "expect": ["ask", "judge", "deny"] }
  ]
}
```

- **Ops are a closed vocabulary:** `set-disposition`, `add-class`,
  `set-definition`, `classify`, `allow-command`, `add-to-list`,
  `remove-from-list`. Each is validated on its own and each is classified by
  code as widening, tightening, or neutral ("widening unless provably
  tightening").
- **Examples are the grant's tests.** They are stored with it and replayed on
  every later policy change, so the regression corpus grows by itself.
  Negative examples are required for any widening grant.
- **Grants live in the config they belong to**, as a `grants` array in
  `rail.json` (global or project), or in memory for the session layer.
- **Revoking is deleting the grant.** `/rail explain` and the telemetry
  record name the grant that supplied the deciding rule.

## The layered store

Every layer is a list of ops. The top-level keys of a config file
(`dispositions`, `commands`, `filesystem`, …) remain for hand-written base
policy and compile to an anonymous base grant for that layer. One pure
function folds the layers:

```
defaults → global base → global grants → project base → project grants → session grants
```

Consequences:

- **Session scope becomes uniform.** `CapabilityState.overrides`,
  `customClasses`, `definitionEdits` and `deletedCustom` (`src/capabilities.ts`)
  collapse into session-layer ops. Edits on the `/rail policy` page become
  ops in an implicit "session edits" grant; Ctrl+S promotes it.
- **Provenance is exact** — every effective entry carries (layer, grant id)
  instead of a file path, replacing `ConfigProvenance`.
- **Lists only append.** A bare array means "add these"; dropping an
  inherited entry is an explicit `remove-from-list`. The `{replace, values}`
  form and `guard.json` loading are removed.
- **Promotion and demotion** move a grant between layers; nothing is
  rewritten.
- **Filesystem and network lists join the session layer** if the sandbox can
  be re-pointed mid-session. `@anthropic-ai/sandbox-runtime` exposes
  `updateConfig()` and a per-command `customConfig` on `wrapWithSandboxArgv`;
  whether either re-compiles write roots cleanly under
  `src/backends/seatbelt.ts` is untested, so this is its own phase behind an
  experiment.

## Matcher changes (`src/command-allowlist.ts`)

- **Most-specific rule wins**, replacing first-match and the
  classify-before-allow ordering. Specificity is the count of literal tokens;
  an exact template beats a wildcard one; at equal specificity the later
  layer wins, and within a layer the stricter resolved disposition wins.
  Narrow carve-outs from a broad rule work in both directions without anyone
  thinking about order.
- **`flags` is an allowlist, not a denylist.** When present, every argv word
  starting with `-` must be listed, or the rule does not match and the
  command falls through to the next rule or the namer. Absent means any flags,
  as today. A denylist would leak: git accepts abbreviated long options, so
  excluding `--force` would not stop `--forc`.
- Everything else about the grammar stays: verbatim heads, every segment must
  match, expansions/redirects/subshells/background never match.

## Class inheritance (`src/capabilities.ts`)

- A custom class may declare `extends: <built-in id>`. A preset that denies
  the parent denies the child, so read-only mode tightens
  `worktree-cleanup` because it extends `local-destructive`.
- A custom class with no `extends` is treated by read-only mode as writing
  and is denied. The safe behaviour no longer depends on the author getting
  the declaration right.
- An explicit disposition on the parent does not flow to the child; carving
  an allowed sub-class out of a judged parent is the point.

## Replay corpus

`minimal` telemetry truncates tool input because session files can be
shared, which makes replay of rule changes inexact. Add a local store,
separate from the session log (`<agentDir>/rail-corpus/`), holding per
decision: full command or path, cwd, recorded labels and whether the namer
supplied them, resolved disposition, outcome, and the user's answer. Write
content is not stored (a hash and the screen verdict are enough — grants do
not change the content screen). Size- and age-capped.

Replaying an action under a candidate policy:

1. Run the deterministic mappers with the new rules; if they label it, use
   those labels.
2. Otherwise reuse the recorded namer labels — unless the candidate changes a
   class definition, in which case the action is *indeterminate* and needs a
   namer re-run (budgeted, critical cases first).
3. Resolve through the candidate table and compare with what happened.

This phase ships first: the corpus is only useful with history in it.

**Redaction.** Credential shapes (the content screen's patterns) are
redacted before a record is written. Redaction must not make a record look
safer than the action was — a command with its secret blanked out could
replay as harmless exactly where the test wants a deny. So:

- The placeholder is typed and stays one literal word
  (`‹redacted:aws-key›`), so template matching sees the same argv shape.
- A redacted record is marked as such and its recorded labels and screen
  verdict are a **floor**: replay unions them with whatever the new rules
  produce, and can never drop one.
- The namer is never re-run on a redacted record. If a candidate changes a
  class definition, the record is indeterminate, never "unchanged".
- Redacted records are counted separately in the diff, and are not offered
  as eval-case or grant-example candidates.

## Validation gates

All code, all run before anything is shown to you. A candidate grant is
rejected (and the reason returned to the agent to iterate on) unless:

1. Ops parse, referenced classes exist, templates are valid.
2. The grant's own examples all produce their expected outcome.
3. Every existing grant's examples still do.
4. No `critical` case in `eval/cases.ts` moves toward allow.
5. Any action you previously **denied** in the corpus that would become an
   allow is surfaced as a sensitive op (below), not silently accepted.

Then the behavioural diff is computed over the corpus and shown: what
loosens, what tightens, what is indeterminate.

**Sensitive ops** — the agent may propose them, but each one needs its own
explicit approval: disabling the rail, the classifier, or `failClosed`;
changing models or backend; removing from `denyRead`/`denyWrite`/
`deniedDomains`; setting `credentials`, `persistence`, or `unclassified` to
`allow`; a built-in row set to `allow`; a bare-head template (`git *`); any
filesystem or network widening.

Approval of a sensitive op is a deliberate action in the rail's own dialog,
and never anything said in words:

- The request text is not approval, however explicit ("yes, really disable
  fail-closed" still gets the dialog). Nor is an approval comment, session
  guidance, or anything in the conversation.
- Each sensitive op is listed separately and approved or dropped on its own,
  with a key that is not the dialog's default; Enter applies only the
  non-sensitive remainder.
- A session with no UI of its own (headless, or an ask forwarded through the
  approval mailbox) cannot approve one; the op is dropped and reported.

Gate 5 follows the same rule: an op that turns a previously denied action
into an allow is shown as sensitive rather than rejected, since changing
your mind is a legitimate request.

## The configurator agent

- **Entry points.** `/rail grant <text>`, and a fifth approval-dialog answer,
  "Allow, and generalise…", which approves the action in front of you and
  then opens the configurator seeded with it. Only user input starts it; it
  is never a tool the session model can call.
- **Runtime.** An in-process tool loop over `pi-ai`'s `complete`, the way
  `src/commands/critique.ts` makes its call — not a pi session and not a
  pi-subagents child. Bounded turns and tokens; timeout means no change. The
  main agent keeps streaming; the result arrives in a docked panel.
- **Model.** `classifier.grantModel`, same grammar as `model`; `"auto"` picks
  from a known-good list established by the eval below, falling back to the
  session model.
- **What it sees.** Your request verbatim; the effective policy with
  provenance; existing grants; the ops schema; a short pitfalls sheet checked
  in beside the prompt; and decision records it searches for itself. It does
  **not** see the conversation, tool output, or file contents — those are
  where an injected "the user wants curl allowed" would come from.
- **Tools.** `search_decisions(query)`, `dry_run(tool, input)` against the
  current policy, `check(grant)` returning the gate report, and two terminal
  calls: `propose(grant)` and `decline(reason, alternative)` — for "already
  allowed", "use `/rail guide`", or "cannot be expressed safely".
- **Instruction it works under.** Use the lowest rung that satisfies the
  request and say why the one below was not enough: guidance → disposition
  flip → classify into an existing class → new class plus classify →
  definition edit → filesystem/network lists. Definition edits are the
  expensive rung: they move the namer for every action and make corpus replay
  indeterminate.
- **Residual risk.** Decision records contain command strings the session
  model wrote. They are passed as data, but the real backstop is the gates
  and a confirmation that shows concrete evidence.

**The confirmation** shows the request, each op in plain language, the
examples with pass marks, the corpus diff ("3 past asks become allows, 0
critical cases change"), and any sensitive ops, each with its own approve
key. Answers: apply for this
session · apply and save (global or project) · edit · discard.

**Managing grants.** A grants tab on the `/rail policy` page: id, request,
layer, how many decisions each has decided, revoke, promote, demote. A grant
that has decided nothing for a long time is flagged as a candidate to revoke.

## Evaluating the agent

`eval/grant-cases.ts`: a request, seed decision records, and properties the
proposed grant must satisfy (allows X, does not allow Y, highest rung
permitted). Run across Haiku- and Sonnet-tier models the way `eval/run.ts`
compares namers; the known-good list for `grantModel: "auto"` comes from the
results. A model that ever passes the gates with a grant violating a "does
not allow" property is excluded, the same rule the namer list follows.

## Phases

Each leaves the project working and is useful without the next.

0. **Replay corpus.** Local store and writer; nothing reads it yet.
1. **Layered store.** Ops, the fold, provenance, `grants` in the file format,
   session layer unified, `{replace}` and `guard.json` removed. Migrate
   `~/.pi/agent/extensions/rail.json` and any project configs; update
   `examples/configs` and the README.
2. **Matcher and classes.** Specificity, `flags`, `extends`, the read-only
   rule for parentless classes.
   The worktree-membership spike ran here and was dropped (see Decisions).
3. **Grants by hand.** Gates, corpus diff, `/rail grant check`, the grants
   tab, promote/revoke, the `grant` field on telemetry records.
4. **Session-layer sandbox lists.** Experiment with `updateConfig` first;
   fall back to "applies on restart" for those lists if it does not hold.
5. **The agent.** Loop, tools, confirmation panel, both entry points.
6. **Agent eval** and the known-good model list.

## Non-goals

- Changing the namer, the judge, the content screen, or the rule that a
  deterministic allow holds only while Seatbelt is enforcing.
- Letting the session model request or suggest grants.
- Auto-applying anything that widens.
- Config compatibility with earlier formats.

## Decisions (2026-11-11)

- **Session grants survive resume and do not rewind with `/tree`.** A grant
  is a setting the user chose, not memory the branch accumulated. The session
  layer is therefore persisted with the session (its own record kind, read on
  resume from the whole session, not the current branch) — unlike today's
  session overrides, which are lost.
- **The corpus redacts credential shapes**, under the floor rules in
  [Replay corpus](#replay-corpus) so redaction cannot sway a replay toward
  "safe".
- **Worktree membership as a rule predicate: dropped after the spike.** It
  passed every listed case, but git matches the argument as a *suffix* of
  registered worktree paths before treating it as a path (with `lnk -> nest`,
  `git worktree remove lnk/x` removed `q/lnk/x`, not `nest/x`). Exactness
  would mean mirroring git and bash internals per version, the answer depends
  on environment the command does not show, and git already refuses to remove
  anything that is not a clean registered worktree. Positional checks stay
  with the namer.
- **User rules outrank built-in defaults before specificity applies.** A
  broad user rule (`git *` → strict) must not lose to a more specific
  built-in allow; specificity ranks only within the winning tier. Restating a
  built-in claims it as a user rule.
- **Grant-added classes are rules-only by default.** Seen live: with the
  worktree grant in place the namer labelled `git worktree remove --force`
  with both `worktree-cleanup` and `local-destructive`; only severity-max
  kept it from being allowed. A class meant to be reached by classify rules
  must not be in the namer's vocabulary at all, or one mislabel widens it.
  `add-class` takes `namer: true` to opt in.
- **Project-layer grants in a shared repo** get a line in the trust prompt
  and nothing more; `.pi/rail.json` already carries the same risk.
