import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, type Message } from "@earendil-works/pi-ai/compat";
import { capabilityRegistry, getEffectiveDisposition } from "../capabilities.ts";
import { buildCapabilityPromptForCritique } from "../classifier.ts";
import { loadConfig, type ResolvedRailConfig } from "../config.ts";
import { showRailView } from "../live-view.ts";
import { getPersistentConfigPath } from "../persistent-settings.ts";
import { syncCapabilityPreset, type RuntimeState } from "../state.ts";
import { formatError } from "../util.ts";

const CRITIQUE_SYSTEM_PROMPT = `You are an expert reviewer of the capability taxonomy used by a local coding agent's rail.

The rail names each proposed tool action with one or more capability classes — a cheap model does the naming, deterministic mappers and a content screen shortcut the common cases — and a user-owned disposition table then decides allow, ask, deny, or escalation to a stronger judge. The class DEFINITIONS are the prompt the namer sees; the table is the user's whole policy.

Critique the definitions and the screen for:
1. Boundaries: can two classes both plausibly claim the same action, or does an obvious action fall between them? Definitions should say what belongs to a neighbour ("X, but Y is class Z instead").
2. Namability: could a cheap model apply this class from a projected tool call, or does it need context the namer never sees?
3. Disposition fit: does each class group actions the user would want treated the same way? A class whose members deserve different answers is the wrong shape.
4. Screen coverage: what content-level attack would slip past the deterministic screen and reach the table with a benign label — and what benign content would trip it needlessly?

The taxonomy is deliberately capped at twelve classes: propose sharper wording before proposing a thirteenth, and say plainly if a proposed class is edge-case disease. Be concise and constructive; comment only where something could be improved.`;

function formatTableForCritique(config: ResolvedRailConfig, state: RuntimeState): string {
  return capabilityRegistry(config).map((entry) => {
    const effective = getEffectiveDisposition(config, state.capabilities, entry.id);
    return `- ${entry.id} (${entry.name}) → ${effective.disposition} [${effective.scope}]\n  ${entry.definition}`;
  }).join("\n");
}

/** Handles `/rail critique [provider/model]`; defaults to Pi's current model. */
export function createCritiqueRunner(deps: { state: RuntimeState }) {
  const { state } = deps;

  return async function runCritiqueCommand(args: string, ctx: ExtensionContext) {
    const config = state.config ?? loadConfig(ctx);
    syncCapabilityPreset(state);
    const modelSpec = args.trim();
    const model = modelSpec
      ? (() => {
          const slash = modelSpec.indexOf("/");
          return slash > 0 ? ctx.modelRegistry.find(modelSpec.slice(0, slash), modelSpec.slice(slash + 1)) : undefined;
        })()
      : ctx.model;

    if (!model || model.provider === "unknown" || model.id === "unknown") {
      ctx.ui.notify("No critique model selected. Use /rail critique provider/model or select a Pi model first.", "error");
      return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      ctx.ui.notify(auth.ok ? `No API key for ${model.provider}` : auth.error, "error");
      return;
    }

    ctx.ui.setStatus("rail-critique", ctx.ui.theme.fg("accent", "Critiquing rail capabilities"));
    ctx.ui.notify(`Critiquing the rail capability taxonomy with ${model.provider}/${model.id}...`, "info");
    const userPrompt = [
      "Here are the rail's namer and judge system prompts, its capability classes with their effective dispositions, and the deterministic content screen:",
      "",
      "<rail_capability_mode>",
      buildCapabilityPromptForCritique(config, state.capabilities),
      "</rail_capability_mode>",
      "",
      "And the resolved disposition table as the user currently has it:",
      "",
      formatTableForCritique(config, state),
      "",
      "Please critique the class definitions, the table, and the screen.",
    ].join("\n");

    const message: Message = { role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() };
    try {
      const response = await complete(
        model,
        { systemPrompt: CRITIQUE_SYSTEM_PROMPT, messages: [message] },
        { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
      );
      if (response.stopReason === "aborted") throw new Error("critique aborted");
      const critique = response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      const output = [
        "# Rail capability critique",
        "",
        `Model: ${model.provider}/${model.id}`,
        `Config: ${getPersistentConfigPath()}`,
        "",
        critique || "No critique returned.",
      ].join("\n");
      showRailView(ctx, state, "report", () => output.split("\n"));
      ctx.ui.notify("Rail capability critique ready.", "info");
    } catch (error) {
      const reason = formatError(error);
      ctx.ui.notify(`Rail critique failed: ${reason}`, "error");
    } finally {
      ctx.ui.setStatus("rail-critique", undefined);
    }
  };
}
