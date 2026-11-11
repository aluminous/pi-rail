import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordCapabilityHits, recordCapabilityOutcome, type CapabilityId, type Disposition } from "../src/capabilities.ts";
import { globalRailConfigPath, mergeConfig, type ResolvedRailConfig } from "../src/config.ts";
import {
  addClass,
  cycleDisposition,
  deleteClass,
  describeDispositionSource,
  dispositionRow,
  dispositionRows,
  dispositionSummary,
  editClassDefinition,
  hasUnsavedChanges,
  presetBanner,
  saveDispositions,
  setRowDisposition,
  type DispositionPersistence,
} from "../src/dispositions.ts";
import type { PersistedCapabilityClass } from "../src/persistent-settings.ts";
import { sessionAddedClasses, sessionDispositionEdits } from "../src/session-policy.ts";
import { createRuntimeState, syncCapabilityPreset, type RuntimeState } from "../src/state.ts";
import { DispositionPage } from "../src/tui/disposition-page.ts";
import { testConfig } from "./helpers.ts";

/** Tags every styled segment so assertions can see which colour a row segment got. */
const theme = {
  fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
  bold: (text: string) => text,
};

const tui = { terminal: { rows: 40 }, requestRender: () => {} };

/** Sentinel strings for the select keybinding ids; arrows and ctrl+s go through the real matchesKey. */
const keybindings = {
  matches(keyData: string, keyId: string): boolean {
    return (
      (keyId === "tui.select.up" && keyData === "<up>") ||
      (keyId === "tui.select.down" && keyData === "<down>") ||
      (keyId === "tui.select.confirm" && keyData === "<enter>") ||
      (keyId === "tui.select.cancel" && keyData === "<esc>") ||
      (keyId === "tui.input.tab" && keyData === "\t")
    );
  },
};

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const CTRL_S = "\x13";
const TAB = "\t";

/**
 * Persistence spy in the shape saveDispositions writes through. Disposition
 * rows land in the array the caller owns; class writes are recorded separately
 * so tests can assert on either without one drowning the other.
 */
function spyPersistence(rows: Array<[CapabilityId, Disposition | undefined]>) {
  const classes: Array<[string, PersistedCapabilityClass | undefined]> = [];
  const definitions: Array<[string, string | undefined]> = [];
  const persistence: DispositionPersistence & {
    classes: typeof classes;
    definitions: typeof definitions;
  } = {
    disposition: (id, disposition) => void rows.push([id, disposition]),
    capabilityClass: (id, entry) => void classes.push([id, entry]),
    capabilityDefinition: (id, definition) => void definitions.push([id, definition]),
    baseOps: (ops) => assert.fail(`unexpected base-op write: ${JSON.stringify(ops)}`),
    classes,
    definitions,
  };
  return persistence;
}

function openPage(state: RuntimeState, config: ResolvedRailConfig) {
  const persisted: Array<[CapabilityId, Disposition | undefined]> = [];
  const closes: undefined[] = [];
  const notes: Array<{ message: string; level?: string }> = [];
  const page = new DispositionPage({
    tui,
    theme,
    keybindings,
    rows: () => dispositionRows(config, state),
    cycle: (id, step) => setRowDisposition(config, state, id, cycleDisposition(dispositionRow(config, state, id).value, step)),
    save: () => void saveDispositions(config, state, spyPersistence(persisted)),
    banner: () => presetBanner(state),
    addClass: (input) => addClass(config, state, input),
    editDefinition: (id, definition) => editClassDefinition(config, state, id, definition),
    deleteClass: (id) => deleteClass(state, id),
    notify: (message, level) => void notes.push({ message, level }),
    done: (value) => closes.push(value),
  });
  page.focused = true;
  const line = (id: string) => page.render(200).find((text) => text.includes(id)) ?? "";
  const text = () => page.render(200).join("\n");
  return { page, persisted, closes, line, notes, text };
}

/** Types a string into whichever form field is focused, one key at a time. */
function type(page: DispositionPage, value: string): void {
  for (const char of value) page.handleInput(char);
}

describe("disposition rows", () => {
  it("resolves value, persisted, and modified against the config", () => {
    const config = mergeConfig(testConfig(), { dispositions: { "install-dependencies": "ask" } }, globalRailConfigPath());
    const state = createRuntimeState();
    const before = dispositionRows(config, state);
    assert.equal(before.length, 12);
    assert.deepEqual(before.map((row) => row.id).slice(0, 3), ["read-project", "read-system", "run-dev-tools"]);
    assert.equal(before.find((row) => row.id === "install-dependencies")?.value, "ask");
    assert.equal(before.every((row) => !row.modified), true);

    setRowDisposition(config, state, "modify-project", "deny");
    const row = dispositionRow(config, state, "modify-project");
    assert.equal(row.value, "deny");
    assert.equal(row.persisted, "allow");
    assert.equal(row.modified, true);
    assert.equal(row.effective.scope, "session");
  });

  it("drops the override when a row lands back on its persisted value", () => {
    const config = testConfig();
    const state = createRuntimeState();
    setRowDisposition(config, state, "credentials", "deny");
    assert.deepEqual(sessionDispositionEdits(state), { credentials: "deny" });
    setRowDisposition(config, state, "credentials", "judge");
    assert.deepEqual(sessionDispositionEdits(state), {});
    assert.equal(dispositionRow(config, state, "credentials").modified, false);
  });

  it("cycles allow → judge → ask → deny and back around", () => {
    assert.equal(cycleDisposition("allow", 1), "judge");
    assert.equal(cycleDisposition("judge", 1), "ask");
    assert.equal(cycleDisposition("ask", 1), "deny");
    assert.equal(cycleDisposition("deny", 1), "allow");
    assert.equal(cycleDisposition("allow", -1), "deny");
  });

  it("summarizes this session's stats, omitting zero buckets", () => {
    const state = createRuntimeState();
    recordCapabilityHits(state.capabilities, ["off-machine-effects", "off-machine-effects", "off-machine-effects"]);
    recordCapabilityOutcome(state.capabilities, ["off-machine-effects"], "allow");
    recordCapabilityOutcome(state.capabilities, ["off-machine-effects"], "ask-approved");
    recordCapabilityOutcome(state.capabilities, ["off-machine-effects"], "judge-deny");
    const rows = dispositionRows(testConfig(), state);
    assert.equal(rows.find((row) => row.id === "off-machine-effects")?.statsLabel, "3 hits · 1 allowed · 1 asked · 1 denied");
    assert.equal(rows.find((row) => row.id === "read-project")?.statsLabel, "", "unseen classes show no stats");
  });

  it("marks preset-tightened rows without touching the row the user edits", () => {
    const config = testConfig();
    const state = createRuntimeState();
    state.readOnly = true;
    syncCapabilityPreset(state);
    const row = dispositionRow(config, state, "modify-project");
    assert.equal(row.value, "allow", "cycling still edits the underlying row");
    assert.equal(row.effective.disposition, "deny");
    assert.equal(row.presetTightened, true);
    assert.equal(dispositionSummary(row), "modify-project  allow → deny*");
    assert.match(presetBanner(state) ?? "", /^read-only preset active: modify\/destructive rows tightened to deny/);
    assert.equal(dispositionRow(config, state, "read-project").presetTightened, false);
  });

  it("names where a row came from", () => {
    const config = mergeConfig(testConfig(), { dispositions: { "install-dependencies": "ask" } }, globalRailConfigPath());
    const state = createRuntimeState();
    assert.equal(describeDispositionSource(dispositionRow(config, state, "read-project").effective), "built-in default");
    assert.equal(describeDispositionSource(dispositionRow(config, state, "install-dependencies").effective), "global config");
    setRowDisposition(config, state, "read-project", "deny");
    assert.equal(describeDispositionSource(dispositionRow(config, state, "read-project").effective), "this session");
    state.readOnly = true;
    syncCapabilityPreset(state);
    assert.equal(describeDispositionSource(dispositionRow(config, state, "modify-project").effective), "read-only preset");
  });
});

describe("saveDispositions", () => {
  it("persists every override, folds it into the config, and clears the session rows", () => {
    const config = testConfig();
    const state = createRuntimeState();
    setRowDisposition(config, state, "modify-project", "ask");
    setRowDisposition(config, state, "credentials", "deny");
    const written: Array<[CapabilityId, Disposition | undefined]> = [];
    const result = saveDispositions(config, state, spyPersistence(written));

    assert.deepEqual(written, [["modify-project", "ask"], ["credentials", "deny"]]);
    assert.deepEqual(result.saved, ["modify-project", "credentials"]);
    assert.deepEqual(result.shadowed, []);
    assert.deepEqual(sessionDispositionEdits(state), {}, "saved rows are no longer session overrides");
    const row = dispositionRow(config, state, "modify-project");
    assert.equal(row.value, "ask", "the effective value does not move on save");
    assert.equal(row.persisted, "ask");
    assert.equal(row.modified, false, "highlights clear once the value is persisted");
    assert.deepEqual(config.provenance.dispositions["modify-project"], { layer: "global", file: globalRailConfigPath() });
  });

  it("reports rows a project config will win back", () => {
    const config = mergeConfig(testConfig(), { dispositions: { "network-fetch": "allow" } }, "/repo/.pi/rail.json");
    const state = createRuntimeState();
    setRowDisposition(config, state, "network-fetch", "deny");
    const result = saveDispositions(config, state, spyPersistence([]));
    assert.deepEqual(result.saved, ["network-fetch"]);
    assert.deepEqual(result.shadowed, ["network-fetch"]);
  });

  it("is a no-op without session changes", () => {
    const config = testConfig();
    const state = createRuntimeState();
    const written: Array<[CapabilityId, Disposition | undefined]> = [];
    const result = saveDispositions(config, state, spyPersistence(written));
    assert.deepEqual(written, []);
    assert.deepEqual(result.saved, []);
  });
});

describe("DispositionPage", () => {
  it("renders one row per class with disposition and stats columns", () => {
    const state = createRuntimeState();
    recordCapabilityHits(state.capabilities, ["off-machine-effects"]);
    recordCapabilityOutcome(state.capabilities, ["off-machine-effects"], "ask-denied");
    const { page, line } = openPage(state, testConfig());
    const rendered = page.render(200);
    assert.equal(rendered.filter((text) => /(read-project|off-machine-effects|unclassified)/.test(text)).length, 3);
    assert.match(line("off-machine-effects"), /off-machine-effects\s+ask\s+<muted> 1 hit · 1 asked<\/muted>/);
    assert.match(line("install-dependencies"), /install-dependencies {2}allow/, "the widest class id still leaves a column gutter");
    assert.match(rendered.join("\n"), /↑↓ row · ←→\/Enter cycle/);
    assert.match(rendered.join("\n"), /＋ Add class…/, "the add row closes the list");
    const definition = rendered.find((text) => text.includes("Reading, listing, or searching files")) ?? "";
    assert.match(definition, /session working directory\.<\/muted>/, "the highlighted row's short definition sits in the footer area");
    assert.doesNotMatch(definition, /credentials instead/, "definitions are prompt text; the footer shows the first sentence only");
  });

  it("moves the highlight with up and down, wrapping at the ends", () => {
    const { page, line } = openPage(createRuntimeState(), testConfig());
    assert.match(line("read-project"), /<accent>→ <\/accent>/);
    page.handleInput("<down>");
    assert.equal(page.selectedId(), "read-system");
    assert.match(line("read-system"), /<accent>→ <\/accent>/);
    assert.doesNotMatch(line("read-project"), /→/);
    page.handleInput("<up>");
    page.handleInput("<up>");
    assert.equal(page.selectedId(), undefined, "up from the first row wraps to the add row past the last class");
    page.handleInput("<up>");
    assert.equal(page.selectedId(), "unclassified", "and once more lands on the last class");
  });

  it("cycles the highlighted row and applies it at session scope immediately", () => {
    const state = createRuntimeState();
    const config = testConfig();
    const { page } = openPage(state, config);
    page.handleInput(RIGHT);
    assert.deepEqual(sessionDispositionEdits(state), { "read-project": "judge" });
    page.handleInput("<enter>");
    assert.deepEqual(sessionDispositionEdits(state), { "read-project": "ask" });
    page.handleInput(LEFT);
    page.handleInput(LEFT);
    assert.deepEqual(sessionDispositionEdits(state), {}, "back on the persisted value the override is dropped");

    page.handleInput("<down>");
    page.handleInput(LEFT);
    assert.deepEqual(sessionDispositionEdits(state), { "read-system": "deny" });
  });

  it("colours modified rows and keeps that visible while the row is highlighted", () => {
    const state = createRuntimeState();
    const { page, line } = openPage(state, testConfig());
    assert.doesNotMatch(line("read-project"), /<warning>/);
    page.handleInput(RIGHT);
    const modified = line("read-project");
    assert.match(modified, /<warning>judge\s*<\/warning>/, "the disposition cell carries the modified colour");
    assert.match(modified, /<accent>read-project\s*<\/accent>/, "selection colours the id, so both stay visible");
    page.handleInput("<down>");
    assert.match(line("read-project"), /<warning>judge\s*<\/warning>/, "still modified once the highlight moves away");
  });

  it("Ctrl+S persists the overrides, clears them, and drops the highlight", () => {
    const state = createRuntimeState();
    const { page, persisted, line } = openPage(state, testConfig());
    page.handleInput(RIGHT);
    page.handleInput("<down>");
    page.handleInput(RIGHT);
    assert.deepEqual(sessionDispositionEdits(state), { "read-project": "judge", "read-system": "judge" });

    page.handleInput(CTRL_S);
    assert.deepEqual(persisted, [["read-project", "judge"], ["read-system", "judge"]]);
    assert.deepEqual(sessionDispositionEdits(state), {});
    assert.doesNotMatch(line("read-project"), /<warning>/);
    assert.match(line("read-project"), /read-project\s+judge/, "the saved value stays in effect");
  });

  it("Esc closes and leaves the session overrides in force", () => {
    const state = createRuntimeState();
    const { page, closes, persisted } = openPage(state, testConfig());
    page.handleInput(RIGHT);
    page.handleInput("<esc>");
    assert.deepEqual(closes, [undefined]);
    assert.deepEqual(persisted, [], "Esc is not a save");
    assert.deepEqual(sessionDispositionEdits(state), { "read-project": "judge" });
  });

  it("banners the read-only preset and marks the rows it tightens", () => {
    const state = createRuntimeState();
    state.readOnly = true;
    const { page, line } = openPage(state, testConfig());
    assert.match(page.render(200).join("\n"), /<warning>\s+read-only preset active: modify\/destructive rows tightened to deny \(marked \*\)<\/warning>/);
    assert.match(line("modify-project"), /allow → deny\*/);
    assert.doesNotMatch(line("read-project"), /\*/);

    // Cycling still edits the underlying row; the preset keeps winning.
    page.handleInput("<down>");
    page.handleInput("<down>");
    page.handleInput("<down>");
    assert.equal(page.selectedId(), "modify-project");
    page.handleInput(RIGHT);
    assert.match(line("modify-project"), /judge → deny\*/);
    assert.deepEqual(sessionDispositionEdits(state), { "modify-project": "judge" });
  });
});

describe("class editing at session scope", () => {
  it("adds a class the registry and the table both see immediately", () => {
    const config = testConfig();
    const state = createRuntimeState();
    assert.equal(addClass(config, state, { id: "touches-customer-data", definition: "Customer records." }), undefined);

    const row = dispositionRows(config, state).find((entry) => entry.id === "touches-customer-data");
    assert.ok(row, "the new class has a table row");
    assert.equal(row.value, "ask", "new classes default to ask");
    assert.equal(row.sessionNew, true);
    assert.equal(row.builtin, false);
    assert.equal(hasUnsavedChanges(state), true);
  });

  it("rejects malformed, duplicate, and built-in-shadowing ids", () => {
    const config = testConfig();
    const state = createRuntimeState();
    assert.match(addClass(config, state, { id: "Not Kebab", definition: "x" })!, /kebab-case/);
    assert.match(addClass(config, state, { id: "read-project", definition: "x" })!, /built-in class/);
    assert.match(addClass(config, state, { id: "fine-id", definition: "  " })!, /definition is required/);
    assert.equal(addClass(config, state, { id: "fine-id", definition: "Real." }), undefined);
    assert.match(addClass(config, state, { id: "fine-id", definition: "Again." })!, /already exists/);
  });

  it("edits any class definition, built-ins included, without touching the shipped text", () => {
    const config = testConfig();
    const state = createRuntimeState();
    assert.equal(editClassDefinition(config, state, "read-project", "Reads, rephrased."), undefined);
    const row = dispositionRow(config, state, "read-project");
    assert.equal(row.fullDefinition, "Reads, rephrased.");
    assert.equal(row.sessionEdited, true);
    assert.equal(row.builtin, true);
    assert.match(editClassDefinition(config, state, "not-a-class", "x")!, /Unknown capability class/);
  });

  it("refuses to delete a built-in and points at the alternatives", () => {
    const state = createRuntimeState();
    assert.match(deleteClass(state, "credentials")!, /built-in and cannot be deleted/);
    assert.match(deleteClass(state, "credentials")!, /set it to deny, or edit its definition/);
  });

  it("deletes a custom class and drops its row", () => {
    const config = testConfig();
    const state = createRuntimeState();
    addClass(config, state, { id: "touches-customer-data", definition: "Customer records." });
    assert.equal(deleteClass(state, "touches-customer-data"), undefined);
    assert.equal(dispositionRows(config, state).some((row) => row.id === "touches-customer-data"), false);
  });
});

describe("saveDispositions with class changes", () => {
  it("persists adds, edits, and deletions alongside disposition rows", () => {
    const config = mergeConfig(
      testConfig(),
      { capabilities: { classes: [{ id: "legacy-class", definition: "On its way out." }] } },
      globalRailConfigPath(),
    );
    const state = createRuntimeState();
    addClass(config, state, { id: "touches-customer-data", definition: "Customer records." });
    editClassDefinition(config, state, "read-project", "Reads, rephrased.");
    deleteClass(state, "legacy-class");
    setRowDisposition(config, state, "modify-project", "ask");

    const rows: Array<[CapabilityId, Disposition | undefined]> = [];
    const persistence = spyPersistence(rows);
    const result = saveDispositions(config, state, persistence);

    assert.deepEqual(result.added, ["touches-customer-data"]);
    assert.deepEqual(result.edited, ["read-project"]);
    assert.deepEqual(result.removed, ["legacy-class"]);
    assert.deepEqual(result.saved, ["modify-project"]);

    assert.deepEqual(persistence.classes, [
      ["touches-customer-data", { id: "touches-customer-data", definition: "Customer records.", disposition: "ask" }],
      ["legacy-class", undefined],
    ]);
    assert.deepEqual(persistence.definitions, [["read-project", "Reads, rephrased."]]);
    assert.deepEqual(rows, [["modify-project", "ask"]]);

    // The session layer is empty afterwards, so no marker survives the save.
    assert.equal(hasUnsavedChanges(state), false);
    const after = dispositionRows(config, state);
    const added = after.find((row) => row.id === "touches-customer-data")!;
    assert.equal(added.sessionNew, false, "a saved class is no longer session-new");
    assert.equal(added.value, "ask", "and its effective value does not move");
    assert.equal(after.some((row) => row.id === "legacy-class"), false, "the deletion stuck");
    assert.equal(after.find((row) => row.id === "read-project")!.sessionEdited, false);
  });

  it("rewrites a persisted custom class in place when its definition is edited", () => {
    const config = mergeConfig(
      testConfig(),
      { capabilities: { classes: [{ id: "touches-customer-data", definition: "Old wording." }] } },
      globalRailConfigPath(),
    );
    const state = createRuntimeState();
    editClassDefinition(config, state, "touches-customer-data", "New wording.");
    const persistence = spyPersistence([]);
    const result = saveDispositions(config, state, persistence);

    assert.deepEqual(result.edited, ["touches-customer-data"]);
    assert.deepEqual(persistence.definitions, [], "custom classes store the definition inline, not as an override");
    assert.deepEqual(persistence.classes, [
      ["touches-customer-data", { id: "touches-customer-data", definition: "New wording.", disposition: "ask" }],
    ]);
  });
});

describe("DispositionPage without tabs", () => {
  it("is a single view: no tab header, and the rules pointer names the status page", () => {
    const { page, text } = openPage(createRuntimeState(), testConfig());
    const rendered = text();
    assert.match(rendered, /Capability policy/);
    assert.doesNotMatch(rendered, /Tab:/, "the mechanism rules moved to the status page");
    assert.doesNotMatch(rendered, /Tab switches view/);
    assert.match(rendered, /the resolved filesystem\/network rules are \/rail policy rules/);
    assert.match(rendered, /↑↓ row · ←→\/Enter cycle/);

    // Tab is no longer a page gesture in list mode; it must not move anything.
    page.handleInput(TAB);
    assert.equal(page.selectedId(), "read-project");
    assert.match(text(), /read-project/);
  });

  it("closes on Esc", () => {
    const { page, closes } = openPage(createRuntimeState(), testConfig());
    page.handleInput("<esc>");
    assert.deepEqual(closes, [undefined]);
  });
});

describe("DispositionPage class editing", () => {
  it("adds a class through the form and tags the new row", () => {
    const state = createRuntimeState();
    const { page, text, notes } = openPage(state, testConfig());
    page.handleInput("a");
    assert.match(text(), /New capability class/);
    assert.match(text(), /Enter or Ctrl\+S commits \(session scope\) · Esc cancels/);

    type(page, "touches-customer-data");
    page.handleInput(TAB);
    type(page, "Customer records.");
    page.handleInput("<enter>");

    assert.match(text(), /touches-customer-data/);
    assert.match(text(), /<warning> \(new\)<\/warning>/);
    assert.equal(sessionAddedClasses(state).length, 1);
    assert.match(notes.at(-1)!.message, /touches-customer-data added for this session, default ask/);
  });

  it("reaches the same form from Enter on the add row", () => {
    const { page, text } = openPage(createRuntimeState(), testConfig());
    for (let i = 0; i < 12; i++) page.handleInput("<down>");
    assert.equal(page.selectedId(), undefined, "the add row is past the last class");
    page.handleInput("<enter>");
    assert.match(text(), /New capability class/);
  });

  it("keeps the user in the form on a validation error", () => {
    const state = createRuntimeState();
    const { page, text } = openPage(state, testConfig());
    page.handleInput("a");
    type(page, "read-project");
    page.handleInput(TAB);
    type(page, "Shadowing a built-in.");
    page.handleInput("<enter>");

    assert.match(text(), /New capability class/, "still in the form");
    assert.match(text(), /<error>.*built-in class/);
    assert.equal(sessionAddedClasses(state).length, 0);
  });

  it("edits a definition with e, prefilled with the current text", () => {
    const state = createRuntimeState();
    const config = testConfig();
    const { page, text } = openPage(state, config);
    page.handleInput("e");
    assert.match(text(), /Edit read-project/);
    // The editor is seeded with the current definition, wrapped in full view.
    assert.match(text(), /is credentials instead\./, "the field starts from the current definition");

    // Clear the prefill, then type the replacement.
    for (let i = 0; i < 400; i++) page.handleInput("\x7f");
    type(page, "Reads, rephrased.");
    page.handleInput(CTRL_S);

    assert.equal(dispositionRow(config, state, "read-project").fullDefinition, "Reads, rephrased.");
    assert.match(text(), /<warning> \(edited\)<\/warning>/);
  });

  it("wraps a long definition across multiple lines between chat-style rules", () => {
    const { page } = openPage(createRuntimeState(), testConfig());
    page.handleInput("e");
    // Narrow enough that read-project's paragraph must wrap several times.
    const lines = page.render(60);
    // Older pi-tui colours each rule cell, newer ones the whole run.
    const rules = lines.filter((line) => /<borderMuted>─+<\/borderMuted>/.test(line));
    assert.equal(rules.length, 2, "the editor draws the chat input's rules above and below");
    // The two rule lines render identically, so find them from opposite ends.
    const top = lines.indexOf(rules[0]!);
    const bottom = lines.lastIndexOf(rules[1]!);
    assert.ok(bottom - top - 1 >= 3, `the paragraph wraps across the box, got ${bottom - top - 1} lines`);
    assert.match(lines[top + 1] ?? "", /^Reading, listing/, "text sits flush like the chat input (no padding)");
  });

  it("prefill leaves the caret at the end, so typing appends", () => {
    const state = createRuntimeState();
    const config = testConfig();
    const { page } = openPage(state, config);
    page.handleInput("e");
    type(page, " Also symlinks.");
    page.handleInput("<enter>");
    assert.match(dispositionRow(config, state, "read-project").fullDefinition, /is credentials instead\. Also symlinks\.$/);
  });

  it("joins editing newlines into spaces on commit", () => {
    const state = createRuntimeState();
    const { page } = openPage(state, testConfig());
    page.handleInput("a");
    type(page, "multi-line-class");
    page.handleInput(TAB);
    type(page, "First line.");
    page.handleInput("\n"); // ctrl+j: a newline while editing, chat-style
    type(page, "Second line.");
    page.handleInput("<enter>");
    assert.equal(sessionAddedClasses(state)[0]?.definition, "First line. Second line.");
  });

  it("continues on a new line instead of committing when Enter follows a backslash", () => {
    const state = createRuntimeState();
    const { page, text } = openPage(state, testConfig());
    page.handleInput("a");
    type(page, "backslash-class");
    page.handleInput(TAB);
    type(page, "First.\\");
    page.handleInput("<enter>");
    assert.match(text(), /New capability class/, "the backslash swallowed the commit");
    assert.equal(sessionAddedClasses(state).length, 0);
    type(page, "Second.");
    page.handleInput("<enter>");
    assert.equal(sessionAddedClasses(state)[0]?.definition, "First. Second.");
  });

  it("cancels a form with Esc, leaving the session untouched", () => {
    const state = createRuntimeState();
    const { page, text } = openPage(state, testConfig());
    page.handleInput("a");
    type(page, "abandoned");
    page.handleInput("<esc>");
    assert.match(text(), /↑↓ row/, "back in list mode");
    assert.equal(sessionAddedClasses(state).length, 0);
    assert.equal(hasUnsavedChanges(state), false);
  });

  it("deletes a custom class with d and refuses on a built-in", () => {
    const state = createRuntimeState();
    const config = testConfig();
    const { page, text, notes } = openPage(state, config);

    page.handleInput("d");
    assert.match(notes.at(-1)!.message, /read-project is built-in and cannot be deleted/);
    assert.equal(notes.at(-1)!.level, "warning");

    addClass(config, state, { id: "touches-customer-data", definition: "Customer records." });
    page.refresh();
    for (let i = 0; i < 12; i++) page.handleInput("<down>");
    assert.equal(page.selectedId(), "touches-customer-data");
    page.handleInput("d");
    assert.doesNotMatch(text(), /touches-customer-data/, "the row disappears");
    assert.match(notes.at(-1)!.message, /touches-customer-data removed for this session/);
  });

  it("routes Ctrl+S to the form in form mode and to the save in list mode", () => {
    const state = createRuntimeState();
    const { page, persisted } = openPage(state, testConfig());
    page.handleInput("a");
    type(page, "touches-customer-data");
    page.handleInput(TAB);
    type(page, "Customer records.");
    page.handleInput(CTRL_S);
    assert.deepEqual(persisted, [], "Ctrl+S committed the form, it did not persist");
    assert.equal(sessionAddedClasses(state).length, 1);

    setRowDisposition(testConfig(), state, "modify-project", "deny");
    page.handleInput(CTRL_S);
    assert.deepEqual(persisted, [["modify-project", "deny"]], "in list mode it persists");
  });

  it("does not treat letter keys as commands while a form is open", () => {
    const state = createRuntimeState();
    const { page, text } = openPage(state, testConfig());
    page.handleInput("a");
    // "d" and "e" are plain characters inside the id field, not delete/edit.
    type(page, "deed");
    assert.match(text(), /New capability class/);
    page.handleInput(TAB);
    type(page, "Definition.");
    page.handleInput("<enter>");
    assert.deepEqual(sessionAddedClasses(state).map((entry) => entry.id), ["deed"]);
  });
});
