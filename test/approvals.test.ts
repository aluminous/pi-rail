import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askRailApproval, wireBlockedSignal } from "../src/approvals.ts";
import { addSessionGuidance, type ClassifierState } from "../src/classifier.ts";
import { createRuntimeState, type RuntimeState } from "../src/state.ts";
import { RailApprovalDialog, type RailApprovalAnswer } from "../src/tui/approval-dialog.ts";

const theme = { fg: (_name: string, text: string) => text };

/** Maps sentinel strings to select keybinding ids so tests can drive the dialog. */
const keybindings = {
  matches(keyData: string, keyId: string): boolean {
    return (
      (keyId === "tui.select.up" && keyData === "<up>") ||
      (keyId === "tui.select.down" && keyData === "<down>") ||
      (keyId === "tui.select.confirm" && keyData === "<enter>") ||
      (keyId === "tui.select.cancel" && keyData === "<esc>")
    );
  },
};

function openDialog(): { dialog: RailApprovalDialog; answers: RailApprovalAnswer[] } {
  const answers: RailApprovalAnswer[] = [];
  const dialog = new RailApprovalDialog({
    title: "Rail reviewer asks for approval",
    message: "Deploy to staging?",
    theme,
    keybindings,
    done: (answer) => answers.push(answer),
  });
  dialog.focused = true;
  return { dialog, answers };
}

describe("RailApprovalDialog", () => {
  it("resolves plain allow and deny without a comment", () => {
    const allow = openDialog();
    allow.dialog.handleInput("<enter>");
    assert.deepEqual(allow.answers, [{ approved: true }]);

    const deny = openDialog();
    deny.dialog.handleInput("<down>");
    deny.dialog.handleInput("<enter>");
    assert.deepEqual(deny.answers, [{ approved: false }]);
  });

  it("escape cancels the ask (a stop-the-turn signal), it does not deny", () => {
    const { dialog, answers } = openDialog();
    dialog.handleInput("<esc>");
    assert.deepEqual(answers, [{ approved: false, cancelled: true }]);
  });

  it("typed text becomes the comment for the highlighted option", () => {
    const { dialog, answers } = openDialog();
    for (const ch of "staging is fine") dialog.handleInput(ch);
    assert.equal(answers.length, 0);
    dialog.handleInput("<enter>");
    assert.deepEqual(answers, [{ approved: true, comment: "staging is fine" }]);
  });

  it("renders the comment inline on the highlighted option row", () => {
    const { dialog } = openDialog();
    for (const ch of "ok") dialog.handleInput(ch);
    const lines = dialog.render(80);
    assert.equal(lines.some((line) => line.includes("→ Allow — ok")), true);
  });

  it("arrowing between options keeps the shared comment", () => {
    const { dialog, answers } = openDialog();
    for (const ch of "not today") dialog.handleInput(ch);
    dialog.handleInput("<down>");
    dialog.handleInput("<up>");
    dialog.handleInput("<down>");
    dialog.handleInput("<enter>");
    assert.deepEqual(answers, [{ approved: false, comment: "not today" }]);
  });

  it("omits empty and whitespace-only comments", () => {
    const empty = openDialog();
    empty.dialog.handleInput("<enter>");
    assert.deepEqual(empty.answers, [{ approved: true }]);

    const whitespace = openDialog();
    for (const ch of "   ") whitespace.dialog.handleInput(ch);
    whitespace.dialog.handleInput("<enter>");
    assert.deepEqual(whitespace.answers, [{ approved: true }]);
  });

  it("backspace edits the inline comment", () => {
    const { dialog, answers } = openDialog();
    for (const ch of "okay") dialog.handleInput(ch);
    dialog.handleInput("\x7f");
    dialog.handleInput("\x7f");
    dialog.handleInput("<enter>");
    assert.deepEqual(answers, [{ approved: true, comment: "ok" }]);
  });
});

// The herdr:blocked contract is refcounted on the listener side (active += 1,
// inactive -= 1), so what these tests defend is exact pairing: one active when
// an ask starts blocking on the user, one inactive on any exit, never more —
// an unpaired emit wedges or flickers the pane state for the whole session.
describe("askRailApproval blocked signal", () => {
  type BlockedPayload = { active: boolean; label?: string };

  /** Fake shared bus: records herdr:blocked payloads in emission order. */
  function fakeBus() {
    const emissions: BlockedPayload[] = [];
    return {
      emissions,
      emit(channel: string, data: unknown) {
        assert.equal(channel, "herdr:blocked");
        emissions.push(data as BlockedPayload);
      },
    };
  }

  function signalState(): { state: RuntimeState; emissions: BlockedPayload[] } {
    const state = createRuntimeState();
    const bus = fakeBus();
    wireBlockedSignal(state, bus);
    return { state, emissions: bus.emissions };
  }

  /** TUI ctx whose dialog resolves through `custom`; tests script or defer it. */
  function tuiCtx(custom: () => Promise<RailApprovalAnswer | undefined>): ExtensionContext {
    return { hasUI: true, mode: "tui", ui: { custom } } as unknown as ExtensionContext;
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("pairs active/inactive around an approved TUI ask, labelled by the reviewed tool", async () => {
    const { state, emissions } = signalState();
    const ctx = tuiCtx(async () => ({ approved: true }));
    const outcome = await askRailApproval(ctx, state, "Rail asks for approval", "Allow?", {
      forwardMeta: { toolName: "bash", site: "capability" },
    });
    assert.equal(outcome.kind, "answered");
    assert.deepEqual(emissions, [{ active: true, label: "Rail approval: bash" }, { active: false }]);
  });

  it("pairs on deny and on cancel (dialog dismissed without an answer)", async () => {
    const deny = signalState();
    await askRailApproval(tuiCtx(async () => ({ approved: false })), deny.state, "Rail asks for approval", "Allow?");
    assert.deepEqual(deny.emissions, [{ active: true, label: "Rail asks for approval" }, { active: false }]);

    const cancel = signalState();
    const outcome = await askRailApproval(tuiCtx(async () => undefined), cancel.state, "Rail asks for approval", "Allow?");
    assert.deepEqual(outcome, { kind: "answered", answer: { approved: false }, forwarded: false });
    assert.deepEqual(cancel.emissions, [{ active: true, label: "Rail asks for approval" }, { active: false }]);
  });

  it("pairs on the RPC select fallback surface", async () => {
    const { state, emissions } = signalState();
    const ctx = {
      hasUI: true,
      mode: "rpc",
      ui: { select: async () => "Allow", input: async () => undefined },
    } as unknown as ExtensionContext;
    const outcome = await askRailApproval(ctx, state, "Rail path approval", "Approve?", {
      forwardMeta: { toolName: "write", site: "path", access: "write", path: "/etc/out" },
    });
    assert.deepEqual(outcome, { kind: "answered", answer: { approved: true }, forwarded: false });
    assert.deepEqual(emissions, [{ active: true, label: "Rail approval: write" }, { active: false }]);
  });

  it("still emits inactive when the ask throws", async () => {
    const { state, emissions } = signalState();
    const ctx = tuiCtx(async () => {
      throw new Error("stale ctx");
    });
    await assert.rejects(() => askRailApproval(ctx, state, "Rail asks for approval", "Allow?"), /stale ctx/);
    assert.deepEqual(emissions, [{ active: true, label: "Rail asks for approval" }, { active: false }]);
  });

  it("keeps refcount overlap, balance, and order for asks queued behind each other", async () => {
    const { state, emissions } = signalState();
    const gates = [deferred<RailApprovalAnswer | undefined>(), deferred<RailApprovalAnswer | undefined>()];
    let dialogsShown = 0;
    const ctx = tuiCtx(() => gates[dialogsShown++]!.promise);

    const first = askRailApproval(ctx, state, "Rail asks for approval", "first?", {
      forwardMeta: { toolName: "bash", site: "capability" },
    });
    const second = askRailApproval(ctx, state, "Rail asks for approval", "second?", {
      forwardMeta: { toolName: "write", site: "capability" },
    });
    // Both asks are blocking on the user already — the queued one signals too,
    // so the blocked state stays continuous across the dialog handoff.
    assert.deepEqual(emissions, [
      { active: true, label: "Rail approval: bash" },
      { active: true, label: "Rail approval: write" },
    ]);
    // The dialog itself opens on a microtask; flush before asserting only one is up.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dialogsShown, 1);

    gates[0]!.resolve({ approved: true });
    await first;
    gates[1]!.resolve({ approved: false });
    await second;

    assert.deepEqual(emissions.slice(2), [{ active: false }, { active: false }]);
    // Never-negative depth, and everything released: the refcount invariant.
    let depth = 0;
    for (const emission of emissions) {
      depth += emission.active ? 1 : -1;
      assert.equal(depth >= 0, true);
    }
    assert.equal(depth, 0);
  });

  it("collapses the label to one line", async () => {
    const { state, emissions } = signalState();
    await askRailApproval(tuiCtx(async () => ({ approved: true })), state, "Rail approval —\n subagent   researcher", "Allow?");
    assert.equal(emissions[0]!.label, "Rail approval — subagent researcher");
  });

  it("survives a throwing bus without leaking into the ask", async () => {
    const state = createRuntimeState();
    wireBlockedSignal(state, {
      emit() {
        throw new Error("bus down");
      },
    });
    const outcome = await askRailApproval(tuiCtx(async () => ({ approved: true })), state, "Rail asks for approval", "Allow?");
    assert.deepEqual(outcome, { kind: "answered", answer: { approved: true }, forwarded: false });
  });

  it("does not signal from headless sessions (their user sits at the parent)", async () => {
    const { state, emissions } = signalState();
    const ctx = { hasUI: false, mode: "print", ui: {} } as unknown as ExtensionContext;
    const outcome = await askRailApproval(ctx, state, "Rail asks for approval", "Allow?");
    assert.equal(outcome.kind, "unanswerable");
    assert.deepEqual(emissions, []);
  });
});

describe("addSessionGuidance", () => {
  it("formats entries and keeps only the most recent ones", () => {
    const state: ClassifierState = {};
    addSessionGuidance(state, "allowed", "bash", "npm run deploy", "staging deploys are fine");
    assert.equal(state.sessionGuidance?.length, 1);
    assert.match(state.sessionGuidance![0]!, /^User allowed bash \(npm run deploy\) with comment: staging deploys are fine$/);

    for (let i = 0; i < 20; i++) addSessionGuidance(state, "denied", "write", `file-${i}`, `no ${i}`);
    assert.equal(state.sessionGuidance?.length, 12);
    assert.match(state.sessionGuidance!.at(-1)!, /no 19/);
  });
});
