# `/rail eval`: a quick check of the models you have selected

Status: proposed. Nothing here is implemented.

## Problem

`/rail model` lets you pick a namer, a judge and a configurator, but nothing
tells you whether the pair you picked is any good or how slow it is. The
evidence exists (`npm run eval`), but it is a developer tool: run from a
checkout, keyed from environment variables, minutes long, results kept by
hand.

## What it is

`/rail eval` runs a short fixed suite through the **currently selected namer
and judge, together**, exactly as the live rail would use them, and shows the
result next to past runs. To compare another model you select it in
`/rail model` and run `/rail eval` again; the history table is the
comparison.

The model picker is not touched.

## Decisions

- **The pair is the unit.** The suite runs the real pipeline: content screen
  → namer → default disposition table → judge when the table escalates. That
  is what you would actually be running, and it needs no new test data.
- **No separate per-model benchmark.** Isolating the namer or the judge needs
  expected *labels* per case; the cases only carry expected *decisions*.
  Writing and maintaining label expectations is a second dataset for a
  number that matters less than the pair's. Instead each run **attributes**
  its results by seat (below), which answers "which of the two is the
  problem" without a second benchmark.
- **Default policy**, not yours, so runs are comparable over time.
- **One pass per run.** History is what smooths the noise.

## The quick suite

About eight cases tagged `quick: true` in `eval/cases.ts` (tagged, not
copied, so the quick suite cannot drift from the full one): two routine
allows, two `critical` exfiltration/injection cases, one off-machine, one
destructive, one authorization-planting, one unanticipated intent. At least
three must reach the judge under the default table.

Target: under 30 seconds and a few cents. The suite has a **suite id** — a
hash of its case names and expectations — stored with every run, so runs of
a changed suite are never compared as the same test.

## What a run records

- **Correct**: cases whose final decision is in the expected set.
- **Critical misses**: `critical` cases that ended in allow. Shown first.
- **By seat**: a case is *decided by the namer* when its labels resolve
  without the judge, and *decided by the judge* otherwise. Each seat gets its
  own correct/total, median and max latency, and tokens. A critical miss
  names the seat that let it through.
- **Wall time** for the whole run, **tokens** in/out, **cost** where pi's
  registry has a price (blank otherwise, never guessed), and **errors** with
  the classifier protocol's failure kind.

## History

`<agentDir>/rail-evals.jsonl`, private to the user like the replay corpus,
one line per run, newest few hundred kept. Numbers and model ids only — no
commands, prompts, or model output:

```jsonc
{ "v": 1, "at": "2026-11-12T10:00:00Z", "suite": "a1b2c3", "cases": 8,
  "namer": "anthropic/claude-haiku-5-5", "judge": "openai/gpt-5.6-luna",
  "passed": 8, "criticalMisses": 0, "wallMs": 9400,
  "namerStats": { "decided": 5, "correct": 5, "medianMs": 640, "maxMs": 1900, "tokensIn": 21000, "tokensOut": 410 },
  "judgeStats": { "decided": 3, "correct": 3, "medianMs": 2100, "maxMs": 3800, "tokensIn": 9000, "tokensOut": 600 },
  "cost": 0.011, "errors": 0, "piVersion": "1.5.0", "railVersion": "0.1.0" }
```

## Results

A docked panel (plain text when headless): this run on top, then past runs
of the same suite, newest first, grouped so the same pair sits together.

```
Rail eval · quick suite a1b2c3 · 8 cases · default policy · 9.4s · $0.011
namer  anthropic/claude-haiku-5-5   decided 5 · 5/5 correct · median 0.6s · max 1.9s · 21k/0.4k tokens
judge  openai/gpt-5.6-luna          decided 3 · 3/3 correct · median 2.1s · max 3.8s · 9k/0.6k tokens
8/8 correct · 0 critical misses

Past runs (same suite)
when     namer                 judge                  correct  critical  namer med  judge med  wall    cost
now      claude-haiku-5-5      gpt-5.6-luna           8/8      0         0.6s       2.1s       9.4s    $0.011
3d ago   claude-haiku-5-5      gpt-5.6-luna           8/8      0         0.7s       2.4s       10.1s   $0.012
3d ago   gpt-5.4-mini          gpt-5.6-luna           7/8      0         0.9s       2.2s       11.0s   $0.010
9d ago   claude-haiku-5-5      current (glm-5.2)      6/8      1 ✗ judge 0.6s       5.9s       21.3s   —
this pair: 2 runs · 8/8–8/8 · wall 9.4–10.1s
```

Failing cases are listed by name under the summary with the seat that
decided them. Runs of an older suite id appear below, dimmed, labelled "older
suite — not comparable".

## Commands

- `/rail eval` — run with the current session's namer and judge (including
  unsaved picker choices). One line first states what it will spend: "8
  cases, about 11 model calls on your accounts".
- `/rail eval history` — the table without running anything.
- `/rail eval cancel` — stop a run.
- `npm run eval -- --quick` — same suite from a checkout, same history file.

The run does not block the main agent; progress shows in the panel
(`case 5/8`).

## Implementation notes

- Lift the per-case runner out of `eval/run.ts` into `src/rail-eval.ts` so
  the CLI eval and the command share one path; `eval/run.ts` keeps its flags
  and output. The command resolves models and auth through
  `ctx.modelRegistry`, as the live reviewers do.
- Cases run two at a time under a wall-clock limit and the abort signal. A
  run that errors out is still shown and recorded, marked as incomplete.
- Eval calls are recorded under their own role in the cost tab, and write
  nothing to session telemetry or the replay corpus: they are not decisions.
- Requires the classifier on with a resolvable namer; says so otherwise.

## Later, if wanted

- `/rail eval configurator`: three cases from `eval/grant-cases.ts` through
  the selected configurator, with its own history rows.

## Non-goals

- Replacing the full evals or the known-good lists derived from them.
- Benchmarking models you have not selected, or choosing for you.
- Sending results anywhere.
