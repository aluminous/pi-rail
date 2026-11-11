import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { decidePathAccess, isClassifierExemptRead, normalizeUserPath, scrubEnvironment } from "../src/policy.ts";
import { makeFixtureDir, testConfig } from "./helpers.ts";

const fixture = makeFixtureDir();
const cwd = fixture.dir;
after(() => fixture.cleanup());

function setup() {
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "app.ts"), "ok");
  writeFileSync(path.join(cwd, ".env"), "SECRET=1");
  writeFileSync(path.join(cwd, ".env.local"), "SECRET=1");
  writeFileSync(path.join(cwd, "cert.pem"), "---");
  mkdirSync(path.join(cwd, "outside"), { recursive: true });
}
setup();

describe("normalizeUserPath", () => {
  it("resolves relative paths against cwd", () => {
    assert.equal(normalizeUserPath(cwd, "src/app.ts"), path.join(cwd, "src", "app.ts"));
  });

  it("strips a leading @ prefix", () => {
    assert.equal(normalizeUserPath(cwd, "@src/app.ts"), path.join(cwd, "src", "app.ts"));
  });
});

describe("isClassifierExemptRead", () => {
  it("exempts reads inside the session cwd", () => {
    assert.equal(isClassifierExemptRead(testConfig(), cwd, "src/app.ts"), true);
  });

  it("does not exempt deny-matching reads even inside cwd", () => {
    assert.equal(isClassifierExemptRead(testConfig(), cwd, ".env"), false);
  });

  it("still consults the lists when filesystem enforcement is disabled", () => {
    const config = testConfig((c) => {
      c.filesystem.enabled = false;
    });
    assert.equal(isClassifierExemptRead(config, cwd, "src/app.ts"), true);
    assert.equal(isClassifierExemptRead(config, cwd, ".env"), false);
  });

  it("exempts reads matching an explicit allowRead entry outside cwd", () => {
    const config = testConfig((c) => {
      c.filesystem.allowRead = [path.join(cwd, "outside")];
    });
    writeFileSync(path.join(cwd, "outside", "notes.txt"), "ok");
    assert.equal(isClassifierExemptRead(config, cwd, path.join(cwd, "outside", "notes.txt")), true);
  });

  it("does not exempt unlisted reads outside cwd", () => {
    const config = testConfig();
    assert.equal(isClassifierExemptRead(config, path.join(cwd, "src"), path.join(cwd, "outside")), false);
  });

  it("does not exempt unresolvable paths", () => {
    assert.equal(isClassifierExemptRead(testConfig(), cwd, "no-such-file.txt"), false);
  });
});

describe("decidePathAccess read", () => {
  it("allows denied paths when filesystem restrictions are disabled", () => {
    const config = testConfig((c) => {
      c.filesystem.enabled = false;
    });
    assert.equal(decidePathAccess(config, cwd, ".env", "read").allowed, true);
  });

  it("allows normal project files in blacklist mode", () => {
    const decision = decidePathAccess(testConfig(), cwd, "src/app.ts", "read");
    assert.equal(decision.allowed, true);
  });

  it("denies .env by exact pattern", () => {
    const decision = decidePathAccess(testConfig(), cwd, ".env", "read");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "denied-by-pattern");
  });

  it("denies .env.local via the .env.* glob", () => {
    const decision = decidePathAccess(testConfig(), cwd, ".env.local", "read");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "denied-by-pattern");
  });

  it("denies *.pem by basename glob anywhere under cwd", () => {
    const decision = decidePathAccess(testConfig(), cwd, "cert.pem", "read");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "denied-by-pattern");
  });

  it("reports unresolvable for nonexistent read targets", () => {
    const decision = decidePathAccess(testConfig(), cwd, "no-such-file.txt", "read");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "unresolvable");
  });

  it("enforces whitelist mode when allowRead is non-empty", () => {
    const config = testConfig((c) => {
      c.filesystem.allowRead = [path.join(cwd, "src")];
    });
    assert.equal(decidePathAccess(config, cwd, "src/app.ts", "read").allowed, true);
    const outside = decidePathAccess(config, cwd, "cert.txt", "read");
    assert.equal(outside.allowed, false);
  });
});

describe("decidePathAccess write", () => {
  it("allows paths outside write roots when filesystem restrictions are disabled", () => {
    const config = testConfig((c) => {
      c.filesystem.enabled = false;
    });
    assert.equal(decidePathAccess(config, cwd, "/usr/local/pwned.txt", "write").allowed, true);
  });

  it("allows writes inside cwd via the '.' root", () => {
    const decision = decidePathAccess(testConfig(), cwd, "src/new-file.ts", "write");
    assert.equal(decision.allowed, true);
  });

  it("allows writes to nonexistent paths under an existing allowed parent", () => {
    const decision = decidePathAccess(testConfig(), cwd, "src/deep/nested/file.ts", "write");
    assert.equal(decision.allowed, true);
  });

  it("returns outside-roots for writes outside allowed roots", () => {
    const decision = decidePathAccess(testConfig(), cwd, "/usr/local/pwned.txt", "write");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "outside-roots");
  });

  it("denies write to configured deny patterns even inside cwd", () => {
    const decision = decidePathAccess(testConfig(), cwd, ".env", "write");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "denied-by-pattern");
  });

  it("canonicalizes symlinks so they cannot escape allowed roots", () => {
    const escapeTarget = path.join(cwd, "..", `pi-rail-escape-${process.pid}`);
    mkdirSync(escapeTarget, { recursive: true });
    symlinkSync(escapeTarget, path.join(cwd, "sneaky"));
    // Only cwd is writable, so the sibling dir the symlink points at is out of
    // roots — but the un-canonicalized path cwd/sneaky/out.txt looks inside cwd.
    const config = testConfig((c) => {
      c.filesystem.allowWrite = ["."];
    });
    const decision = decidePathAccess(config, cwd, "sneaky/out.txt", "write");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "outside-roots");
  });

  it("denies reads through symlinks that resolve into denied paths", () => {
    const secretDir = path.join(cwd, "secrets");
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(path.join(secretDir, "token.txt"), "s3cr3t");
    symlinkSync(path.join(secretDir, "token.txt"), path.join(cwd, "innocent.txt"));
    const config = testConfig((c) => {
      c.filesystem.denyRead = [secretDir];
    });
    const decision = decidePathAccess(config, cwd, "innocent.txt", "read");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "denied-by-pattern");
  });
});

describe("scrubEnvironment", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/Users/tester",
    LC_ALL: "en_US.UTF-8",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GITHUB_TOKEN: "gh-token",
    MY_APP_TOKEN: "app-token",
    RANDOM_VAR: "not-allowed",
  };

  it("passes everything not unset with the defaults (blacklist mode)", () => {
    const scrubbed = scrubEnvironment(env, testConfig());
    assert.equal(scrubbed.PATH, "/usr/bin");
    assert.equal(scrubbed.RANDOM_VAR, "not-allowed");
    assert.equal(scrubbed.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(scrubbed.GITHUB_TOKEN, undefined);
    assert.equal(scrubbed.MY_APP_TOKEN, undefined);
  });

  it("removes unset patterns and then whitelists with a non-empty allow list", () => {
    const config = testConfig((c) => {
      c.environment.allow = ["PATH", "HOME", "LC_*", "*_TOKEN"];
    });
    const scrubbed = scrubEnvironment(env, config);
    assert.equal(scrubbed.PATH, "/usr/bin");
    assert.equal(scrubbed.HOME, "/Users/tester");
    assert.equal(scrubbed.LC_ALL, "en_US.UTF-8");
    assert.equal(scrubbed.RANDOM_VAR, undefined);
    assert.equal(scrubbed.MY_APP_TOKEN, undefined, "unset wins over allow");
  });

  it("strips the approval mailbox, rg's config path, and password-style secrets by default", () => {
    const scrubbed = scrubEnvironment({
      PI_RAIL_APPROVAL_MAILBOX: "/agent/rail-approvals/x#token",
      RIPGREP_CONFIG_PATH: "/tmp/rgrc",
      DB_PASSWORD: "p",
      PGPASSWORD: "p",
      npm_config__authToken: "t",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      LESSKEY: "/etc/lesskey",
      JAVA_HOME: "/opt/jdk",
    }, testConfig());
    assert.deepEqual(Object.keys(scrubbed).sort(), ["JAVA_HOME", "LESSKEY", "SSH_AUTH_SOCK"]);
  });

  it("keeps AWS_CA_BUNDLE while dropping AWS credential variables with the defaults", () => {
    const caEnv = {
      AWS_CA_BUNDLE: "/etc/ssl/private-ca.pem",
      AWS_ACCESS_KEY_ID: "AKIA123",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_SESSION_TOKEN: "aws-session",
    };
    const scrubbed = scrubEnvironment(caEnv, testConfig());
    assert.equal(scrubbed.AWS_CA_BUNDLE, "/etc/ssl/private-ca.pem");
    assert.equal(scrubbed.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(scrubbed.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(scrubbed.AWS_SESSION_TOKEN, undefined);
  });

  it("passes CA-certificate variables with the defaults", () => {
    const caEnv = { JAVA_TOOL_OPTIONS: "-Djavax.net.ssl.trustStore=/etc/ssl/ca.jks", SSL_CERT_FILE: "/etc/ssl/ca.pem" };
    const scrubbed = scrubEnvironment(caEnv, testConfig());
    assert.equal(scrubbed.JAVA_TOOL_OPTIONS, "-Djavax.net.ssl.trustStore=/etc/ssl/ca.jks");
    assert.equal(scrubbed.SSL_CERT_FILE, "/etc/ssl/ca.pem");
  });
});
