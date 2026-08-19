// Interop with the pi-subagents extension (npm:pi-subagents), which spawns
// child `pi --mode json -p` sessions. Two one-way, best-effort channels:
//
// - Child side: pi-subagents' runtime listens on the child's extension event
//   bus for `subagent:acknowledge-extension` and reports collected ids back to
//   the parent as `runtimeAcknowledgedExtensions` on the run result. Emitting
//   there proves the rail actually loaded (and enforced) inside the child.
// - Parent side: the `subagent`/`subagent_wait` tool results carry those
//   acknowledgements per child. A finished child without the rail's id ran
//   with no rail — most commonly because pi-subagents launched it with
//   `--no-extensions` (agent `extensions:` frontmatter,
//   `subagents.defaultExtensions`, or a capability ceiling) or because it was
//   an external-CLI runner. That is worth a user-facing warning, since the
//   parent statusline shows an active rail while children run with no rail.
//
// Everything here is observability, never enforcement: failures are swallowed
// and no tool call is blocked or altered.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimeState } from "./state.ts";

/** Set to "1" by pi-subagents in every child pi session it spawns. */
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
/** Child event bus channel pi-subagents collects extension acknowledgements on. */
export const SUBAGENT_ACK_EVENT = "subagent:acknowledge-extension";
/** Id acknowledged with; the parent-side check also accepts an "@version" suffix. */
export const RAIL_ACK_ID = "pi-rail";

/** pi-subagents tools whose results carry per-child acknowledgement data. */
const SUBAGENT_RESULT_TOOLS = new Set(["subagent", "subagent_wait"]);

/**
 * Acknowledges the rail on the child's event bus when this session is a
 * pi-subagents child and the rail is actually enforcing. Deliberately not
 * emitted when the rail is disabled or failed to initialize: the
 * acknowledgement means "bash here is on the rail", not merely "the extension
 * loaded", so the parent-side warning fires for those children too.
 */
export function acknowledgeRailInSubagentChild(pi: ExtensionAPI, state: RuntimeState, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[SUBAGENT_CHILD_ENV] !== "1") return false;
  if (!state.enabled || !state.initialized) return false;
  try {
    pi.events.emit(SUBAGENT_ACK_EVENT, { id: RAIL_ACK_ID });
    return true;
  } catch {
    return false;
  }
}

export interface UnacknowledgedSubagent {
  agent: string;
  /** Stable identity for once-per-child dedupe; undefined when the result has none (then it re-warns). */
  key: string | undefined;
  /** True when pi-subagents launched the child with ambient extensions disabled (--no-extensions). */
  extensionsRestricted: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRailAck(entry: Record<string, unknown>): boolean {
  const ack = entry.runtimeAcknowledgedExtensions;
  if (!isRecord(ack) || !Array.isArray(ack.ids)) return false;
  const matches = (id: unknown, known: string) => id === known || (typeof id === "string" && id.startsWith(`${known}@`));
  return ack.ids.some((id) => matches(id, RAIL_ACK_ID));
}

/**
 * Extracts finished child runs that never acknowledged the rail from a
 * subagent tool result. Non-terminal entries (still running or detached) are
 * skipped: their acknowledgement file is only read once the child exits.
 */
export function findUnacknowledgedSubagents(toolName: string, details: unknown): UnacknowledgedSubagent[] {
  if (!SUBAGENT_RESULT_TOOLS.has(toolName)) return [];
  if (!isRecord(details) || !Array.isArray(details.results)) return [];
  const missing: UnacknowledgedSubagent[] = [];
  for (const entry of details.results) {
    if (!isRecord(entry)) continue;
    if (entry.detached === true) continue;
    if (isRecord(entry.progress) && entry.progress.status === "running") continue;
    if (entry.exitCode === undefined && entry.error === undefined) continue;
    if (hasRailAck(entry)) continue;
    const launch = entry.launchResolvedExtensions;
    const sessionFile = typeof entry.sessionFile === "string" ? entry.sessionFile : undefined;
    const transcriptPath = typeof entry.transcriptPath === "string" ? entry.transcriptPath : undefined;
    missing.push({
      agent: typeof entry.agent === "string" && entry.agent ? entry.agent : "unknown",
      key: sessionFile ?? transcriptPath,
      extensionsRestricted: isRecord(launch) && launch.disableAmbientExtensions === true,
    });
  }
  return missing;
}

interface NotifyContext {
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

function agentList(entries: UnacknowledgedSubagent[]): string {
  return [...new Set(entries.map((entry) => entry.agent))].join(", ");
}

/**
 * Parent-side check for a tool_result event: warns once per child when a
 * subagent finished without acknowledging the rail. Old pi-subagents
 * versions (no acknowledgement channel) and external-CLI runners cannot
 * acknowledge, so the generic wording stays a "was not active" observation
 * rather than a claim about why.
 */
export function warnUnacknowledgedSubagents(event: { toolName: string; details?: unknown }, ctx: NotifyContext, state: RuntimeState): void {
  if (!state.config?.enabled || !state.enabled) return;
  const fresh = findUnacknowledgedSubagents(event.toolName, event.details).filter(
    (entry) => entry.key === undefined || !state.subagentAckWarned.has(entry.key),
  );
  if (fresh.length === 0) return;
  for (const entry of fresh) {
    if (entry.key !== undefined) state.subagentAckWarned.add(entry.key);
  }
  const restricted = fresh.filter((entry) => entry.extensionsRestricted);
  const other = fresh.filter((entry) => !entry.extensionsRestricted);
  const parts: string[] = [];
  if (restricted.length > 0) parts.push(`${agentList(restricted)} (launched with ambient extensions disabled, e.g. agent 'extensions:' frontmatter or subagents.defaultExtensions)`);
  if (other.length > 0) parts.push(`${agentList(other)} (rail not loaded or not enforcing there — disabled config, an external runner, or an older pi-subagents)`);
  ctx.ui.notify(`Pi Rail was not active in finished subagent children: ${parts.join("; ")}. Their bash and file actions ran without the rail.`, "warning");
}
