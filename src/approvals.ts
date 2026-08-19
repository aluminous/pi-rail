import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { forwardAskToParent, type ForwardedAskMeta, type ForwardFailure } from "./approval-mailbox.ts";
import type { RuntimeState } from "./state.ts";
import { RailApprovalDialog, type RailApprovalAnswer } from "./tui/approval-dialog.ts";
import { textPrefix } from "./util.ts";

export type { RailApprovalAnswer } from "./tui/approval-dialog.ts";

const OPTION_LABELS = ["Allow", "Allow with comment", "Deny", "Deny with comment"] as const;

/** How the dialog is presented; set by the mailbox servicer for background-popped dialogs. */
export interface AskPresentationOptions {
  defaultDeny?: boolean;
  inputGraceMs?: number;
  onCancelHandle?: (cancel: () => void) => void;
}

export interface AskOptions extends AskPresentationOptions {
  /** When set, a headless session forwards the ask to the parent mailbox instead of failing. */
  forwardMeta?: ForwardedAskMeta;
  /** Aborts a forwarded wait (the child's turn signal). */
  signal?: AbortSignal;
}

/**
 * Every way an ask can end. Call sites branch once on `kind` and keep exactly
 * the deny path they already had for headless sessions — "no UI and no
 * mailbox" and "the forward failed" are the same branch with different
 * `detail` text, so there is no predicate to keep in sync with a later
 * runtime failure.
 */
export type AskOutcome =
  | { kind: "answered"; answer: RailApprovalAnswer; forwarded: boolean }
  | { kind: "unanswerable"; detail: string };

/** The ask entry point's shape, for injection (the mailbox servicer takes one). */
export type RailAsk = typeof askRailApproval;

/**
 * Serializes dialogs per session state: the parent's own asks and the mailbox
 * servicer's forwarded asks share one queue, so two non-overlay customs never
 * fight over the editor area. Lives on RuntimeState (not module scope) so a
 * session reset or a test fixture starts with a clean queue.
 */
async function withDialogLock<T>(state: RuntimeState, fn: () => Promise<T>): Promise<T> {
  const run = state.dialogQueue.then(fn, fn);
  state.dialogQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Wires pi's shared extension bus into the ask path, so pane managers (herdr's
 * integration listens for `herdr:blocked`) can show "blocked" instead of
 * "working" while a rail dialog waits on the user. index.ts calls this once,
 * next to the appendEntry wiring; tests pass a recording fake. The emit is
 * wrapped here, at the seam, so a throwing bus can never leak into an ask —
 * and a swallowed `active` throw is safe because the paired `inactive` throw
 * is swallowed identically, keeping the listener's refcount balanced.
 */
export function wireBlockedSignal(state: RuntimeState, events: Pick<EventBus, "emit">): void {
  state.emitBlocked = (payload) => {
    try {
      events.emit("herdr:blocked", payload);
    } catch {
      /* a broken bus must not break approvals */
    }
  };
}

/**
 * One line for a pane manager's blocked indicator. The tool under review is
 * the most useful thing to show and forwardMeta carries it for free; the
 * title (already short, and for mailbox-serviced asks it names the asking
 * subagent) covers the rest. Whitespace collapsed: the contract is one line.
 */
function blockedLabel(title: string, options: AskOptions): string {
  const base = options.forwardMeta ? `Rail approval: ${options.forwardMeta.toolName}` : title;
  return textPrefix(base.replace(/\s+/g, " ").trim(), 80);
}

/**
 * Brackets a user-facing ask with the blocked signal. The listener refcounts
 * active/inactive pairs, so pairing must be exact on every path: one `active`
 * as the wait begins — queue time included, a dialog queued behind another is
 * already blocking on the user, and overlapping refcounts keep the blocked
 * state continuous across a queue — and one `inactive` on ANY exit, answer or
 * throw. The single try/finally is what guarantees never-unpaired.
 */
async function withBlockedSignal<T>(state: RuntimeState, label: string, fn: () => Promise<T>): Promise<T> {
  if (!state.emitBlocked) return fn();
  state.emitBlocked({ active: true, label });
  try {
    return await fn();
  } finally {
    state.emitBlocked({ active: false });
  }
}

function describeForwardFailure(failure: Exclude<ForwardFailure, "no-mailbox">): string {
  if (failure === "parent-gone") return "the ask was forwarded to the parent session, but that session went away";
  if (failure === "cancelled") return "the forwarded ask was cancelled before the user answered";
  return "the parent session rejected the forwarded ask";
}

/**
 * Asks the user to approve a rail-gated action, with optional comment.
 *
 * Interactive sessions get the TUI dialog (or, over RPC, a select plus an
 * input answered via the extension-UI sub-protocol). Headless sessions with
 * `forwardMeta` forward the ask to the parent session's approval mailbox and
 * block until the user there answers. Anything else is `unanswerable`, and
 * the caller renders its usual headless deny with the detail woven in.
 */
export async function askRailApproval(
  ctx: ExtensionContext,
  state: RuntimeState,
  title: string,
  message: string,
  options: AskOptions = {},
): Promise<AskOutcome> {
  if (ctx.hasUI) {
    // The blocked signal lives here, on the presenting side only — one seam
    // covering the TUI dialog, the RPC select fallback, and forwarded subagent
    // asks (the mailbox servicer re-enters through this same entry point). The
    // forwarding child below never signals: its user sits at the parent.
    const answer = await withBlockedSignal(state, blockedLabel(title, options), () =>
      withDialogLock(state, () => presentDialog(ctx, state, title, message, options)),
    );
    return { kind: "answered", answer, forwarded: false };
  }
  if (options.forwardMeta) {
    const result = await forwardAskToParent({ title, message, meta: options.forwardMeta, signal: options.signal });
    if (result.ok) return { kind: "answered", answer: result.answer, forwarded: true };
    if (result.failure !== "no-mailbox") return { kind: "unanswerable", detail: describeForwardFailure(result.failure) };
  }
  return { kind: "unanswerable", detail: "this headless session has no user to ask" };
}

async function presentDialog(
  ctx: ExtensionContext,
  state: RuntimeState,
  title: string,
  message: string,
  options: AskPresentationOptions,
): Promise<RailApprovalAnswer> {
  if (ctx.mode === "tui") {
    // The status/policy panel and this dialog share the editor area; close the
    // panel first so the two non-overlay customs never fight over it.
    state.liveView?.close();
    const answer = await ctx.ui.custom<RailApprovalAnswer | undefined>(
      (_tui, theme, keybindings, done) =>
        new RailApprovalDialog({
          title,
          message,
          theme,
          keybindings,
          done,
          defaultDeny: options.defaultDeny,
          inputGraceMs: options.inputGraceMs,
          onCancelHandle: options.onCancelHandle,
        }),
    );
    return answer ?? { approved: false };
  }
  // RPC clients answer per-request by id, and get no cancel handle: a
  // forwarded ask serviced by an RPC parent stays open until answered.
  const picked = await ctx.ui.select(`${title}\n\n${message}`, [...OPTION_LABELS]);
  // A dismissed select is the RPC form of Escape: stop the turn, don't deny.
  if (picked === undefined) return { approved: false, cancelled: true };
  if (picked === "Allow") return { approved: true };
  if (picked === "Allow with comment" || picked === "Deny with comment") {
    const comment = (await ctx.ui.input("Comment for the rail (kept as session guidance)"))?.trim();
    return { approved: picked === "Allow with comment", comment: comment || undefined };
  }
  return { approved: false };
}
