// The three reviewer-model seats — namer, judge, configurator — as session
// settings with an explicit save, the same contract as the disposition page:
// a pick applies to this session at once, a seat whose session value differs
// from the persisted one is marked, and save writes the session values to the
// global rail.json and clears the marks.
//
// The session values are ClassifierState's *Override fields (RuntimeState),
// not session-policy ops: a model choice is not policy, so it is neither part
// of the session policy snapshot nor replayed from the branch, and a new
// session or reload starts from the config again (resetSessionState).
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifierEnabled, grantModelSpec, judgeModelSpec, resolveClassifierModel, resolveGrantModel, resolveJudgeModel, type ClassifierState } from "./classifier.ts";
import type { ResolvedRailConfig } from "./config.ts";
import { updatePersistentClassifierSettings } from "./persistent-settings.ts";
import type { RuntimeState } from "./state.ts";

export type ReviewerSeat = "namer" | "judge" | "configurator";

export const REVIEWER_SEATS: readonly ReviewerSeat[] = ["namer", "judge", "configurator"];

/** The config key each seat reads and saves to. */
export const SEAT_CONFIG_KEY = { namer: "model", judge: "judgeModel", configurator: "grantModel" } as const;

/**
 * A pick for one seat: "auto" | "current" | "provider/id", or "off" on the
 * namer only. The judge takes neither "off" (a judge disposition with no
 * judge must keep failing loudly) nor "auto" (the namer's cheap-model list);
 * the configurator has no "off" because it only runs when asked.
 */
export type SeatValue = string;

export function isReviewerSeat(value: string): value is ReviewerSeat {
  return (REVIEWER_SEATS as readonly string[]).includes(value);
}

/** The seat's effective spec this session ("off" when the namer is switched off). */
export function seatSpec(config: ResolvedRailConfig, classifier: ClassifierState, seat: ReviewerSeat): SeatValue {
  if (seat === "namer") {
    if (!classifierEnabled(config, classifier)) return "off";
    return classifier.modelOverride ?? config.classifier.model;
  }
  if (seat === "judge") return judgeModelSpec(config, classifier);
  return grantModelSpec(config, classifier);
}

/** What the seat would be without this session's override: the resolved config. */
export function persistedSeatSpec(config: ResolvedRailConfig, seat: ReviewerSeat): SeatValue {
  return seatSpec(config, {}, seat);
}

/** Whether the session value differs from the persisted one (the page's marker). */
export function seatUnsaved(config: ResolvedRailConfig, classifier: ClassifierState, seat: ReviewerSeat): boolean {
  return seatSpec(config, classifier, seat) !== persistedSeatSpec(config, seat);
}

export function anySeatUnsaved(config: ResolvedRailConfig, classifier: ClassifierState): boolean {
  return REVIEWER_SEATS.some((seat) => seatUnsaved(config, classifier, seat));
}

/** The model the seat would call right now, or undefined ("off", nothing resolves). */
export function resolveSeatModel(ctx: ExtensionContext, config: ResolvedRailConfig, classifier: ClassifierState, seat: ReviewerSeat): Model<Api> | undefined {
  if (seat === "namer") return classifierEnabled(config, classifier) ? resolveClassifierModel(ctx, config, classifier) : undefined;
  if (seat === "judge") return resolveJudgeModel(ctx, config, classifier);
  return resolveGrantModel(ctx, config, classifier);
}

/** Why a value cannot go on a seat, or undefined when it can. */
export function seatValueRefusal(seat: ReviewerSeat, value: SeatValue): string | undefined {
  if (seat === "judge" && value === "off") {
    return "The judge cannot be turned off: a class set to judge with no judge model must keep failing loudly. Move the class off judge with /rail set <class> ask|deny instead.";
  }
  if (seat === "judge" && value === "auto") {
    return "auto is the namer's known-good cheap-model list, not a judge setting — it would quietly downgrade escalation review. Use `current` or an explicit provider/model.";
  }
  if (seat === "configurator" && value === "off") {
    return "The configurator only runs when you ask it to (/rail grant), so there is nothing to turn off. Pick auto, current, or a provider/model.";
  }
  return undefined;
}

/**
 * Sets one seat for this session. The namer's "off" flips the enable switch
 * and keeps the model; any namer model pick switches the namer back on, which
 * is what picking a model always meant here.
 */
export function setSeatValue(classifier: ClassifierState, seat: ReviewerSeat, value: SeatValue): void {
  const refusal = seatValueRefusal(seat, value);
  if (refusal) throw new Error(refusal);
  if (seat === "namer") {
    if (value === "off") {
      classifier.enabledOverride = false;
      return;
    }
    classifier.enabledOverride = true;
    classifier.modelOverride = value;
    return;
  }
  if (seat === "judge") classifier.judgeModelOverride = value;
  else classifier.grantModelOverride = value;
}

export interface ClassifierSettingsWriter {
  (update: { enabled?: boolean; model?: string; judgeModel?: string; grantModel?: string }): void;
}

export interface SaveSeatsResult {
  /** "judge: current → openai/gpt-5.4" per seat written, in seat order. */
  changes: string[];
}

/**
 * Writes every seat whose session value differs from the persisted one to the
 * global config, then folds the same values into the in-memory base config so
 * the markers clear — the disposition page's save does the same with its ops.
 * Seats that already match are not written: a save with nothing unsaved
 * leaves the file alone.
 *
 * The namer is saved as both keys it is made of: `enabled`, and `model` when
 * the namer is on (an "off" keeps whatever model the file had, so switching
 * back on later restores it).
 */
export function saveReviewerSeats(state: RuntimeState, write: ClassifierSettingsWriter = updatePersistentClassifierSettings): SaveSeatsResult {
  const base = state.baseConfig;
  if (!base) return { changes: [] };
  const classifier = state.classifier;
  const update: Parameters<ClassifierSettingsWriter>[0] = {};
  const changes: string[] = [];
  for (const seat of REVIEWER_SEATS) {
    if (!seatUnsaved(base, classifier, seat)) continue;
    const before = persistedSeatSpec(base, seat);
    const after = seatSpec(base, classifier, seat);
    changes.push(`${seat}: ${before} → ${after}`);
    if (seat === "namer") {
      update.enabled = after !== "off";
      if (after !== "off") update.model = after;
    } else {
      update[SEAT_CONFIG_KEY[seat]] = after;
    }
  }
  if (changes.length === 0) return { changes };
  write(update);
  if (update.enabled !== undefined) base.classifier.enabled = update.enabled;
  if (update.model !== undefined) base.classifier.model = update.model;
  if (update.judgeModel !== undefined) base.classifier.judgeModel = update.judgeModel;
  if (update.grantModel !== undefined) base.classifier.grantModel = update.grantModel;
  // Assignment invalidates the derived (session-layer) copy cached for base.
  state.config = base;
  return { changes };
}

/** "Reviewer models saved: judge: current → openai/gpt-5.4." or the nothing-to-do line. */
export function saveSeatsMessage(result: SaveSeatsResult, configPath: string): string {
  if (result.changes.length === 0) return "No unsaved reviewer model changes.";
  return `Reviewer models saved to ${configPath}: ${result.changes.join("; ")}.`;
}
