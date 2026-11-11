import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { classifierEnabled } from "../classifier.ts";
import { resolveAutoClassifierModel, resolveAutoGrantModel } from "../classifier-models.ts";
import type { ResolvedRailConfig } from "../config.ts";
import { loadConfig } from "../config.ts";
import { toggleRailPanel } from "../live-view.ts";
import { modelLabel, SEAT_NOTES, seatItems } from "../model-selector.ts";
import { getPersistentConfigPath } from "../persistent-settings.ts";
import {
  isReviewerSeat,
  persistedSeatSpec,
  resolveSeatModel,
  REVIEWER_SEATS,
  saveReviewerSeats,
  saveSeatsMessage,
  seatSpec,
  seatUnsaved,
  seatValueRefusal,
  setSeatValue,
  type ReviewerSeat,
  type SeatValue,
} from "../reviewer-seats.ts";
import { lastRailDecision, type RuntimeState } from "../state.ts";
import { ReviewerModelPage, type SeatView } from "../tui/model-page.ts";
import { pickFromList, type SelectItem } from "../tui/select-list.ts";
import { formatError } from "../util.ts";

type Show = (message: string, level?: "info" | "warning" | "error") => void;

/** Pi's active model, or undefined when the registry has not resolved one yet. */
function sessionModel(ctx: ExtensionContext): Model<Api> | undefined {
  return ctx.model && ctx.model.provider !== "unknown" && ctx.model.id !== "unknown" ? ctx.model : undefined;
}

/** "judge: current → anthropic/claude-opus-4-5", with "(unavailable)" when nothing resolves. */
function seatSummary(ctx: ExtensionContext, config: ResolvedRailConfig, state: RuntimeState, seat: ReviewerSeat): string {
  const spec = seatSpec(config, state.classifier, seat);
  if (spec === "off") return `${seat}: off`;
  const resolved = resolveSeatModel(ctx, config, state.classifier, seat);
  if (resolved && modelLabel(resolved) === spec) return `${seat}: ${spec}`;
  return `${seat}: ${spec} → ${resolved ? modelLabel(resolved) : "(unavailable)"}`;
}

/** Every seat as the page and the RPC flow render it, from the live state. */
function seatViews(ctx: ExtensionContext, config: ResolvedRailConfig, state: RuntimeState, models: Model<Api>[]): SeatView[] {
  const currentModel = sessionModel(ctx);
  return REVIEWER_SEATS.map((seat) => ({
    seat,
    summary: seatSummary(ctx, config, state, seat),
    unsaved: seatUnsaved(config, state.classifier, seat),
    persisted: persistedSeatSpec(config, seat),
    note: SEAT_NOTES[seat],
    items: seatItems(seat, {
      models,
      currentModel,
      // Each seat's own auto list: the namer's cheap known-good models, the
      // configurator's eval-derived ones. The judge has no auto row.
      autoModel: seat === "configurator" ? resolveAutoGrantModel(models) : resolveAutoClassifierModel(models),
      spec: seatSpec(config, state.classifier, seat),
    }),
  }));
}

/**
 * Parses a typed value for a seat: auto/current/off as words, otherwise a
 * provider/model the registry knows. Returns the spec, or a message.
 */
function parseSeatValue(ctx: ExtensionContext, seat: ReviewerSeat, arg: string): { value: SeatValue } | { error: string } {
  const lower = arg.toLowerCase();
  if (lower === "auto" || lower === "off" || lower === "current") {
    const refusal = seatValueRefusal(seat, lower);
    if (refusal) return { error: refusal };
    if (lower === "current" && !sessionModel(ctx)) return { error: "No current Pi model is selected." };
    return { value: lower };
  }
  const slash = arg.indexOf("/");
  const model = slash > 0 ? ctx.modelRegistry.find(arg.slice(0, slash), arg.slice(slash + 1)) : undefined;
  if (!model) return { error: `Model not found: ${arg}` };
  return { value: modelLabel(model) };
}

/** Sets one seat for this session and reports what it now resolves to. */
function setSeat(ctx: ExtensionContext, state: RuntimeState, config: () => ResolvedRailConfig, seat: ReviewerSeat, arg: string, show: Show): void {
  const parsed = parseSeatValue(ctx, seat, arg);
  if ("error" in parsed) {
    ctx.ui.notify(parsed.error, "error");
    return;
  }
  setSeatValue(state.classifier, seat, parsed.value);
  const summary = seatSummary(ctx, config(), state, seat);
  const tail = seatUnsaved(config(), state.classifier, seat) ? " — for this session; /rail model save persists it" : " — same as the saved setting";
  show(`Rail ${summary}${tail}.`);
}

function save(state: RuntimeState, show: Show): void {
  try {
    show(saveSeatsMessage(saveReviewerSeats(state), getPersistentConfigPath()));
  } catch (error) {
    show(`Could not save reviewer models: ${formatError(error)}`, "warning");
  }
}

function seatStatus(ctx: ExtensionContext, config: ResolvedRailConfig, state: RuntimeState, seat: ReviewerSeat): string[] {
  const unsaved = seatUnsaved(config, state.classifier, seat);
  return [`${seatSummary(ctx, config, state, seat)}${unsaved ? ` (this session, unsaved; saved: ${persistedSeatSpec(config, seat)})` : ""}`];
}

function statusReport(ctx: ExtensionContext, config: ResolvedRailConfig, state: RuntimeState, seats: readonly ReviewerSeat[] = REVIEWER_SEATS): string {
  const available = ctx.modelRegistry.getAvailable().map(modelLabel).slice(0, 30);
  const lastDecision = lastRailDecision(state);
  const full = seats.length === REVIEWER_SEATS.length;
  return [
    full ? `Reviewers: ${classifierEnabled(config, state.classifier) ? "enabled" : "disabled"}` : undefined,
    ...seats.flatMap((seat) => seatStatus(ctx, config, state, seat)),
    `Persistent config: ${getPersistentConfigPath()}`,
    full && lastDecision ? `Last decision: ${lastDecision.decision} (${lastDecision.labels.join(", ")}) ${lastDecision.reason}` : undefined,
    full && state.classifier.lastError ? `Last error: ${state.classifier.lastError}` : undefined,
    ...(full ? ["", "Available models:", ...(available.length > 0 ? available.map((model) => `- ${model}`) : ["(none with configured auth)"])] : []),
  ].filter((line): line is string => typeof line === "string").join("\n");
}

/**
 * RPC degradation of the page, mirroring /rail policy's: pick a seat (labels
 * carry the effective setting and an "(unsaved)" tag), then pick its model;
 * the pick applies at session scope and the seat list comes back so several
 * seats can be set in a row. "Save persistently" is the Ctrl+S equivalent;
 * cancel exits leaving the session values in force.
 */
async function runSelectFlow(ctx: ExtensionContext, state: RuntimeState, config: () => ResolvedRailConfig, models: Model<Api>[], show: Show, onChange: () => void): Promise<void> {
  for (;;) {
    const views = seatViews(ctx, config(), state, models);
    const items: SelectItem<ReviewerSeat | "save">[] = views.map((view) => ({
      value: view.seat,
      label: `${view.summary}${view.unsaved ? " (unsaved)" : ""}`,
      searchText: view.seat,
      description: view.note,
    }));
    items.push({
      value: "save",
      label: "Save persistently",
      searchText: "save persist write global config models",
      description: "Write every unsaved seat to the global rail config",
    });
    const picked = await pickFromList<ReviewerSeat | "save">(ctx, { title: "Rail reviewer models (changes apply to this session)", items });
    if (!picked) return;
    if (picked.value === "save") {
      save(state, show);
      onChange();
      continue;
    }
    const view = views.find((entry) => entry.seat === picked.value)!;
    // Labels are the answers over the wire, so model rows use the unique
    // provider/id rather than the TUI's id-plus-badge.
    const choice = await pickFromList<SeatValue>(ctx, {
      title: `${view.summary}\n${view.note}`,
      items: view.items.map((item) => (item.suffix ? { ...item, label: item.value, suffix: undefined } : item)),
    });
    if (!choice) continue;
    setSeatValue(state.classifier, view.seat, choice.value);
    onChange();
    show(`Rail ${seatSummary(ctx, config(), state, view.seat)} — for this session.`);
  }
}

/** `/rail model [<seat>] [auto|current|off|status|provider/model]`, `/rail model save`; no arg opens the picker. */
export async function runModelCommand(
  args: string,
  ctx: ExtensionContext,
  state: RuntimeState,
  /** Called after a pick or a save made inside the page or the RPC flow (the statusline names the namer). */
  onChange: () => void = () => {},
): Promise<void> {
  if (!state.config) state.config = loadConfig(ctx);
  // Read fresh at every use: a save folds into the base config, and the page
  // outlives this call.
  const config = () => state.config!;
  const arg = args.trim();
  const show: Show = (message, level = "info") => {
    if (!ctx.hasUI) console.log(message);
    ctx.ui.notify(message, level);
  };

  if (arg.toLowerCase() === "save") return save(state, show);
  if (arg.toLowerCase() === "status") return show(statusReport(ctx, config(), state));

  // `/rail model …` keeps meaning the namer; the other seats live behind their own word.
  const seatMatch = arg.match(/^(namer|judge|configurator)(?:\s+([\s\S]*))?$/i);
  if (seatMatch) {
    const seat = seatMatch[1]!.toLowerCase();
    const rest = (seatMatch[2] ?? "").trim();
    if (!isReviewerSeat(seat)) return;
    if (!rest || rest.toLowerCase() === "status") return show(statusReport(ctx, config(), state, [seat]));
    return setSeat(ctx, state, config, seat, rest, show);
  }
  if (arg) return setSeat(ctx, state, config, "namer", arg, show);

  ctx.modelRegistry.refresh();
  const models = ctx.modelRegistry.getAvailable();
  const opened = toggleRailPanel(ctx, state, "model", (host) => new ReviewerModelPage({
    ...host,
    seats: () => seatViews(ctx, config(), state, models),
    pick: (seat, value) => {
      const refusal = seatValueRefusal(seat, value);
      if (refusal) return refusal;
      setSeatValue(state.classifier, seat, value);
      onChange();
      return undefined;
    },
    save: () => {
      save(state, show);
      onChange();
    },
  }));
  if (opened) return;
  if (!ctx.hasUI) return show(statusReport(ctx, config(), state));
  await runSelectFlow(ctx, state, config, models, show, onChange);
}
