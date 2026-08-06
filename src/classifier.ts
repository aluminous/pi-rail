import { complete, type Message, type Model, type Api } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  capabilityRegistry,
  capabilityRegistryIds,
  getEffectiveDisposition,
  type CapabilityId,
  type CapabilityState,
} from "./capabilities.ts";
import type { ResolvedRailConfig } from "./config.ts";
import {
  buildJudgeText,
  buildNamerText,
  ClassifierModelUnavailableError,
  ClassifierRetryableError,
  isModelUnavailableError,
  isRetryableClassifierError,
  JUDGE_SYSTEM_PROMPT,
  NAMER_SYSTEM_PROMPT,
  parseJudgeResult,
  parseNamerResult,
  projectToolCall,
  retryFailureKind,
  tagClassifierFailure,
  type ClassifierTokenUsage,
  type RailDecision,
  type JudgeResult,
  type NamerResult,
} from "./classifier-protocol.ts";
import { resolveAutoClassifierModel } from "./classifier-models.ts";
import { screenLexiconSummary } from "./content-screen.ts";
import { formatError, textPrefix } from "./util.ts";

export {
  isClassifierModelUnavailable,
  projectToolCall,
  type RailDecision,
  type JudgeResult,
  type NamerResult,
  type ReviewProjection,
} from "./classifier-protocol.ts";

/** The last resolved decision, for the status panel. */
export interface LastRailDecision {
  toolName: string;
  at: number;
  labels: CapabilityId[];
  decision: RailDecision;
  reason: string;
}

export interface ClassifierState {
  enabledOverride?: boolean;
  modelOverride?: string;
  /**
   * Session override for the judge model, set by `/rail model` (judge tab) and
   * `/rail model judge …`. Wins over config.classifier.judgeModel. There is no
   * "off" here on purpose: the judge cannot be disabled, only re-pointed.
   */
  judgeModelOverride?: string;
  lastDecision?: LastRailDecision;
  lastError?: string;
  /**
   * Session-scoped, user-authored guidance collected from allow/deny-with-
   * comment answers to rail prompts. Injected into the namer and the judge.
   */
  sessionGuidance?: string[];
}

const SESSION_GUIDANCE_LIMIT = 12;

/** Records an allow/deny comment from a rail prompt as classifier guidance for the rest of the session. */
export function addSessionGuidance(state: ClassifierState, decision: "allowed" | "denied", toolName: string, subject: string, comment: string): void {
  const entry = `User ${decision} ${toolName} (${textPrefix(subject, 120)}) with comment: ${textPrefix(comment.trim(), 400)}`;
  state.sessionGuidance = [...(state.sessionGuidance ?? []), entry].slice(-SESSION_GUIDANCE_LIMIT);
}

/**
 * Guidance the user volunteered rather than one collected from an approval
 * answer (`/rail guide`). Same ring and same limit, so a session that talks a
 * lot to the rail still cannot grow the payload without bound.
 */
export function addUserGuidance(state: ClassifierState, text: string): void {
  const entry = `User guidance: ${textPrefix(text.trim(), 400)}`;
  state.sessionGuidance = [...(state.sessionGuidance ?? []), entry].slice(-SESSION_GUIDANCE_LIMIT);
}

/** Drops all session guidance; returns how many entries went away, for the notification. */
export function clearSessionGuidance(state: ClassifierState): number {
  const count = state.sessionGuidance?.length ?? 0;
  state.sessionGuidance = undefined;
  return count;
}

/** Guidance entries currently in the ring, and the cap they are counted against. */
export function sessionGuidanceCount(state: ClassifierState): { count: number; limit: number } {
  return { count: state.sessionGuidance?.length ?? 0, limit: SESSION_GUIDANCE_LIMIT };
}

export type CompleteFn = typeof complete;

export interface ClassifierAuthResult {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  error?: string;
}

/**
 * Everything the review flow needs from the outside world. Production code
 * adapts ExtensionContext via createClassifierIO; tests and the eval runner
 * provide scripted implementations.
 */
export interface ClassifierIO {
  cwd: string;
  signal: AbortSignal | undefined;
  complete: CompleteFn;
  getAuth(model: Model<Api>): Promise<ClassifierAuthResult>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  recentUserMessages(): string[];
  sleep(ms: number, signal: AbortSignal | undefined): Promise<void>;
}

function currentModel(ctx: ExtensionContext): Model<Api> | undefined {
  if (!ctx.model || ctx.model.provider === "unknown" || ctx.model.id === "unknown") return undefined;
  return ctx.model;
}

export function resolveClassifierModel(ctx: ExtensionContext, config: ResolvedRailConfig, state: ClassifierState): Model<Api> | undefined {
  return resolveModelSpec(ctx, state.modelOverride ?? config.classifier.model);
}

/**
 * The spec the judge will use: session override first, then config. Exported
 * so display surfaces label the same model the judge will actually reach for.
 */
export function judgeModelSpec(config: ResolvedRailConfig, state: ClassifierState): string {
  return state.judgeModelOverride ?? config.classifier.judgeModel;
}

/**
 * The judge runs rarely and on the consequential tail, so it defaults to
 * "current" — the session's own (strong) model — rather than the cheap namer
 * model. Same spec grammar as classifier.model.
 */
export function resolveJudgeModel(ctx: ExtensionContext, config: ResolvedRailConfig, state: ClassifierState): Model<Api> | undefined {
  return resolveModelSpec(ctx, judgeModelSpec(config, state));
}

function resolveModelSpec(ctx: ExtensionContext, spec: string): Model<Api> | undefined {
  if (spec === "auto") {
    // Best known-good model among those with configured auth; falls back to
    // the session's current model when none of the preferences is available.
    return resolveAutoClassifierModel(ctx.modelRegistry.getAvailable()) ?? currentModel(ctx);
  }
  if (spec === "current") return currentModel(ctx);
  const slash = spec.indexOf("/");
  if (slash <= 0) return undefined;
  return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
}

function recentUserMessagesFromSession(ctx: ExtensionContext): string[] {
  const entries = ctx.sessionManager.getBranch() as Array<Record<string, any>>;
  const users: string[] = [];
  for (const entry of entries.slice(-30)) {
    const message = entry.message;
    if (!message || message.role !== "user") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n");
    if (text.trim()) users.push(textPrefix(text.trim(), 1000));
  }
  return users.slice(-6);
}

export async function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw new Error("classifier review aborted");
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("classifier review aborted"));
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createClassifierIO(ctx: ExtensionContext, completeFn: CompleteFn = complete): ClassifierIO {
  return {
    cwd: ctx.cwd,
    signal: ctx.signal,
    complete: completeFn,
    getAuth: async (model) => {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      return auth.ok ? { ok: true, apiKey: auth.apiKey, headers: auth.headers } : { ok: false, error: auth.error };
    },
    notify: (message, level) => ctx.ui.notify(message, level),
    recentUserMessages: () => recentUserMessagesFromSession(ctx),
    sleep: defaultSleep,
  };
}

async function completeTextOnce(params: {
  model: Model<Api>;
  io: ClassifierIO;
  systemPrompt: string;
  text: string;
  timeoutMs: number;
}): Promise<{ text: string; usage?: ClassifierTokenUsage }> {
  const auth = await params.io.getAuth(params.model);
  if (!auth.ok || !auth.apiKey) throw new ClassifierModelUnavailableError(auth.ok ? `No API key for ${params.model.provider}` : auth.error ?? "auth failed");
  const message: Message = { role: "user", content: [{ type: "text", text: params.text }], timestamp: Date.now() };
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, params.timeoutMs);
  const onParentAbort = () => controller.abort();
  params.io.signal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    const response = await params.io.complete(
      params.model,
      { systemPrompt: params.systemPrompt, messages: [message] },
      { apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal },
    );
    if (response.stopReason === "aborted") {
      if (didTimeout) throw new ClassifierRetryableError(`reviewer timed out after ${params.timeoutMs}ms`, params.timeoutMs);
      throw new Error("classifier review aborted");
    }
    if (response.stopReason === "error") {
      // Surface the provider error so retry/unavailable classification sees
      // the real cause instead of a misleading JSON parse failure.
      throw new Error((response as { errorMessage?: string }).errorMessage ?? "provider returned an error with no message");
    }
    return {
      text: response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n"),
      usage: toClassifierUsage(response.usage),
    };
  } catch (error) {
    if (didTimeout) throw new ClassifierRetryableError(`reviewer timed out after ${params.timeoutMs}ms`, params.timeoutMs);
    if (params.io.signal?.aborted) throw new Error("classifier review aborted");
    if (isModelUnavailableError(error)) throw new ClassifierModelUnavailableError(formatError(error));
    throw error;
  } finally {
    clearTimeout(timeout);
    params.io.signal?.removeEventListener("abort", onParentAbort);
  }
}

interface RetryBudget {
  attempts: number;
  maxAttempts: number;
}

export function modelSpec(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

/**
 * One notification per failed attempt, carrying the kind, the cause-enriched
 * detail, and the backoff — there used to be a second, contentless "retry N/5"
 * line, which told the user a retry was happening without ever saying why.
 *
 * Every error that leaves this function is tagged with how many attempts it
 * burned and against which model, because the surfaces that report it (the
 * block reason, lastError, telemetry) are frames away from the budget.
 */
async function completeText(params: {
  model: Model<Api>;
  io: ClassifierIO;
  systemPrompt: string;
  text: string;
  timeoutMs: number;
  budget: RetryBudget;
}): Promise<{ text: string; usage?: ClassifierTokenUsage }> {
  while (params.budget.attempts < params.budget.maxAttempts) {
    params.budget.attempts++;
    const attempt = params.budget.attempts;
    try {
      return await completeTextOnce(params);
    } catch (error) {
      const terminal = error instanceof ClassifierModelUnavailableError || !isRetryableClassifierError(error) || attempt >= params.budget.maxAttempts;
      if (terminal) throw tagClassifierFailure(error, { attempts: attempt, maxAttempts: params.budget.maxAttempts, model: modelSpec(params.model) });
      const delayMs = 250 * 4 ** (attempt - 1);
      params.io.notify(
        `Rail classifier attempt ${attempt}/${params.budget.maxAttempts} failed (${retryFailureKind(error)}): ${formatError(error)}. Retrying in ${delayMs}ms.`,
        "warning",
      );
      await params.io.sleep(delayMs, params.io.signal);
    }
  }
  throw new Error("classifier retry loop exhausted");
}

/** Tags a post-response failure (a protocol violation) with the same attempt context transport failures get. */
function tagParseFailure<T>(error: T, model: Model<Api>, budget: RetryBudget): T {
  return tagClassifierFailure(error, { attempts: budget.attempts, maxAttempts: budget.maxAttempts, model: modelSpec(model) });
}

/**
 * pi-ai's Usage, narrowed to what the rail accounts for. `cost` is dollars and
 * is the one field a provider may not report at all; carrying it through as an
 * optional keeps "unpriced" distinguishable from "free" in the per-model view.
 */
function toClassifierUsage(usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined): ClassifierTokenUsage | undefined {
  if (!usage) return undefined;
  const cost = usage.cost?.total;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(typeof cost === "number" ? { costUsd: cost } : {}),
  };
}

function addUsage(total: ClassifierTokenUsage, part: ClassifierTokenUsage | undefined): void {
  total.input += part?.input ?? 0;
  total.output += part?.output ?? 0;
  total.cacheRead = (total.cacheRead ?? 0) + (part?.cacheRead ?? 0);
  total.cacheWrite = (total.cacheWrite ?? 0) + (part?.cacheWrite ?? 0);
  // Left undefined when no attempt was priced, so the review reads as unpriced
  // rather than as costing exactly nothing.
  if (typeof part?.costUsd === "number") total.costUsd = (total.costUsd ?? 0) + part.costUsd;
}

/**
 * The namer: ONE model call that labels an action against the taxonomy. The
 * injectable IO boundary is the entry point for orchestration tests and the
 * offline eval runner.
 */
export async function runNaming(params: {
  io: ClassifierIO;
  model: Model<Api>;
  config: ResolvedRailConfig;
  toolName: string;
  input: unknown;
  sessionGuidance?: string[];
  /** Session taxonomy edits; folded into the registry the namer is shown and validated against. */
  capabilities?: CapabilityState;
}): Promise<NamerResult> {
  const projection = projectToolCall(params.toolName, params.input, params.io.cwd, params.config);
  const registry = capabilityRegistry(params.config, params.capabilities);
  const budget: RetryBudget = { attempts: 0, maxAttempts: 5 };
  const usage: ClassifierTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const response = await completeText({
    model: params.model,
    io: params.io,
    systemPrompt: NAMER_SYSTEM_PROMPT,
    text: buildNamerText(registry, params.io.recentUserMessages(), projection, params.sessionGuidance ?? []),
    timeoutMs: params.config.classifier.timeoutMs,
    budget,
  });
  addUsage(usage, response.usage);
  try {
    const named = parseNamerResult(response.text, capabilityRegistryIds(registry));
    return { ...named, tokenUsage: usage, attempts: budget.attempts };
  } catch (error) {
    throw tagParseFailure(error, params.model, budget);
  }
}

/** The judge: the escalation review the `judge` disposition delegates to. */
export async function runJudging(params: {
  io: ClassifierIO;
  model: Model<Api>;
  config: ResolvedRailConfig;
  toolName: string;
  input: unknown;
  labels: CapabilityId[];
  authorizationEvidence?: string;
  sessionGuidance?: string[];
  recentGuardDecisions?: string[];
  capabilities?: CapabilityState;
}): Promise<JudgeResult> {
  const projection = projectToolCall(params.toolName, params.input, params.io.cwd, params.config);
  const budget: RetryBudget = { attempts: 0, maxAttempts: 5 };
  const usage: ClassifierTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const response = await completeText({
    model: params.model,
    io: params.io,
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    text: buildJudgeText({
      registry: capabilityRegistry(params.config, params.capabilities),
      recentUserMessages: params.io.recentUserMessages(),
      projection,
      sessionGuidance: params.sessionGuidance,
      recentGuardDecisions: params.recentGuardDecisions ?? [],
      labels: params.labels,
      authorizationEvidence: params.authorizationEvidence,
    }),
    timeoutMs: params.config.classifier.timeoutMs,
    budget,
  });
  addUsage(usage, response.usage);
  try {
    return { ...parseJudgeResult(response.text), tokenUsage: usage, attempts: budget.attempts };
  } catch (error) {
    throw tagParseFailure(error, params.model, budget);
  }
}

export async function nameToolCall(params: {
  ctx: ExtensionContext;
  config: ResolvedRailConfig;
  state: ClassifierState;
  toolName: string;
  input: unknown;
  completeFn?: CompleteFn;
  capabilities?: CapabilityState;
}): Promise<NamerResult> {
  const model = resolveClassifierModel(params.ctx, params.config, params.state);
  if (!model) throw new ClassifierModelUnavailableError(`Classifier model not found: ${params.state.modelOverride ?? params.config.classifier.model}`);
  return runNaming({
    io: createClassifierIO(params.ctx, params.completeFn),
    model,
    config: params.config,
    toolName: params.toolName,
    input: params.input,
    sessionGuidance: params.state.sessionGuidance,
    capabilities: params.capabilities,
  });
}

export async function judgeToolCall(params: {
  ctx: ExtensionContext;
  config: ResolvedRailConfig;
  state: ClassifierState;
  toolName: string;
  input: unknown;
  labels: CapabilityId[];
  authorizationEvidence?: string;
  recentGuardDecisions?: string[];
  completeFn?: CompleteFn;
  capabilities?: CapabilityState;
}): Promise<JudgeResult> {
  const model = resolveJudgeModel(params.ctx, params.config, params.state);
  if (!model) throw new ClassifierModelUnavailableError(`Judge model not found: ${judgeModelSpec(params.config, params.state)}`);
  return runJudging({
    io: createClassifierIO(params.ctx, params.completeFn),
    model,
    config: params.config,
    toolName: params.toolName,
    input: params.input,
    labels: params.labels,
    authorizationEvidence: params.authorizationEvidence,
    sessionGuidance: params.state.sessionGuidance,
    recentGuardDecisions: params.recentGuardDecisions,
    capabilities: params.capabilities,
  });
}

/** What /rail critique reviews: the prompts, the class definitions, the table, and the screen's coverage. */
export function buildCapabilityPromptForCritique(config: ResolvedRailConfig, capabilities: CapabilityState | undefined): string {
  const table = capabilityRegistry(config, capabilities).map((entry) => {
    const effective = getEffectiveDisposition(config, capabilities, entry.id);
    return `- ${entry.id}: ${effective.disposition} (${effective.scope})\n  ${entry.definition}`;
  });
  const screen = screenLexiconSummary().map((group) => `- ${group.kind}:\n${group.entries.map((line) => `    - ${line}`).join("\n")}`);
  return [
    "## Namer system prompt",
    NAMER_SYSTEM_PROMPT,
    "",
    "## Judge system prompt",
    JUDGE_SYSTEM_PROMPT,
    "",
    "## Capability classes and their effective dispositions",
    ...table,
    "",
    "## Deterministic content screen (routes writes/edits to the namer when it trips)",
    ...screen,
  ].join("\n");
}

export function classifierEnabled(config: ResolvedRailConfig | undefined, state: ClassifierState): boolean {
  if (!config) return false;
  return state.enabledOverride ?? config.classifier.enabled;
}
