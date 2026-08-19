import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifierEnabled, judgeModelSpec, resolveClassifierModel, resolveJudgeModel } from "../classifier.ts";
import { resolveAutoClassifierModel } from "../classifier-models.ts";
import type { ResolvedRailConfig } from "../config.ts";
import { loadConfig } from "../config.ts";
import { selectClassifierModel, type ClassifierModelChoice } from "../model-selector.ts";
import { getPersistentConfigPath, updatePersistentClassifierSettings } from "../persistent-settings.ts";
import { lastRailDecision, type RuntimeState } from "../state.ts";
import { formatError } from "../util.ts";

type Show = (message: string) => void;

function persist(ctx: ExtensionContext, update: { enabled?: boolean; model?: string; judgeModel?: string }): void {
  try {
    updatePersistentClassifierSettings(update);
  } catch (error) {
    ctx.ui.notify(`Could not persist rail classifier setting: ${formatError(error)}`, "warning");
  }
}

/** Pi's active model, or undefined when the registry has not resolved one yet. */
function sessionModel(ctx: ExtensionContext) {
  return ctx.model && ctx.model.provider !== "unknown" && ctx.model.id !== "unknown" ? ctx.model : undefined;
}

function spec(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** Applies a judge pick at session scope and mirrors it into the persistent config. */
function setJudgeModel(ctx: ExtensionContext, state: RuntimeState, value: string): void {
  state.classifier.judgeModelOverride = value;
  persist(ctx, { judgeModel: value });
}

/**
 * `/rail model judge [<spec>|current|status]` — the textual form of the
 * dialog's judge tab, so RPC clients and scripts can set or query it.
 *
 * Neither "off" nor "auto" is accepted, for the reasons spelled out on the
 * judge tab: the judge cannot be disabled, and "auto" is the namer's cheap
 * high-volume preference list.
 */
async function runJudgeModelCommand(arg: string, ctx: ExtensionContext, state: RuntimeState, config: ResolvedRailConfig, show: Show): Promise<void> {
  const lower = arg.toLowerCase();

  if (lower === "off") {
    ctx.ui.notify(
      "The judge cannot be turned off: a class set to judge with no judge model must keep failing loudly. Move the class off judge with /rail set <class> ask|deny instead.",
      "error",
    );
    return;
  }
  if (lower === "auto") {
    ctx.ui.notify(
      "auto is the namer's known-good cheap-model list, not a judge setting — it would quietly downgrade escalation review. Use `current` or an explicit provider/model.",
      "error",
    );
    return;
  }
  if (lower === "current") {
    const model = sessionModel(ctx);
    if (!model) {
      ctx.ui.notify("No current Pi model is selected.", "error");
      return;
    }
    setJudgeModel(ctx, state, "current");
    show(`Rail judge model set to current and saved: ${spec(model)}`);
    return;
  }
  if (arg && lower !== "status") {
    const slash = arg.indexOf("/");
    const model = slash > 0 ? ctx.modelRegistry.find(arg.slice(0, slash), arg.slice(slash + 1)) : undefined;
    if (!model) {
      ctx.ui.notify(`Model not found: ${arg}`, "error");
      return;
    }
    setJudgeModel(ctx, state, spec(model));
    show(`Rail judge model saved: ${spec(model)}`);
    return;
  }

  showJudgeStatus(ctx, state, config, show);
}

function showJudgeStatus(ctx: ExtensionContext, state: RuntimeState, config: ResolvedRailConfig, show: Show): void {
  const resolved = resolveJudgeModel(ctx, config, state.classifier);
  show([
    `Configured judge model: ${judgeModelSpec(config, state.classifier)}`,
    `Resolved judge model: ${resolved ? spec(resolved) : "(none)"}`,
    `Persistent config: ${getPersistentConfigPath()}`,
  ].join("\n"));
}

/** Applies one pick from the two-tab dialog to the target it names. */
function applyChoice(ctx: ExtensionContext, state: RuntimeState, choice: ClassifierModelChoice): void {
  if (choice.target === "judge") {
    if (choice.value === "current") setJudgeModel(ctx, state, "current");
    else if (choice.model) setJudgeModel(ctx, state, spec(choice.model));
    return;
  }

  if (choice.value === "off") {
    state.classifier.enabledOverride = false;
  } else if (choice.value === "auto") {
    state.classifier.enabledOverride = true;
    state.classifier.modelOverride = "auto";
  } else if (choice.value === "current") {
    state.classifier.enabledOverride = true;
    state.classifier.modelOverride = "current";
  } else if (choice.model) {
    state.classifier.enabledOverride = true;
    state.classifier.modelOverride = spec(choice.model);
  }
  persist(ctx, { enabled: state.classifier.enabledOverride, model: state.classifier.modelOverride });
}

/** Handles `/rail model [auto|current|off|status|judge …|provider/model]`; no arg opens the selector in TUI mode. */
export async function runModelCommand(args: string, ctx: ExtensionContext, state: RuntimeState): Promise<void> {
  const config = state.config ?? loadConfig(ctx);
  const arg = args.trim();
  const show = (message: string) => {
    if (!ctx.hasUI) console.log(message);
    ctx.ui.notify(message, "info");
  };

  // `/rail model …` keeps meaning the namer; the judge lives behind its own word.
  const judge = arg.match(/^judge(?:\s+([\s\S]*))?$/i);
  if (judge) return runJudgeModelCommand((judge[1] ?? "").trim(), ctx, state, config, show);

  if (arg === "off") {
    state.classifier.enabledOverride = false;
    persist(ctx, { enabled: false });
    show("Rail classifier disabled and saved.");
    return;
  }
  if (arg === "auto") {
    state.classifier.enabledOverride = true;
    state.classifier.modelOverride = "auto";
    persist(ctx, { enabled: true, model: "auto" });
    const resolved = resolveClassifierModel(ctx, config, state.classifier);
    show(`Rail classifier enabled in auto mode and saved${resolved ? `; currently resolves to ${spec(resolved)}` : "; no known-good model is available yet"}.`);
    return;
  }
  if (arg === "current") {
    if (!ctx.model) {
      ctx.ui.notify("No current Pi model is selected.", "error");
      return;
    }
    state.classifier.enabledOverride = true;
    state.classifier.modelOverride = "current";
    persist(ctx, { enabled: true, model: "current" });
    show(`Rail classifier enabled using current model and saved: ${spec(ctx.model)}`);
    return;
  }
  if (arg && arg !== "status") {
    const slash = arg.indexOf("/");
    const model = slash > 0 ? ctx.modelRegistry.find(arg.slice(0, slash), arg.slice(slash + 1)) : undefined;
    if (!model) {
      ctx.ui.notify(`Model not found: ${arg}`, "error");
      return;
    }
    state.classifier.enabledOverride = true;
    state.classifier.modelOverride = spec(model);
    persist(ctx, { enabled: true, model: state.classifier.modelOverride });
    show(`Rail classifier enabled and saved using ${spec(model)}`);
    return;
  }

  if (!arg) {
    ctx.modelRegistry.refresh();
    const models = ctx.modelRegistry.getAvailable();
    const choice = await selectClassifierModel({
      ctx,
      models,
      currentModel: sessionModel(ctx),
      autoModel: resolveAutoClassifierModel(models),
      namer: {
        spec: state.classifier.modelOverride ?? config.classifier.model,
        resolved: resolveClassifierModel(ctx, config, state.classifier),
      },
      judge: {
        spec: judgeModelSpec(config, state.classifier),
        resolved: resolveJudgeModel(ctx, config, state.classifier),
      },
    });
    if (!choice) return;
    applyChoice(ctx, state, choice);
  }

  const selected = resolveClassifierModel(ctx, config, state.classifier);
  const judgeSelected = resolveJudgeModel(ctx, config, state.classifier);
  const available = ctx.modelRegistry.getAvailable().map(spec).slice(0, 30);
  const lastDecision = lastRailDecision(state);
  show([
    `Reviewers: ${classifierEnabled(config, state.classifier) ? "enabled" : "disabled"}`,
    `Configured namer model: ${state.classifier.modelOverride ?? config.classifier.model}`,
    `Resolved namer model: ${selected ? spec(selected) : "(none)"}`,
    `Configured judge model: ${judgeModelSpec(config, state.classifier)}`,
    `Resolved judge model: ${judgeSelected ? spec(judgeSelected) : "(none)"}`,
    `Persistent config: ${getPersistentConfigPath()}`,
    lastDecision
      ? `Last decision: ${lastDecision.decision} (${lastDecision.labels.join(", ")}) ${lastDecision.reason}`
      : undefined,
    state.classifier.lastError ? `Last error: ${state.classifier.lastError}` : undefined,
    "",
    "Available models:",
    ...(available.length > 0 ? available.map((model) => `- ${model}`) : ["(none with configured auth)"]),
  ].filter((line): line is string => typeof line === "string").join("\n"));
}
