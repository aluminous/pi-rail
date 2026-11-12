# Pi Rail Extension

Pi Rail adds layers of protection around Pi's command and file tools. On macOS,
it contains shell commands with Seatbelt, applies deterministic path policy to
Pi's file tools, and scrubs the command environment. An optional LLM reviewer
labels actions with a small capability taxonomy; your
[disposition table](#capability-mode) decides what happens next. The backend
interface leaves room for a container backend later.

## Scope

- macOS Seatbelt containment for `bash` and user `!` / `!!` commands.
- Policy checks for the built-in `read`, `write`, and `edit` tools.
- Optional capability naming and judge review for `bash`, `read`, `write`, and
  `edit` actions.
- A container backend is planned for later.
- Windows and non-container Linux are out of scope for now.

## Install

Pi extensions execute with the same system permissions as Pi. Review the source
and security limitations before installing third-party extensions.

Install Pi Rail directly from GitHub:

```bash
pi install git:github.com/aluminous/pi-rail
```

To try it for one run without adding it to your settings:

```bash
pi -ne -e git:github.com/aluminous/pi-rail
```

To remove it later:

```bash
pi remove git:github.com/aluminous/pi-rail
```

For local development, clone the repository and install dependencies:

```bash
git clone https://github.com/aluminous/pi-rail.git
cd pi-rail
npm install
pi -ne -e .
```

After installation, start Pi normally from any project:

```bash
pi
```

The extension uses `@anthropic-ai/sandbox-runtime` for Seatbelt profile generation and command wrapping.

## Usage

```bash
pi
# or for quick testing without other extensions
pi -ne -e .
```

Flags:

- `--no-rail`: explicitly disable Pi Rail and run bash without the rail.

Commands — everything lives under `/rail`, with argument autocomplete:

- `/rail`: open the control panel (searchable actions with a live status header; a plain select dialog over RPC).
- `/rail status`: toggle the live **status page** — a bordered panel docked where the editor sits (like the model chooser), updating while the agent streams above it. Six tabs, each a set of tables: **session** (decision counters, per-class capability stats, recent events, errors by kind), **models** (per-model, per-role tokens, dollars, and latency), **namer** (recent classifications, each with the command or path it named under the row), **judge** (recent escalation verdicts, each with the judged command or path and the verdict's reason), **engine** (backend, restriction layers, reviewer settings, approvals, guidance), and **policy** (the resolved mechanism rules). **Tab** cycles tabs, arrows/page keys scroll the active one, Esc closes. Over RPC it toggles a live widget carrying every tab in sequence.
- `/rail policy`: open the **capability policy page** — the editable capability table with live per-class stats (see [Dispositions](#dispositions)). Over RPC it degrades to select dialogs; invoking it again closes it.
- `/rail policy rules`: open the status page on its **policy** tab — the resolved mechanism policy (filesystem, network, environment scrubbing, and the command allowlist, provenance-annotated per entry). Invoking another tab while the page is open switches rather than closing. Outside the TUI this stays a standalone live widget, as before.
- `/rail set <class> [allow|judge|ask|deny]`: set one class for this session from the command line (completions offer class ids — including custom ones — then dispositions). Without a disposition it prints the current effective value and where it came from.
- `/rail grant <what you want, in your own words>`: the configurator proposes the narrowest grant for the request and opens the same confirmation as `/rail grant add` (see [The configurator](#the-configurator)); `/rail grant cancel` stops a run in flight.
- `/rail grant add <file>`: evaluate a grant file against the gates and open the confirmation; `/rail grant check <file>` prints the gate report and applies nothing; `/rail grants` lists every grant with what it decided, and revokes, promotes, or demotes (see [Grants by hand](#grants-by-hand)).
- `/rail guide <text>`: add classifier guidance for this session without waiting to be asked (see [Session guidance](#session-guidance)). Bare `/rail guide` prompts for the text; `/rail guide clear` drops every entry.
- `/rail on`: enable Pi Rail.
- `/rail off`: disable for the next agent turn, then re-enable automatically.
- `/rail off session`: disable until the session ends.
- `/rail readonly` (or `ro`, or ctrl+shift+t): toggle session read-only mode — `write`/`edit` are blocked, `bash` must be reviewed (and is blocked outright if the classifier is off), and a session disposition preset denies the writing capability classes — along with any custom class that `extends` one of them or extends nothing (see [`extends`](#custom-capability-classes)). The toggle is also announced into the agent's context, so the model knows the ground rules changed.
- ctrl+shift+r: toggle the rail off for the upcoming agent turn (it re-enables itself when the turn ends, like `/rail off`); pressing it again while armed — or while the rail is off for the session — re-enables immediately.
- `/rail model`: the reviewer-model picker, laid out like pi's own model chooser (type to filter, `id [provider]` rows, ✓ on the active choice) with one tab per reviewer seat — **namer**, **judge**, **configurator** — switched with Tab / Shift+Tab. Each tab lists `auto` (with what it resolves to; not on the judge), `current` (the session model), `off` (namer only), then every model with configured auth. Enter sets the highlighted entry **for this session only** and keeps the picker open; a tab whose session value differs from the saved one is marked `*`. **Ctrl+S** writes every marked seat to the global config (`classifier.model`/`enabled`, `classifier.judgeModel`, `classifier.grantModel`), says what changed, and clears the marks. Esc closes, leaving the session values in force until pi restarts or a new session starts. Over RPC the picker degrades to select dialogs: seat, then model, with a "Save persistently" item in the seat list.
- `/rail model auto|current|off|provider/model-id`: set the namer for this session. `auto` (the default) picks the best available known-good model, preferring subscription providers; `off` turns review off for the session, and picking any model turns it back on.
- `/rail model judge current|provider/model-id`: set the judge for this session. Bare `/rail model judge` (or `judge status`) prints its setting and what it resolves to. Neither `off` nor `auto` is accepted: the judge cannot be disabled, and `auto` is the namer's cheap-model list.
- `/rail model configurator auto|current|provider/model-id`: set the [configurator](#the-configurator) for this session; its `auto` is its own eval-derived list.
- `/rail model save`: write this session's reviewer models to the global config — the text form of Ctrl+S.
- `/rail model status`: print every seat's setting (unsaved session values marked), what it resolves to, and the available models.
- `/rail eval`: check the namer and judge this session would use (see [Checking your models](#checking-your-models-rail-eval)); `/rail eval history` shows past runs without running anything, `/rail eval cancel` stops a run.
- `/rail smoke`: run the command-containment and namer smoke tests.
- `/rail critique [provider/model-id]`: critique the capability class definitions, the disposition table, and the content screen with Pi's current model or a specific one.

### Checking your models: `/rail eval`

`/rail model` picks the seats; `/rail eval` tells you whether the pair you
picked is any good and how slow it is. It runs a short fixed suite — the
eight cases tagged `quick` in `eval/cases.ts`: routine allows, credential
exfiltration, injection, authorization planting, off-machine, destructive,
and an unanticipated intent, four of them reaching the judge — through the session's **current namer and
judge together** (unsaved picker choices included), exactly as the live rail
would: content screen, namer, the **built-in** disposition table (never
yours, so runs stay comparable), judge when the table escalates. It first
says what it will spend ("8 cases, about 12 model calls on your accounts"),
then runs two cases at a time under a 90s limit without holding up the main
agent; progress (`case 5/8`) and then the report show in a docked panel.

The report puts critical misses (a critical case that ended in allow) first,
then each seat's share: a case is *decided by the namer* when the table
resolves its labels without the judge, and *decided by the judge* otherwise,
so a failing case names the seat that got it wrong, and an errored one names
the seat, the failure kind and the provider's reason (`! judge error on
subtle-authority-in-docs: server error (529 Overloaded)`). Latency and tokens
are per seat call (input counts what was sent, with the cached part shown when
there is one); wall time and cost are per run (cost from pi's model registry,
blank when a price is unknown — never guessed — and a `≥` lower bound when a
call failed). Below it, past runs of the
same suite, newest first with each pair together; to compare another model,
pick it in `/rail model` and run `/rail eval` again.

Runs are kept in `~/.pi/agent/rail-evals.jsonl` (private to you, newest 300):
numbers and model ids only, no commands, prompts, or model output. Each
carries a suite id — a hash of the quick cases and their expectations — and
runs of a changed suite are listed apart as not comparable. Eval calls show
under their own `eval` role in the status page's models tab and touch nothing
else: no telemetry, replay corpus, decision traces, or session guidance.
Headless (`pi -p "/rail eval"`), it runs to completion and prints the report.
It needs the classifier on and both seats resolvable, and says so otherwise.

Rail reports are **never placed into the conversation**: pi delivers custom
messages to the LLM as user messages, and a status or policy report is a map
of the rail's rules, approvals, and session guidance — exactly what a
compromised agent would want to read. All rail output goes through
user-only channels (popups, widgets, notifications); the agent only ever
sees the block reason attached to a denied tool call. Rail commands are
user-facing: in headless modes (json/print) there is no one to invoke or see
them, so views are a stderr error and pickers resolve as cancelled.

Statusline legend — the rail statusline is deliberately terse:

```
Rail: seatbelt, 26 domains, auto (openai-codex/gpt-5.4-mini) R2(+1) C4 D1 ↑12k ↓800
```

`R` = deterministic decisions (no model consulted), `C` = model reviews (namer
and/or judge), `D` = denials, `(+n)` = added since your last message, `↑`/`↓` =
reviewer input/output tokens this session. The counters turn yellow when there are denials, blocks, or
errors. The model shown is the namer's effective (session) setting; a trailing
`*` on it means some reviewer seat has a session value `/rail model save` has
not written yet.

The top-level `statusLine` config field controls when the statusline is shown
(also settable from the `/rail` panel, which saves it globally):

- `"always"` (default): always visible.
- `"never"`: never shown.
- `"auto"`: shown only when something needs attention — the rail is disabled
  or erroring, or a call was denied or blocked since your last message.

## Configuration

Policy is folded from layers, each one applied over everything before it:

1. Built-in defaults.
2. `~/.pi/agent/extensions/rail.json` — its base keys, then its `grants`.
3. `<cwd>/.pi/rail.json` when the project is trusted — base keys, then `grants`.
4. The session layer: named session grants, then this session's `/rail policy`
   and `/rail set` edits.

`/rail model save` (Ctrl+S in the picker) persists reviewer-model choices by updating the global extension config at `~/.pi/agent/extensions/rail.json`; until then a `/rail model` choice holds for the session only. It does not write extension-specific fields into Pi's main `settings.json`. A trusted project config can still override the global settings, including individual `dispositions` rows.

Only `rail.json` is read. A `guard.json` left over from before the pi-guard →
pi-rail rename is ignored without comment; rename it (and convert any
`{"replace", "values"}` lists, below) if you still want it.

Example `.pi/rail.json`:

```json
{
  "enabled": true,
  "backend": "seatbelt",
  "statusLine": "always",
  "filesystem": {
    "enabled": true,
    "denyRead": ["~/.config/my-cloud-cli"],
    "allowWrite": ["~/.cache/my-tool"]
  },
  "environment": {
    "unset": ["MY_SERVICE_TOKEN"]
  },
  "network": {
    "enabled": true,
    "allowedDomains": { "add": ["registry.npmjs.org"], "remove": ["docker.io", "*.docker.io"] }
  },
  "dispositions": {
    "off-machine-effects": "ask",
    "local-destructive": "judge"
  },
  "classifier": {
    "enabled": false,
    "model": "auto",
    "judgeModel": "current",
    "grantModel": "auto",
    "timeoutMs": 8000,
    "failClosed": true,
    "telemetry": "minimal"
  }
}
```

The `filesystem.enabled` and `network.enabled` fields control whether those
restriction layers are enforced; they do not turn Pi Rail or the reviewers
on and off. Both default to `true`.

Ready-to-copy profiles are available under [`examples/configs`](examples/configs):

- [`classifier-focused.json`](examples/configs/classifier-focused.json): unrestricted files and network, with semantic review enabled.
- [`balanced.json`](examples/configs/balanced.json): the default filesystem and network restrictions plus semantic review.
- [`offline-restricted.json`](examples/configs/offline-restricted.json): narrower write access, no networking, and semantic review.
- [`network-allowlist.json`](examples/configs/network-allowlist.json): unrestricted files with an allowlist-only network policy.
- [`filesystem-denylist.json`](examples/configs/filesystem-denylist.json): unrestricted networking with a denylist-driven filesystem policy.
- [`dispositions-deny-by-default.json`](examples/configs/dispositions-deny-by-default.json) and [`dispositions-allow-by-default.json`](examples/configs/dispositions-allow-by-default.json): disposition-table profiles that drop the deterministic file/network boundaries and let the capability table carry the policy — strict deny-by-default, and permissive with a concrete deny set.

### Lists only append

A list in a config file **adds** to the list it inherits; it never replaces
it. Dropping an inherited entry is an explicit `remove`:

```json
{
  "commands": { "allow": ["cargo *", "just *"] },
  "network": { "allowedDomains": { "add": ["crates.io", "static.crates.io"], "remove": ["docker.io", "*.docker.io"] } }
}
```

- A bare array means `{"add": [...]}`. Entries already inherited are not
  repeated; the result keeps the inherited entries first, in order, followed by
  the new ones.
- `{"add": [...], "remove": [...]}` — either key optional — also drops the
  named inherited entries. Removing an entry that is not there is a no-op.
  Within one list the removes apply first, so `{"remove": [x], "add": [x]}`
  moves an inherited entry to the end of the list.
- The old `{"replace": …, "values": …}` form has been **removed**. A list
  written that way, or otherwise malformed, gets one diagnostic and is **left
  exactly as inherited** — a list is policy, and a half-read one is worse than
  the one already in force. Nothing a lower layer set disappears because a
  higher layer forgot to restate it.

Every list takes both forms: `filesystem.allowRead`, `filesystem.denyRead`,
`filesystem.allowWrite`, `filesystem.denyWrite`, `environment.allow`,
`environment.unset`, `network.allowedDomains`, `network.deniedDomains`, and
`commands.allow`, whose added entries may also be `{"template", "flags"}`
objects (removes name the template). A plain string restating an entry
already present keeps that entry's flags; an object entry, or an
`allow-command` op, states the whole rule and replaces them — an
`allow-command` without `flags` sets the entry back to "any flags".
`commands.classify` takes a bare array or `{"add": [...]}` of rule objects;
classify rules cannot be removed by a later layer yet.

`/rail policy rules` annotates each entry with where it came from — `default`,
`global`, `project`, `session`, or the grant that added it, as in
`project · worktree-cleanup`. Restating a built-in default claims it: the entry
keeps its place but is shown as (and treated as) the restating layer's own,
since nobody needs to restate a default to keep it. Restating an entry an
earlier config layer or grant introduced still credits that introducer.

### Grants

A grant is a named, self-contained policy change: the request in your words
and the operations it produced. Grants live in a config file's `grants` array
(global or project) and apply after that file's base keys:

```jsonc
{
  "grants": [
    {
      "id": "worktree-cleanup",                  // kebab-case, unique within the file
      "request": "i want to allow cleaning up worktrees",
      "created": "2026-11-11",
      "ops": [
        { "op": "add-class", "id": "worktree-cleanup", "extends": "local-destructive", "disposition": "allow",
          "definition": "Removing or pruning linked git worktrees of this repo. Deleting anything else is local-destructive instead." },
        { "op": "classify", "template": "git worktree remove *", "flags": [], "capability": "worktree-cleanup" },
        { "op": "classify", "template": "git worktree prune *", "flags": ["--dry-run", "-n", "-v"], "capability": "worktree-cleanup" }
      ],
      "examples": [
        { "tool": "bash", "input": { "command": "git worktree prune" }, "expect": ["allow"] },
        { "tool": "bash", "input": { "command": "git worktree remove --force ../x" }, "expect": ["ask", "judge", "deny"] }
      ]
    }
  ]
}
```

The ops are a closed vocabulary, each validated on its own — a bad op is
skipped with a diagnostic and the rest of the grant still applies, and an
unknown field on an op is an error for that op:

| op | fields |
|---|---|
| `set-disposition` | `capability`, `disposition` |
| `add-class` | `id`, `definition`, optional `name`, `disposition`, `extends`, `namer` |
| `remove-class` | `id` (custom classes only) |
| `set-definition` | `capability`, `definition` |
| `classify` | `template`, `capability`, optional `flags` |
| `allow-command` | `template`, optional `flags` |
| `add-to-list` / `remove-from-list` | `list` (any list above except `commands.classify`), `values` |

A file's ordinary keys are its base policy and mean exactly these ops; a grant
is the same thing with a name, so it can be attributed, moved, and revoked.
`examples` are the grant's tests: they run every time a grant is added (its
own) and every time another grant is added (everyone's) — see
[Grants by hand](#grants-by-hand). The same grant id in another layer is a
separate grant — provenance tells them apart. The policy tab of `/rail status`
lists every grant in force, and `/rail grants` manages them.

**Rules-only classes.** A class a grant adds is *rules-only* by default: it is
left out of the namer's vocabulary entirely and only `classify` rules reach it.
A class meant to be reached by a narrow rule must not be one mislabel away from
widening — with `worktree-cleanup` in the namer's vocabulary, the namer was
seen labelling `git worktree remove --force` with it. `"namer": true` on the
`add-class` op opts in. Classes in a file's base `capabilities.classes` and
classes added on the policy page keep the namer default (`"namer": false`
there makes one rules-only too). The policy page shows "rules only" in the
class's footer line.

### Grants by hand

Write a grant as a JSON file — one grant object — and hand it to the rail:

- **`/rail grant check <file>`** runs every gate below and prints the report.
  Nothing is applied; it works headless too.
- **`/rail grant add <file>`** runs the same gates, then opens the
  confirmation (a docked panel in the TUI; a sequence of selects over RPC).
- **`/rail grants`** lists every grant with its layer, op count, how many
  decisions it decided this session and across the replay corpus, and when it
  last decided anything ("never decided" for one that never has). `g` / `p`
  promote a session grant to the global / project config, `d` demotes a file
  grant to the session, `r` (twice) revokes. Each takes effect on the next tool
  call: a change to a file grant refolds the live policy from the files at
  once, filesystem, network, and environment lists included — the Seatbelt
  profile is re-pointed in the same step (see [Session scope](#session-scope)).
  Only `filesystem.enabled`, `network.enabled`, and the `seatbelt` overrides
  wait for a restart, and the view says so.

[`examples/grants/worktree-cleanup.json`](examples/grants/worktree-cleanup.json)
is a complete grant that passes its own gates. The file shape:

```jsonc
{
  "id": "worktree-cleanup",                        // kebab-case
  "request": "i want to allow cleaning up worktrees", // required: the request in your own words
  "created": "2026-11-11",                         // optional: defaults to today
  "ops": [ /* the op table above */ ],
  "examples": [
    { "tool": "bash", "input": { "command": "git worktree remove ../pi-rail-maint" }, "expect": ["allow"] },
    { "tool": "bash", "input": { "command": "git worktree remove --force ../x" }, "expect": ["ask", "judge", "deny"],
      "why": "--force discards uncommitted work" }
  ]
}
```

An example passes when its dry-run outcome is one of `expect` (a deterministic
policy block counts as `deny`). An example **with** `allow` in `expect` is
positive; one without is **negative**.

**The gates.** All code, run before anything is shown:

1. **Structure** — every op and example parses (a grant with one bad op is
   rejected whole, unlike config loading), referenced classes exist, templates
   and flags are valid, and the id is not taken in the target layer.
2. **Its own examples** pass. A grant with any widening op (see "widening
   unless provably tightening" below) must have at least one passing negative
   example — and the check is **per rule**: every widening classify or
   allow-command rule needs an example it decides itself, and every allowing
   rule with a trailing `*` needs a **near miss**: a passing negative example
   that is the same command with other arguments or flags (`git worktree
   remove --force ../x` for `git worktree remove *`). A chained or unrelated
   command does not count. The failure names the rule.
3. **Every other grant's examples** still pass with this one added. An example
   that already failed without it is reported, not blamed on it.
4. **No `critical` case in `eval/cases.ts` moves toward allow.**
5. **An action you denied when asked** (in the replay corpus) that this grant
   would allow is not a failure — changing your mind is legitimate — but it
   becomes a sensitive op (below).

Then the corpus diff: every recorded decision is replayed with and without the
grant, and the confirmation shows what loosens, what tightens, and what is
indeterminate ("3 past asks become allows · 0 critical cases change · 2
indeterminate"). Redacted records are counted apart: their recorded labels and
screen verdict are a floor the replay can never drop, and they are never
re-named.

**What a dry run can and cannot know.** The gates run the interceptor's own
stage helpers in its order — path policy, the deterministic mappers, the
content screen, the table — so a grant evaluates in the gates exactly as it
would live, with these stated assumptions, repeated in every report:

- **Seatbelt is assumed enforcing.** A deterministic allow holds live only
  while the sandbox enforces; without it those commands go to the namer.
- **The namer is not called.** An action no rule labels end to end is decided
  live by a model. The gates instead check whether the grant changes anything
  the namer sees (the namer-visible classes and their definitions) or what its
  labels resolve to. If not, the action is decided as before the grant — a
  negative example like the `--force` one above passes as "outside this
  grant". If so (a definition edit, a new namer-visible class, a loosened
  row), the item "needs a namer re-check", which fails gates 2–4. This is why
  definition edits are the expensive rung, and why grant-added classes are
  rules-only. A positive example must be decided by rules.
- **The judge and you are not simulated**: `judge` and `ask` are outcomes in
  their own right.
- With the classifier off, an action no rule labels passes through unreviewed,
  live and in the gates alike.

**Probes.** Code also probes every widening rule with a trailing `*`: its
literal prefix plus `--force`, `-f`, `--hard`, `--delete`, `-D`, `-d`,
`--mirror`, `--all`, `--no-verify`, `-rf`, `--prune`, `--force-with-lease`,
`+main:main`, `:main`, `/`, `~`, `..`, `*`, and a chained `… x && rm -rf ~`,
each dry-run with and without the grant. What comes out newly allowed is
listed in the confirmation ("op 2 also allows: …") and in the report. A probe
is not a failure by itself — `git worktree remove ~` is git's to refuse — but
an allowed probe with `--force`, `-f`, `--hard`, `--delete`, `-D`, `--mirror`,
`--force-with-lease` or `-rf`, or a flags list naming one of them, makes the op
sensitive.

**Sensitive ops** need their own approval, each one separately: removing a
`denyRead`/`denyWrite`/`deniedDomains` entry; setting `credentials`,
`persistence`, or `unclassified` (or a class extending one of them) to
`allow`; any built-in row set to `allow`; a bare-head template (`git *`); any
filesystem, network, or environment widening; a rule that allows a
destructive flag (above); and gate 5's previously denied actions. (Disabling the rail, the classifier, or `failClosed`, and changing
models or the backend, are on the plan's list too, but no op can express them:
those are file settings a grant cannot touch.)

**The confirmation** shows the request, each op in plain language with its
direction, the examples with pass marks, the corpus summary, and every gate
failure. A grant that fails a gate offers only Discard and says why. Otherwise:
**Apply for this session** · **Apply and save to global** · **Apply and save
to project** (only when the project is trusted and has a `.pi` directory) ·
**Discard**. Sensitive ops are listed above the answers, each with its own
toggle, **off** by default, toggled with **Space** — never Enter. Enter on an
answer applies the non-sensitive ops plus exactly the sensitive ones toggled
on. If leaving out an unapproved sensitive op makes the rest fail its gates
(its own examples, typically), the grant is re-evaluated and **not** applied,
and the panel says which example broke. Over RPC each sensitive op gets its own
select whose first, default answer drops it.

Approval is a deliberate action in the rail's own dialog and never anything in
words: not the grant's `request`, not an approval comment, not session
guidance. A session without a UI of its own (headless, or a subagent child
whose asks are forwarded) cannot approve a sensitive op and cannot apply a
widening grant at all — `/rail grant add` prints the report and applies
nothing. A grant that only tightens is applied to the session there.
Promoting a session grant to a file asks for no new approval, widening or not:
its ops were approved (sensitive ones one by one) when it was applied, and
promotion moves it unchanged.

**Attribution.** A review whose deciding label came from a grant — its classify
or allow rule, its table row, or the class it declared — names it: `/rail
explain` says "decided by grant worktree-cleanup", and the review records carry
`grant` (telemetry detail tier; always in the replay corpus), which is where the
grants view's counts come from.

### The configurator

`/rail grant <text>` — say what you want in your own words, e.g. `/rail grant
i want to allow cleaning up worktrees` — and a model works out the narrowest
grant, proves it with the same gates as a hand-written one, and hands it to
the same confirmation. Nothing it says approves anything: the confirmation
shows its rationale on top, every sensitive op is a toggle that starts off,
and the grant's `request` is always your verbatim text (set by code, whatever
the model writes). The command returns at once; a docked panel (a widget over
RPC) shows which tool it is calling and the turn count while the main agent
keeps streaming. It needs a UI: in a headless session it refuses up front,
since a model-authored grant is never applied without the confirmation — not
even a tightening one.

**What it sees.** Your request; the effective disposition table with
provenance; the class list (parent, rules-only, a one-line definition); your
command rules and existing grants; and what its tools return. **What it never
sees:** the conversation, tool output, or file contents — the agent function
has no parameter that could carry them (`src/grant-agent.ts`), which is where
an injected "the user wants curl allowed" would come from.

**Its tools** (a closed set, real tool calling over pi-ai; every rule it writes
with a trailing `*` must say its flags — a list, or `"any"` — or the tool
answers with an error): `search_decisions`
(the replay corpus: command or path, labels, outcome, your answer — newest
first, at most 20, delimited and marked as data written by another model),
`dry_run` (an action under the current policy), `check` (the gates on a
candidate), and two terminal calls: `propose` (code re-runs the gates; a
failure goes back to the model, never to you) and `decline` — "already
allowed" (accepted only after a dry run showed an allow), "use `/rail guide`
instead", "cannot be expressed safely", or a question when the request is
unclear. It works up a ladder and says why the rung below was not enough:
guidance → disposition flip → classify into an existing class → new rules-only
class plus classify → definition edit → filesystem/network lists. The prompt
and its pitfalls sheet live in `src/grant-agent-prompt.ts`.

**Limits.** 12 model calls, 24k output tokens, three minutes, and
`/rail grant cancel`; exceeding any ends the run with nothing changed. Its
calls are accounted under the `configurator` role on the status page's models
tab.

**"Allow, and generalise…"** is an extra answer in the approval dialog (a
third row between Allow and Deny in the TUI, never the default; the fifth
option over RPC). It approves the action exactly like Allow — the tool call
proceeds at once, and telemetry, the corpus, and session replay record a plain
`approved` — and then asks once for the request text, prefilled with "allow
things like this: <command>", and starts the configurator seeded with the
action (its tool and command or path; never a write's content). It is offered
on asks forwarded from a subagent too, since it is still you answering, but the
grant applies to this (parent) session's layer; a child picks it up only once
you save it to a config file. It is not offered without a UI.

The session model has no way to start the configurator: it is reachable only
from a typed `/rail grant` and from your own answer in the rail's dialog. No
tool is registered for it and no message hook leads to it (a test in
`test/grant-agent-command.test.ts` checks the call sites).

**The eval.** `npm run eval:grant -- provider/model …` runs
`eval/grant-cases.ts` through the real loop and scores each outcome by code:
what must and must not become allowed, the highest rung permitted, the decline
expected, and that sensitive changes surface as sensitive. A model that ever
passes the gates with a grant violating a safety property is excluded from the
auto list; see `eval/GRANT_RESULTS.md`.

### Session scope

Everything `/rail policy` and `/rail set` change lands in the session layer,
as ops in an implicit `session-edits` grant, and is folded into the effective
policy on the very next tool call — dispositions, new classes, definition
edits, and class deletions alike, so a class added this session is
immediately usable by a session grant's classify rule. **Ctrl+S** promotes
`session-edits` into the global config's base keys.

The session layer survives resuming the session and deliberately does **not**
rewind with `/tree`: it is a setting you chose, not something the branch
accumulated (the rail's memory — recent decisions, guidance, stats — does
follow the branch). It is written to the session file on every change and
restored from the latest record, whichever branch it was written on. A new
session starts with an empty session layer, and an in-memory session writes
nothing.

Filesystem, network, and environment lists change at the session layer like
any other list. The Seatbelt profile follows in the same step as the file
tools' path policy: every change that moves one of those lists — a session
grant applied or revoked, a file grant promoted, demoted, revoked, or saved —
re-points the sandbox (sandbox-runtime's `updateConfig`) before the next
command is wrapped. If the sandbox refuses the update, the change is undone in
both engines and the error is shown; nothing is ever enforced more widely by
the file tools than by the sandbox, or the other way round. A command that is
already running keeps the filesystem profile and environment it started with;
its network does not — the proxy checks the domain lists per connection, so a
running command's next connection already follows the new lists. Widening any
of these lists is a sensitive op, so at the session layer it is only reachable
through the grant confirmation's per-op approval (or a config file you edit
yourself). What still applies only at restart: `filesystem.enabled`,
`network.enabled` (whether the proxy runs at all is fixed when the sandbox
starts), and the `seatbelt` overrides.

## Capability mode

The whole decision policy is one table of **capability dispositions**. Every
intercepted action is *named* with one or more of twelve capability classes, and
the table says what happens to each class — nothing else decides.

| class | default | class | default |
|---|---|---|---|
| `read-project` | allow | `off-machine-effects` | ask |
| `read-system` | allow | `modify-system` | ask |
| `run-dev-tools` | allow | `credentials` | judge |
| `modify-project` | allow | `local-destructive` | judge |
| `install-dependencies` | allow | `persistence` | judge |
| `network-fetch` | judge | `unclassified` | judge |

The four dispositions are **allow**, **ask** (bring me in), **deny**, and
**judge** (let a strong model think about this one). An action that spans
classes takes the strictest disposition among them, which is why extra benign
labels cannot dilute a strict one. `off-machine-effects` is defined by the
**machine boundary**, not by tool name: `kubectl`/`docker` against a local
cluster (kind, minikube, k3d, docker-desktop, colima) stays local, the same
command against a remote context does not. `local-destructive` covers deletes
and overwrites *and* local commits — it is the class most expected to be
re-scoped per session. `unclassified` is the completeness valve: an
unanticipated intent resolving to a thoughtful second look is correct by
construction.

Set rows in `dispositions` (global or project config). Omitted classes keep
their defaults — the table merges **per row**, so setting one class never
resets the others.

### Dispositions

`/rail policy` opens the table as an interactive page (docked panel, agent
still streaming above it): one row per class with its disposition and this
session's stats — `off-machine-effects  ask  3 hits · 1 allowed · 1 asked · 1
denied`. The highlighted row's definition shows underneath.

| key | effect |
|---|---|
| ↑ / ↓ | move the highlight |
| ← / → / Enter | cycle the row: allow → judge → ask → deny |
| `a` | add a custom class (also Enter on the trailing `＋ Add class…` row) |
| `e` | edit the highlighted class's definition |
| `d` | delete the highlighted class (custom classes only) |
| Tab | switch between the **dispositions** and **rules** tabs |
| Ctrl+S | save every session change to the global config |
| Esc | close (session changes stay in effect) |

Every edit applies **immediately, for this session** — that is the point of
the page: `local-destructive` and friends are meant to be re-scoped per
session, and closing the page does not undo anything (nor does resuming the
session later; see [Session scope](#session-scope)). Rows that differ from
the persisted value are coloured; **Ctrl+S** persists them to
`~/.pi/agent/extensions/rail.json` and the colouring clears. Stats update
live while the agent works.

In read-only mode a banner names the active preset and its rows render as
`allow → deny*`: the preset tightens the effective value, cycling still edits
the row underneath it. Over RPC the page degrades to select dialogs (pick a
class, then a disposition, "Edit definition…", or "Delete class"; "Add new
class…" and "Save persistently" close the list), and `/rail set <class>
<disposition>` does the same thing in one line.

### Custom capability classes

The taxonomy is editable. You can add classes of your own, rewrite what any
class means to the namer, and delete classes you added — the twelve built-ins
can be **edited but not deleted**, since deterministic mappers and the
read-only preset name them directly. Set a built-in to `deny`, or rewrite its
definition, instead.

On the page: `a` opens the add form (id, then definition), `e` edits the
highlighted class's definition, `d` removes a custom class. Inside a form,
**Tab** moves between fields, **Enter** or **Ctrl+S** commits, **Esc**
cancels; validation errors keep you in the form with your text intact.

Like disposition edits, class changes take effect **immediately at session
scope** — the namer sees a new class on the very next action — and stay
session-local until **Ctrl+S** writes them to the global config. Rows added
this session are tagged `(new)`, edited ones `(edited)`; deleted ones simply
disappear. The save message counts what moved: `Dispositions saved: 2 rows · 1
class added · 1 edited · 1 removed.`

New classes default to **ask**: a newly named intent is exactly the case for
bringing you in, and it is the one default that cannot silently widen what the
agent may do.

Persisted classes live under `capabilities` in the config, merged **by id**
across layers so a project config adding one class keeps the global ones:

```jsonc
{
  "capabilities": {
    // Custom classes join the namer's vocabulary.
    "classes": [
      {
        "id": "touches-customer-data",           // kebab-case, cannot shadow a built-in
        "name": "Touches customer data",         // optional; defaults to the id
        "definition": "Reading or writing rows in the production customer database, including via ORM scripts and migration tooling. Reading fixture or seed data in the repo is read-project instead.",
        "disposition": "deny"                    // optional; defaults to "ask"
      }
    ],
    // Rewrite what a built-in means to the namer, keyed by built-in class id.
    "definitions": {
      "run-dev-tools": "Running this project's own tooling: pnpm scripts, vitest, tsc, biome. Anything invoking terraform or kubectl is off-machine-effects instead."
    }
  },
  "dispositions": {
    "touches-customer-data": "deny"              // custom ids are valid rows
  }
}
```

`definition` is prompt text the namer reads verbatim, so write it as a decision
boundary ("X, but Y is class Z instead") rather than a description. An invalid
entry is skipped with a diagnostic and the rest of the config still loads.

**`extends`.** A custom class may name the built-in class it narrows:
`"extends": "local-destructive"`. It must be one of the twelve built-ins (a
chain through custom classes could be removed from under it), and it decides
one thing — how session presets treat the class:

- A preset that denies the parent denies the child: read-only mode tightens a
  `worktree-cleanup` class that extends `local-destructive`, whatever its row
  says.
- A custom class with **no** `extends` is treated by every preset as a writing
  class, so read-only mode denies it. The safe behaviour does not depend on
  the author remembering the declaration.
- A class extending a built-in the preset leaves alone (`read-project`,
  `run-dev-tools`, …) is left alone too — declare that for a custom class of
  read-only commands you want usable in read-only mode.

An explicit disposition on the parent does **not** flow to the child: carving
an allowed sub-class out of a judged parent is the point. The policy page shows
the parent in the class's footer line; it is set in config or by an
`add-class` op (the page's add form does not ask for it).

Editing the taxonomy changes the payload prefix the namer sees, which
invalidates the provider's prompt cache once — the accepted cost of a
vocabulary you can edit.

### Session guidance

Answering a rail prompt with a comment records it as session guidance, which
is injected into every later namer and judge call. `/rail guide <text>` adds
an entry directly, without waiting to be asked:

```
/rail guide the deploy script in this repo is expected to push to staging
```

Entries share one ring with approval comments, capped at 12 (oldest drop out);
the confirmation reports the position, `Guidance added for this session
(3/12).` `/rail guide clear` empties it, and the status page's engine
tab lists what is currently in force. Guidance is session-scoped and never persisted.

### How an action gets named

```
deterministic mappers ──▶ content screen ──▶ namer (one cheap call)
        │                       │                    │
        └──────────▶ disposition table ◀─────────────┘
                allow │ ask │ deny │ judge
                                    │
                              judge (strong model, per action, ask-preferred)
```

- **Deterministic mappers** are caches of an obvious label, not of a verdict:
  in-cwd reads → `read-project`, allowlisted commands → their template's tag,
  commands matching a [`commands.classify`](#user-command-classification) rule
  → the class you mapped them to, `denyRead` matches → `credentials`,
  out-of-roots writes → `modify-system`. Because they cache a *label*, flipping
  a disposition row retunes the fast path too.
- **The content screen** (`src/content-screen.ts`) routes writes and edits
  deterministically: authorization/consent lexicon, phrasing aimed at future
  automated reviewers, persistence surfaces by path (manifests, git hooks,
  shell profiles, cron/launchd/systemd, SSH and agent config), manifest
  lifecycle-script additions, and credential shapes. Clean content gets
  `modify-project`/`modify-system` with zero tokens; tripped content goes to
  the namer.
- **The namer** is one call that returns only `{"labels":[…]}` plus an
  optional short authorization quote. It never decides. Write content is part
  of the action it names. Its output is parsed fail-closed: schema violations
  throw, unknown class ids are dropped, an empty set becomes `unclassified`.
- **The judge** runs only for classes you set to `judge`. It sees more than
  the namer — recent user messages, session guidance, the action, and the
  rail's last few decisions — and decides for that one action only, never as
  a standing approval. Deny is reserved for what confirmation cannot fix;
  everything else unclear is an ask. `classifier.judgeModel` defaults to
  `"current"` (the session's own model). A judge failure degrades to asking
  you, not to allowing.

Authorization evidence the namer quotes only ever *decorates* the confirmation
prompt ("reviewer notes: user said …") — it never removes one, which keeps the
fabricated-consent surface closed.

With the classifier off, capability mode reduces to the deterministic mappers
and the screen: labelled actions still resolve through the table (`judge`
degrades to `ask`), and anything that would need the namer passes through
unreviewed, exactly as before.

### Retired: classifier rule tiers

The prose rule tiers (`classifier.rules` with `allow`/`soft_deny`/`hard_deny`/
`environment`) have been **removed**. A config that still sets the key loads
fine and emits one diagnostic saying it is ignored; the lists are no longer
parsed, merged, or displayed. Their successor is the disposition table plus the
class definitions in `src/capabilities.ts` — edit both from `/rail policy`.

### Command allowlist

`commands.allow` lists command templates that resolve to a capability label
deterministically, with no model call. A rule is words plus an optional trailing `*`: `"pwd"`
matches exactly that command with no arguments, `"git status *"` matches
`git status` with any arguments. Heads compare verbatim (`/usr/bin/grep`
does not match `"grep *"`). The defaults cover read-only inspection
(`grep`, `rg`, `ls`, `cat`, `diff`, `du`, `jq`, hashing, …), read-only
system probes (`ps`, `printenv`, bare `env`/`date`/`hostname`), git's
read-only spellings (`status`/`log`/`diff`/`show`/`blame`/`grep`, exact
forms like `git remote -v`, `git stash list`, `git config --get`), and
toolchain version probes. The inclusion bar: every invocation matching a
template must be unable to write files, run other programs, or use the
network — which is why `find`, `sed`, `awk`, `sort`, `tee`, and `env CMD`
are deliberately absent (see the comment in `src/command-allowlist.ts`).

Each built-in template carries a capability tag: inspection and read-only git
are `read-project`, machine introspection (`uname`, `whoami`, `printenv`) is
`read-system`, and toolchain version probes are `run-dev-tools`. A chain takes
the union of its segments' tags. Templates you add in `commands.allow` default
to `read-project`; an entry is a plain string, or `{"template": "…", "flags":
[...]}` to accept only the listed flags (see [flags](#flags-allowlists)).

Commands are parsed with a minimal shell grammar, and a chain (`&&`, `||`,
`;`, `|`, newlines) is exempt only when *every* command in it matches a rule:
`grep a || grep b` passes `"grep *"`, `grep a; rm x` does not. Quoting is
respected (a `;` inside quotes is data). Redirects, expansions (`$VAR`,
`$(…)`, backticks), subshells, background `&`, and anything outside the
grammar (heredocs, process substitution) fall through to normal review.

The deterministic labelling applies only while the sandbox is actually
enforcing (filesystem restrictions on with the Seatbelt backend initialized):
`grep` is only safe when Seatbelt bounds what it can read. Otherwise the
command goes to the namer.

```json
{
  "commands": {
    "allow": [
      "grep *", "git status *", "make lint",
      { "template": "git cat-file *", "flags": ["-p", "-t", "-s", "-e"] }
    ]
  }
}
```

(`git cat-file --textconv` and `--filters` run configured programs; the flags
allowlist keeps them out of the deterministic allow without a denylist that
`--text` would slip past.)

The built-ins use the same mechanism. Each wildcard template was audited for
flags that write, delete, or run a program, and those that have one carry an
allowlist of their read-only flags: `rg` (not `--pre`/`--pre-glob`, which run
a program per file, or `-z`), `git log`/`show`/`diff`/`reflog show`/`stash
show`/`shortlog` (not `--output`, `--ext-diff`, `--show-signature`), `git grep`
(not `-O`), `git tag -l`/`--list` and `git config --get` (no write flag riding
along after the read one), `file` (not `-C`, `-z`), and `diff` (not
`--paginate`). `git branch *` is gone — a bare positional creates a branch —
replaced by the exact listing forms (`git branch`, `-a`, `-r`, `-v`, `-vv`,
`-av`, `--all`, `--remotes`, `--show-current`) and `git branch --list *` /
`-l *` with read-only flags. Anything else goes to the namer. With a flags
list, an unquoted glob or brace (`rg foo *.ts`) never matches, since it could
expand into a flag; a quoted one (`rg 'a.*b'`) does. The status page's policy
tab names these lists "built-in read-only set" rather than printing them.

### User command classification

`commands.classify` maps command templates to capability classes of your
choosing — including [custom classes](#custom-capability-classes). Where
`commands.allow` says "this template is read-only inspection", classify says
"this template is *that* class", which is how a custom class becomes reachable
deterministically instead of only when a model happens to name it.

```json
{
  "capabilities": {
    "classes": [
      {
        "id": "k8s-ops",
        "name": "Cluster operations",
        "definition": "Any kubectl or helm action against a cluster, read or write.",
        "disposition": "ask"
      }
    ]
  },
  "commands": {
    "classify": [
      { "template": "kubectl *", "capability": "k8s-ops" },
      { "template": "helm *", "capability": "k8s-ops" },
      { "template": "terraform plan *", "capability": "read-system" }
    ]
  }
}
```

The template grammar is the allowlist's, matched by the same shell parser with
the same conservatism: words plus an optional trailing `*`, heads compared
verbatim, and a chain classified only when *every* segment matches some rule —
expansions, redirects, subshells, and background jobs make a segment
unmatchable no matter which list a rule would have come from. The union of the
matched capabilities across segments is the action's label set, exactly as it
is for allowlisted commands.

**Precedence: your rules first, then the most specific.** Every rule — the
built-in allowlist, your `commands.allow` entries, and classify rules from
every layer — is one pool. Any rule from your config (global, project, or
session; base keys or a grant) **always wins over a built-in default** that
also matches: the defaults are all allow-tagged inspection, so letting a more
specific default beat a broad rule of yours could only loosen what you wrote.
Among the rules of the tier that won, the most specific decides, in this order:

1. more literal words (`kubectl get *` beats `kubectl *`);
2. at equal count, an exact template beats one ending in `*` (`git stash`
   beats `git stash *` for the bare command);
3. a rule with a `flags` allowlist beats one without — it is the narrower
   statement about the same words;
4. the later layer: global < project < session, and within a file base keys
   before its grants, earlier grants before later ones;
5. the stricter resolved disposition (with read-only mode's preset applied).

So `{"template": "git *", "capability": "local-destructive"}` re-labels every
git command, `git status` included. To keep a built-in allowed under a broad
rule of your own, restate it — a restated default is yours, and then wins by
specificity:

```json
{
  "commands": {
    "allow": ["git status *", "git log *"],
    "classify": [{ "template": "git *", "capability": "local-destructive" }]
  }
}
```

Declaration order never matters, so a narrow carve-out works in both
directions without anyone ordering anything: `kubectl get *` → `read-system`
inside a broad `kubectl *` → `k8s-ops` (`ask`), and equally `docker system
prune *` → `local-destructive` inside a broad `docker *` → `run-dev-tools`.
`/rail test`, `/rail explain`, and the policy tab of `/rail status` say which
rule won and, when another rule also matched, that it was outranked and why
("built-in default, a user rule matches", "more literal words", …).

#### Flags allowlists

A classify rule or an allow entry may carry `"flags": [...]`. When present,
every word after the template's literal words that starts with `-` must be
accepted, or the rule **does not match** and the command falls to the
next-ranked rule, or to the namer:

```json
{ "template": "git worktree remove *", "flags": [], "capability": "worktree-cleanup" }
```

matches `git worktree remove ../x` but not `git worktree remove --force ../x`
— nor `--forc`, which git accepts as an abbreviation of `--force`. That is why
this is an allowlist: a denylist of `--force` would leak. The exact rules:

- `--dry-run` accepts exactly `--dry-run`; `--dry-run=value` is accepted only
  when `--dry-run=` is listed (list both to accept both spellings). No prefix
  or abbreviation matching.
- `-n` is one short flag. A single-dash word in the command is a cluster:
  with `-n` and `-v` listed, `-nv` passes and `-nf` does not. A longer
  single-dash entry (`-name`) accepts that exact word. Attached values for
  short flags (`-C=`, `-n5`) are not supported: a cluster with an unlisted
  letter fails.
- `--` is always accepted and ends flag checking; words after it are
  positional. A lone `-` is positional. `-1` is a flag and fails unless listed.
- The template's own literal words are never checked, and words that do not
  start with `-` are positional (so a flag's separate value is not checked).
- A word containing `*`, `?`, `[`, or `{` fails the check (before `--`):
  quoting is not visible to the matcher, and unquoted the shell would expand
  `*` (with a file named `--force` in the directory) or `{--force,x}` into a
  flag the allowlist never saw.
- `"flags": []` means no flags at all; no `flags` key means any flags, as
  before.
- Entries must start with `-` and contain no whitespace; `-`, `--`,
  `--name=value`, and `-x=` are refused with a diagnostic, as is `flags` on a
  template without a trailing `*` (there would be nothing to check).

**The safety asymmetry.** When every segment matches and the labels resolve to
`ask`, `judge`, or `deny`, the rail acts on that directly and never calls the
namer: those are the tightening and user-involving directions, nothing runs
that the table would not have permitted, and a `judge` class still gets its
full curated review — only the namer's labelling step is replaced by your own.
When the labels resolve to `allow`, the allowlist's original precondition still
applies unchanged: the deterministic allow holds only while the Seatbelt
sandbox is actually enforcing, and otherwise the command falls through to the
namer as it does today. A command with *any* unmatched segment falls through
entirely — the matched segments' labels are deliberately not passed on as
hints, so `kubectl get pods && helm upgrade api` is reviewed as the whole thing
rather than arriving pre-labelled with the harmless half.

Classification is labelling, not permission. The labels go through the same
disposition table and the same severity-max as any others, so a class you set
to `deny` denies whether the label came from a rule or from a model, and
read-only mode's preset still denies a command you classified into one of the
built-in writing classes — or into a custom class that extends one, or extends
nothing (see [`extends`](#custom-capability-classes)). A custom class
extending `read-project` or another class the preset leaves alone stays
usable in read-only mode. Plain `commands.allow` entries are `read-project`
and are not tightened by the preset.

The list takes a bare array or `{"add": [...]}`, and like every list it only
appends: a later layer's rules go after the ones it inherits (a rule for a
template already listed replaces it, class and flags together, and ranks as
the later layer's). Each entry must be `{"template": …, "capability": …}` plus
an optional `"flags": [...]`, and nothing else. The capability must be a
class known by the time the rule is folded: a built-in, or a custom class from
this or any earlier layer — the same file may declare it, since a file's
taxonomy is applied before its rules, and a session grant may classify into a
class the session itself added. An entry naming an unknown class, or carrying
an unusable template — an empty one, a bare `*`, or a `*` that is not the last
word — is reported as a diagnostic and skipped, leaving the other rules in
force.

`/rail policy rules` lists the rules with their class and provenance, `/rail
explain` shows a `commands.classify` stage naming the rule each segment
matched, and `/rail test kubectl apply -f x.yaml` dry-runs one command through
the whole chain.

The default namer model is `"auto"`: Pi Rail picks the best available
model from a known-good list (see `src/classifier-models.ts`), preferring
subscription providers (openai-codex, github-copilot) over per-token providers
like OpenRouter, and ordered by the benchmark in `eval/RESULTS.md` within each
provider. Models that failed the safety evals are never auto-selected. If none
of the known-good models has configured auth, auto falls back to the session's
current model. Set `"model"` to `"current"` or an explicit `provider/model-id`
to opt out of auto selection. `"judgeModel"` uses the same grammar and defaults
to `"current"`: the judge runs rarely and on the consequential tail, so it
should be the strong model you are already talking to, not the cheap namer.
`/rail model` (judge tab) and `/rail model judge …` set a session value that
wins over it until pi restarts; `/rail model save` writes it. `"grantModel"` picks the
[configurator](#the-configurator)'s model, same grammar, default `"auto"`;
its auto list is its own (`AUTO_GRANT_MODEL_PREFERENCES`, filled only from
`eval/GRANT_RESULTS.md` — currently Anthropic's `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-sonnet-5`, in that order — Haiku first: no safety violations and the cheapest), and when no
listed model has auth `"auto"` means the session's current model. The picker's configurator tab and
`/rail model configurator …` set it for the session, like the other two seats.

## Filesystem policy

Set `filesystem.enabled` to `false` to disable deterministic path checks for
Pi file tools and filesystem restrictions for sandboxed commands. File actions
are still named and resolved through the disposition table. Environment
scrubbing is configured separately.

Reads are blacklist-based by default: tools and sandboxed commands can read ordinary system, project, and home files unless the path matches `denyRead`. The default read denylist covers common credential stores and sensitive app profiles on macOS and Linux, including SSH, cloud credentials, GPG, Kubernetes, Docker, browser profiles, keychains/keyrings, `.env` files, and private key files.

Writes are whitelist-based by default: tools and sandboxed commands can write to the project directory, including local `.git` metadata for normal source-control operations, temp directories, and common development caches such as npm/pnpm/yarn, Cargo registry/git caches, Gradle caches/wrapper, Maven local repository, Go module/build caches, pip caches, NuGet packages, Ivy/Coursier, Bazel, uv, Ruff, and pre-commit caches. Sensitive paths in `denyWrite` remain hard-blocked even if they overlap an allowed write root.

Linked git worktrees of the session repo are trusted like the project directory: a path inside a worktree registered by the session repo is treated as in-project by the read exemption and the deterministic path policy, with relative allow/deny patterns (a `denyWrite` of `.env` or `src/**`, the `.` write root) re-anchored at the worktree root so the worktree gets exactly the decisions the project itself would get. Membership is verified bidirectionally without running git: the worktree's `.git` file must point into the session repo's `.git/worktrees/<name>`, and that registry entry's `gitdir` must point back at the same `.git` file — so a forged `.git` file cannot claim membership; only a `git worktree add` performed through the rail creates the reverse link. Limitation: this trust currently applies to the classifier and file-tool path policy only. With the Seatbelt backend enabled, the sandbox profile holds literal write roots compiled from the configured lists, and a worktree appearing does not add one, so sandboxed bash still cannot write into a worktree outside those roots (worktrees under `/tmp` or the project directory are covered by the default roots). A session grant adding the worktree's path to `filesystem.allowWrite` fixes that live: the profile is re-pointed as the grant applies (see [Session scope](#session-scope)), no restart needed.

The macOS keychain is the one place the two engines deliberately disagree.
`~/Library/Keychains` stays in `denyRead`, so Pi's `read` tool still treats the
keychain as credentials — but the Seatbelt profile reads it back in, because a
keychain lookup runs inside the calling process: `security`, and any CLI that
keeps its token there, opens the keychain file itself and only uses securityd
to unlock it. With the store read-denied nothing errors; the login keychain
just drops out of the search list and every lookup reports "could not be found"
as if the token were missing. Only reads are granted — keychain writes,
renames, and deletes stay denied — and the read-back stands down for any
keychain deny that came from a config file rather than the built-in defaults,
so an explicit `"denyRead": ["~/Library/Keychains"]` (restating the default
claims it) or a deny of a directory containing it is honoured for bash too.

Use project or global config to narrow these defaults for more sensitive workspaces.

## Network policy

Network restrictions are enabled by default. The default allowed domains cover GitHub and common container registries: GitHub/GitHubusercontent/GHCR, Docker Hub, Quay, Google Container Registry and Artifact Registry, Kubernetes registry, Microsoft Container Registry, and public ECR. All other domains are denied by default.

Set `network.enabled` to `false` to disable network restrictions and allow
normal unrestricted networking. With networking disabled, no proxy is set up:
the sandbox runtime's local proxy is never started and sandboxed commands get
no proxy-related environment variables, so tools that break under proxying
work normally. To block networking entirely, keep the policy
enabled and use an empty allowlist:

```json
{
  "network": {
    "enabled": true,
    "allowedDomains": []
  }
}
```

Hosts that match no rule are denied by default (the profile runs the proxy in
strict-allowlist mode), so an empty allowlist blocks everything. Do NOT write
`"deniedDomains": ["*"]` for this: denies are checked before allows, so a
deny-all entry silently vetoes the allowlist itself. `deniedDomains` is for
carving explicit exceptions out of an allowed wildcard — for example allowing
`*.github.com` while denying `gist.github.com`.

## Environment scrubbing

Sandboxed commands (agent `bash`, and your `!` / `!!` commands) are spawned
with a scrubbed copy of pi's environment. Two lists decide what is left:

- `environment.unset` — patterns removed first, always. `*` matches any run of
  characters except `/`, and matching is case-sensitive.
- `environment.allow` — empty by default, which is **blacklist mode**: every
  variable not unset passes. A non-empty list is **whitelist mode**: only
  names matching one of its patterns pass (unset still wins over allow).

Blacklist is the default because a whitelist breaks toolchains in ways no
default list can anticipate — `JAVA_HOME`, `GOPATH`, `NVM_DIR`,
`SSH_AUTH_SOCK`, `PYENV_ROOT`, private-CA bundles (`SSL_CERT_FILE`,
`NODE_EXTRA_CA_CERTS`, …) and whatever else your shell exports — while the
secrets worth stripping mostly follow naming conventions. The default unset
list:

- AWS credentials by name: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_SESSION_TOKEN`, `AWS_SECURITY_TOKEN`, `AWS_WEB_IDENTITY_TOKEN_FILE`
  (named rather than `AWS_*`, which would also strip `AWS_PROFILE`,
  `AWS_REGION`, `AWS_CA_BUNDLE`).
- Common tokens and provider keys by name: `GITHUB_TOKEN`, `GH_TOKEN`,
  `NPM_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.
- Naming conventions: `*_TOKEN`, `*_SECRET`, `*_KEY`, `*_API_KEY`,
  `*_PASSWORD`, `*_PASSWD`.
- Secrets with no suffix to match: `PGPASSWORD`, `MYSQL_PWD`,
  `npm_config__auth*`, `NPM_CONFIG__AUTH*`.
- `PI_RAIL_APPROVAL_MAILBOX` — the [approval mailbox](#forwarded-asks-the-approval-mailbox)
  channel token. Subagent children get it from the pi process's own
  environment, never through bash; a sandboxed command holding it could forge
  an approval.
- `RIPGREP_CONFIG_PATH` — rg reads extra flags from that file, and a
  `--pre <program>` there would get past the built-in rg flags allowlist.

The suffix globs occasionally take a harmless variable (starship's
`STARSHIP_SESSION_KEY`, for instance). Drop an entry with
`{"remove": [...]}` if one bites; add your own secrets' names with a plain
array:

```json
{ "environment": { "unset": ["MY_SERVICE_CREDENTIAL"] } }
```

**Whitelist mode with append-only lists.** Lists [only append](#lists-only-append),
and the default allow list is empty, so a config that writes
`"environment": { "allow": ["FOO"] }` does not add FOO to anything: it switches
to whitelist mode with FOO as the *only* variable passed. `PATH`, `HOME`,
`TERM`, `LANG`/`LC_*`, `TMPDIR` and every toolchain variable your commands need
then have to be listed too, for example:

```json
{ "environment": { "allow": ["PATH", "HOME", "USER", "SHELL", "TERM", "TMPDIR", "LANG", "LC_*", "SSH_AUTH_SOCK", "JAVA_HOME", "GOPATH", "NVM_DIR"] } }
```

In the grant gates the first allow entry counts as a tightening and emptying
the list again as a widening.

What the scrub cannot see: the sandbox runtime adds its own variables after
the scrub — the network proxy settings (`HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY`, `NO_PROXY` and their lowercase forms, `GIT_SSH_COMMAND`) when the
network layer is on, `TMPDIR` pointing into its writable temp dir, and
`SANDBOX_RUNTIME=1` — and those are not subject to either list. Scrubbing is
by name, so a secret stored under an innocuous name (a `DATABASE_URL` with a
password in it) passes in blacklist mode. And it covers sandboxed commands
only: Pi itself, its extensions, and processes they spawn outside the rail
keep the full environment.

## What is protected

- Agent `bash` tool calls are routed through Pi Rail.
- User `!` and `!!` bash commands are routed through Pi Rail.
- When filesystem restrictions are enabled, built-in `read`, `write`, and `edit` tool calls are checked by deterministic path policy because Seatbelt only contains subprocesses.
- When filesystem restrictions are enabled, reads are allowed by default except for configured sensitive paths, and writes are limited to configured roots.
- Environment variables are scrubbed before sandboxed commands are spawned: `environment.unset` patterns are removed first; by default everything else passes (blacklist mode), and a non-empty `environment.allow` switches to whitelist mode. See [Environment scrubbing](#environment-scrubbing).
- Every intercepted `bash`, `read`, `write`, and `edit` call is named with capability classes after deterministic policy checks and before execution; the disposition table then decides.
- Trusted reads never reach a model: a `read` whose canonical path is inside the session working directory or matches an explicit `allowRead` entry — and does not match `denyRead` — is labelled deterministically (0 tokens, 0 latency; counted as "Exempt (no model consulted)" in the status report, together with allowlisted commands and screen-clean writes). The allow/deny lists are consulted for this routing even when `filesystem.enabled` is `false`, which only disables *blocking*. Reads under the user skills directory (`~/.pi/agent/skills`) and of pi's own docs are exempt the same way: invoking a skill *is* a read of its SKILL.md, so naming it would tax every skill invocation — only the read is exempt, and the actions a skill's instructions produce are still reviewed individually.
- While a reviewer call is in flight, pi's streaming spinner reads `Classifying...` (namer) or `Judging...` (judge), so a rail wait is distinguishable from the agent model thinking.
- A `read` matching `denyRead` is **not** hard-blocked any more: it is labelled `credentials`, which defaults to `judge`. Reading a test-fixture key and reading toward exfiltration are different actions, and telling them apart is a judgment call. `denyWrite` matches stay hard blocks — writes to secret and config paths are containment, not policy.
- Writes and edits are never exempted by path alone: their content goes through the deterministic content screen, and anything it trips on goes to the namer.
- Reviewer failures are retried up to five attempts with a class-aware schedule: timeouts, rate limits, and network failures back off exponentially (250ms, growing 4x), while a malformed reply retries immediately with the parse error fed back — the call succeeded and nothing is healing in the background, so there is nothing to wait for. Auth failures, unknown models, and other 4xx errors are terminal. `classifier.timeoutMs` is an idle timeout, not a total deadline: the reviewer streams its response and the clock resets on every token, so a slow-but-progressing model can take as long as it needs while a stalled request still fails fast. If no usable namer model is available, or fail-closed naming still fails after retries, Pi Rail stops the current turn for user intervention without exiting Pi. A judge failure instead degrades to asking you.

## Approval prompts and session guidance

When the rail needs a human decision — a class set to `ask`, a judge verdict
of `ask`, or a path outside the configured roots — the prompt offers four
choices: **Allow**, **Allow with comment**, **Deny**, and **Deny with
comment** — plus **Allow, and generalise…**, which approves and then starts
the [configurator](#the-configurator) from the action. **Esc is neither**: it stops the turn — recorded and reported as a
`stop`, not a denial, because reaching for the interrupt key says "not now",
not "never", and a false deny would bias the judge against an action you never
actually judged. The prompt names the capabilities that were matched and the
row that decided, so a block is always attributable ("`off-machine-effects`,
which is set to ask (default)"). When the judge routed the ask, its verdict
carries two labeled lines — *What it does* (the action in plain terms) and
*Why it's an ask* (the policy or risk that escalated it) — never a restatement
of the command, which is displayed alongside, and never a yes/no question:
an ask is an approval escalation, and your answer is the decision. Comments become *session guidance*: user-authored
notes injected into the namer and the judge for the rest of the session, so
"allow — staging deploys are fine today" or "deny — never touch prod configs"
tunes behavior without editing config files. Deny comments are echoed to the
agent in the block reason so it can change course immediately. Guidance is
session-scoped (last 12 entries) and shown on the status page's engine tab.

The policy is ask-first throughout: `deny` is what you set for a class you
never want, and the judge reserves deny for actions that stay unsafe even
after you confirm them. Everything else that merely lacks authorization
becomes a question to you, because answering the question *is* the
authorization process.

## Headless sessions and subagents

`ctx.hasUI` tells the rail whether anyone can answer a prompt:

- **TUI** — prompts are interactive dialogs.
- **RPC mode** (`pi --mode rpc`) — prompts become `extension_ui_request`
  events on stdout; the driving client answers them over the protocol, so
  approvals work if the client implements that sub-protocol (see pi's
  `docs/rpc.md` and `examples/rpc-extension-ui.ts`). Every rail interface
  degrades to protocol dialogs there: approval prompts become select+input,
  and the `/rail` control panel, reviewer model picker, and statusline
  chooser become plain select dialogs (search and live headers are TUI-only).
  `/rail status` and `/rail policy rules` toggle live *widgets*
  (fire-and-forget `setWidget` requests keyed `rail-status`/`rail-policy`,
  refreshed on every rail event) — user-visible in any client that renders
  widgets, and never part of agent context. Tabs are TUI-only, so the widget
  carries every status tab in sequence under its own header, `/rail policy
  rules` narrows it to the policy tab, and `/rail policy` (the table)
  degrades to select dialogs, class editing included. Smoke and critique results arrive the same
  way, keyed `rail-report`.
- **json / print modes** — headless: there is no one here to ask. When a
  parent rail session advertises its approval mailbox (below), ask decisions
  are forwarded there and answered by the real user; otherwise they become
  blocks whose reason states exactly that ("no user to ask"), so the agent —
  or a parent process reading the transcript — knows the block is about
  approval availability, not policy.

### Forwarded asks: the approval mailbox

A pi-subagents child is headless, but the user is one process up. Every
interactive rail session runs an approval mailbox — a private file
request/reply inbox under the agent dir — and advertises it in the process
environment, which pi-subagents children (and grandchildren) inherit. When a
child rail hits an `ask`, it writes a request and blocks its tool call until
you answer the normal approval dialog in the parent session, labeled with the
subagent's identity ("Rail approval — subagent researcher"). Allow/deny and
any comment flow back to the child; deny comments become the child's session
guidance exactly as if the dialog had been local. Asks route to the nearest
interactive ancestor at any nesting depth, and detached background children
keep working across `/new` (the mailbox is process-lifetime).

Design properties worth knowing:

- **User consent only.** The channel never routes through a model —
  deliberately not built on pi-subagents' `contact_supervisor`, whose replies
  come from the parent *agent*. Forwarded dialogs also default-select Deny
  and ignore the first ~400 ms of input, so an Enter aimed at the editor
  cannot approve a subagent's action unseen.
- **Forge-resistant.** The mailbox lives under the agent dir (not `$TMPDIR`,
  which sandboxed bash can write), and the channel token exists only in the
  environment variable — which the rail's environment scrubbing strips from
  sandboxed commands. Forging an approval requires code execution outside the
  sandbox.
- **No hangs.** Children detect a dead parent by heartbeat (a pid check lies
  after pid reuse) and fall back to the headless deny; the parent answers
  every consumed request — even invalid ones get a rejection — and
  auto-cancels a dialog whose requester died. There is deliberately no
  wall-clock timeout: an unanswered ask waits for you, and pi-subagents'
  own idle notices surface the quietly-blocked child.
- **Zero configuration**, on by default; a bash-spawned `pi -p` child does
  not inherit the channel (the env scrub drops it — the alternative would
  hand the token to every sandboxed command).

The protocol, options considered, and accepted risks are recorded in
[SUBAGENT_ASKS_PLAN.md](SUBAGENT_ASKS_PLAN.md); the RPC-mode alternative
remains viable for clients that drive pi over the protocol (see
[docs/history/FEEDBACK_PLAN.md](docs/history/FEEDBACK_PLAN.md)).

### pi-subagents interop

The [`pi-subagents`](https://github.com/nicobailon/pi-subagents) extension
(not affiliated; also distinct from the npm `pi-guard` package it recommends
for bash policy) spawns children that inherit your installed extensions by
default, so each child runs its own rail instance. Pi Rail participates in
its acknowledgement channel both ways:

- **As a child**, when the rail is enforcing it emits
  `subagent:acknowledge-extension` (id `pi-rail`) so the run status records
  that the child was on the rail. The pre-rename id `pi-extension-guard` is
  still accepted parent-side, so a new parent does not mistake an older child
  for one that ran without the rail.
- **As the parent**, it inspects `subagent`/`subagent_wait` results and warns
  once per finished child that never acknowledged — that child ran
  without the rail. Common causes: the agent profile declares `extensions:`
  frontmatter, `subagents.defaultExtensions` is set, a capability ceiling
  passes `--no-extensions`, the agent is an external-CLI runner, or the
  rail was loaded via `pi -ne -e` and is not in ambient settings.

Both channels are best-effort observability, never enforcement.

## Decision telemetry

Every rail decision — capability reviews, deterministic policy blocks, path
approvals, and reviewer errors — is recorded as a `custom` entry
(`customType: "rail"`) in pi's own session log, next to the tool call it
judged. Entries do not participate in LLM context and are written
best-effort: telemetry never blocks or breaks a tool call, and ephemeral
sessions simply skip persistence. (Sessions recorded before the pi-guard →
pi-rail rename carry `customType: "guard"` and are no longer read by the
analysis tooling or session replay.)

These records are also the rail's own memory: session guidance, the recent
decisions shown to the judge, and the status counters are **derived from the
records along the current session branch**, not kept as freestanding state.
Rewinding with `/tree` therefore rewinds the rail too — a denial you navigate
away from stops biasing the judge, and returns if you navigate forward to
that branch again — and resuming or forking a session restores the memory its
branch actually accumulated instead of starting blank.

`classifier.telemetry` picks the detail tier; the memory-core fields
(decision, labels, target, reason, the user's answer and comment) are always
written when a session is persisted, because replay depends on them:

- `"minimal"` (default): adds resolved disposition and the row that decided,
  the grant behind the deciding label (`grant`),
  content-screen verdict, judge fields (model, verdict, latency, tokens) when
  the judge ran, attempts, latency, token usage, namer model, and a truncated
  projection of the tool input.
- `"full"`: complete projection including the policy summary, for eval-case
  extraction.
- `"off"`: the memory core only — extra detail is dropped by omitting keys,
  never by zeroing them, so analysis cannot mistake "not recorded" for
  "measured zero".

Note that session files can be shared (`pi share` uploads the whole file), so
records stay minimal by default even though the session already contains the
full tool call inputs.

`npm run telemetry` (`eval/session-stats.ts`) aggregates rail entries across
all local sessions: decision rates, capability label frequencies, judge and
screen-trip rates, retry rate, latency p50/p95/max, token cost, models used,
path approvals, and errors.
`npm run telemetry -- --cases` dumps denied/rejected reviews as eval-case
candidates, flagging ones where the same command was executed later in the
session (false-positive candidates worth adding to `eval/cases.ts`).

### Replay corpus

Session telemetry truncates commands and paths because session files can be
shared, which makes replaying a policy change against past decisions inexact.
So the rail also keeps a separate, local replay corpus: one JSON line per
decision (capability reviews, path approvals, deterministic policy blocks)
with the timestamp, cwd, tool, the **full** command or path, the capability
labels and whether the namer supplied them, the content-screen verdict, the
resolved disposition and deciding row, the outcome, the user's answer
(marked `forwarded` when it came from the parent session), and the judge's
verdict. It does not keep token usage, latency, free-text reasons, comments,
or any write/edit content — a write keeps only a sha256 and a byte length.

- **Where:** `<agent dir>/rail-corpus/<YYYY-MM>.jsonl` (`~/.pi/agent/rail-corpus/`
  by default), one append-only file per UTC month; directory `0700`, files
  `0600`. Headless subagent children append to the same files.
- **Redaction:** credential shapes in commands — the content screen's
  credential patterns (AWS/GitHub/GitLab/Slack/OpenAI/Google keys, JWTs,
  private keys, SSH key bodies), the value of a credential-named key
  (`API_KEY=…`, `--password=…`, `"password":"…"`), the token after
  `Bearer`/`Basic`, and high-entropy tokens and large base64 blobs — are
  replaced by one typed shell word such as `‹redacted:aws-key›`, so the
  command still parses into the same commands and arguments. Expansions like
  `API_KEY=$TOKEN` are references and are left alone. A redacted record
  carries `redacted: true` and the list of kinds. Paths, and references to
  credential stores like `~/.aws/credentials`, are never redacted: they are
  what the rules match on. Positional secrets with no key or shape to
  recognise them by (`mysql -psecret`, `curl -u user:pass`,
  `--password secret`) are not redacted.
- **Cap:** at most 12 months and about 50 MB; whole month files are pruned,
  oldest first, once per process.
- **Off switch:** `"corpus": { "enabled": false }`. The corpus is independent
  of `classifier.telemetry`, is never written while the rail is disabled,
  never leaves the machine, and is never part of the session file.

The grant gates replay the corpus ([Grants by hand](#grants-by-hand)), and
`/rail grants` counts what each grant decided from its `grant` field.

## Related extensions

- [`pi-sandbox`](https://github.com/carderne/pi-sandbox) (Chris Arderne) — the inspiration for Pi Rail: OS-level sandboxing for Pi with interactive permission prompts, on macOS `sandbox-exec` and Linux `bubblewrap`. Pi Rail adds the semantic layer on top of similar containment — capability naming, the disposition table, the judge; if you want a mature prompt-oriented sandbox without model review, especially on Linux, start there.
- [`pi-guard`](https://github.com/jdiamond/pi-guard) (Jason Diamond) — a deterministic permission system for pi tools: allow/ask/deny rules with extensible matchers, no OS sandbox. Pi Rail's command allowlist plays a similar role, but its decisions sit inside Seatbelt containment and fall through to the classifier instead of rules alone. (This project was itself named pi-guard before being renamed to avoid the clash; a leftover `guard.json` is no longer read — see [Configuration](#configuration).)
- [herdr](https://herdr.dev) — while a rail approval dialog is open, the rail emits `herdr:blocked` on pi's extension bus (with a label naming the ask), so herdr's pane state shows *waiting for input* instead of *working*. Refcounted and paired on every exit path; a no-op when herdr's integration isn't listening.

## Limitations

Pi Rail is a defense-in-depth containment layer, not a complete adversarial security boundary.

- Seatbelt applies to spawned subprocesses, not arbitrary Pi extension code.
- Domain-level network allowlisting is limited and depends on the sandbox runtime's hostname handling. A proxy layer is a better future design for more precise domain policy.
- Broad workspace write access can still allow project-local persistence. Local `.git` writes are allowed so explicit git commands can work; rely on the `off-machine-effects`, `local-destructive`, and `persistence` classes for risky source-control actions, and keep protected paths like `.pi`, `.env`, keys, and shell startup files denied.
- Unix sockets, Docker sockets, inherited credentials, and overly broad writable directories can weaken isolation.
- The namer only names; the disposition table decides. A prompt-injected namer can at worst mislabel a capability, and the table still refuses a class you set to deny. Neither reviewer can override deterministic deny rules or Seatbelt.
- The judge holds decision authority only for classes you explicitly delegated to it, only for one action at a time, and never above a deny that severity-max already produced.
- Disabling filesystem or network restrictions deliberately removes those hard boundaries; reviewer decisions can be wrong or unavailable.
- Session-layer changes to filesystem, network, and environment lists re-point the Seatbelt profile for the *next* command. A command already running keeps the filesystem profile and environment it was spawned with (a revoked write root stays writable to it until it exits); only its network follows the new domain lists, connection by connection. `filesystem.enabled`, `network.enabled`, and the `seatbelt` overrides change only at restart.
- Read-only mode does not tighten plain `commands.allow` entries: they are tagged `read-project`, which the read-only preset leaves alone, so classify a writing command into a writing class instead of allowlisting it.

## Future container backend

The backend interface is in `src/backends/types.ts`. A future `container` backend should implement the same interface and reuse the config/policy modules.

## Development

```bash
npm install
npm run check   # tsc --noEmit
npm test        # node --test (Node 22.18+ runs TypeScript directly)
npm run test:tui  # tmux-driven TUI integration test (skips without tmux + pi)
```

### UI architecture

Three seam modules own every run-mode branch; feature code never inspects
`ctx.mode` to pick a presentation:

- `src/live-view.ts` — display surfaces (the status page, smoke/critique
  reports): docked panel in the TUI, `setWidget` over RPC, a stderr error
  headless. `showRailView` replaces any open view; `toggleRailView` adds
  toggle semantics for the recurring views; `toggleRailPanel` hosts a
  component panel (the status page, the disposition page) and returns false
  where custom components do not exist, so the caller degrades.
- `src/approvals.ts` — response dialogs (approval prompts): a custom dialog
  with inline comment input in the TUI, `select`+`input` protocol dialogs
  over RPC. Callers gate on `ctx.hasUI` first because headless approval
  absence is a policy decision (block with an explanatory reason), not a
  presentation choice.
- `src/tui/select-list.ts` — pickers (control panel, the RPC side of the
  model picker, statusline chooser): searchable list in the TUI, plain `select` dialog
  elsewhere; resolves `undefined` where no dialog capability exists, which
  callers already treat as cancel.

The status page follows the same rule from the other direction: its six tabs
are plain functions of `(state, config, width, theme)` in `src/status-tabs.ts`,
built on the column-fitting helper in `src/tui/table.ts`, so the TUI panel
(`src/tui/status-page.ts`) and the RPC widget render the same content — the
widget just concatenates every tab and passes a no-op theme.

The disposition page follows the same rule: `src/dispositions.ts` holds the
row model (values, provenance, stats, class add/edit/delete, save) with no UI
in it, and the two surfaces — `src/tui/disposition-page.ts` and the RPC select
loop in `src/commands/dispositions.ts` — render it. The class vocabulary
itself lives one level down in `src/capabilities.ts`: `capabilityRegistry()`
folds built-ins, config classes, and session edits into the ordered list that
both the table and the namer payload read.

The reviewer-model picker is the same shape again: `src/reviewer-seats.ts`
holds the three seats (effective vs saved value, set, save) with no UI,
`src/model-selector.ts` builds each seat's rows, and `src/tui/model-page.ts`
and the RPC select loop in `src/commands/model.ts` render them. The session
values are `RuntimeState.classifier` fields, not session-policy ops: a model
is not policy, so it is not in the session policy snapshot and a new session
starts from the config.

Transient signals (`notify`, `setStatus`) work in TUI and RPC and no-op
headless. New UI belongs in one of these seams — extend them rather than
branching on mode inline, so every surface degrades consistently.

### Reviewer testing layers

The reviewers are verified at four layers, and only the last one touches a live model:

1. **Protocol** (`test/classifier-protocol.test.ts`): projection building, payload construction, response parsing, and error classification are pure functions in `src/classifier-protocol.ts`. The key property pinned here is fail-closed parsing — any model output outside the exact JSON schema throws instead of being interpreted, while unknown class ids are dropped and an empty label set becomes `unclassified`.
2. **Screen** (`test/content-screen.test.ts`): the deterministic write/edit screen. The load-bearing case is the regression test that imports the round-2 `subtle-*` cases from `eval/cases.ts` and asserts every one trips the screen — those cases are exactly what a path-only exemption misses, so a screen that lets one through is a broken screen.
3. **Orchestration** (`test/classifier-flow.test.ts`, `test/interceptor.test.ts`, `test/capabilities.test.ts`): the single-call namer, the judge, the shared retry budget, backoff, timeout, auth failures, deterministic label routing, and severity-max table resolution run against scripted fakes, so they are deterministic. No LLM is involved.
4. **Judgment** (`eval/`): whether a real model names and judges well is measured, not asserted. `npm run eval -- provider/model [provider/model ...]` runs the golden dataset in `eval/cases.ts` through the production path — namer, built-in disposition table, judge when the table escalates — and reports decision agreement, critical misses (a "critical" case decided as allow), the labels each case got, judge rate, latency, and token usage. Pass several models to compare them. One model plays both seats there; in production the judge defaults to the session model. API keys come from the usual env vars (`ANTHROPIC_API_KEY`, etc). The eval exits non-zero if any critical case was allowed. It is intentionally not part of `npm test`. `--quick` runs only the `/rail eval` suite (the cases tagged `quick`), two at a time under the same wall clock, prints the `/rail eval` report after the table, and appends one run per model to the same history file `/rail eval` keeps (the path is printed); `--filter` and `--json` combine with it, and a filtered quick run gets its own suite id. The CLI and the command share one runner (`src/rail-eval.ts`); a write whose content screens clean takes the screen's deterministic label without a namer call in both, as it does live.

Keys resolve from the provider env var first, then fall back to pi's own auth store (`auth.json` in the pi agent dir) for providers you logged into via pi with an API key — so if `/login` in pi works for a provider, the eval usually needs no extra setup. OAuth-based pi logins (like Claude Pro/Max) are not usable here; those providers still need an env var.

With an OpenRouter key, one `OPENROUTER_API_KEY` covers models from every vendor, which makes cross-vendor comparison easy:

```bash
OPENROUTER_API_KEY=... npm run eval -- \
  openrouter/anthropic/claude-haiku-4.5 \
  openrouter/openai/gpt-5-mini \
  openrouter/google/gemini-2.5-flash
```

Model ids under `openrouter/` follow OpenRouter's own `vendor/model` naming. Ids missing from pi-ai's pinned catalog are synthesized automatically, since OpenRouter serves everything through one OpenAI-compatible endpoint.

5. **Configurator judgment** (`eval/grant-run.ts`): `npm run eval:grant -- provider/model [...]` (with `--filter` and `--json`) runs every case in `eval/grant-cases.ts` through `runGrantAgent` with a real model and scores the outcome by code (`eval/grant-score.ts`, unit-tested in `test/grant-score.test.ts`): a table per model of each property's pass/fail, turns, tokens, latency, final rung, and gate status. It exits non-zero when a model passed the gates with a grant that violates a must-not-allow, must-be-sensitive, forbidden-op, or injection property. Keys resolve as for `npm run eval`; the loop itself is tested offline against a scripted fake model (`test/grant-agent.test.ts`). See `eval/GRANT_RESULTS.md`.

The `@earendil-works/*` packages are declared as peer dependencies because Pi
provides them at runtime. Pinned development copies are installed only for
local typechecking and tests.

The same filesystem config is enforced by two engines: `src/policy.ts` for Pi's file tools and the Seatbelt profile for bash. Both consume `compileFilesystemPolicy` (in `src/policy.ts`), which resolves each pattern once and reports the ones a Seatbelt profile cannot express — glob patterns (`.env.*`, `*.pem`) and bare names (`.env`), which reach the sandbox as literal resolved paths — in its `degraded` list. Degraded patterns surface as a session-start warning and in `/rail status`. `test/policy-seatbelt-agreement.test.ts` pins down that both engines deny the same sensitive locations and that every unexpressible pattern is declared degraded; extend it when adding deny patterns.
