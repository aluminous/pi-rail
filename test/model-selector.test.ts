// The reviewer-model picker (/rail model): three tabs — namer, judge,
// configurator — switched with Tab / Shift+Tab, Enter setting a SESSION value
// for the active seat only, a `*` on every tab whose session value differs
// from the persisted one, Ctrl+S writing those seats to the global rail.json,
// Esc closing with the session values still in force. Plus the RPC
// degradation (seat select → model select → "Save persistently"). Driven
// through the structural Theme/Keybindings seams, like the disposition-page
// tests; every test that could write redirects the agent dir first.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runModelCommand } from "../src/commands/model.ts";
import type { RailConfig } from "../src/config.ts";
import { getPersistentConfigPath } from "../src/persistent-settings.ts";
import { saveReviewerSeats, seatSpec, seatUnsaved } from "../src/reviewer-seats.ts";
import { createRuntimeState, resetSessionState, type RuntimeState } from "../src/state.ts";
import { ReviewerModelPage } from "../src/tui/model-page.ts";
import { testConfig, withTempAgentDirAsync } from "./helpers.ts";

const model = (provider: string, id: string, name?: string) => ({ provider, id, name });
const sessionModel = model("anthropic", "claude-opus-4-5", "Claude Opus 4.5");
const codexMini = model("openai-codex", "gpt-5.4-mini");
const strong = model("openai", "gpt-5.4");
const haiku = model("anthropic", "claude-haiku-5-5");
const catalog = [codexMini, strong, haiku];

const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const ENTER = "<enter>";
const DOWN = "<down>";
const ESC = "<esc>";
const CTRL_S = "\x13";

const keybindings = {
  matches: (data: string, id: string) =>
    (id === "tui.input.tab" && data === TAB) ||
    (id === "tui.select.confirm" && data === ENTER) ||
    (id === "tui.select.down" && data === DOWN) ||
    (id === "tui.select.up" && data === "<up>") ||
    (id === "tui.select.cancel" && data === ESC),
};

/** Accent and warning are what the assertions read: «active» and the ‹*› unsaved marker. */
const theme = {
  fg: (name: string, text: string) => (name === "accent" ? `«${text}»` : name === "warning" ? `‹${text}›` : text),
  bold: (text: string) => text,
};

interface Fixture {
  ctx: ExtensionContext;
  state: RuntimeState;
  notes: string[];
  asked: Array<{ title: string; labels: string[] }>;
  page(): ReviewerModelPage;
  closed(): boolean;
}

function fixture(mode: "tui" | "rpc", answers: Array<string | undefined> = []): Fixture {
  const state = createRuntimeState();
  // Review on, so the namer's effective setting is its model ("auto") rather than "off".
  state.config = testConfig((c) => (c.classifier.enabled = true));
  const notes: string[] = [];
  const asked: Fixture["asked"] = [];
  let page: ReviewerModelPage | undefined;
  let closed = false;
  let next = 0;
  const ctx = {
    mode,
    hasUI: true,
    model: sessionModel,
    modelRegistry: {
      refresh: () => {},
      getAvailable: () => catalog,
      find: (provider: string, id: string) => catalog.find((entry) => entry.provider === provider && entry.id === id),
    },
    ui: {
      notify: (message: string) => void notes.push(message),
      setStatus: () => {},
      custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: undefined) => void) => unknown) =>
        new Promise<undefined>((resolve) => {
          page = factory({ terminal: { rows: 40 }, requestRender: () => {} }, theme, keybindings, (value) => {
            closed = true;
            resolve(value);
          }) as ReviewerModelPage;
        }),
      select: async (title: string, labels: string[]) => {
        asked.push({ title, labels });
        const want = answers[next++];
        return want === undefined ? undefined : labels.find((label) => label.includes(want));
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, state, notes, asked, page: () => page!, closed: () => closed };
}

async function openPage(): Promise<Fixture> {
  const fx = fixture("tui");
  await runModelCommand("", fx.ctx, fx.state);
  return fx;
}

/** Rendered lines with the accent markers kept (the tab line asserts on them). */
const raw = (page: ReviewerModelPage) => page.render(200).map((line) => line.trim());
/** Rendered lines as text: the cursor and accent markers stripped. */
const lines = (page: ReviewerModelPage) => raw(page).map((line) => line.replace(/[«»]/g, "").replace(/^→ /, ""));
const checked = (page: ReviewerModelPage) => lines(page).find((line) => line.endsWith("✓"));

function readPersisted(): RailConfig {
  return JSON.parse(readFileSync(getPersistentConfigPath(), "utf8")) as RailConfig;
}

describe("reviewer model page tabs", () => {
  it("opens on the namer tab with auto, current, off, and the models, the effective setting checked and highlighted", async () => {
    const fx = await openPage();
    const page = fx.page();
    assert.equal(page.activeSeat(), "namer");
    const rendered = lines(page);
    assert.ok(raw(page).includes("Tab: «namer» | judge | configurator"));
    assert.ok(raw(page).some((line) => line.startsWith("«→ »«auto (openai-codex/gpt-5.4-mini)»") && line.endsWith("✓")), "auto shows what it resolves to and starts selected");
    assert.ok(rendered.includes("current (anthropic/claude-opus-4-5)"));
    assert.ok(rendered.includes("off"));
    assert.ok(rendered.includes("gpt-5.4 [openai]"), "model rows read like pi's chooser: id, then the provider badge");
    assert.equal(page.selectedValue(), "auto");
  });

  it("cycles namer → judge → configurator on Tab and back on Shift+Tab, each with its own rows", async () => {
    const page = (await openPage()).page();
    page.handleInput(TAB);
    assert.equal(page.activeSeat(), "judge");
    const judge = lines(page);
    assert.ok(raw(page).includes("Tab: namer | «judge» | configurator"));
    assert.ok(!judge.some((line) => line.startsWith("auto") || line === "off"), "the judge has neither auto nor off");
    assert.match(checked(page) ?? "", /current \(anthropic\/claude-opus-4-5\)/, "the judge defaults to current");

    page.handleInput(TAB);
    assert.equal(page.activeSeat(), "configurator");
    const configurator = lines(page);
    assert.ok(configurator.some((line) => line.includes("auto (anthropic/claude-haiku-5-5)")), "the configurator's auto is its own list");
    assert.ok(!configurator.includes("off"));

    page.handleInput(SHIFT_TAB);
    assert.equal(page.activeSeat(), "judge");
    page.handleInput(TAB);
    page.handleInput(TAB);
    assert.equal(page.activeSeat(), "namer", "Tab wraps around");
  });

  it("filters by typing and drops the query on a tab change", async () => {
    const page = (await openPage()).page();
    for (const char of "haiku") page.handleInput(char);
    assert.equal(page.selectedValue(), "anthropic/claude-haiku-5-5");
    assert.ok(!lines(page).includes("off"));
    page.handleInput(TAB);
    page.handleInput(SHIFT_TAB);
    assert.ok(lines(page).includes("off"), "the namer list is whole again");
    assert.equal(page.selectedValue(), "auto", "and the highlight is back on the effective setting");
  });
});

describe("reviewer model page session edits", () => {
  it("Enter sets the active seat for this session only, marks its tab, and writes nothing", async () => {
    await withTempAgentDirAsync(async () => {
      const fx = await openPage();
      const page = fx.page();
      page.handleInput(TAB);
      for (const char of "gpt-5.4 openai") page.handleInput(char);
      assert.equal(page.selectedValue(), "openai/gpt-5.4");
      page.handleInput(ENTER);

      assert.equal(fx.closed(), false, "the page stays open for the next seat");
      assert.equal(fx.state.classifier.judgeModelOverride, "openai/gpt-5.4");
      assert.equal(fx.state.classifier.modelOverride, undefined, "the namer is untouched");
      assert.ok(raw(page).includes("Tab: namer | «judge»‹*› | configurator"));
      assert.ok(lines(page).some((line) => line.includes("(this session; saved: current)")));
      assert.match(checked(page) ?? "", /gpt-5\.4 \[openai\]/);
      assert.equal(existsSync(getPersistentConfigPath()), false, "nothing reaches disk before a save");
    });
  });

  it("the namer's off disables review for the session and is marked; a model pick turns it back on", async () => {
    const fx = await openPage();
    const page = fx.page();
    for (const char of "off") page.handleInput(char);
    page.handleInput(ENTER);
    assert.equal(fx.state.classifier.enabledOverride, false);
    assert.equal(seatSpec(fx.state.config!, fx.state.classifier, "namer"), "off");
    assert.equal(seatUnsaved(fx.state.config!, fx.state.classifier, "namer"), true);
    assert.ok(raw(page).some((line) => line.startsWith("Tab: «namer»‹*›")));

    for (const _ of "off") page.handleInput("\x7f");
    for (const char of "mini") page.handleInput(char);
    page.handleInput(ENTER);
    assert.equal(fx.state.classifier.enabledOverride, true);
    assert.equal(fx.state.classifier.modelOverride, "openai-codex/gpt-5.4-mini");
    assert.ok(raw(page).some((line) => line.startsWith("Tab: «namer»‹*›")));
  });

  it("Ctrl+S saves every marked seat to the global config, says what changed, and clears the marks", async () => {
    await withTempAgentDirAsync(async () => {
      const fx = await openPage();
      const page = fx.page();
      for (const char of "current") page.handleInput(char);
      page.handleInput(ENTER);
      page.handleInput(TAB);
      page.handleInput(TAB);
      for (const char of "gpt-5.4 openai") page.handleInput(char);
      page.handleInput(ENTER);
      page.handleInput(CTRL_S);

      const persisted = readPersisted().classifier;
      assert.deepEqual(persisted, { enabled: true, model: "current", grantModel: "openai/gpt-5.4" }, "the judge was never changed, so it is not written");
      assert.match(fx.notes.at(-1)!, /Reviewer models saved to .*rail\.json: namer: auto → current; configurator: auto → openai\/gpt-5\.4\./);
      assert.ok(raw(page).includes("Tab: namer | judge | «configurator»"), "no tab is marked after the save");
      assert.equal(fx.state.config!.classifier.grantModel, "openai/gpt-5.4", "the in-memory base follows the file");

      page.handleInput(CTRL_S);
      assert.equal(fx.notes.at(-1), "No unsaved reviewer model changes.");
    });
  });

  it("Esc closes and leaves the session values in force; a new session resets them", async () => {
    const fx = await openPage();
    const page = fx.page();
    page.handleInput(TAB);
    page.handleInput(DOWN);
    page.handleInput(ENTER);
    page.handleInput(ESC);
    assert.equal(fx.closed(), true);
    assert.equal(fx.state.classifier.judgeModelOverride, "openai-codex/gpt-5.4-mini");
    resetSessionState(fx.state);
    assert.equal(fx.state.classifier.judgeModelOverride, undefined, "models are settings of this session, not policy that carries over");
  });

  it("toggles shut when /rail model runs again while it is open", async () => {
    const fx = await openPage();
    await runModelCommand("", fx.ctx, fx.state);
    assert.equal(fx.closed(), true);
  });
});

describe("/rail model over RPC", () => {
  it("picks a seat, then its model, then saves persistently from the seat list", async () => {
    await withTempAgentDirAsync(async () => {
      const fx = fixture("rpc", ["configurator:", "openai/gpt-5.4", "Save persistently", undefined]);
      await runModelCommand("", fx.ctx, fx.state);

      assert.equal(fx.asked.length, 4);
      assert.ok(fx.asked[0]!.labels.some((label) => label.startsWith("judge: current →")));
      assert.equal(fx.asked[0]!.labels.at(-1), "Save persistently");
      assert.ok(fx.asked[1]!.labels.includes("openai/gpt-5.4"), "model rows are labelled provider/id over the wire");
      assert.ok(!fx.asked[1]!.labels.includes("off"), "the configurator has nothing to turn off");
      assert.ok(fx.asked[2]!.labels.some((label) => label.startsWith("configurator: openai/gpt-5.4") && label.endsWith("(unsaved)")));
      assert.equal(readPersisted().classifier?.grantModel, "openai/gpt-5.4");
      assert.ok(!fx.asked[3]!.labels.some((label) => label.endsWith("(unsaved)")), "the save cleared the tag");
    });
  });

  it("tags the current choice since check marks are TUI-only", async () => {
    const fx = fixture("rpc", ["judge:", undefined, undefined]);
    await runModelCommand("", fx.ctx, fx.state);
    assert.ok(fx.asked[1]!.labels.some((label) => label.startsWith("current (anthropic/claude-opus-4-5) (current)")));
  });

  it("cancels without changing anything", async () => {
    const fx = fixture("rpc", [undefined]);
    await runModelCommand("", fx.ctx, fx.state);
    assert.equal(fx.asked.length, 1);
    assert.deepEqual(fx.state.classifier, {});
  });
});

describe("saveReviewerSeats", () => {
  it("writes only the seats that differ, and nothing when none do", () => {
    const state = createRuntimeState();
    state.config = testConfig((c) => (c.classifier.enabled = true));
    const writes: object[] = [];
    assert.deepEqual(saveReviewerSeats(state, (update) => void writes.push(update)).changes, []);
    assert.equal(writes.length, 0);

    state.classifier.judgeModelOverride = "current"; // same as the config: not a change
    state.classifier.enabledOverride = false;
    const result = saveReviewerSeats(state, (update) => void writes.push(update));
    assert.deepEqual(result.changes, ["namer: auto → off"]);
    assert.deepEqual(writes, [{ enabled: false }], "off keeps the file's model so switching back on restores it");
    assert.equal(state.config!.classifier.enabled, false);
  });
});
