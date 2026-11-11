import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startApprovalMailbox } from "../src/approval-mailbox.ts";
import type { CompleteFn } from "../src/classifier.ts";
import { mergeConfig } from "../src/config.ts";
import { interceptToolCall } from "../src/interceptor.ts";
import {
  appendCorpusDecision,
  buildCorpusRecord,
  corpusFileName,
  createCorpusWriter,
  pruneCorpus,
  readCorpus,
  redactCredentials,
  redactionPlaceholder,
  selectPrunable,
  type CorpusRecord,
  type CorpusWriter,
} from "../src/replay-corpus.ts";
import { parseShellCommand, type ShellScript } from "../src/shell-parse.ts";
import { createRuntimeState, type RuntimeState } from "../src/state.ts";
import { makeFixtureDir, testConfig, withTempAgentDirAsync } from "./helpers.ts";

const fixture = makeFixtureDir();
after(() => fixture.cleanup());

const MODEL = "openrouter/anthropic/claude-haiku-4.5";
// Credential-shaped test values. Built by concatenation so this file is not
// itself a credential-shaped blob to anything scanning the repo.
const AWS_KEY = `AKIA${"IOSFODNN7EXAMPLE"}`;
const GITHUB_TOKEN = `ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`;
const AWS_SECRET = `wJalrXUtnFEMI/K7MDENG/${"bPxRfiCYEXAMPLEKEY"}`;
const JWT = `eyJ${"hbGciOiJIUzI1NiJ9"}.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"}`;

function fakeCtx(cwd: string): ExtensionContext & { aborted: boolean } {
  const ctx = {
    cwd,
    hasUI: false,
    mode: "print",
    aborted: false,
    abort() {
      ctx.aborted = true;
    },
    ui: { notify() {} },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    sessionManager: { getBranch: () => [] },
    signal: undefined,
  };
  return ctx as unknown as ExtensionContext & { aborted: boolean };
}

/** A ctx whose namer/judge model resolves, optionally answering asks in order. */
function reviewingCtx(cwd: string, answers?: string[]): ExtensionContext & { aborted: boolean } {
  const ctx = fakeCtx(cwd) as unknown as Record<string, any>;
  ctx.modelRegistry.find = () => ({ provider: "openrouter", id: "anthropic/claude-haiku-4.5" });
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-key" });
  if (answers) {
    ctx.hasUI = true;
    ctx.ui.custom = async () => ({ choice: answers.shift() ?? "Deny", comment: undefined });
    ctx.ui.select = async () => answers.shift() ?? "Deny";
  }
  return ctx as unknown as ExtensionContext & { aborted: boolean };
}

function scripted(steps: string[]): CompleteFn {
  return (async () => {
    const step = steps.shift();
    if (step === undefined) throw new Error("scripted complete exhausted");
    return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: step }], usage: { input: 10, output: 5 }, timestamp: Date.now() };
  }) as unknown as CompleteFn;
}

/** A recording writer: the interceptor tests care what was appended, not where. */
function capture(): { writer: CorpusWriter; records: CorpusRecord[] } {
  const records: CorpusRecord[] = [];
  return { writer: { dir: "", append: (record) => records.push(record) }, records };
}

function railState(overrides?: Parameters<typeof testConfig>[0]): { state: RuntimeState; records: CorpusRecord[] } {
  const state = createRuntimeState();
  state.config = testConfig(overrides);
  state.enabled = true;
  state.initialized = true;
  const { writer, records } = capture();
  state.corpus = writer;
  return { state, records };
}

/** Per simple command: [assignments, argv words, redirects]. Equal shapes are what template matching sees as equal. */
function shape(command: string): number[][] {
  const parsed = parseShellCommand(command);
  assert.ok(parsed.ok, `expected ${command} to parse`);
  const out: number[][] = [];
  const walk = (script: ShellScript) => {
    for (const chain of script.chains) {
      for (const pipeline of chain.pipelines) {
        for (const cmd of pipeline.commands) {
          if (cmd.kind === "subshell") walk(cmd.body);
          else out.push([cmd.assignments.length, cmd.argv.length, cmd.redirects.length]);
        }
      }
    }
  };
  walk(parsed.script);
  return out;
}

describe("redactCredentials", () => {
  it("replaces each credential shape with a typed placeholder", () => {
    const cases: Array<[string, string]> = [
      [`aws configure set aws_access_key_id ${AWS_KEY}`, "aws-key"],
      [`git clone https://x:${GITHUB_TOKEN}@github.com/o/r`, "github-token"],
      [`curl -H "Authorization: Bearer ${JWT}" https://api.example.com`, "jwt"],
      [`export OPENAI_API_KEY=sk-${"proj1234567890abcdefghij"}`, "sk-key"],
      [`echo ${AWS_SECRET}`, "high-entropy"],
    ];
    for (const [command, kind] of cases) {
      const result = redactCredentials(command);
      assert.deepEqual(result.kinds, [kind], command);
      assert.ok(result.text.includes(redactionPlaceholder(kind)), result.text);
    }
  });

  it("covers the whole secret, not just the prefix the screen pattern matches", () => {
    const result = redactCredentials(`curl -H "Authorization: Bearer ${JWT}" x`);
    assert.equal(result.text, `curl -H "Authorization: Bearer ${redactionPlaceholder("jwt")}" x`, "the JWT signature goes too");
    const pem = redactCredentials(`printf '%s' '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----' > k`);
    assert.equal(pem.text, `printf '%s' '${redactionPlaceholder("private-key")}' > k`);
    const ssh = redactCredentials(`echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyBody me@host" >> keys`);
    assert.equal(ssh.text, `echo "ssh-ed25519 ${redactionPlaceholder("ssh-key")} me@host" >> keys`, "the algorithm word is structure and stays");
  });

  it("preserves the parsed shape: same commands, argv words, assignments, redirects", () => {
    const commands = [
      // A secret as its own argument.
      `aws configure set aws_access_key_id ${AWS_KEY}`,
      // A secret as the value of a leading assignment: it must stay an assignment.
      `GITHUB_TOKEN=${GITHUB_TOKEN} gh api /user`,
      `AWS_SECRET_ACCESS_KEY=${AWS_SECRET} aws s3 ls`,
      // Inside a quoted string.
      `curl -H "Authorization: Bearer ${JWT}" https://api.example.com | jq .`,
      // Inside a URL.
      `git clone https://x:${GITHUB_TOKEN}@github.com/o/r && cd r`,
      `curl "https://api.example.com/v1?key=${AWS_SECRET}" > out.json`,
      // A flag with an attached value.
      `deploy --token=${AWS_SECRET} --env prod`,
    ];
    for (const command of commands) {
      const result = redactCredentials(command);
      assert.ok(result.kinds.length > 0, `expected a redaction in ${command}`);
      assert.deepEqual(shape(result.text), shape(command), `${command} → ${result.text}`);
    }
    const assignment = redactCredentials(`GITHUB_TOKEN=${GITHUB_TOKEN} gh api /user`).text;
    const parsed = parseShellCommand(assignment);
    assert.ok(parsed.ok);
    const first = parsed.script.chains[0]!.pipelines[0]!.commands[0]!;
    assert.ok(first.kind === "command");
    assert.equal(first.assignments[0]?.name, "GITHUB_TOKEN", "the variable name survives");
    assert.match(redactCredentials(`deploy --token=${AWS_SECRET}`).text, /^deploy --token=‹redacted:high-entropy›$/, "the flag survives");
  });

  it("does not redact plain commands, hashes, or credential-store paths", () => {
    const plain = [
      "git status && npm test",
      "cat ~/.aws/credentials",
      "ssh -i ~/.ssh/id_ed25519 deploy@host",
      "security find-generic-password -s github ~/Library/Keychains/login.keychain-db",
      "git show 0123456789abcdef0123456789abcdef01234567",
      "ls /private/tmp/scratch-501/9f1c2d3e-5b6a-4c7d-8e9f-0a1b2c3d4e5f/work",
      "cat /Users/dev/Library/Application_Support/Code/User/workspaceStorage/state.json",
    ];
    for (const command of plain) assert.deepEqual(redactCredentials(command), { text: command, kinds: [] }, command);
  });
});

describe("redactCredentials: secrets found by context", () => {
  const named = redactionPlaceholder("named-secret");
  const auth = redactionPlaceholder("auth-token");

  it("redacts the value of a credential-named key, keeping the key and separator", () => {
    const cases: Array<[string, string]> = [
      ["API_KEY=hunter2 npm run deploy", `API_KEY=${named} npm run deploy`],
      ["deploy --password=abc --env prod", `deploy --password=${named} --env prod`],
      ["docker run -e DB_PASSWORD=x img", `docker run -e DB_PASSWORD=${named} img`],
      [`curl -H "password: x" https://h`, `curl -H "password: ${named}" https://h`],
      [`echo "API_KEY=hunter2 and more" > f`, `echo "API_KEY=${named} and more" > f`],
      [`curl -d '{"password":"p","user":"u"}' https://x`, `curl -d '{"password":"${named}","user":"u"}' https://x`],
      [`curl -d "{\\"password\\":\\"p\\",\\"user\\":\\"u\\"}" https://x`, `curl -d "{\\"password\\":\\"${named}\\",\\"user\\":\\"u\\"}" https://x`],
      ["curl 'https://x/?api_key=abc&b=2'", `curl 'https://x/?api_key=${named}&b=2'`],
      ["PASSWORD='p w' cmd", `PASSWORD='${named}' cmd`],
    ];
    for (const [command, expected] of cases) {
      const result = redactCredentials(command);
      assert.equal(result.text, expected, command);
      assert.deepEqual(result.kinds, ["named-secret"], command);
    }
  });

  it("redacts the credential after an authorization scheme, keeping the scheme", () => {
    assert.deepEqual(redactCredentials(`curl -H "Authorization: Bearer abc123" https://x`), { text: `curl -H "Authorization: Bearer ${auth}" https://x`, kinds: ["auth-token"] });
    assert.equal(redactCredentials("curl -H 'authorization: basic dXNlcjpwYXNz' x").text, `curl -H 'authorization: basic ${auth}' x`, "the scheme is case-insensitive");
    assert.deepEqual(redactCredentials("echo a basic setup"), { text: "echo a basic setup", kinds: [] }, "prose after the scheme word is not a token");
  });

  it("leaves expansions, empty values, and space-separated flags alone", () => {
    const untouched = [
      "API_KEY=$FOO x",
      "API_KEY=${FOO} x",
      "API_KEY=$(pass show k) x",
      'API_KEY="$FOO" x',
      'curl -H "Authorization: Bearer $TOKEN" x',
      "curl -H \"Authorization: Bearer ${TOKEN}\" x",
      "PASSWORD= x",
      'grep "password=" src/',
      "deploy --password abc",
      "grep password src/",
      "grep -rn password src/ | head",
    ];
    for (const command of untouched) assert.deepEqual(redactCredentials(command), { text: command, kinds: [] }, command);
    // A value that runs into an expansion keeps the expansion an expansion.
    assert.equal(redactCredentials("PASSWORD=ab$X cmd").text, `PASSWORD=${named}$X cmd`);
  });

  it("does not re-redact a value a shape pattern already replaced", () => {
    assert.deepEqual(redactCredentials(`OPENAI_API_KEY=sk-${"proj1234567890abcdefghij"} x`).kinds, ["sk-key"]);
    assert.deepEqual(redactCredentials(`curl -H "Authorization: Bearer ${JWT}" x`).kinds, ["jwt"]);
  });

  it("preserves the parsed shape", () => {
    const commands = [
      "API_KEY=hunter2 npm run deploy",
      "deploy --password=abc --env prod",
      `echo "API_KEY=hunter2 and more" > f && cat f`,
      `curl -H "Authorization: Bearer abc123" https://x`,
      `curl -d '{"password":"p","user":"u"}' https://x`,
      `curl -d "{\\"password\\":\\"p\\"}" https://x | jq .`,
      "PASSWORD=ab$X cmd",
    ];
    for (const command of commands) {
      const result = redactCredentials(command);
      assert.ok(result.kinds.length > 0, `expected a redaction in ${command}`);
      assert.deepEqual(shape(result.text), shape(command), `${command} → ${result.text}`);
    }
    const parsed = parseShellCommand(redactCredentials("API_KEY=hunter2 npm run deploy").text);
    assert.ok(parsed.ok);
    const first = parsed.script.chains[0]!.pipelines[0]!.commands[0]!;
    assert.ok(first.kind === "command");
    assert.equal(first.assignments[0]?.name, "API_KEY", "still an assignment");
    const expansion = parseShellCommand(redactCredentials("PASSWORD=ab$X cmd").text);
    assert.ok(expansion.ok);
    const assigned = expansion.script.chains[0]!.pipelines[0]!.commands[0]!;
    assert.ok(assigned.kind === "command");
    assert.deepEqual(assigned.assignments[0]?.value.parts.map((part) => part.kind), ["literal", "expansion"], "the expansion part survives");
  });
});

describe("buildCorpusRecord", () => {
  const at = new Date("2026-11-11T10:00:00.000Z");

  it("keeps a bash command whole and unredacted when it holds no secret", () => {
    const command = `git worktree remove ../pi-rail-maint && ${"echo padding ".repeat(30)}rm -rf ~/dev`;
    const record = buildCorpusRecord({ kind: "review", tool: "bash", cwd: "/repo", input: { command, timeout: 30 }, labels: ["local-destructive"], outcome: "ask" }, at);
    assert.equal(record.input.command, command, "no truncation: replay needs the half after the 120th char");
    assert.equal(record.redacted, undefined);
    assert.equal(record.redactions, undefined);
    assert.equal(record.named, false);
    assert.equal(record.namerLabels, undefined);
    assert.equal(record.screenTripped, undefined, "absent: the screen never looked");
  });

  it("marks a redacted record and lists its kinds", () => {
    const record = buildCorpusRecord({ kind: "review", tool: "bash", cwd: "/repo", input: { command: `X=${AWS_KEY} y ${GITHUB_TOKEN}` }, outcome: "deny" }, at);
    assert.equal(record.redacted, true);
    assert.deepEqual(record.redactions, ["github-token", "aws-key"]);
    assert.ok(!JSON.stringify(record).includes(AWS_KEY));
    assert.ok(!JSON.stringify(record).includes(GITHUB_TOKEN));
  });

  it("stores a write's hash and length, never its content", () => {
    const content = `const key = "${AWS_KEY}";\n// héllo`;
    const record = buildCorpusRecord({ kind: "review", tool: "write", cwd: "/repo", input: { path: "/repo/src/a.ts", content }, screenTripped: true, outcome: "ask" }, at);
    assert.equal(record.input.path, "/repo/src/a.ts");
    assert.equal(record.input.content?.bytes, Buffer.byteLength(content, "utf-8"));
    assert.match(record.input.content?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(record.screenTripped, true);
    assert.ok(!JSON.stringify(record).includes("héllo"));
    assert.equal(record.redacted, undefined, "nothing was redacted because nothing of the content was kept");
  });

  it("stores an edit's replacement-text hash and edit count, never the texts", () => {
    const record = buildCorpusRecord({ kind: "review", tool: "edit", cwd: "/repo", input: { path: "a.ts", edits: [{ oldText: "secret-old", newText: "secret-new" }] }, outcome: "allow" }, at);
    assert.equal(record.input.editCount, 1);
    assert.ok(record.input.content);
    assert.ok(!JSON.stringify(record).includes("secret-"));
  });

  it("keeps the forwarded marker and drops falsy optionals", () => {
    const forwarded = buildCorpusRecord({ kind: "approval", tool: "write", cwd: "/r", input: { path: "/x" }, outcome: "allow", userAnswer: "approved", forwarded: true }, at);
    assert.equal(forwarded.forwarded, true);
    const local = buildCorpusRecord({ kind: "approval", tool: "write", cwd: "/r", input: { path: "/x" }, outcome: "allow", userAnswer: "approved", forwarded: false }, at);
    assert.equal("forwarded" in local, false);
  });
});

describe("interceptor corpus records", () => {
  const cwd = path.join(fixture.dir, "project");
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "app.ts"), "ok");

  it("records a deterministic bash review with the full command and no namer", async () => {
    const { state, records } = railState((c) => {
      c.capabilities.classes = [{ id: "k8s-ops", name: "Cluster ops", definition: "Cluster operations.", default: "deny" }];
      c.commands.classify = [{ template: "kubectl *", capability: "k8s-ops" }];
    });
    const command = `kubectl delete pod ${"api-".repeat(60)}x`;
    const result = await interceptToolCall({ toolName: "bash", input: { command } }, fakeCtx(cwd), state);
    assert.equal(result?.block, true);
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.v, 1);
    assert.equal(record.kind, "review");
    assert.equal(record.tool, "bash");
    assert.equal(record.cwd, cwd);
    assert.equal(record.input.command, command, "full command, unlike telemetry's 120-char target");
    assert.deepEqual(record.labels, ["k8s-ops"]);
    assert.equal(record.named, false);
    assert.equal(record.resolvedDisposition, "deny");
    assert.equal(record.decidedBy, "k8s-ops");
    assert.equal(record.outcome, "deny");
    assert.equal(record.userAnswer, undefined);
    assert.ok(!Number.isNaN(Date.parse(record.at)));
  });

  it("records namer labels when the namer supplied them", async () => {
    const { state, records } = railState((c) => {
      c.classifier.enabled = true;
      c.classifier.model = MODEL;
    });
    await interceptToolCall({ toolName: "bash", input: { command: "make lint" } }, reviewingCtx(cwd), state, scripted(['{"labels":["run-dev-tools"]}']));
    const record = records.at(-1)!;
    assert.equal(record.named, true);
    assert.deepEqual(record.namerLabels, ["run-dev-tools"]);
    assert.deepEqual(record.labels, ["run-dev-tools"]);
  });

  it("records the user's answer and the judge's verdict", async () => {
    const { state, records } = railState((c) => {
      c.classifier.enabled = true;
      c.classifier.model = MODEL;
      c.classifier.judgeModel = MODEL;
      c.capabilities.classes = [{ id: "k8s-ops", name: "Cluster ops", definition: "Cluster operations.", default: "judge" }];
      c.commands.classify = [{ template: "kubectl *", capability: "k8s-ops" }];
    });
    await interceptToolCall(
      { toolName: "bash", input: { command: "kubectl apply -f deploy.yaml" } },
      reviewingCtx(cwd, ["Allow"]),
      state,
      scripted(['{"decision":"ask","action":"applies a deployment","risk":"cluster state"}']),
    );
    const record = records.at(-1)!;
    assert.deepEqual(record.judge, { verdict: "ask" });
    assert.equal(record.resolvedDisposition, "judge");
    assert.equal(record.userAnswer, "approved");
    assert.equal(record.outcome, "allow");
    assert.equal(record.reason, undefined, "free-text reasons that could quote the command are not kept for reviews");
  });

  it("records a read review with its full path", async () => {
    const { state, records } = railState();
    await interceptToolCall({ toolName: "read", input: { path: "src/app.ts" } }, fakeCtx(cwd), state);
    const record = records.at(-1)!;
    assert.equal(record.tool, "read");
    assert.deepEqual(record.input, { path: "src/app.ts" });
    assert.deepEqual(record.labels, ["read-project"]);
    assert.equal(record.outcome, "allow");
  });

  it("records a write review with the screen verdict and no content", async () => {
    const { state, records } = railState();
    const content = "export const banner = 'hello from the corpus test';\n";
    await interceptToolCall({ toolName: "write", input: { path: path.join(cwd, "src", "b.ts"), content } }, fakeCtx(cwd), state);
    const record = records.at(-1)!;
    assert.equal(record.tool, "write");
    assert.equal(record.input.path, path.join(cwd, "src", "b.ts"));
    assert.equal(record.input.content?.bytes, Buffer.byteLength(content));
    assert.equal(record.screenTripped, false, "false, not absent: the screen looked and found it clean");
    assert.deepEqual(record.labels, ["modify-project"]);
    assert.ok(!JSON.stringify(record).includes("hello from the corpus test"));
  });

  it("records deterministic policy blocks with the full target", async () => {
    const { state, records } = railState((c) => {
      c.classifier.enabled = false;
    });
    const target = path.join(cwd, ".env");
    const result = await interceptToolCall({ toolName: "write", input: { path: target, content: "SECRET=1" } }, fakeCtx(cwd), state);
    assert.equal(result?.block, true);
    const record = records.at(-1)!;
    assert.equal(record.kind, "block");
    assert.equal(record.outcome, "block");
    assert.equal(record.input.path, target);
    assert.ok(record.input.content, "the write's content is hashed, not kept");
    assert.ok(record.reason?.includes(target));
  });

  it("records read-only blocks", async () => {
    const { state, records } = railState();
    state.readOnly = true;
    await interceptToolCall({ toolName: "write", input: { path: "src/c.ts", content: "x" } }, fakeCtx(cwd), state);
    assert.equal(records.at(-1)?.kind, "block");
    assert.match(records.at(-1)?.reason ?? "", /read-only mode/);
  });

  it("records a capability-routed path ask that nobody could answer, without a user answer", async () => {
    const { state, records } = railState((c) => {
      c.classifier.enabled = false;
      c.filesystem.allowWrite = ["."];
    });
    const outside = path.join(fixture.dir, "outside-write.txt");
    const result = await interceptToolCall({ toolName: "write", input: { path: outside, content: "x" } }, fakeCtx(cwd), state);
    assert.equal(result?.block, true);
    assert.equal(records.length, 1, "the path dialog is the whole decision: one record");
    const record = records[0]!;
    assert.equal(record.kind, "approval");
    assert.equal(record.access, "write");
    assert.equal(record.input.path, outside);
    assert.deepEqual(record.labels, ["modify-system"]);
    assert.equal(record.named, false);
    assert.equal(record.resolvedDisposition, "ask");
    assert.equal(record.decidedBy, "modify-system");
    assert.equal(record.screenTripped, false);
    assert.equal(record.outcome, "deny");
    assert.equal(record.userAnswer, undefined, "no dialog was shown, so no answer");
  });

  it("keeps the forwarded marker for an answer from the parent session", async () => {
    await withTempAgentDirAsync(async () => {
      const parentState = createRuntimeState();
      parentState.lastUiContext = { hasUI: true } as ExtensionContext;
      const ask = (async () => ({ kind: "answered", answer: { approved: true }, forwarded: false })) as unknown as Parameters<typeof startApprovalMailbox>[0]["ask"];
      const mailbox = startApprovalMailbox({ state: parentState, ask, env: process.env, pollMs: 20 });
      assert.ok(mailbox);
      try {
        const { state, records } = railState((c) => {
          c.classifier.enabled = false;
          c.filesystem.allowWrite = ["."];
        });
        const outside = path.join(fixture.dir, "forwarded-write.txt");
        const result = await interceptToolCall({ toolName: "write", input: { path: outside, content: "x" } }, fakeCtx(cwd), state);
        assert.equal(result, undefined);
        const record = records.at(-1)!;
        assert.equal(record.forwarded, true);
        assert.equal(record.userAnswer, "approved");
        assert.equal(record.outcome, "allow");

        // The repeat is answered by session path memory: recorded, marked remembered.
        await interceptToolCall({ toolName: "write", input: { path: outside, content: "y" } }, fakeCtx(cwd), state);
        assert.equal(records.at(-1)?.remembered, true);
        assert.equal(records.at(-1)?.userAnswer, undefined);
      } finally {
        mailbox.stop();
      }
    });
  });

  it("writes nothing when corpus.enabled is false or the rail is off", async () => {
    const off = railState((c) => {
      c.corpus.enabled = false;
    });
    await interceptToolCall({ toolName: "read", input: { path: "src/app.ts" } }, fakeCtx(cwd), off.state);
    assert.equal(off.records.length, 0);

    const railOff = railState();
    railOff.state.enabled = false;
    appendCorpusDecision(railOff.state, { kind: "block", tool: "write", cwd, input: { path: "x" }, outcome: "block" });
    assert.equal(railOff.records.length, 0);

    const configOff = railState((c) => {
      c.enabled = false;
    });
    appendCorpusDecision(configOff.state, { kind: "block", tool: "write", cwd, input: { path: "x" }, outcome: "block" });
    assert.equal(configOff.records.length, 0);
  });

  it("is independent of the telemetry tier", async () => {
    const { state, records } = railState((c) => {
      c.classifier.telemetry = "off";
    });
    await interceptToolCall({ toolName: "read", input: { path: "src/app.ts" } }, fakeCtx(cwd), state);
    assert.equal(records.length, 1);
  });

  it("swallows writer failures without changing the decision", async () => {
    const { state } = railState();
    state.corpus = {
      dir: "",
      append() {
        throw new Error("disk full");
      },
    };
    const result = await interceptToolCall({ toolName: "read", input: { path: "src/app.ts" } }, fakeCtx(cwd), state);
    assert.equal(result, undefined);
    assert.equal(state.stats.classifierSkips, 1);
  });
});

describe("corpus config", () => {
  it("defaults on, merges a boolean, and diagnoses anything else", () => {
    assert.equal(testConfig().corpus.enabled, true);
    assert.equal(mergeConfig(testConfig(), { corpus: { enabled: false } }, "/x/rail.json").corpus.enabled, false);
    const bad = mergeConfig(testConfig(), { corpus: { enabled: "no" as unknown as boolean } }, "/x/rail.json");
    assert.equal(bad.corpus.enabled, true);
    assert.ok(bad.diagnostics.some((line) => line.includes("/x/rail.json.corpus.enabled")));
    const notObject = mergeConfig(testConfig(), { corpus: true as unknown as { enabled: boolean } }, "/x/rail.json");
    assert.ok(notObject.diagnostics.some((line) => line.includes("/x/rail.json.corpus: expected an object")));
  });
});

describe("corpus store", () => {
  let counter = 0;
  const freshDir = () => path.join(fixture.dir, `corpus-${++counter}`, "rail-corpus");
  const record = (at: string): CorpusRecord => buildCorpusRecord({ kind: "block", tool: "write", cwd: "/r", input: { path: "/x" }, outcome: "block" }, new Date(at));

  it("names files by UTC month", () => {
    assert.equal(corpusFileName(new Date("2026-11-30T23:59:59.999Z")), "2026-11.jsonl");
    assert.equal(corpusFileName(new Date("2026-12-01T00:00:00.000Z")), "2026-12.jsonl");
  });

  it("appends one line per record into the record's month file, with private permissions", () => {
    const dir = freshDir();
    const writer = createCorpusWriter({ dir });
    writer.append(record("2026-11-11T10:00:00.000Z"));
    writer.append(record("2026-11-12T10:00:00.000Z"));
    writer.append(record("2026-12-01T00:00:01.000Z"));
    assert.deepEqual(readdirSync(dir).sort(), ["2026-11.jsonl", "2026-12.jsonl"]);
    assert.equal(readFileSync(path.join(dir, "2026-11.jsonl"), "utf-8").split("\n").filter(Boolean).length, 2);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(dir, "2026-11.jsonl")).mode & 0o777, 0o600);
  });

  it("tightens an existing directory to 0700", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    createCorpusWriter({ dir }).append(record("2026-11-11T10:00:00.000Z"));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it("selects month files past the age cap and past the size cap, never the newest for size", () => {
    const now = new Date("2026-11-11T00:00:00Z");
    const caps = { maxBytes: 100, maxAgeMonths: 12 };
    const files = [
      { name: "2026-11.jsonl", bytes: 60 },
      { name: "2026-10.jsonl", bytes: 30 },
      { name: "2026-09.jsonl", bytes: 30 }, // 120 > 100: pruned for size
      { name: "2025-12.jsonl", bytes: 1 }, // oldest kept by age, but past the size cap already
      { name: "2025-11.jsonl", bytes: 1 }, // exactly 12 months back: pruned for age
      { name: "notes.txt", bytes: 9999 }, // not ours
    ];
    assert.deepEqual(selectPrunable(files, now, caps).sort(), ["2025-11.jsonl", "2025-12.jsonl", "2026-09.jsonl"]);
    assert.deepEqual(selectPrunable([{ name: "2026-11.jsonl", bytes: 10_000 }], now, caps), [], "the current month survives the size cap");
    assert.deepEqual(selectPrunable([{ name: "2025-12.jsonl", bytes: 1 }], now, caps), [], "within age");
    assert.deepEqual(selectPrunable([{ name: "2024-01.jsonl", bytes: 1 }], now, caps), ["2024-01.jsonl"], "an old lone file goes by age");
  });

  it("prunes on the first append only, once per writer", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "2020-01.jsonl"), "{}\n");
    writeFileSync(path.join(dir, "keep.txt"), "not ours");
    const writer = createCorpusWriter({ dir, now: () => new Date("2026-11-11T00:00:00Z") });
    writer.append(record("2026-11-11T10:00:00.000Z"));
    assert.deepEqual(readdirSync(dir).sort(), ["2026-11.jsonl", "keep.txt"]);
    writeFileSync(path.join(dir, "2020-02.jsonl"), "{}\n");
    writer.append(record("2026-11-11T10:00:01.000Z"));
    assert.ok(readdirSync(dir).includes("2020-02.jsonl"), "no prune on the hot path after the first write");
  });

  it("prunes by size through the directory", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "2026-11.jsonl"), "x".repeat(80));
    writeFileSync(path.join(dir, "2026-10.jsonl"), "x".repeat(80));
    assert.deepEqual(pruneCorpus(dir, new Date("2026-11-11T00:00:00Z"), { maxBytes: 100, maxAgeMonths: 12 }), ["2026-10.jsonl"]);
    assert.deepEqual(readdirSync(dir), ["2026-11.jsonl"]);
    assert.deepEqual(pruneCorpus(path.join(dir, "missing"), new Date(), { maxBytes: 1, maxAgeMonths: 1 }), [], "never throws");
  });

  it("swallows write failures", () => {
    const blocker = path.join(fixture.dir, "corpus-blocker");
    writeFileSync(blocker, "a file where the directory should be");
    const writer = createCorpusWriter({ dir: path.join(blocker, "rail-corpus") });
    writer.append(record("2026-11-11T10:00:00.000Z"));
  });

  it("reads records back, skipping malformed and foreign lines", () => {
    const dir = freshDir();
    const writer = createCorpusWriter({ dir });
    writer.append(record("2026-10-01T00:00:00.000Z"));
    writer.append(record("2026-11-01T00:00:00.000Z"));
    appendFileSync(path.join(dir, "2026-11.jsonl"), `not json\n{"v":2,"at":"x","tool":"bash","kind":"review","input":{},"outcome":"allow"}\n[1]\n{"v":1}\n\n{"torn":\n`);
    writer.append(record("2026-11-02T00:00:00.000Z"));
    writeFileSync(path.join(dir, "README"), "ignored");
    const records = readCorpus(dir);
    assert.deepEqual(records.map((entry) => entry.at), ["2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z"]);
    assert.deepEqual(readCorpus(path.join(dir, "missing")), []);
  });
});
