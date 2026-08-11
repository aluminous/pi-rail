import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRuntimeState, recordJudgement, recordModelCall, type RuntimeState } from "../src/state.ts";
import { PLAIN_THEME, type StatusTab } from "../src/status-tabs.ts";
import { StatusPage } from "../src/tui/status-page.ts";
import { testConfig } from "./helpers.ts";

/** Tags every styled segment so assertions can see which colour a segment got. */
const theme = {
  fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
  bold: (text: string) => text,
};

const tui = { terminal: { rows: 40 }, requestRender: () => {} };

const keybindings = {
  matches(keyData: string, keyId: string): boolean {
    return (
      (keyId === "tui.select.up" && keyData === "<up>") ||
      (keyId === "tui.select.down" && keyData === "<down>") ||
      (keyId === "tui.select.cancel" && keyData === "<esc>") ||
      (keyId === "tui.input.tab" && keyData === "\t")
    );
  },
};

const TAB = "\t";
const LEFT = "\x1b[D";

function openPage(state: RuntimeState = createRuntimeState(), initialTab?: StatusTab) {
  const closes: undefined[] = [];
  const widths: number[] = [];
  const config = testConfig();
  const page = new StatusPage({
    tui,
    theme,
    keybindings,
    initialTab,
    view: (width, pageTheme) => {
      widths.push(width);
      return { state, config, classifierLabel: "auto (test/fake-model)", theme: pageTheme, width };
    },
    done: (value) => closes.push(value),
  });
  page.focused = true;
  const text = (width = 120) => page.render(width).join("\n");
  return { page, text, closes, widths, state };
}

describe("StatusPage tabs", () => {
  it("opens on session and names every tab in the header", () => {
    const { page, text } = openPage();
    assert.equal(page.activeTab(), "session");
    assert.match(text(), /<muted>Tab:<\/muted> <accent>session<\/accent><muted> \| <\/muted><muted>models<\/muted>/);
    for (const name of ["namer", "judge", "engine", "policy"]) assert.match(text(), new RegExp(`<muted>${name}</muted>`));
  });

  it("cycles forward with Tab and wraps around", () => {
    const { page } = openPage();
    const seen = [page.activeTab()];
    for (let i = 0; i < 6; i++) {
      page.handleInput(TAB);
      seen.push(page.activeTab());
    }
    assert.deepEqual(seen, ["session", "models", "namer", "judge", "engine", "policy", "session"]);
  });

  it("steps back with left", () => {
    const { page } = openPage();
    page.handleInput(LEFT);
    assert.equal(page.activeTab(), "policy");
  });

  it("shows the active tab's own content", () => {
    const state = createRuntimeState();
    recordModelCall(state, { role: "namer", model: "openrouter/haiku", latencyMs: 400, usage: { input: 1200, output: 40, costUsd: 0.0012 } });
    recordJudgement(state, { at: Date.now(), toolName: "bash", target: "", labels: ["credentials"], verdict: "deny", reason: "credential exfiltration", latencyMs: 900, inputTokens: 10, outputTokens: 2 });
    const { page, text } = openPage(state);
    assert.match(text(), /Decisions/, "session tab");
    assert.doesNotMatch(text(), /openrouter\/haiku/);

    page.handleInput(TAB);
    assert.match(text(), /openrouter\/haiku/, "models tab");
    assert.match(text(), /avg ms/);

    page.handleInput(TAB);
    assert.match(text(), /Recent classifications/, "namer tab");

    page.handleInput(TAB);
    assert.match(text(), /credential exfiltration/, "judge tab");

    page.handleInput(TAB);
    assert.match(text(), /Restriction layers/, "engine tab");

    page.handleInput(TAB);
    assert.match(text(), /─ Filesystem/, "policy tab");
  });

  it("opens directly on a tab when asked, and retargets from outside", () => {
    const { page, text } = openPage(createRuntimeState(), "policy");
    assert.equal(page.activeTab(), "policy");
    assert.match(text(), /─ Filesystem/);
    page.selectTab("models");
    assert.equal(page.activeTab(), "models");
    assert.match(text(), /no reviewer calls yet/);
  });

  it("fits its tables to the width it is rendered at", () => {
    const state = createRuntimeState();
    recordModelCall(state, { role: "namer", model: "openrouter/anthropic/claude-haiku-4.5", latencyMs: 400, usage: { input: 1200, output: 40, costUsd: 0.0012 } });
    const config = testConfig();
    const widths: number[] = [];
    const page = new StatusPage({
      tui,
      theme: PLAIN_THEME,
      keybindings,
      initialTab: "models",
      view: (width, pageTheme) => {
        widths.push(width);
        return { state, config, classifierLabel: "classifier off", theme: pageTheme, width };
      },
      done: () => {},
    });
    const wide = page.render(200);
    const narrow = page.render(60);
    assert.deepEqual(widths, [200, 60], "the view is re-read at the real render width");
    assert.ok(wide.join("\n").includes("openrouter/anthropic/claude-haiku-4.5"));
    assert.ok(narrow.join("\n").includes("…"), "a 60-column models table has to truncate");
    assert.ok(narrow.every((entry) => entry.length <= 60), "no content line overflows the render width");
    page.dispose();
  });
});

describe("StatusPage scrolling and closing", () => {
  it("scrolls the active tab and reports the window in the footer", () => {
    const { page, text } = openPage(createRuntimeState(), "policy");
    const before = text();
    assert.match(before, /1-27\/\d+ · ↑↓ scroll/);
    page.handleInput("<down>");
    const after = text();
    assert.notEqual(after, before, "down scrolls the tab");
    assert.match(after, /2-28\/\d+/);
    page.handleInput("<up>");
    assert.equal(text(), before, "and up scrolls back");
  });

  it("resets the scroll when the tab changes", () => {
    const { page, text } = openPage(createRuntimeState(), "policy");
    page.handleInput("<down>");
    page.handleInput("<down>");
    page.handleInput(TAB);
    page.handleInput(LEFT);
    assert.match(text(), /1-27\//, "back on policy at the top");
  });

  it("closes on Esc", () => {
    const { page, closes } = openPage();
    page.handleInput("<esc>");
    assert.deepEqual(closes, [undefined]);
    page.dispose();
  });

  it("renders through a plain theme without ANSI when asked to", () => {
    const config = testConfig();
    const state = createRuntimeState();
    const page = new StatusPage({
      tui,
      theme: PLAIN_THEME,
      keybindings,
      view: (width, pageTheme) => ({ state, config, classifierLabel: "classifier off", theme: pageTheme, width }),
      done: () => {},
    });
    assert.doesNotMatch(page.render(100).join("\n"), /</);
    page.dispose();
  });
});
