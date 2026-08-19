import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addSessionGuidance, type ClassifierState } from "../src/classifier.ts";
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
