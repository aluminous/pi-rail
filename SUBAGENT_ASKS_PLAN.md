# Forwarded asks: subagent approvals in the parent session

Status: implemented (`src/approval-mailbox.ts`).

## Problem

A pi-subagents child is a `pi --mode json -p` subprocess: `ctx.hasUI` is
false, so every rail `ask` used to auto-deny with "headless session with no
user to ask" — while the user sat one process up, in the interactive parent
session, perfectly able to answer. The rail's policy is ask-first; a subagent
that cannot ask is a subagent that gets denied things the user would have
approved.

## Options considered

**File-based approval mailbox advertised via env var — chosen.**
pi-subagents spawns children with `env: { ...process.env, ...sharedEnv }`, so
anything the parent rail puts in its own process environment reaches every
child and grandchild, including detached background runners — with zero
changes to pi-subagents or pi. The parent creates a private request/reply
inbox, advertises `dir#token` in `PI_RAIL_APPROVAL_MAILBOX`, and services
requests through the normal approval dialog. Works at any nesting depth
(children never create mailboxes, so all asks route to the nearest
interactive ancestor) and with any pi-subagents version.

**Ride pi-subagents' native supervisor channel — rejected on trust model.**
pi-subagents ≥ ~0.43 ships `contact_supervisor` / `subagent_supervisor`:
structurally the same file mailbox (per-child `requests/` + `replies/` dirs
under a temp root, env-advertised, atomic JSON, polling). But requests are
injected into the parent *model's* conversation (`pi.sendMessage(...,
{ triggerTurn: true })`) and the parent LLM writes the reply. A rail ask
exists to obtain *user* consent for an action the child model already tried;
consent minted by another model is not consent. It also would couple the rail
to pi-subagents' wire format and minimum version. The convergent design is
still useful evidence: file inboxes are pi-subagents' own idiom for
cross-process coordination, and its Extension API docs state the event bus is
in-process only.

**Run children in RPC mode and forward `extension_ui_request` — deferred.**
The cleanest protocol on paper (pi already defines the extension-UI
sub-protocol, and unmodified pi-rail works over it), but pi-subagents spawns
`--mode json` with stdin ignored, so this requires upstreaming a mode change.
Still viable as a future direction — possibly as an upstream "guard approval"
request kind that routes to a user dialog rather than the model.

**pi-intercom bridge — rejected.** Optional package, routes through both
models, and the reply lands in the child's agent loop rather than resolving
the blocked tool call.

**Deny-and-retry with pre-granted approvals — rejected.** Wastes the child's
work, and turns one question into a spawn cycle.

## Protocol (v1)

Env var `PI_RAIL_APPROVAL_MAILBOX` = `<dir>#<token>`. The token appears only
in the environment and inside request/response bodies — never in a file.

```
<agentDir>/rail-approvals/<uuid>/     0700
  mailbox.json    { type, version, pid, createdAt }      (no token)
  heartbeat       touched every parent poll tick (~300 ms)
  requests/<ts13>-<requestId>.json    child writes, parent consumes
  responses/<requestId>.json          parent writes, child consumes
```

- All writes are atomic (`.tmp` in the same dir, then rename); readers accept
  only strict filenames, so partial reads and path traversal are impossible.
- The child polls the response file (~250 ms) with no wall-clock timeout,
  exiting when the response arrives, the heartbeat goes stale (~5 s), or its
  abort signal fires. pi has no `tool_call`-hook timeout and pi-subagents
  never kills a quiet mid-call child, so blocking indefinitely is safe; the
  drain-kill only arms after a child's final message.
- The parent answers every consumed request — validation failures get
  `{ approved: false, rejected: "<code>" }` rather than silence, because a
  silently dropped request plus a child without a timeout is a permanent
  hang. Requests from already-dead children are reaped unanswered.
- `mailbox.json.version` gates the wire version: a child that sees an unknown
  version treats the mailbox as absent and falls back to the headless deny
  (parent and child can be different pi-rail installs).
- Liveness is the heartbeat, not `kill(pid, 0)`: a recycled pid passes the
  kill check forever; an mtime cannot lie for more than one tick. A startup
  sweep reaps sibling mailboxes whose parent crashed without cleanup.

## Why the mailbox is where it is

The seatbelt profile re-allows read+write on all temp paths for every
sandboxed command (`src/backends/seatbelt.ts`), so a `$TMPDIR` mailbox would
let model-driven bash read the token and forge an approval for a sibling
child's pending ask. The mailbox therefore lives under the agent dir —
outside the sandbox's write allowances and inside the rail's own default
`denyWrite` — and the token lives only in the env var, which
`scrubEnvironment`'s whitelist strips from every sandboxed command.
Consequence, accepted deliberately: a `pi -p` child spawned from sandboxed
bash does not inherit the channel and keeps the classic headless deny;
allowlisting the var would hand the token to everything.

## Parent-side dialog safety

Forwarded dialogs pop from a background poller, possibly while the user is
typing (pi's non-overlay custom takes focus, and Enter decides):

- default-select **Deny** and drop input for ~400 ms after mount;
- one dialog at a time, oldest first, serialized with the session's own
  approval dialogs through the state dialog lock;
- a watchdog auto-cancels the dialog if the requesting child dies while it is
  open, so a moot question cannot block live children queued behind it.

## Accepted risks

- **Cross-extension dialog collision.** pi's non-overlay custom clobbers
  another extension's open custom. The rail serializes only its own dialogs;
  a collision with a different extension's dialog remains possible.
- **Forged consent requires the token**, i.e. code execution outside the
  sandbox in a process that inherited the parent's environment. Inside that
  boundary the process could equally patch the rail itself.
- **Heartbeat freshness window.** A parent that hard-crashes strands waiting
  children for up to ~5 s before they fall back to the headless deny.

## Lifecycle

Process-lifetime, not session-lifetime: detached children outlive `/new`, so
the mailbox survives session switches and stops only on quit or extension
reload (`index.ts`, `session_shutdown` reasons). Start is idempotent through
a module-global slot; `stop()` restores any shadowed outer env value, so an
interactive pi launched inside another rail session hands the channel back on
exit.
