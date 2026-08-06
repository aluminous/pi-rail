// The same filesystem config is enforced by two engines: src/policy.ts for Pi's
// file tools (in-process) and the Seatbelt profile for bash (via sandbox-runtime).
// Both consume compileFilesystemPolicy; these tests pin down that the two deny
// the same sensitive locations and that every pattern the sandbox cannot express
// is declared in the compiled policy's `degraded` list rather than silently
// weakened. A fake HOME keeps everything off the developer's real machine.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { getSeatbeltRuntimeConfig } from "../src/backends/seatbelt.ts";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import { compileFilesystemPolicy, decidePathAccess, resolveConfigPath, type FilesystemListName } from "../src/policy.ts";
import { makeFixtureDir, testConfig } from "./helpers.ts";

const fixture = makeFixtureDir();
const fakeHome = path.join(fixture.dir, "home");
const cwd = path.join(fixture.dir, "repo");
const originalHome = process.env.HOME;

// Home-relative deny patterns shared faithfully by both engines; glob and
// bare-name patterns cannot be, and must show up in compileFilesystemPolicy's
// degraded list instead (pinned by the invariants below).
const homeDenyPatterns = ["~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.docker", "~/.netrc"];

before(() => {
  process.env.HOME = fakeHome;
  mkdirSync(cwd, { recursive: true });
  for (const pattern of homeDenyPatterns) {
    const target = path.join(fakeHome, pattern.slice(2));
    if (pattern.endsWith("rc")) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "secret");
    } else {
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, "credential"), "secret");
    }
  }
});

after(() => {
  process.env.HOME = originalHome;
  fixture.cleanup();
});

describe("policy and seatbelt agree on default deny paths", () => {
  it("policy denies reads under every home-relative deny pattern", () => {
    const config = testConfig();
    for (const pattern of homeDenyPatterns) {
      const target = pattern.endsWith("rc")
        ? path.join(fakeHome, pattern.slice(2))
        : path.join(fakeHome, pattern.slice(2), "credential");
      const decision = decidePathAccess(config, cwd, target, "read");
      assert.equal(decision.allowed, false, `policy should deny read of ${target}`);
      assert.equal(decision.allowed === false && decision.code, "denied-by-pattern", `expected pattern denial for ${target}`);
    }
  });

  it("seatbelt receives the same paths in its deny list and credential files", () => {
    const runtime = getSeatbeltRuntimeConfig(testConfig(), cwd);
    const denyRead = (runtime.filesystem as { denyRead: string[] }).denyRead;
    const credentialPaths = (runtime.credentials as { files: Array<{ path: string; mode: string }> }).files.map((f) => f.path);
    for (const pattern of homeDenyPatterns) {
      const expanded = path.join(fakeHome, pattern.slice(2));
      assert.ok(denyRead.includes(expanded), `seatbelt denyRead should include ${expanded}`);
      assert.ok(credentialPaths.includes(expanded), `seatbelt credential files should include ${expanded}`);
    }
  });

  it("seatbelt write allowlist matches the policy write roots for cwd and temp", () => {
    const config = testConfig();
    const runtime = getSeatbeltRuntimeConfig(config, cwd);
    const allowWrite = (runtime.filesystem as { allowWrite: string[] }).allowWrite;
    assert.ok(allowWrite.includes(cwd), "seatbelt should allow writes to cwd");
    const policyDecision = decidePathAccess(config, cwd, "new-file.txt", "write");
    assert.equal(policyDecision.allowed, true, "policy should allow writes inside cwd");
  });

  it("both engines scrub non-wildcard credential env vars", () => {
    const config = testConfig();
    const runtime = getSeatbeltRuntimeConfig(config, cwd);
    const envDenials = (runtime.credentials as { envVars: Array<{ name: string }> }).envVars.map((v) => v.name);
    assert.ok(envDenials.includes("GITHUB_TOKEN"));
    assert.ok(envDenials.includes("ANTHROPIC_API_KEY"));
  });

  it("disables filesystem enforcement in both engines", () => {
    const config = testConfig((c) => {
      c.filesystem.enabled = false;
    });
    assert.equal(decidePathAccess(config, cwd, path.join(fakeHome, ".ssh", "credential"), "read").allowed, true);
    const runtime = getSeatbeltRuntimeConfig(config, cwd);
    assert.equal((runtime.filesystem as { disabled?: boolean }).disabled, true);
    assert.deepEqual((runtime.credentials as { files: unknown[] }).files, []);
  });

  it("omits the allowlist to disable network restrictions", () => {
    const config = testConfig((c) => {
      c.network.enabled = false;
    });
    const runtime = getSeatbeltRuntimeConfig(config, cwd);
    assert.equal(Object.hasOwn(runtime.network, "allowedDomains"), false);
    assert.deepEqual(runtime.network.deniedDomains, []);
  });

  it("keeps an empty allowlist when network restrictions should deny all", () => {
    const config = testConfig((c) => {
      c.network.enabled = true;
      c.network.allowedDomains = [];
      c.network.deniedDomains = ["*"];
    });
    const runtime = getSeatbeltRuntimeConfig(config, cwd);
    assert.equal(Object.hasOwn(runtime.network, "allowedDomains"), true);
    assert.deepEqual(runtime.network.allowedDomains, []);
    assert.deepEqual(runtime.network.deniedDomains, ["*"]);
  });

  it("backstops unmatched hosts with strictAllowlist, never a deny-all entry", () => {
    // Regression: sandbox-runtime checks denies BEFORE allows, so the old
    // default of deniedDomains ["*"] denied every host — including the 26
    // allowed ones. gh surfaced it as "the token in keyring is invalid" after
    // the proxy 403'd its api.github.com validation call.
    assert.deepEqual(DEFAULT_CONFIG.network.deniedDomains, []);
    const runtime = getSeatbeltRuntimeConfig(testConfig(), cwd);
    assert.equal(runtime.network.strictAllowlist, true);
    assert.deepEqual(runtime.network.deniedDomains, []);
    // A seatbelt.network override can still loosen the backstop deliberately.
    const loosened = testConfig((c) => {
      c.seatbelt = { network: { strictAllowlist: false } };
    });
    assert.equal(getSeatbeltRuntimeConfig(loosened, cwd).network.strictAllowlist, false);
  });

  it("grants the trustd mach-lookups TLS verification needs", () => {
    // Go binaries on macOS (gh and most cloud CLIs) verify certificates via
    // Security.framework → trustd XPC; denying the lookup fails every chain
    // build with OSStatus -26276, which tools then misreport.
    const runtime = getSeatbeltRuntimeConfig(testConfig(), cwd);
    assert.deepEqual(runtime.network.allowMachLookup, ["com.apple.trustd", "com.apple.trustd.agent"]);
  });
});

// The keychain is the one place the two engines deliberately disagree: bash
// needs to read it (macOS keychain lookups happen in the caller's process, so
// `security` and CLIs that store tokens there open the file themselves), while
// the file tools have no business reading the encrypted blob. See
// KEYCHAIN_READ_ALLOWLIST in src/backends/seatbelt.ts.
describe("keychain reads", () => {
  const keychainDir = path.join(fakeHome, "Library", "Keychains");
  const keychainFile = path.join(keychainDir, "login.keychain-db");

  before(() => {
    mkdirSync(keychainDir, { recursive: true });
    writeFileSync(keychainFile, "not-a-real-keychain");
  });

  const runtimeAllowRead = (config = testConfig()) =>
    (getSeatbeltRuntimeConfig(config, cwd).filesystem as { allowRead?: string[] }).allowRead ?? [];

  it("re-allows the keychain stores in the seatbelt read rules", () => {
    const allowRead = runtimeAllowRead();
    for (const store of [keychainDir, "/Library/Keychains", "/System/Library/Keychains"]) {
      assert.ok(allowRead.includes(store), `seatbelt allowRead should re-allow ${store}`);
    }
  });

  it("keeps the keychain denied for the file tools", () => {
    const decision = decidePathAccess(testConfig(), cwd, keychainFile, "read");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "denied-by-pattern");
  });

  it("does not broaden keychain writes", () => {
    const filesystem = getSeatbeltRuntimeConfig(testConfig(), cwd).filesystem as { allowWrite: string[]; denyRead: string[] };
    for (const store of [keychainDir, "/Library/Keychains", "/System/Library/Keychains"]) {
      assert.ok(!filesystem.allowWrite.includes(store), `seatbelt allowWrite must not include ${store}`);
    }
    // The re-allow lifts file-read* only; sandbox-runtime derives its
    // file-write-create/file-write-unlink move blocks from denyRead, so the
    // entry has to stay in that list for the write denial to survive.
    assert.ok(filesystem.denyRead.includes(keychainDir));
  });

  it("stands down when a config file denies the keychain itself", () => {
    const config = mergeConfig(testConfig(), { filesystem: { denyRead: ["~/Library/Keychains"] } }, "/tmp/rail.json");
    assert.ok(!runtimeAllowRead(config).includes(keychainDir), "a configured deny must not be read back");
    // The two system stores were never the user's deny, so they stay allowed.
    assert.ok(runtimeAllowRead(config).includes("/Library/Keychains"));
  });

  it("stands down for a broader configured deny that covers the keychain", () => {
    const config = mergeConfig(testConfig(), { filesystem: { denyRead: ["~/Library"] } }, "/tmp/rail.json");
    assert.ok(!runtimeAllowRead(config).includes(keychainDir));
  });

  it("still re-allows when a config file replaces denyRead without the keychain", () => {
    const config = mergeConfig(testConfig(), { filesystem: { denyRead: ["~/.ssh"] } }, "/tmp/rail.json");
    assert.ok(runtimeAllowRead(config).includes(keychainDir));
  });

  it("still re-allows when a config file only extends denyRead", () => {
    // The default keychain entry survives an extension with its "default"
    // provenance, which is what keeps the read-back applicable.
    const config = mergeConfig(testConfig(), { filesystem: { denyRead: { replace: false, values: ["~/.terraform.d"] } } }, "/tmp/rail.json");
    assert.ok(runtimeAllowRead(config).includes(keychainDir));
  });

  it("stands down when an extension adds the keychain deny itself", () => {
    const config = mergeConfig(testConfig(), { filesystem: { denyRead: { replace: false, values: [keychainDir] } } }, "/tmp/rail.json");
    assert.ok(!runtimeAllowRead(config).includes(keychainDir));
  });
});

describe("compiled filesystem policy invariants", () => {
  const lists: FilesystemListName[] = ["allowRead", "denyRead", "allowWrite", "denyWrite"];

  it("gives every configured pattern its resolved literal in the sandbox lists", () => {
    const compiled = compileFilesystemPolicy(testConfig(), cwd);
    for (const list of lists) {
      for (const pattern of compiled.patterns[list]) {
        assert.ok(compiled.sandboxPaths[list].includes(resolveConfigPath(cwd, pattern)), `${list} sandbox literal missing for ${pattern}`);
      }
    }
  });

  it("marks exactly the glob and bare-name patterns as degraded", () => {
    const compiled = compileFilesystemPolicy(testConfig(), cwd);
    for (const list of lists) {
      for (const pattern of compiled.patterns[list]) {
        // Independent oracle: only a non-glob pattern anchored at a path root
        // translates faithfully to a Seatbelt subpath literal.
        const isGlob = /[*?\[\]{}]/.test(pattern);
        const anchored = !isGlob && (pattern.includes("/") || pattern.startsWith("~") || path.isAbsolute(pattern) || pattern === ".");
        const entry = compiled.degraded.find((d) => d.list === list && d.pattern === pattern);
        if (anchored) {
          assert.equal(entry, undefined, `${list} pattern ${pattern} should not be degraded`);
        } else {
          assert.ok(entry, `${list} pattern ${pattern} must be listed as degraded`);
          assert.equal(entry.cause, isGlob ? "glob" : "basename");
          assert.equal(entry.sandboxPath, resolveConfigPath(cwd, pattern));
        }
      }
    }
  });

  it("feeds seatbelt the compiled literals verbatim", () => {
    const config = testConfig();
    const compiled = compileFilesystemPolicy(config, cwd);
    const runtime = getSeatbeltRuntimeConfig(config, cwd);
    const filesystem = runtime.filesystem as { denyRead: string[]; denyWrite: string[]; allowWrite: string[] };
    assert.deepEqual(filesystem.denyRead, compiled.sandboxPaths.denyRead);
    assert.deepEqual(filesystem.denyWrite, compiled.sandboxPaths.denyWrite);
    for (const literal of compiled.sandboxPaths.allowWrite) {
      assert.ok(filesystem.allowWrite.includes(literal), `seatbelt allowWrite should include ${literal}`);
    }
  });

  it("declares the gap the sandbox cannot cover: a nested .env only the policy engine denies", () => {
    const nested = path.join(cwd, "nested", ".env");
    mkdirSync(path.dirname(nested), { recursive: true });
    writeFileSync(nested, "SECRET=1");
    const config = testConfig();

    const decision = decidePathAccess(config, cwd, nested, "read");
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "denied-by-pattern");

    const compiled = compileFilesystemPolicy(config, cwd);
    const covered = compiled.sandboxPaths.denyRead.some((literal) => nested === literal || nested.startsWith(`${literal}/`));
    assert.equal(covered, false, "no sandbox literal covers the nested path");
    assert.ok(
      compiled.degraded.some((d) => d.list === "denyRead" && d.pattern === ".env" && d.cause === "basename"),
      "the uncovered pattern must be declared degraded",
    );
  });
});
