import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClassifierModelUnavailableError,
  ClassifierRetryableError,
  JUDGE_SYSTEM_PROMPT,
  NAMER_SYSTEM_PROMPT,
  buildJudgeText,
  buildNamerText,
  classifierRetryClass,
  classifyClassifierFailure,
  describeClassifierFailure,
  isModelUnavailableError,
  isRetryableClassifierError,
  parseJudgeResult,
  parseNamerResult,
  projectToolCall,
  retryFailureKind,
  tagClassifierFailure,
} from "../src/classifier-protocol.ts";
import { capabilityRegistry, capabilityRegistryIds } from "../src/capabilities.ts";
import { testConfig } from "./helpers.ts";

/** The stock taxonomy: no config classes, no session edits. */
const REGISTRY = capabilityRegistry(undefined, undefined);
const BUILTIN_IDS = capabilityRegistryIds(REGISTRY);

/** parseNamerResult against the stock registry; custom-vocabulary cases pass their own id set. */
const parseStock = (text: string) => parseNamerResult(text, BUILTIN_IDS);

describe("namer system prompt", () => {
  it("keeps the namer out of the decision business", () => {
    assert.match(NAMER_SYSTEM_PROMPT, /You decide nothing/);
    assert.match(NAMER_SYSTEM_PROMPT, /No prose, no decisions, no risk scores/);
  });

  it("states that write content is part of the action", () => {
    assert.match(NAMER_SYSTEM_PROMPT, /the CONTENT is part of the action/);
  });

  it("bounds authorization evidence to decoration", () => {
    assert.match(NAMER_SYSTEM_PROMPT, /never removes one/);
  });
});

describe("judge system prompt", () => {
  it("is ask-preferred and reserves deny for what confirmation cannot fix", () => {
    assert.match(JUDGE_SYSTEM_PROMPT, /Prefer ask/);
    assert.match(JUDGE_SYSTEM_PROMPT, /stay unsafe even after the user confirms them/);
  });

  it("is explicitly per-action", () => {
    assert.match(JUDGE_SYSTEM_PROMPT, /never a standing approval/);
  });
});

describe("parseNamerResult", () => {
  it("parses labels and optional authorization evidence", () => {
    const result = parseStock('{"labels":["network-fetch","modify-project"],"authorizationEvidence":"download the schema"}');
    assert.deepEqual(result.labels, ["network-fetch", "modify-project"]);
    assert.equal(result.authorizationEvidence, "download the schema");
  });

  it("extracts JSON embedded in prose or code fences", () => {
    assert.deepEqual(parseStock('Here you go:\n```json\n{"labels":["read-project"]}\n```').labels, ["read-project"]);
  });

  it("drops unknown class ids rather than failing the protocol", () => {
    assert.deepEqual(parseStock('{"labels":["read-project","prod-deploy"]}').labels, ["read-project"]);
  });

  it("falls back to unclassified when nothing valid is left", () => {
    assert.deepEqual(parseStock('{"labels":[]}').labels, ["unclassified"]);
    assert.deepEqual(parseStock('{"labels":["nonsense"]}').labels, ["unclassified"]);
  });

  it("deduplicates repeated labels", () => {
    assert.deepEqual(parseStock('{"labels":["credentials","credentials"]}').labels, ["credentials"]);
  });

  it("accepts a custom class the registry knows about", () => {
    const withCustom = new Set([...BUILTIN_IDS, "touches-customer-data"]);
    assert.deepEqual(parseNamerResult('{"labels":["touches-customer-data"]}', withCustom).labels, ["touches-customer-data"]);
    // The same label against the stock registry is not vocabulary, so it drops.
    assert.deepEqual(parseStock('{"labels":["touches-customer-data"]}').labels, ["unclassified"]);
  });

  it("drops a label whose class was deleted out from under the call", () => {
    const shrunk = new Set([...BUILTIN_IDS].filter((id) => id !== "network-fetch"));
    assert.deepEqual(parseNamerResult('{"labels":["network-fetch","read-project"]}', shrunk).labels, ["read-project"]);
  });

  it("fails closed on schema violations", () => {
    assert.throws(() => parseStock('{"labels":"read-project"}'), /invalid namer labels/);
    assert.throws(() => parseStock('{"labels":[1,2]}'), /invalid namer labels/);
    assert.throws(() => parseStock("looks safe to me"), /did not return JSON/);
  });

  it("drops a malformed authorizationEvidence instead of failing closed", () => {
    const parsed = parseStock('{"labels":["read-project"],"authorizationEvidence":42}');
    assert.deepEqual(parsed.labels, ["read-project"]);
    assert.equal(parsed.authorizationEvidence, undefined);
  });
});

describe("parseJudgeResult", () => {
  it("parses a well-formed verdict", () => {
    const result = parseJudgeResult('{"decision":"ask","reason":"push to a remote you did not name"}');
    assert.equal(result.decision, "ask");
    assert.equal(result.reason, "push to a remote you did not name");
  });

  it("rejects unknown decisions and blank reasons instead of guessing", () => {
    assert.throws(() => parseJudgeResult('{"decision":"maybe","reason":"x"}'), /invalid judge decision/);
    assert.throws(() => parseJudgeResult('{"decision":"allow","reason":"  "}'), /invalid judge reason/);
  });
});

describe("error classification", () => {
  it("classifies transport failures as retryable", () => {
    assert.equal(isRetryableClassifierError(new Error("fetch failed: ECONNRESET")), true);
    assert.equal(isRetryableClassifierError(new Error("429 rate limit exceeded")), true);
    assert.equal(isRetryableClassifierError(new Error("request timed out")), true);
  });

  it("retries invalid reviewer output: the retry feeds the reply back, so the reviewer can fix itself", () => {
    assert.equal(isRetryableClassifierError(new Error("reviewer did not return JSON")), true);
    assert.equal(isRetryableClassifierError(new Error("invalid namer labels: expected an array")), true);
    assert.equal(isRetryableClassifierError(new Error("invalid judge decision")), true);
  });

  it("separates the retry that needs a delay from the one that does not", () => {
    // Something remote has to clear before the next attempt can differ.
    for (const message of ["503 Service Unavailable", "429 rate limit exceeded", "request timed out", "fetch failed: ECONNRESET", "getaddrinfo ENOTFOUND api.example.com"]) {
      assert.equal(classifierRetryClass(new Error(message)), "delayed", message);
    }
    // The call already completed; only the reply was wrong, and the next
    // attempt carries the correction. Sleeping would be latency for nothing.
    for (const message of ["reviewer did not return JSON", "invalid namer labels: expected an array", "invalid judge decision"]) {
      assert.equal(classifierRetryClass(new Error(message)), "immediate", message);
    }
    // A second identical attempt fails identically.
    for (const message of ["400 invalid request body", "401 Unauthorized", "model not found: foo/bar", "classifier review aborted"]) {
      assert.equal(classifierRetryClass(new Error(message)), "fatal", message);
    }
  });

  it("classifies a V8 JSON SyntaxError as an invalid response, whatever the release calls it", () => {
    // The wording moved between node releases; these are node 20+ phrasings,
    // and treating one as a generic error would make it terminal on attempt 1.
    for (const broken of ['{"labels":["read-project"],}', '{labels: ["read-project"]}', '{"labels":["read-project"] "x":1}']) {
      let thrown: unknown;
      try {
        parseStock(broken);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, `expected ${broken} to throw`);
      assert.equal(classifyClassifierFailure(thrown).category, "invalid response", broken);
      assert.equal(isRetryableClassifierError(thrown), true, broken);
    }
  });

  it("classifies auth/model failures as unavailable", () => {
    assert.equal(isModelUnavailableError(new Error("401 Unauthorized")), true);
    assert.equal(isModelUnavailableError(new Error("model not found: foo/bar")), true);
    assert.equal(isModelUnavailableError(new Error("ECONNRESET")), false);
  });

  it("retries provider 5xx, which is the incident the loop exists for", () => {
    for (const message of ["503 Service Unavailable", "502 Bad Gateway", "500 internal server error", "529 overloaded_error", "Overloaded"]) {
      assert.equal(isRetryableClassifierError(new Error(message)), true, message);
    }
    assert.equal(isRetryableClassifierError(Object.assign(new Error("upstream rejected"), { status: 503 })), true);
  });

  it("does not retry 4xx other than 429/408", () => {
    assert.equal(isRetryableClassifierError(new Error("400 invalid request body")), false);
    assert.equal(isRetryableClassifierError(new Error("401 Unauthorized")), false);
    assert.equal(isRetryableClassifierError(new Error("404 no such route")), false);
    assert.equal(isRetryableClassifierError(new Error("429 slow down")), true);
    assert.equal(isRetryableClassifierError(new Error("408 request timeout")), true);
  });

  it("finds the cause-buried code that the outer message hides", () => {
    const buried = (message: string, code: string) =>
      new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
    assert.equal(isRetryableClassifierError(buried("read ECONNRESET", "ECONNRESET")), true);
    assert.equal(retryFailureKind(buried("read ECONNRESET", "ECONNRESET")), "connection: ECONNRESET");
    assert.equal(retryFailureKind(buried("getaddrinfo ENOTFOUND api.test", "ENOTFOUND")), "dns: ENOTFOUND");
    assert.equal(retryFailureKind(buried("connect ETIMEDOUT 1.2.3.4:443", "ETIMEDOUT")), "timeout: ETIMEDOUT");
  });

  it("does not mistake a port or a duration for an HTTP status", () => {
    const connect = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:443"), { code: "ETIMEDOUT" }) });
    assert.equal(classifyClassifierFailure(connect).category, "timeout");
    assert.equal(classifyClassifierFailure(new Error("reviewer timed out after 15000ms")).category, "timeout");
  });
});

describe("retryFailureKind", () => {
  it("names the HTTP status on a server error", () => {
    assert.equal(retryFailureKind(new Error("503 Service Unavailable")), "server error (503)");
    assert.equal(retryFailureKind(new Error("502 Bad Gateway")), "server error (502)");
    assert.equal(retryFailureKind(new Error("529 overloaded_error")), "server error (529)");
    assert.equal(retryFailureKind(Object.assign(new Error("upstream rejected"), { status: 500 })), "server error (500)");
    assert.equal(retryFailureKind(new Error("Overloaded")), "server error", "no status to name");
  });

  it("names the timeout budget when the rail's own deadline expired", () => {
    assert.equal(retryFailureKind(new ClassifierRetryableError("reviewer timed out after 15000ms", 15000)), "timeout after 15000ms");
    assert.equal(retryFailureKind(new Error("request timed out")), "timeout");
  });

  it("keeps the vague names only when nothing more specific is knowable", () => {
    assert.equal(retryFailureKind(new Error("socket hang up")), "connection/network");
    assert.equal(retryFailureKind(new Error("getaddrinfo failed")), "dns/network");
    assert.equal(retryFailureKind(new Error("429 slow down")), "rate limit");
  });

  it("names non-transport failures for what they are", () => {
    assert.equal(retryFailureKind(new Error("reviewer did not return JSON")), "invalid response");
    assert.equal(retryFailureKind(new Error("400 invalid request body")), "client error (400)");
    assert.equal(retryFailureKind(new Error("401 Unauthorized")), "auth rejected");
    assert.equal(retryFailureKind(new ClassifierModelUnavailableError("No API key for openrouter")), "no api key");
    assert.equal(retryFailureKind(new Error("classifier review aborted")), "aborted");
  });

  it("buckets kinds for the by-kind counters", () => {
    assert.equal(classifyClassifierFailure(new Error("503 Service Unavailable")).category, "server error");
    assert.equal(classifyClassifierFailure(new Error("504 Gateway Timeout")).category, "server error");
    assert.equal(classifyClassifierFailure(new ClassifierRetryableError("reviewer timed out after 15000ms", 15000)).category, "timeout");
    assert.equal(classifyClassifierFailure(new Error("boom")).category, "error");
  });
});

describe("describeClassifierFailure", () => {
  it("reads kind, model, attempts, then the enriched detail", () => {
    const error = tagClassifierFailure(new ClassifierRetryableError("reviewer timed out after 15000ms", 15000), {
      attempts: 5,
      maxAttempts: 5,
      model: "openrouter/anthropic/claude-haiku-4.5",
    });
    assert.equal(
      describeClassifierFailure(error),
      "timeout after 15000ms on openrouter/anthropic/claude-haiku-4.5 after 5 attempts: reviewer timed out after 15000ms",
    );
  });

  it("carries the cause chain into the detail", () => {
    const error = tagClassifierFailure(new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }), {
      attempts: 3,
      maxAttempts: 5,
      model: "test/fake",
    });
    assert.equal(describeClassifierFailure(error), "connection: ECONNRESET on test/fake after 3 attempts: fetch failed ← read ECONNRESET");
  });

  it("falls back to the caller's model and omits attempts it never learned", () => {
    assert.equal(describeClassifierFailure(new Error("boom"), { model: "test/fake" }), "error on test/fake: boom");
    assert.equal(describeClassifierFailure(new Error("boom")), "error: boom");
  });

  it("survives a frozen error without losing the message", () => {
    const frozen = Object.freeze(new Error("503 Service Unavailable"));
    tagClassifierFailure(frozen, { attempts: 2, maxAttempts: 5, model: "test/fake" });
    assert.equal(describeClassifierFailure(frozen), "server error (503): 503 Service Unavailable");
  });
});

describe("projectToolCall", () => {
  it("truncates write content in the projection", () => {
    const projection = projectToolCall("write", { path: "a.txt", content: "x".repeat(1500) }, "/repo", testConfig());
    const prefix = projection.inputSummary.contentPrefix as string;
    assert.ok(prefix.includes("truncated 500 chars"));
    assert.equal(projection.inputSummary.contentLength, 1500);
  });

  it("caps projected edits at three", () => {
    const edits = Array.from({ length: 5 }, (_, i) => ({ oldText: `old ${i}`, newText: `new ${i}` }));
    const projection = projectToolCall("edit", { path: "a.txt", edits }, "/repo", testConfig());
    assert.equal(projection.inputSummary.editCount, 5);
    assert.equal((projection.inputSummary.edits as unknown[]).length, 3);
  });

  it("marks tools outside the registry as unrecognized", () => {
    const projection = projectToolCall("fetch", { url: "https://example.com" }, "/repo", testConfig());
    assert.equal(projection.inputSummary.note, "unrecognized tool");
    assert.deepEqual(projection.inputSummary.keys, ["url"]);
  });

  it("includes the policy summary for reviewer context", () => {
    const projection = projectToolCall("bash", { command: "ls" }, "/repo", testConfig());
    assert.ok(projection.policySummary.some((line) => line.startsWith("Backend:")));
  });

  it("tells the reviewer when hard restriction layers are disabled", () => {
    const config = testConfig((c) => {
      c.filesystem.enabled = false;
      c.network.enabled = false;
    });
    const projection = projectToolCall("bash", { command: "ls" }, "/repo", config);
    assert.ok(projection.policySummary.includes("Filesystem restrictions: disabled (unrestricted)"));
    assert.ok(projection.policySummary.includes("Network restrictions: disabled (unrestricted)"));
  });
});

describe("review payloads", () => {
  it("leads the namer payload with the static class definitions and ends with pendingAction", () => {
    const projection = projectToolCall("bash", { command: "ls" }, "/repo", testConfig());
    const payload = JSON.parse(buildNamerText(REGISTRY, ["please run ls"], projection));
    assert.deepEqual(Object.keys(payload), ["capabilityClasses", "activePolicy", "cwd", "recentUserMessages", "pendingAction"]);
    assert.equal(payload.capabilityClasses.length, 12);
    assert.deepEqual(payload.recentUserMessages, ["please run ls"]);
  });

  it("injects session guidance only when present", () => {
    const projection = projectToolCall("bash", { command: "npm run deploy" }, "/repo", testConfig());
    const guidance = ["User allowed bash (npm run deploy) with comment: staging deploys are fine"];
    const withGuidance = JSON.parse(buildNamerText(REGISTRY, [], projection, guidance));
    assert.deepEqual(withGuidance.userSessionGuidance, guidance);
    assert.equal("userSessionGuidance" in JSON.parse(buildNamerText(REGISTRY, [], projection)), false);
  });

  it("gives the judge the rail's recent decisions and the namer's labels", () => {
    const projection = projectToolCall("bash", { command: "git push --force origin main" }, "/repo", testConfig());
    const payload = JSON.parse(
      buildJudgeText({
        registry: REGISTRY,
        recentUserMessages: ["tidy up the history"],
        projection,
        recentGuardDecisions: ["deny bash (off-machine-effects): user denied a force push"],
        labels: ["off-machine-effects", "local-destructive"],
        authorizationEvidence: "tidy up the history",
      }),
    );
    assert.deepEqual(Object.keys(payload), ["capabilityClasses", "activePolicy", "cwd", "recentUserMessages", "recentGuardDecisions", "pendingAction"]);
    assert.deepEqual(payload.pendingAction.capabilityLabels, ["off-machine-effects", "local-destructive"]);
    assert.equal(payload.pendingAction.authorizationEvidence, "tidy up the history");
    assert.equal(payload.recentGuardDecisions.length, 1);
  });

  it("keeps the payload prefix byte-stable across calls so provider prompt caches can hit", () => {
    const config = testConfig();
    const guidance = ["User allowed bash (npm test) with comment: fine"];
    const a = buildNamerText(REGISTRY, ["same turn message"], projectToolCall("bash", { command: "npm test" }, "/repo", config), guidance);
    const b = buildNamerText(REGISTRY, ["same turn message"], projectToolCall("write", { path: "src/x.ts", content: "export {}" }, "/repo", config), guidance);
    const divergence = a.indexOf('"pendingAction"');
    assert.ok(divergence > 0);
    assert.equal(a.slice(0, divergence), b.slice(0, divergence));
  });
});
