// The built-in allowlist's flags audit (src/command-allowlist.ts): every
// wildcard template that has a flag which writes, deletes, or runs a program
// carries a flags allowlist, and `git branch *` is split into read-only forms.
// Tightening only: each shape below now goes to the namer.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandFlagsProblem, DEFAULT_COMMAND_ALLOW_FLAGS, DEFAULT_COMMAND_ALLOW_RULES } from "../src/command-allowlist.ts";
import { dryRunAction } from "../src/grant-eval.ts";
import { testConfig } from "./helpers.ts";

const config = testConfig((c) => (c.classifier.enabled = true));
const outcome = (command: string) => dryRunAction(config, { tool: "bash", input: { command } }, { cwd: "/Users/dev/projects/acme-app" }).outcome;

describe("built-in flags allowlists", () => {
  it("are valid allowlists, and only on wildcard templates", () => {
    for (const rule of DEFAULT_COMMAND_ALLOW_RULES) {
      if (!rule.flags) continue;
      assert.equal(commandFlagsProblem(rule.template, rule.flags), undefined, rule.template);
    }
    assert.ok(Object.keys(DEFAULT_COMMAND_ALLOW_FLAGS).length >= 14);
    assert.deepEqual(config.commands.allowFlags, DEFAULT_COMMAND_ALLOW_FLAGS);
  });

  const now: Array<[string, string]> = [
    ["git branch -D feature-x", "deletes a branch"],
    ["git branch -d feature-x", "deletes a branch"],
    ["git branch -m old new", "renames a branch"],
    ["git branch -f main HEAD~3", "moves a branch"],
    ["git branch newname", "creates a branch (bare positional)"],
    ["git branch --set-upstream-to=origin/main", "writes config"],
    ["git branch --list --delete x", "a delete after a read flag"],
    ["git log --output=/tmp/x", "writes a file"],
    ["git log --ext-diff -p", "runs an external diff"],
    ["git log --show-signature", "runs gpg"],
    ["git diff --output=patch.txt", "writes a file"],
    ["git diff --ext-diff", "runs an external diff"],
    ["git show --output=x HEAD", "writes a file"],
    ["git stash show --output=x", "writes a file"],
    ["git reflog show --output=x", "writes a file"],
    ["git grep -O foo", "runs a pager program"],
    ["git grep --open-files-in-pager=vim foo", "runs a program"],
    ["git shortlog --output=x", "writes a file"],
    ["git tag -l -d v1", "a delete after a read flag"],
    ["git config --get --unset user.name", "a write after a read flag"],
    ["rg --pre ./run.sh foo", "runs a program per file"],
    ["rg --pre=./run.sh foo", "runs a program per file"],
    ["rg -z foo", "runs decompressors"],
    ["rg foo *.ts", "an unquoted glob (could expand to a flag)"],
    ["file -C -m magic", "compiles a magic file"],
    ["file -z archive.gz", "runs decompressors"],
    ["diff -l a b", "runs pr"],
    ["diff --paginate a b", "runs pr"],
  ];
  for (const [command, why] of now) {
    it(`no longer allows \`${command}\` (${why})`, () => assert.notEqual(outcome(command), "allow"));
  }

  const still = [
    "git branch",
    "git branch -a",
    "git branch -vv",
    "git branch --show-current",
    "git branch --list 'feat*'",
    "git branch --list --merged main",
    "git log --oneline -20",
    "git log --format='%h %s' --since=2.weeks",
    "git log -p -- src/app.ts",
    "git diff --cached --stat",
    "git diff HEAD~1 -- '*.ts'",
    "git show HEAD --stat",
    "git grep -n 'foo.*bar'",
    "git tag -l 'v1.*'",
    "git config --get user.email",
    "git stash show -p",
    "rg -n 'foo.*bar' src",
    "rg -g '*.ts' --hidden foo",
    "rg --type=ts -i todo",
    "file -b --mime-type README.md",
    "diff -u a.txt b.txt",
    "grep -rn foo .",
    "cat package.json",
    "ls -la",
    "jq .name package.json",
  ];
  for (const command of still) {
    it(`still allows \`${command}\``, () => assert.equal(outcome(command), "allow"));
  }
});
