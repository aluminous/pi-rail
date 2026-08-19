import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_COMMAND_ALLOWLIST,
  DEFAULT_COMMAND_ALLOW_RULES,
  capabilityForTemplate,
  commandTemplateProblem,
  describeSegmentMatch,
  explainCommandMatch,
  isCommandAllowlisted,
  matchedCapabilities,
} from "../src/command-allowlist.ts";

const GREP = ["grep *"];

describe("isCommandAllowlisted", () => {
  it("allows chains only when every segment matches some rule", () => {
    assert.equal(isCommandAllowlisted("grep a || grep b", GREP), true);
    assert.equal(isCommandAllowlisted("grep a; risky-other-command", GREP), false);
    assert.equal(isCommandAllowlisted("grep a && ls -la && rm x", ["grep *", "ls *"]), false);
    assert.equal(isCommandAllowlisted("grep a\ngrep b", GREP), true);
  });

  it("allows pipes when both sides match", () => {
    assert.equal(isCommandAllowlisted("grep a | head -5", ["grep *", "head *"]), true);
    assert.equal(isCommandAllowlisted("grep a | head -5", GREP), false);
  });

  it("respects quotes: quoted separators are data, unquoted ones split", () => {
    assert.equal(isCommandAllowlisted('grep "a;b"', GREP), true);
    assert.equal(isCommandAllowlisted("grep 'a && b'", GREP), true);
    assert.equal(isCommandAllowlisted("grep 'a' ; rm x", GREP), false);
    assert.equal(isCommandAllowlisted("grep a\\; rm x", GREP), true, "escaped ; is an ordinary argument");
  });

  it("rejects expansions anywhere in argv or assignments", () => {
    assert.equal(isCommandAllowlisted("grep $(whoami)", GREP), false);
    assert.equal(isCommandAllowlisted("grep `whoami`", GREP), false);
    assert.equal(isCommandAllowlisted("grep $HOME", GREP), false);
    assert.equal(isCommandAllowlisted("grep ${PATTERN} file", GREP), false);
    assert.equal(isCommandAllowlisted('grep "pre $(whoami) post"', GREP), false);
    assert.equal(isCommandAllowlisted("FOO=$(whoami) grep a", GREP), false);
  });

  it("rejects redirects, background jobs, and subshells", () => {
    assert.equal(isCommandAllowlisted("grep a > out.txt", GREP), false);
    assert.equal(isCommandAllowlisted("grep a >> out.txt", GREP), false);
    assert.equal(isCommandAllowlisted("grep a 2>&1", GREP), false);
    assert.equal(isCommandAllowlisted("grep a < in.txt", GREP), false);
    assert.equal(isCommandAllowlisted("grep a &", GREP), false);
    assert.equal(isCommandAllowlisted("(grep a)", GREP), false);
  });

  it("rejects anything that fails to parse", () => {
    assert.equal(isCommandAllowlisted("grep 'a", GREP), false);
    assert.equal(isCommandAllowlisted("cat <<EOF\nx\nEOF", ["cat *"]), false);
    assert.equal(isCommandAllowlisted("grep a <(ls)", GREP), false);
  });

  it("compares the head verbatim without path resolution", () => {
    assert.equal(isCommandAllowlisted("/usr/bin/grep foo", GREP), false);
    assert.equal(isCommandAllowlisted("grepx foo", GREP), false);
  });

  it("matches bare-word, multi-word, and trailing-* templates", () => {
    assert.equal(isCommandAllowlisted("pwd", ["pwd"]), true);
    assert.equal(isCommandAllowlisted("pwd -P", ["pwd"]), false);
    assert.equal(isCommandAllowlisted("git status", ["git status *"]), true);
    assert.equal(isCommandAllowlisted("git status --short", ["git status *"]), true);
    assert.equal(isCommandAllowlisted("git stash", ["git status *"]), false);
    assert.equal(isCommandAllowlisted("grep", GREP), true, "* allows zero args");
  });

  it("matches quoted heads after quote removal", () => {
    assert.equal(isCommandAllowlisted("'grep' foo", GREP), true);
  });

  it("skips env-style leading assignments before the head", () => {
    assert.equal(isCommandAllowlisted("LC_ALL=C grep foo", GREP), true);
    assert.equal(isCommandAllowlisted("FOO=1", GREP), false, "bare assignment has no head to judge");
  });

  it("does not allow empty commands or match with an empty rule list", () => {
    assert.equal(isCommandAllowlisted("", GREP), false);
    assert.equal(isCommandAllowlisted("grep a", []), false);
  });

  it("keeps risky git subcommands outside the read-only defaults", () => {
    assert.equal(isCommandAllowlisted("git log --oneline -5", DEFAULT_COMMAND_ALLOWLIST), true);
    assert.equal(isCommandAllowlisted("git push origin main", DEFAULT_COMMAND_ALLOWLIST), false);
  });

  it("pins the read-only spellings in the expanded defaults", () => {
    // Exact read-only forms pass; the mutating spellings of the same tools don't.
    assert.equal(isCommandAllowlisted("git remote -v", DEFAULT_COMMAND_ALLOWLIST), true);
    assert.equal(isCommandAllowlisted("git remote add origin git@github.com:x/y.git", DEFAULT_COMMAND_ALLOWLIST), false);
    assert.equal(isCommandAllowlisted("git stash list", DEFAULT_COMMAND_ALLOWLIST), true);
    assert.equal(isCommandAllowlisted("git stash drop", DEFAULT_COMMAND_ALLOWLIST), false);
    assert.equal(isCommandAllowlisted("git tag", DEFAULT_COMMAND_ALLOWLIST), true);
    assert.equal(isCommandAllowlisted("git tag v1.0.0", DEFAULT_COMMAND_ALLOWLIST), false);
    assert.equal(isCommandAllowlisted("git config --get user.name", DEFAULT_COMMAND_ALLOWLIST), true);
    assert.equal(isCommandAllowlisted("git config user.name Mallory", DEFAULT_COMMAND_ALLOWLIST), false);
    assert.equal(isCommandAllowlisted("env", DEFAULT_COMMAND_ALLOWLIST), true);
    assert.equal(isCommandAllowlisted("env rm -rf /", DEFAULT_COMMAND_ALLOWLIST), false);
    assert.equal(isCommandAllowlisted("date", DEFAULT_COMMAND_ALLOWLIST), true);
    assert.equal(isCommandAllowlisted("date -s 2020-01-01", DEFAULT_COMMAND_ALLOWLIST), false);
    // Write-capable classics stay out entirely.
    assert.equal(isCommandAllowlisted("sed -n 1p file.txt", DEFAULT_COMMAND_ALLOWLIST), false);
    assert.equal(isCommandAllowlisted("find . -name '*.ts'", DEFAULT_COMMAND_ALLOWLIST), false);
    assert.equal(isCommandAllowlisted("sort data.txt", DEFAULT_COMMAND_ALLOWLIST), false);
    // Chained inspection built from the new entries.
    assert.equal(isCommandAllowlisted("du -sh node_modules | sort -h", DEFAULT_COMMAND_ALLOWLIST), false);
    assert.equal(isCommandAllowlisted("git rev-parse HEAD && git describe --tags", DEFAULT_COMMAND_ALLOWLIST), true);
    assert.equal(isCommandAllowlisted("cat package.json | jq .scripts", DEFAULT_COMMAND_ALLOWLIST), true);
  });
});

describe("capability tags", () => {
  const caps = (command: string) => matchedCapabilities(explainCommandMatch(command, { allow: DEFAULT_COMMAND_ALLOWLIST }));

  it("tags inspection as read-project and machine probes as read-system", () => {
    assert.deepEqual(caps("grep foo src"), ["read-project"]);
    assert.deepEqual(caps("uname -a"), ["read-system"]);
  });

  it("tags toolchain probes as run-dev-tools", () => {
    assert.deepEqual(caps("node --version"), ["run-dev-tools"]);
  });

  it("tags stash create/reapply as modify-project and keeps drop/clear off the list", () => {
    assert.deepEqual(caps("git stash"), ["modify-project"]);
    assert.deepEqual(caps('git stash push -m "wip"'), ["modify-project"]);
    assert.deepEqual(caps("git stash push"), ["modify-project"], "trailing * covers the bare subcommand");
    assert.deepEqual(caps("git stash pop"), ["modify-project"]);
    assert.deepEqual(caps("git stash apply stash@{1}"), ["modify-project"]);
    assert.deepEqual(caps("git stash show -p"), ["read-project"]);
    assert.equal(isCommandAllowlisted("git stash drop", DEFAULT_COMMAND_ALLOWLIST), false);
    assert.equal(isCommandAllowlisted("git stash drop stash@{0}", DEFAULT_COMMAND_ALLOWLIST), false);
    assert.equal(isCommandAllowlisted("git stash clear", DEFAULT_COMMAND_ALLOWLIST), false);
    assert.equal(isCommandAllowlisted("git stash branch topic", DEFAULT_COMMAND_ALLOWLIST), false);
  });

  it("unions the tags across chain segments", () => {
    assert.deepEqual(caps("git status && node --version && whoami"), ["read-project", "run-dev-tools", "read-system"]);
  });

  it("gives no labels to a command that is not allowlisted", () => {
    assert.deepEqual(caps("curl example.com"), []);
  });

  it("defaults user-configured templates to read-project", () => {
    assert.equal(capabilityForTemplate("make lint"), "read-project");
    assert.equal(capabilityForTemplate("npm ls *"), "run-dev-tools");
  });

  it("keeps every default template tagged", () => {
    assert.equal(DEFAULT_COMMAND_ALLOW_RULES.length, DEFAULT_COMMAND_ALLOWLIST.length);
    assert.ok(DEFAULT_COMMAND_ALLOW_RULES.every((rule) => rule.capability.length > 0));
  });
});

describe("commands.classify matching", () => {
  const K8S = [{ template: "kubectl *", capability: "k8s-ops" }];

  it("tags a segment with the rule's capability and says the rule was a user one", () => {
    const match = explainCommandMatch("kubectl get pods", { classify: K8S, allow: DEFAULT_COMMAND_ALLOWLIST });
    assert.equal(match.matched, true);
    assert.deepEqual(matchedCapabilities(match), ["k8s-ops"]);
    assert.equal(match.segments[0]?.source, "classify");
    assert.equal(describeSegmentMatch(match.segments[0]!), "`kubectl get pods` → classify rule `kubectl *` (k8s-ops)");
  });

  it("checks user rules before the allowlist, so a built-in template can be re-classified", () => {
    const rules = { classify: [{ template: "git log *", capability: "off-machine-effects" }], allow: DEFAULT_COMMAND_ALLOWLIST };
    const match = explainCommandMatch("git log --oneline", rules);
    assert.deepEqual(matchedCapabilities(match), ["off-machine-effects"]);
    assert.equal(match.matched === true && match.segments[0]!.source, "classify");
    // The allowlist still owns everything the user did not re-map.
    assert.deepEqual(matchedCapabilities(explainCommandMatch("git status", rules)), ["read-project"]);
  });

  it("takes the first matching rule when two classify rules overlap", () => {
    const classify = [
      { template: "kubectl get *", capability: "read-system" },
      { template: "kubectl *", capability: "k8s-ops" },
    ];
    assert.deepEqual(matchedCapabilities(explainCommandMatch("kubectl get pods", { classify, allow: [] })), ["read-system"]);
    assert.deepEqual(matchedCapabilities(explainCommandMatch("kubectl delete pod x", { classify, allow: [] })), ["k8s-ops"]);
  });

  it("unions classify and allowlist tags across a chain", () => {
    const match = explainCommandMatch("git status && kubectl get pods && kubectl top nodes", { classify: K8S, allow: DEFAULT_COMMAND_ALLOWLIST });
    assert.deepEqual(matchedCapabilities(match), ["read-project", "k8s-ops"]);
  });

  it("gives no labels at all when one segment matches nothing", () => {
    const match = explainCommandMatch("kubectl get pods && terraform apply", { classify: K8S, allow: DEFAULT_COMMAND_ALLOWLIST });
    assert.equal(match.matched, false);
    assert.deepEqual(matchedCapabilities(match), []);
    assert.match(match.matched === false ? match.reason : "", /`terraform apply`: no classify or allowlist rule matches/);
    // The matched half is still reported per segment, for the trace — it just carries no labels.
    assert.equal(match.segments?.[0]?.capability, "k8s-ops");
  });

  it("names only the allowlist in the refusal when no classify rules are configured", () => {
    const match = explainCommandMatch("terraform apply", { allow: DEFAULT_COMMAND_ALLOWLIST });
    assert.match(match.matched === false ? match.reason : "", /no allowlist rule matches/);
  });

  it("keeps the allowlist's conservatism: expansions, redirects, subshells, and background stay unmatchable", () => {
    const rules = { classify: K8S, allow: DEFAULT_COMMAND_ALLOWLIST };
    for (const command of ["kubectl get $(cat name)", "kubectl get pods > out.txt", "(kubectl get pods)", "kubectl get pods &", "kubectl get 'pods"]) {
      assert.equal(explainCommandMatch(command, rules).matched, false, command);
    }
  });

  it("matches with classify rules alone when the allowlist is empty", () => {
    assert.equal(explainCommandMatch("kubectl get pods", { classify: K8S, allow: [] }).matched, true);
    const empty = explainCommandMatch("kubectl get pods", { classify: [], allow: [] });
    assert.equal(empty.matched, false);
    assert.match(empty.matched === false ? empty.reason : "", /no command rules are configured/);
  });
});

describe("commandTemplateProblem", () => {
  it("accepts the grammar's real forms", () => {
    for (const template of ["pwd", "kubectl *", "git status *", "docker compose ps"]) {
      assert.equal(commandTemplateProblem(template), undefined, template);
    }
  });

  it("rejects an empty template, a bare *, and a * that is not last", () => {
    assert.match(commandTemplateProblem("")!, /non-empty/);
    assert.match(commandTemplateProblem("   ")!, /non-empty/);
    assert.match(commandTemplateProblem("*")!, /bare `\*` would match every command/);
    assert.match(commandTemplateProblem("* apply")!, /bare `\*` would match every command/);
    assert.match(commandTemplateProblem("kubectl * pods")!, /only means "any arguments" as the last word/);
  });
});
