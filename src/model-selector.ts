import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ReviewerSeat, SeatValue } from "./reviewer-seats.ts";
import type { SelectItem } from "./tui/select-list.ts";

/**
 * What one seat's list is built from: the catalog, the session model, what
 * that seat's own "auto" would pick, and the seat's effective spec (the row
 * that gets the ✓).
 */
export interface SeatListParams {
  models: Model<Api>[];
  currentModel?: Model<Api>;
  /** What "auto" resolves to for THIS seat (the namer and configurator lists differ). */
  autoModel?: Model<Api>;
  spec: SeatValue;
}

export function modelLabel(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** The explicit provider/model rows, shared by every seat but checked per seat. */
function modelItems(models: Model<Api>[], spec: SeatValue): SelectItem<SeatValue>[] {
  return models.map((model) => ({
    value: modelLabel(model),
    label: model.id,
    searchText: `${model.provider} ${model.id} ${model.name ?? ""}`,
    suffix: `[${model.provider}]`,
    description: model.name ? `Model name: ${model.name}` : undefined,
    current: spec === modelLabel(model),
  }));
}

function currentItem(params: SeatListParams, description: string): SelectItem<SeatValue>[] {
  if (!params.currentModel) return [];
  return [{
    value: "current",
    label: `current (${modelLabel(params.currentModel)})`,
    searchText: `current ${params.currentModel.provider} ${params.currentModel.id} ${params.currentModel.name ?? ""}`,
    description,
    current: params.spec === "current",
  }];
}

function autoItem(params: SeatListParams, description: string): SelectItem<SeatValue> {
  return {
    value: "auto",
    label: params.autoModel ? `auto (${modelLabel(params.autoModel)})` : "auto",
    searchText: "auto default known good",
    description: `${description} (${params.autoModel ? `currently ${modelLabel(params.autoModel)}` : "none available: falls back to the current model"})`,
    current: params.spec === "auto",
  };
}

function namerItems(params: SeatListParams): SelectItem<SeatValue>[] {
  return [
    autoItem(params, "Best available known-good namer model, subscriptions first"),
    ...currentItem(params, "Always use Pi's current active model"),
    {
      value: "off",
      label: "off",
      searchText: "off disable classifier",
      description: "Disable classifier review (allowlisted and deterministic decisions still apply)",
      current: params.spec === "off",
    },
    ...modelItems(params.models, params.spec),
  ];
}

/**
 * The judge list deliberately offers neither "off" nor "auto":
 *
 * - "off" would make a `judge` disposition undecidable, and that failure is
 *   meant to stay loud rather than become a setting.
 * - "auto" resolves against AUTO_CLASSIFIER_PREFERENCES, a list of cheap
 *   high-volume namer models. Silently pointing the escalation review at a
 *   mini model is the opposite of what the judge is for.
 */
function judgeItems(params: SeatListParams): SelectItem<SeatValue>[] {
  return [
    ...currentItem(params, "Always use Pi's current active model — the session's own strong model"),
    ...modelItems(params.models, params.spec),
  ];
}

/** The configurator's "auto" is its own eval-derived list (AUTO_GRANT_MODEL_PREFERENCES), not the namer's. */
function configuratorItems(params: SeatListParams): SelectItem<SeatValue>[] {
  return [
    autoItem(params, "Best available model from the configurator's eval-derived list"),
    ...currentItem(params, "Always use Pi's current active model"),
    ...modelItems(params.models, params.spec),
  ];
}

/** One seat's rows, in the order the page and the RPC flow show them. */
export function seatItems(seat: ReviewerSeat, params: SeatListParams): SelectItem<SeatValue>[] {
  if (seat === "namer") return namerItems(params);
  if (seat === "judge") return judgeItems(params);
  return configuratorItems(params);
}

/** One-line note per seat, shown under the tab line. */
export const SEAT_NOTES: Record<ReviewerSeat, string> = {
  namer: "Names every reviewed action against the capability classes; cheap and fast is the point.",
  judge: "Decides the classes you delegated to it. It cannot be turned off — only re-pointed.",
  configurator: "Proposes grants from /rail grant requests; runs only when asked.",
};
