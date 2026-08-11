// The approval mailbox: a file request/reply channel that lets a headless
// pi-subagents child forward a rail `ask` to the interactive parent session,
// where the real user answers the normal approval dialog. The child writes a
// request file and polls for the response while its tool call stays blocked;
// the parent's poller services requests through the injected ask dialog.
//
// Unlike subagents-interop.ts ("observability, never enforcement"), this
// module changes enforcement outcomes: a forwarded answer approves or denies
// the child's tool call. That difference in charter is why they are separate
// files. The trust model: consent must come from the user, never from a model
// — which is also why the channel secret (the token in the env var) is never
// written to disk, and why the mailbox lives under the agent dir rather than
// $TMPDIR, where every seatbelt-sandboxed bash could read and forge it.
//
// Layout (dir 0700):
//   <getAgentDir()>/rail-approvals/<uuid>/
//     mailbox.json   { type, version, pid, createdAt }        (no token)
//     heartbeat      touched by the parent poller every tick; children treat
//                    a stale mtime as parent-gone (pid checks lie after reuse)
//     requests/<ts>-<requestId>.json    child writes, parent consumes
//     responses/<requestId>.json        parent writes, child consumes
//
// Every consumed request is answered, even when validation fails (a rejected
// response with a code): a silently dropped request plus a child with no
// wall-clock timeout would otherwise hang that child forever.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AskOutcome, AskPresentationOptions, RailAsk } from "./approvals.ts";
import type { AccessKind } from "./policy.ts";
import { recordForwardedAsk, type RuntimeState } from "./state.ts";
import { SUBAGENT_CHILD_ENV } from "./subagents-interop.ts";
import type { RailApprovalAnswer } from "./tui/approval-dialog.ts";
import { textPrefix } from "./util.ts";

/** `<dir>#<token>`. The token appears only here and inside request/response bodies — never in a file. */
export const APPROVAL_MAILBOX_ENV = "PI_RAIL_APPROVAL_MAILBOX";

export const MAILBOX_VERSION = 1;
/** Children poll for the response at this cadence while their tool call blocks. */
export const CHILD_POLL_MS = 250;
/** The parent services requests (and touches the heartbeat) at this cadence. */
export const PARENT_POLL_MS = 300;
/** Heartbeat older than this means the parent is gone, however alive its pid looks. */
export const HEARTBEAT_STALE_MS = 5_000;
/** Startup sweep reaps sibling mailboxes whose heartbeat is at least this stale. */
const SWEEP_STALE_MS = 60_000;
const MAX_REQUEST_BYTES = 64 * 1024;
/** Polls the child tolerates its request being gone with no response before giving up (races only). */
const REQUEST_GONE_GRACE_POLLS = 3;

/** Excludes in-flight `.tmp` files, forbids traversal, and sorts oldest-first. */
const REQUEST_FILE_RE = /^(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

export interface ForwardedAskMeta {
  toolName: string;
  site: "path" | "capability";
  access?: AccessKind;
  path?: string;
  labels?: string[];
}

export type ForwardFailure = "no-mailbox" | "parent-gone" | "rejected" | "cancelled";

export type ForwardResult = { ok: true; answer: RailApprovalAnswer } | { ok: false; failure: ForwardFailure };

type RejectedCode = "bad-token" | "bad-version" | "malformed" | "too-large";

interface MailboxRoute {
  dir: string;
  token: string;
}

function parseMailboxEnv(env: NodeJS.ProcessEnv): MailboxRoute | undefined {
  const value = env[APPROVAL_MAILBOX_ENV];
  if (!value) return undefined;
  const hash = value.lastIndexOf("#");
  if (hash <= 0 || hash === value.length - 1) return undefined;
  const dir = value.slice(0, hash);
  if (!path.isAbsolute(dir)) return undefined;
  return { dir, token: value.slice(hash + 1) };
}

/** `.tmp` in the same directory, then rename: readers matching the strict names never see a partial file. */
function writeAtomicJson(filePath: string, value: unknown): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, "\t"), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function heartbeatFresh(dir: string, now = Date.now()): boolean {
  try {
    return now - fs.statSync(path.join(dir, "heartbeat")).mtimeMs < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

function readMailboxDescriptor(dir: string): { version: number; pid: number } | undefined {
  try {
    const raw = fs.readFileSync(path.join(dir, "mailbox.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.type !== "rail-approval-mailbox" || typeof record.version !== "number" || typeof record.pid !== "number") return undefined;
    return { version: record.version, pid: record.pid };
  } catch {
    return undefined;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Child side
// ---------------------------------------------------------------------------

/**
 * Whether a parent mailbox is advertised and verifiably alive. Sync, cheap,
 * and never throws; callers treat false as "this session is simply headless".
 * The mailbox version gates the wire version: an unknown version reads as
 * absent, so a newer child degrades to the headless deny instead of speaking
 * a protocol the parent won't answer.
 */
export function approvalForwardingAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const route = parseMailboxEnv(env);
  if (!route) return false;
  const descriptor = readMailboxDescriptor(route.dir);
  if (!descriptor || descriptor.version !== MAILBOX_VERSION) return false;
  return heartbeatFresh(route.dir);
}

/**
 * Forwards one ask to the parent mailbox and blocks until the user answers,
 * the parent dies (stale heartbeat or vanished dir), or `signal` aborts. No
 * wall-clock timeout by design: the tool call is already blocked, pi has no
 * hook timeout, and pi-subagents never kills a quiet mid-call child — the
 * user decides when the ask resolves, however long that takes.
 */
export async function forwardAskToParent(params: {
  title: string;
  message: string;
  meta: ForwardedAskMeta;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
}): Promise<ForwardResult> {
  const env = params.env ?? process.env;
  const route = parseMailboxEnv(env);
  if (!route || !approvalForwardingAvailable(env)) return { ok: false, failure: "no-mailbox" };
  const pollMs = params.pollMs ?? CHILD_POLL_MS;
  const requestId = crypto.randomUUID();
  const requestFile = path.join(route.dir, "requests", `${Date.now()}-${requestId}.json`);
  const responseFile = path.join(route.dir, "responses", `${requestId}.json`);
  const subagent: Record<string, string> = {};
  if (env.PI_SUBAGENT_RUN_ID) subagent.runId = textPrefix(env.PI_SUBAGENT_RUN_ID, 128);
  if (env.PI_SUBAGENT_CHILD_AGENT) subagent.agent = textPrefix(env.PI_SUBAGENT_CHILD_AGENT, 128);
  if (env.PI_SUBAGENT_CHILD_INDEX) subagent.childIndex = textPrefix(env.PI_SUBAGENT_CHILD_INDEX, 16);
  try {
    writeAtomicJson(requestFile, {
      type: "rail-approval-request",
      version: MAILBOX_VERSION,
      token: route.token,
      requestId,
      ts: Date.now(),
      childPid: process.pid,
      subagent,
      toolName: textPrefix(params.meta.toolName, 128),
      site: params.meta.site,
      ...(params.meta.access ? { access: params.meta.access } : {}),
      ...(params.meta.path ? { path: textPrefix(params.meta.path, 1024) } : {}),
      ...(params.meta.labels ? { labels: params.meta.labels.slice(0, 16).map((label) => textPrefix(label, 64)) } : {}),
      title: textPrefix(params.title, 200),
      message: textPrefix(params.message, 8000),
    });
  } catch {
    return { ok: false, failure: "no-mailbox" };
  }
  let requestGonePolls = 0;
  try {
    while (true) {
      const response = readResponse(responseFile, route.token, requestId);
      if (response) return response;
      if (params.signal?.aborted) return { ok: false, failure: "cancelled" };
      if (!heartbeatFresh(route.dir)) return { ok: false, failure: "parent-gone" };
      // Request consumed but no response: the parent writes the response
      // before unlinking the request, so this is a narrow race (or a foreign
      // unlink) — tolerate a few polls, then give up rather than loop.
      if (!fs.existsSync(requestFile)) {
        if (++requestGonePolls > REQUEST_GONE_GRACE_POLLS) return { ok: false, failure: "rejected" };
      } else {
        requestGonePolls = 0;
      }
      await sleep(pollMs, params.signal);
    }
  } finally {
    // Cancels a not-yet-shown parent dialog on abort; harmless when consumed.
    try {
      fs.unlinkSync(requestFile);
    } catch {
      /* already consumed */
    }
  }
}

function readResponse(responseFile: string, token: string, requestId: string): ForwardResult | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(responseFile, "utf-8");
  } catch {
    return undefined;
  }
  try {
    fs.unlinkSync(responseFile);
  } catch {
    /* best effort */
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.type !== "rail-approval-response" || parsed.version !== MAILBOX_VERSION) return { ok: false, failure: "rejected" };
    if (parsed.token !== token || parsed.requestId !== requestId) return { ok: false, failure: "rejected" };
    if (typeof parsed.rejected === "string") return { ok: false, failure: "rejected" };
    if (typeof parsed.approved !== "boolean") return { ok: false, failure: "rejected" };
    const comment = typeof parsed.comment === "string" ? textPrefix(parsed.comment, 2000) : undefined;
    return { ok: true, answer: comment ? { approved: parsed.approved, comment } : { approved: parsed.approved } };
  } catch {
    return { ok: false, failure: "rejected" };
  }
}

// ---------------------------------------------------------------------------
// Parent side
// ---------------------------------------------------------------------------

export interface ApprovalMailbox {
  dir: string;
  stop(): void;
}

/**
 * The one live mailbox for this process. Start is idempotent through this
 * slot: a second start (extension re-init) stops the previous poller instead
 * of leaking it alongside a new one. Process-lifetime on purpose — detached
 * children outlive `/new`, and tearing the mailbox down per-session would
 * silently flip their in-flight asks to auto-deny while the user is present.
 */
let liveMailbox: ApprovalMailbox | undefined;

/**
 * Creates and services this process's approval mailbox. Returns undefined in
 * child or headless sessions — only the nearest interactive ancestor answers,
 * which is what routes nested grandchildren to the one real user.
 *
 * `ask` is injected (index.ts passes askRailApproval) so this module never
 * value-imports the approvals layer; the dependency stays one-directional.
 */
export function startApprovalMailbox(params: {
  state: RuntimeState;
  ask: RailAsk;
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
}): ApprovalMailbox | undefined {
  const env = params.env ?? process.env;
  if (env[SUBAGENT_CHILD_ENV] === "1") return undefined;
  if (!contextHasUI(params.state)) return undefined;
  liveMailbox?.stop();

  const root = path.join(getAgentDir(), "rail-approvals");
  sweepDeadMailboxes(root);
  const dir = path.join(root, crypto.randomUUID());
  const token = crypto.randomUUID();
  try {
    fs.mkdirSync(path.join(dir, "requests"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dir, "responses"), { recursive: true, mode: 0o700 });
    writeAtomicJson(path.join(dir, "mailbox.json"), {
      type: "rail-approval-mailbox",
      version: MAILBOX_VERSION,
      pid: process.pid,
      createdAt: Date.now(),
    });
    fs.writeFileSync(path.join(dir, "heartbeat"), "", { mode: 0o600 });
  } catch {
    return undefined;
  }

  const previousEnv = env[APPROVAL_MAILBOX_ENV];
  env[APPROVAL_MAILBOX_ENV] = `${dir}#${token}`;

  let servicing = false;
  let stopped = false;
  const tick = () => {
    // The heartbeat beats even while a dialog is open — a child waiting on
    // that very dialog would otherwise read the pause as parent-gone.
    try {
      const now = new Date();
      fs.utimesSync(path.join(dir, "heartbeat"), now, now);
    } catch {
      return;
    }
    if (servicing || stopped) return;
    servicing = true;
    void serviceRequests({ dir, token, state: params.state, ask: params.ask })
      .catch(() => undefined)
      .finally(() => {
        servicing = false;
      });
  };
  const interval = setInterval(tick, params.pollMs ?? PARENT_POLL_MS);
  interval.unref?.();

  const mailbox: ApprovalMailbox = {
    dir,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      // Restore rather than delete: an inner interactive session that
      // shadowed an outer session's mailbox falls back to it.
      if (env[APPROVAL_MAILBOX_ENV] === `${dir}#${token}`) {
        if (previousEnv === undefined) delete env[APPROVAL_MAILBOX_ENV];
        else env[APPROVAL_MAILBOX_ENV] = previousEnv;
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      if (liveMailbox === mailbox) liveMailbox = undefined;
    },
  };
  liveMailbox = mailbox;
  return mailbox;
}

/** ctx getters throw once the runner invalidates a context; treat that as "no UI right now". */
function contextHasUI(state: RuntimeState): boolean {
  try {
    return state.lastUiContext?.hasUI === true;
  } catch {
    return false;
  }
}

/** Reaps sibling mailboxes whose parent died without stop() (crash, SIGKILL). */
function sweepDeadMailboxes(root: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const mtime = fs.statSync(path.join(dir, "heartbeat")).mtimeMs;
      if (now - mtime < SWEEP_STALE_MS) continue;
    } catch {
      /* no heartbeat at all: dead */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* another sweeper may race us */
    }
  }
}

interface ParsedRequest {
  requestId: string;
  childPid: number | undefined;
  toolName: string;
  from: string;
  title: string;
  message: string;
}

async function serviceRequests(params: { dir: string; token: string; state: RuntimeState; ask: RailAsk }): Promise<void> {
  const requestsDir = path.join(params.dir, "requests");
  let names: string[];
  try {
    names = fs.readdirSync(requestsDir).filter((name) => REQUEST_FILE_RE.test(name)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    await serviceOne(params, path.join(requestsDir, name), name);
  }
}

async function serviceOne(
  params: { dir: string; token: string; state: RuntimeState; ask: RailAsk },
  file: string,
  name: string,
): Promise<void> {
  const requestId = REQUEST_FILE_RE.exec(name)?.[2];
  if (!requestId) return;
  const respond = (body: Record<string, unknown>) => {
    // Response before unlink: the child reads request-gone-without-response
    // as a failure after a short grace, so this order is what keeps rejected
    // requests from looking like races.
    try {
      writeAtomicJson(path.join(params.dir, "responses", `${requestId}.json`), {
        type: "rail-approval-response",
        version: MAILBOX_VERSION,
        token: params.token,
        requestId,
        ts: Date.now(),
        ...body,
      });
    } catch {
      /* child will see parent-gone via heartbeat if we can't write at all */
    }
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
  const reject = (code: RejectedCode) => respond({ approved: false, rejected: code });

  const parsed = parseRequest(file, params.token);
  if (parsed === "unreadable") {
    // Vanished or unreadable with nothing to answer to; drop the file if it
    // still exists so requests/ only ever holds pending work.
    try {
      fs.unlinkSync(file);
    } catch {
      /* gone */
    }
    return;
  }
  if (parsed === "too-large" || parsed === "malformed" || parsed === "bad-token" || parsed === "bad-version") {
    reject(parsed);
    return;
  }

  // Dead requester: nobody is polling for an answer, so asking would only
  // stall the queue behind a moot dialog.
  if (parsed.childPid !== undefined && !pidAlive(parsed.childPid)) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* gone */
    }
    return;
  }
  // The child unlinks its request when its wait aborts; re-check before the dialog.
  if (!fs.existsSync(file)) return;

  const ctx = latestUiContext(params.state);
  if (!ctx) return; // leave pending; a fresh ctx arrives with the next event

  let cancel: (() => void) | undefined;
  let cancelled = false;
  const options: AskPresentationOptions = {
    // Background-popped dialog: the user may be mid-keystroke, and Enter
    // decides. Deny-first plus an input grace window keeps a stray Enter from
    // approving a subagent's action unseen.
    defaultDeny: true,
    inputGraceMs: 400,
    onCancelHandle: (fn) => {
      cancel = fn;
    },
  };
  // Auto-resolve the dialog if the child dies while it is open, so a moot
  // question cannot block live children queued behind it.
  const watchdog = setInterval(() => {
    const gone = (parsed.childPid !== undefined && !pidAlive(parsed.childPid)) || !fs.existsSync(file);
    if (gone) {
      cancelled = true;
      cancel?.();
    }
  }, 1000);
  watchdog.unref?.();

  let outcome: AskOutcome;
  try {
    outcome = await params.ask(ctx, params.state, parsed.title, parsed.message, options);
  } catch {
    return; // stale ctx mid-dialog; leave the request for the next tick
  } finally {
    clearInterval(watchdog);
  }
  if (cancelled) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* gone */
    }
    return;
  }
  if (outcome.kind !== "answered") return;
  respond(outcome.answer.comment ? { approved: outcome.answer.approved, comment: outcome.answer.comment } : { approved: outcome.answer.approved });
  recordForwardedAsk(params.state, { toolName: parsed.toolName, approved: outcome.answer.approved, from: parsed.from });
}

function latestUiContext(state: RuntimeState) {
  try {
    if (state.lastUiContext?.hasUI) return state.lastUiContext;
  } catch {
    /* invalidated */
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Keeps \n and \t; strips the C0/C1 controls that could redraw or spoof the dialog. */
function sanitizeForDialog(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

function parseRequest(file: string, token: string): ParsedRequest | "unreadable" | RejectedCode {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return "unreadable";
  }
  if (stat.size > MAX_REQUEST_BYTES) return "too-large";
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof value !== "object" || value === null) return "malformed";
    parsed = value as Record<string, unknown>;
  } catch {
    return "malformed";
  }
  if (parsed.type !== "rail-approval-request") return "malformed";
  if (parsed.version !== MAILBOX_VERSION) return "bad-version";
  if (parsed.token !== token) return "bad-token";
  if (typeof parsed.requestId !== "string" || typeof parsed.title !== "string" || typeof parsed.message !== "string") return "malformed";
  const subagent = (typeof parsed.subagent === "object" && parsed.subagent !== null ? parsed.subagent : {}) as Record<string, unknown>;
  const agent = typeof subagent.agent === "string" ? sanitizeForDialog(textPrefix(subagent.agent, 128)) : undefined;
  const runId = typeof subagent.runId === "string" ? sanitizeForDialog(textPrefix(subagent.runId, 128)) : undefined;
  const childPid = typeof parsed.childPid === "number" && Number.isInteger(parsed.childPid) && parsed.childPid > 0 ? parsed.childPid : undefined;
  const from = agent
    ? `subagent ${agent}${runId ? ` (run ${runId.slice(0, 8)})` : ""}`
    : `pi child${childPid ? ` (pid ${childPid})` : ""}`;
  const toolName = typeof parsed.toolName === "string" ? sanitizeForDialog(textPrefix(parsed.toolName, 128)) : "tool";
  return {
    requestId: parsed.requestId,
    childPid,
    toolName,
    from,
    title: `Rail approval — ${from}`,
    message: `From ${from}, ${toolName} in a headless child:\n\n${sanitizeForDialog(textPrefix(parsed.message, 8000))}`,
  };
}
