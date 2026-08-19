import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { classifierExemptReadReason, decidePathAccess, denyReadMatch, isClassifierExemptRead } from "../src/policy.ts";
import { screenWrite } from "../src/content-screen.ts";
import { linkedWorktreeRoot, sessionCheckoutRoot, sessionGitCommonDir } from "../src/worktrees.ts";
import { makeFixtureDir, testConfig } from "./helpers.ts";

// Real git repos in a throwaway tmp dir: the detection code parses git's
// actual on-disk worktree registry, so the fixtures must be the genuine
// article, not hand-written lookalikes. Hermetic on purpose — HOME and every
// config scope are redirected so the host machine's git setup (and the host
// repo these tests live in) cannot leak into any assertion.
const fixture = makeFixtureDir();
after(() => fixture.cleanup());

const repo = path.join(fixture.dir, "repo");
const gitDir = path.join(repo, ".git");
const wt = path.join(fixture.dir, "wt");
const sibling = path.join(fixture.dir, "sibling");
const plain = path.join(fixture.dir, "plain");
const evil = path.join(fixture.dir, "evil");

const gitEnv = {
  ...process.env,
  HOME: fixture.dir,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv, stdio: "ignore" });
}

function setup() {
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(path.join(repo, "tracked.txt"), "ok");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "worktree", "add", "-q", "-b", "wt-branch", wt);
  git(repo, "worktree", "add", "-q", "-b", "sibling-branch", sibling);
  mkdirSync(path.join(wt, "src"));
  writeFileSync(path.join(wt, "src", "app.ts"), "ok");
  writeFileSync(path.join(wt, ".env"), "SECRET=1");
  mkdirSync(plain);
  writeFileSync(path.join(plain, "notes.txt"), "ok");
  // A forged membership claim: a .git FILE pointing at wt's real registry
  // entry, written by "someone" who can create files in /tmp but never ran
  // `git worktree add` through the rail. The forward pointer is perfect; only
  // the reverse check can tell it apart from the real worktree.
  mkdirSync(evil);
  writeFileSync(path.join(evil, ".git"), `gitdir: ${path.join(gitDir, "worktrees", "wt")}\n`);
  writeFileSync(path.join(evil, "payload.txt"), "boo");
}
setup();

describe("linkedWorktreeRoot", () => {
  it("resolves the worktree root for files inside a registered linked worktree", () => {
    assert.equal(linkedWorktreeRoot(gitDir, path.join(wt, "src", "app.ts")), wt);
    assert.equal(linkedWorktreeRoot(gitDir, wt), wt);
  });

  it("resolves not-yet-created paths through their existing worktree ancestor", () => {
    assert.equal(linkedWorktreeRoot(gitDir, path.join(wt, "deep", "nested", "new.ts")), wt);
  });

  it("resolves the main checkout when the candidate is inside it", () => {
    assert.equal(linkedWorktreeRoot(gitDir, path.join(repo, "tracked.txt")), repo);
  });

  it("returns undefined for plain outside paths, existing or not", () => {
    assert.equal(linkedWorktreeRoot(gitDir, path.join(plain, "notes.txt")), undefined);
    assert.equal(linkedWorktreeRoot(gitDir, path.join(fixture.dir, "ghost", "nothing.txt")), undefined);
  });

  it("rejects a forged gitfile whose registry entry points back at the real worktree", () => {
    assert.equal(linkedWorktreeRoot(gitDir, path.join(evil, "payload.txt")), undefined);
  });

  it("rejects a gitfile targeting a registry entry that no longer points back (tampered reverse link)", () => {
    const tamperedRoot = path.join(fixture.dir, "tampered");
    git(repo, "worktree", "add", "-q", "-b", "tampered-branch", tamperedRoot);
    writeFileSync(path.join(gitDir, "worktrees", "tampered", "gitdir"), path.join(fixture.dir, "elsewhere", ".git") + "\n");
    assert.equal(linkedWorktreeRoot(gitDir, path.join(tamperedRoot, "tracked.txt")), undefined);
  });

  it("rejects a worktree moved without updating the registry (reverse link mismatch)", () => {
    const movedFrom = path.join(fixture.dir, "moved-from");
    const movedTo = path.join(fixture.dir, "moved-to");
    git(repo, "worktree", "add", "-q", "-b", "moved-branch", movedFrom);
    renameSync(movedFrom, movedTo);
    assert.equal(linkedWorktreeRoot(gitDir, path.join(movedTo, "tracked.txt")), undefined);
  });

  it("returns undefined when the session git dir does not exist", () => {
    assert.equal(linkedWorktreeRoot(path.join(fixture.dir, "no-repo", ".git"), path.join(wt, "src", "app.ts")), undefined);
  });
});

describe("sessionGitCommonDir", () => {
  it("returns the .git directory for the main checkout and its subdirectories", () => {
    assert.equal(sessionGitCommonDir(repo), gitDir);
    mkdirSync(path.join(repo, "sub"), { recursive: true });
    assert.equal(sessionGitCommonDir(path.join(repo, "sub")), gitDir);
  });

  it("anchors a linked-worktree cwd on the COMMON git dir, not its private worktrees/<name> dir", () => {
    assert.equal(sessionGitCommonDir(path.join(wt, "src")), gitDir);
  });

  it("returns undefined outside any repo", () => {
    assert.equal(sessionGitCommonDir(plain), undefined);
  });
});

describe("sessionCheckoutRoot", () => {
  it("identifies a linked worktree from the main checkout", () => {
    assert.deepEqual(sessionCheckoutRoot(repo, path.join(wt, "src", "app.ts")), { root: wt, linked: true });
  });

  it("trusts the main checkout and sibling worktrees when cwd is itself a linked worktree", () => {
    assert.deepEqual(sessionCheckoutRoot(wt, path.join(repo, "tracked.txt")), { root: repo, linked: false });
    assert.deepEqual(sessionCheckoutRoot(wt, path.join(sibling, "tracked.txt")), { root: sibling, linked: true });
  });

  it("returns undefined for paths in cwd's own checkout — including when cwd is a deliberate subdirectory narrowing", () => {
    assert.equal(sessionCheckoutRoot(repo, path.join(repo, "tracked.txt")), undefined);
    assert.equal(sessionCheckoutRoot(path.join(repo, "sub"), path.join(repo, "tracked.txt")), undefined);
  });

  it("returns undefined for forged and plain outside paths", () => {
    assert.equal(sessionCheckoutRoot(repo, path.join(evil, "payload.txt")), undefined);
    assert.equal(sessionCheckoutRoot(repo, path.join(plain, "notes.txt")), undefined);
  });
});

describe("classifier read exemption in worktrees", () => {
  it("exempts reads inside a linked worktree of the session repo", () => {
    assert.equal(classifierExemptReadReason(testConfig(), repo, path.join(wt, "src", "app.ts")), "in linked worktree of session repo");
  });

  it("exempts main-checkout and sibling-worktree reads when cwd is a worktree", () => {
    assert.equal(classifierExemptReadReason(testConfig(), wt, path.join(repo, "tracked.txt")), "in main checkout of session repo");
    assert.equal(classifierExemptReadReason(testConfig(), wt, path.join(sibling, "tracked.txt")), "in linked worktree of session repo");
  });

  it("keeps denyRead precedence: a basename deny still wins inside the worktree", () => {
    assert.equal(isClassifierExemptRead(testConfig(), repo, path.join(wt, ".env")), false);
    assert.equal(denyReadMatch(testConfig(), repo, path.join(wt, ".env")), ".env");
  });

  it("anchors relative denyRead patterns at the worktree root", () => {
    mkdirSync(path.join(wt, "config"), { recursive: true });
    writeFileSync(path.join(wt, "config", "secret.txt"), "s3cr3t");
    const config = testConfig((c) => {
      c.filesystem.denyRead = ["config/secret.txt"];
    });
    // Relative to the session cwd this path would be ../wt/config/secret.txt
    // and never match; the worktree anchor is what makes the pattern bite.
    assert.equal(denyReadMatch(config, repo, path.join(wt, "config", "secret.txt")), "config/secret.txt");
    assert.equal(classifierExemptReadReason(config, repo, path.join(wt, "config", "secret.txt")), undefined);
  });

  it("does not exempt forged-worktree or plain outside reads", () => {
    assert.equal(classifierExemptReadReason(testConfig(), repo, path.join(evil, "payload.txt")), undefined);
    assert.equal(classifierExemptReadReason(testConfig(), repo, path.join(plain, "notes.txt")), undefined);
  });
});

describe("decidePathAccess in worktrees", () => {
  // Narrow allowWrite to "." alone: the default list also trusts the OS temp
  // dir, which would allow these tmp-dir fixtures for the wrong reason and
  // mask whether worktree anchoring did anything.
  const cwdOnlyWrites = () =>
    testConfig((c) => {
      c.filesystem.allowWrite = ["."];
    });

  it("allows writes inside a linked worktree via the re-anchored '.' root", () => {
    const decision = decidePathAccess(cwdOnlyWrites(), repo, path.join(wt, "newfile.ts"), "write");
    assert.equal(decision.allowed, true);
    assert.equal(decision.allowed && decision.matchedRoot, ".");
    assert.equal(decision.allowed && decision.worktreeRoot, wt);
  });

  it("allows writes to not-yet-existing nested paths inside the worktree", () => {
    assert.equal(decidePathAccess(cwdOnlyWrites(), repo, path.join(wt, "deep", "nested", "new.ts"), "write").allowed, true);
  });

  it("anchors relative denyWrite globs at the worktree root", () => {
    const config = testConfig((c) => {
      c.filesystem.allowWrite = ["."];
      c.filesystem.denyWrite = ["src/**"];
    });
    const decision = decidePathAccess(config, repo, path.join(wt, "src", "blocked.ts"), "write");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "denied-by-pattern");
  });

  it("keeps basename denyWrite entries working inside the worktree", () => {
    const decision = decidePathAccess(cwdOnlyWrites(), repo, path.join(wt, ".env"), "write");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "denied-by-pattern");
  });

  it("still treats forged and plain outside paths as outside the roots", () => {
    for (const target of [path.join(evil, "x.ts"), path.join(plain, "x.ts")]) {
      const decision = decidePathAccess(cwdOnlyWrites(), repo, target, "write");
      assert.equal(decision.allowed, false);
      assert.equal(decision.allowed === false && decision.code, "outside-roots");
    }
  });

  it("extends whitelist read mode into the worktree, and only there", () => {
    const config = testConfig((c) => {
      c.filesystem.allowRead = ["."];
    });
    const inside = decidePathAccess(config, repo, path.join(wt, "src", "app.ts"), "read");
    assert.equal(inside.allowed, true);
    assert.equal(inside.allowed && inside.worktreeRoot, wt);
    const outside = decidePathAccess(config, repo, path.join(plain, "notes.txt"), "read");
    assert.equal(outside.allowed, false);
    assert.equal(outside.allowed === false && outside.code, "outside-roots");
  });
});

describe("content screen labeling in worktrees", () => {
  // The screen's clean-write label is the fast path for edits: without the
  // checkout-aware branch, a clean edit inside a linked worktree labels
  // modify-system (default ask) while the identical edit in cwd labels
  // modify-project (default allow) — observed live before this test existed.
  it("labels a clean write inside a linked worktree modify-project", () => {
    const verdict = screenWrite({ cwd: repo, target: path.join(wt, "src", "app.ts"), content: "export const ok = 1;\n" });
    assert.equal(verdict.tripped, false);
    assert.equal(verdict.label, "modify-project");
  });

  it("keeps modify-system for a clean write outside any session checkout", () => {
    const verdict = screenWrite({ cwd: repo, target: path.join(plain, "notes.txt"), content: "hello\n" });
    assert.equal(verdict.tripped, false);
    assert.equal(verdict.label, "modify-system");
  });
});
