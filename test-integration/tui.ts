/**
 * tmux-driven TUI integration test: boots the real pi TUI with this extension
 * loaded (`pi -ne -e <repo root>`) inside a detached tmux session and drives
 * it with send-keys, asserting on capture-pane output.
 *
 * Deliberately excluded from `npm test` (which only globs test/*.test.ts):
 * it needs tmux and pi installed and takes ~15s. Run via `npm run test:tui`.
 * It only ever submits /rail slash commands, so no LLM turn is triggered.
 * The user's global pi config leaks into the session (model warnings, other
 * noise), so every assertion is substring-based and tolerates unrelated lines.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const SESSION = `pi-rail-tui-test-${process.pid}`;
/** Exact-match session target (the trailing colon is required for `=` in target-pane position). */
const TARGET = `=${SESSION}:`;
const STARTUP_TIMEOUT_MS = 60_000;
const UI_TIMEOUT_MS = 15_000;
const POLL_MS = 250;

function which(binary: string): string | undefined {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${binary}`], { encoding: "utf8" });
  const found = (result.stdout ?? "").trim();
  return result.status === 0 && found !== "" ? found : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function tmux(...args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8" });
}

/** The currently visible pane content (ANSI stripped by capture-pane). */
function visiblePane(): string {
  return tmux("capture-pane", "-p", "-t", TARGET);
}

/** Entire pane history plus the visible screen. */
function fullScrollback(): string {
  return tmux("capture-pane", "-p", "-S", "-", "-t", TARGET);
}

/** Polls capture-pane until the predicate holds; fails with the last pane content attached. */
async function waitFor(predicate: (pane: string) => boolean, description: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let pane = "";
  for (;;) {
    pane = visiblePane();
    if (predicate(pane)) return pane;
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }
  assert.fail(`Timed out after ${timeoutMs}ms waiting for ${description}.\nLast captured pane:\n${pane}`);
}

/**
 * Whether the editor (bottom rows of the pane) still shows the typed text.
 * Matches on the end of the line, not on containment: an open panel can sit in
 * those same rows and mention a command in its own hint text (the disposition
 * page points at `/rail policy rules`), which a substring test reads as an
 * un-submitted editor.
 */
function editorShows(pane: string, text: string): boolean {
  const lines = pane.trimEnd().split("\n");
  return lines.slice(-8).some((line) => line.trimEnd().endsWith(text));
}

/**
 * Types a slash command and submits it, verified. The first Enter submits
 * immediately for exact command matches but may instead accept an autocomplete
 * selection, leaving the text in the editor. So: send one Enter, poll briefly,
 * and only send a second Enter if the editor still shows the command. Never
 * blindly double-Enter — with a panel open, Enter activates the highlighted
 * item.
 */
async function submitCommand(command: string): Promise<void> {
  tmux("send-keys", "-l", "-t", TARGET, command);
  await waitFor((pane) => editorShows(pane, command), `editor to show ${JSON.stringify(command)}`, UI_TIMEOUT_MS);
  tmux("send-keys", "-t", TARGET, "Enter");
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!editorShows(visiblePane(), command)) return;
    await sleep(POLL_MS);
  }
  // The first Enter was consumed by the completion popup; this one submits.
  tmux("send-keys", "-t", TARGET, "Enter");
  await waitFor((pane) => !editorShows(pane, command), `editor to clear after submitting ${JSON.stringify(command)}`, UI_TIMEOUT_MS);
}

/**
 * Closes the focused rail overlay with Esc and waits until `marker` (a string
 * only that overlay renders) is gone from the visible pane. The footer text is
 * not a reliable close marker: long overlay content (e.g. the policy view at
 * 40 rows) clips the footer line off the bottom of the screen.
 */
async function closeOverlay(name: string, marker: string): Promise<void> {
  tmux("send-keys", "-t", TARGET, "Escape");
  await waitFor((pane) => !pane.includes(marker), `${name} overlay to close`, UI_TIMEOUT_MS);
}

test("pi TUI: rail startup, the tabbed status page, the disposition page, the model picker, no [rail] conversation reports", async (t) => {
  const tmuxPath = which("tmux");
  const piPath = which("pi");
  if (tmuxPath === undefined || piPath === undefined) {
    t.skip(`needs tmux and pi on PATH (tmux: ${tmuxPath ?? "not found"}, pi: ${piPath ?? "not found"})`);
    return;
  }

  const extensionRoot = path.resolve(import.meta.dirname, "..");
  const projectDir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "pi-rail-tui-project-")));
  let sessionStarted = false;
  try {
    // A tiny throwaway git repo for pi to treat as the project.
    const git = (...args: string[]) => execFileSync("git", ["-C", projectDir, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    writeFileSync(path.join(projectDir, "README.md"), "# pi-rail TUI test fixture\n");
    writeFileSync(path.join(projectDir, "hello.txt"), "hello\n");
    // Pin what the assertions depend on: the developer's global rail config
    // leaks into the session (the project layer merges over it), and a global
    // statusLine of "auto"/"never" would fail the statusline gate below.
    mkdirSync(path.join(projectDir, ".pi"));
    writeFileSync(path.join(projectDir, ".pi", "rail.json"), `${JSON.stringify({ statusLine: "always" })}\n`);
    git("add", ".");
    git("-c", "user.name=pi-rail-test", "-c", "user.email=pi-rail-test@example.invalid", "commit", "--quiet", "-m", "fixture");

    tmux(
      "new-session", "-d", "-s", SESSION, "-x", "140", "-y", "40", "-c", projectDir,
      `${shellQuote(piPath)} -ne -e ${shellQuote(extensionRoot)}`,
    );
    sessionStarted = true;

    // Startup: init notification plus a statusline (statusLine defaults to "always").
    await waitFor(
      (pane) => pane.includes("Rail initialized with seatbelt backend"),
      "rail init notification",
      STARTUP_TIMEOUT_MS,
    );
    await waitFor(
      (pane) => pane.split("\n").some((line) => line.trim().startsWith("Rail: seatbelt")),
      'statusline starting with "Rail: seatbelt"',
      UI_TIMEOUT_MS,
    );

    // /rail status opens the tabbed status page on the session tab: the tab
    // header, the counters table, and the per-class capability table.
    await submitCommand("/rail status");
    await waitFor(
      (pane) => pane.includes("Tab: session | models | namer | judge | engine | policy") && /counter\s+total\s+turn/.test(pane),
      "status page (tab header + decision counters table)",
      UI_TIMEOUT_MS,
    );
    // Tab cycles to the models tab. This session never calls a reviewer (no
    // agent turn runs), so its table is the empty state rather than rows.
    tmux("send-keys", "-t", TARGET, "Tab");
    await waitFor(
      (pane) => pane.includes("─ Reviewer models") && pane.includes("(no reviewer calls yet)"),
      "models tab after Tab",
      UI_TIMEOUT_MS,
    );
    await closeOverlay("status", "Tab: session");

    // /rail policy opens the interactive disposition page: every class, its
    // disposition, and the session stats column.
    await submitCommand("/rail policy");
    await waitFor(
      (pane) => pane.includes("Capability policy") && /read-project\s+allow/.test(pane) && /off-machine-effects\s+ask/.test(pane),
      "disposition page with its rows",
      UI_TIMEOUT_MS,
    );
    // Right cycles the highlighted row (allow → judge) at session scope.
    tmux("send-keys", "-t", TARGET, "Right");
    await waitFor((pane) => /read-project\s+judge/.test(pane), "cycled disposition on the highlighted row", UI_TIMEOUT_MS);
    // "e" opens the definition editor: the whole paragraph is visible at once,
    // wrapped chat-input style between its own rules — the old single-line
    // Input only ever showed a sliver scrolled past the caret, so head and
    // tail on screen together is the wrapping working. (At 140 columns the
    // asserted phrases sit clear of the word-wrap points.)
    tmux("send-keys", "-l", "-t", TARGET, "e");
    await waitFor(
      (pane) => pane.includes("Edit read-project") && pane.includes("Reading, listing, or searching") && pane.includes("is credentials instead."),
      "edit form with the whole definition wrapped into view",
      UI_TIMEOUT_MS,
    );
    tmux("send-keys", "-t", TARGET, "Escape");
    await waitFor((pane) => !pane.includes("Edit read-project"), "edit form to close back to the list", UI_TIMEOUT_MS);
    await closeOverlay("disposition page", "Capability policy");

    // Read-only mode is a session preset: the page banners it and shows the
    // tightened effective value next to the row the user still edits.
    await submitCommand("/rail readonly");
    await submitCommand("/rail policy");
    await waitFor(
      (pane) => pane.includes("read-only preset active") && /modify-project\s+allow → deny\*/.test(pane),
      "read-only banner and preset-tightened row",
      UI_TIMEOUT_MS,
    );
    await closeOverlay("disposition page", "Capability policy");
    await submitCommand("/rail readonly");

    // The disposition page is a single view again: no tab header, and a
    // pointer at the command that shows the mechanism rules.
    await submitCommand("/rail policy");
    await waitFor(
      (pane) => pane.includes("Capability policy") && pane.includes("/rail policy rules") && !pane.includes("Tab: dispositions"),
      "disposition page with no tab header",
      UI_TIMEOUT_MS,
    );
    await closeOverlay("disposition page", "Capability policy");

    // /rail model opens the reviewer-model picker: one tab per seat, Tab and
    // Shift+Tab switch. Nothing is picked here — a pick is session-only, but
    // the test never saves, so the developer's rail.json is never written.
    await submitCommand("/rail model");
    await waitFor(
      (pane) => pane.includes("Rail reviewer models") && pane.includes("Tab: namer | judge | configurator") && pane.includes("Ctrl+S saves"),
      "reviewer model picker with its three seat tabs",
      UI_TIMEOUT_MS,
    );
    tmux("send-keys", "-t", TARGET, "Tab");
    await waitFor((pane) => pane.includes("It cannot be turned off"), "judge tab after Tab", UI_TIMEOUT_MS);
    tmux("send-keys", "-t", TARGET, "BTab");
    await waitFor((pane) => pane.includes("Names every reviewed action"), "namer tab after Shift+Tab", UI_TIMEOUT_MS);
    await closeOverlay("reviewer model picker", "Rail reviewer models");

    // /rail policy rules opens the status page directly on its policy tab, as
    // a provenance table. No footer assertion here: the policy tab is tall
    // enough to clip the footer at 40 rows.
    await submitCommand("/rail policy rules");
    await waitFor(
      (pane) => /entry\s+source/.test(pane) && pane.includes("─ Filesystem") && pane.includes("Tab: session"),
      "status page on the policy tab with its provenance table",
      UI_TIMEOUT_MS,
    );
    await closeOverlay("policy rules", "─ Filesystem");

    // Nothing above should have posted a [rail] report into the conversation.
    const scrollback = fullScrollback();
    assert.ok(
      !scrollback.includes("[rail]"),
      `expected no [rail] report in the conversation.\nFull scrollback:\n${scrollback}`,
    );
  } finally {
    if (sessionStarted) {
      try {
        tmux("kill-session", "-t", TARGET);
      } catch {
        // Session already gone (e.g. pi crashed); nothing to kill.
      }
    }
    rmSync(projectDir, { recursive: true, force: true });
  }
});
