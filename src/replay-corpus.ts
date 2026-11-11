// The replay corpus: a local, append-only record of rail decisions with the
// FULL action input, kept so a candidate policy change can later be replayed
// against what actually happened (GRANTS_PLAN.md, "Replay corpus"). This
// module writes the corpus; src/grant-eval.ts replays it for the grant gates,
// and the grants view counts what each grant decided from it.
//
// Why a separate store instead of the session log: session telemetry
// (src/telemetry.ts) truncates targets and projections because session files
// can be shared (`pi share` uploads the whole file), which makes a replay of a
// rule change inexact — "git worktree remove ../x && rm -rf ~/dev" truncated
// at 120 chars can lose the half that matters. The corpus is never part of a
// session file and never leaves the machine, so it can keep the whole command
// or path; what it must not keep is secrets, so commands are redacted (below)
// and write/edit content is reduced to a hash and a length.
//
// Layout (dir 0700, files 0600):
//   <getAgentDir()>/rail-corpus/<YYYY-MM>.jsonl    one JSON record per line, UTC month
//
// Like telemetry, the corpus is best-effort: a failed write is swallowed and
// never touches the tool call. Unlike telemetry it is independent of the
// `classifier.telemetry` tier — the tier exists for shareable session files,
// which this is not — and is switched by `corpus.enabled` instead.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CapabilityId, Disposition } from "./capabilities.ts";
import type { RailDecision, RailOutcome } from "./classifier-protocol.ts";
import {
  BASE64_BLOB_PATTERN,
  CREDENTIAL_CONTENT_PATTERNS,
  CREDENTIAL_KEY_PATTERN,
  HIGH_ENTROPY_RUN_PATTERN,
  isHighEntropyToken,
  writtenContentOf,
} from "./content-screen.ts";
import type { AccessKind } from "./policy.ts";
import type { RuntimeState } from "./state.ts";
import type { UserAnswer } from "./telemetry.ts";

export const CORPUS_VERSION = 1;
export const CORPUS_DIR_NAME = "rail-corpus";
/** Total size the month files may occupy before the oldest are pruned. */
export const CORPUS_MAX_BYTES = 50 * 1024 * 1024;
/** Months kept, counting the current one. */
export const CORPUS_MAX_AGE_MONTHS = 12;

const MONTH_FILE_RE = /^(\d{4})-(\d{2})\.jsonl$/;

/**
 * The action as replay needs it. bash keeps its full (redacted) command;
 * read/write/edit keep their full path. Write/edit content is never stored:
 * grants do not change the content screen, so the recorded screen verdict is
 * what replay uses, and the hash only lets a reader tell identical writes
 * apart. For edit the hashed content is the replacement text the screen saw
 * (every newText, joined), not the oldText it was matched against.
 */
export interface CorpusInput {
  command?: string;
  path?: string;
  content?: { sha256: string; bytes: number };
  editCount?: number;
}

export interface CorpusRecord {
  v: 1;
  /** ISO-8601 UTC timestamp; its month names the file the record lives in. */
  at: string;
  cwd: string;
  tool: string;
  /**
   * review — the disposition table decided (finish() in the interceptor);
   * approval — the path-approval dialog decided, either a plain out-of-roots
   * read or a capability-routed out-of-roots write (which writes no review);
   * block — a deterministic policy block (denyWrite, read-only mode).
   */
  kind: "review" | "approval" | "block";
  input: CorpusInput;
  /** Final capability labels: deterministic and namer labels together. Absent for blocks and plain path asks. */
  labels?: CapabilityId[];
  /**
   * True when the namer (a model) supplied labels, false when they were purely
   * deterministic. Replay re-runs the deterministic mappers but can only reuse
   * the namer's, so it needs to know which happened. Unlike telemetry's
   * `reviewed`, the judge running does not set this: the judge decides, it
   * does not label.
   */
  named?: boolean;
  /** The namer's own labels, present exactly when `named` is true. */
  namerLabels?: CapabilityId[];
  /** Content-screen verdict; absent when the screen never looked (absent ≠ false, as in telemetry). */
  screenTripped?: boolean;
  /** Severity-max of the table over `labels`, before the judge or the user. */
  resolvedDisposition?: Disposition;
  /** The label that produced `resolvedDisposition`. */
  decidedBy?: CapabilityId;
  /** The named grant whose rule, row, or class produced the deciding label (decidingGrant); absent when none did. */
  grant?: string;
  /** What became of the call: post-judge, post-user. */
  outcome: RailOutcome | "block";
  /** How the user answered an ask; absent when none was shown. */
  userAnswer?: UserAnswer;
  /** The answer came from the parent session via the approval mailbox (this session was a headless child). */
  forwarded?: true;
  /** Session path memory answered a capability-routed ask without a dialog. */
  remembered?: true;
  /** For approval records: which access the dialog was about. */
  access?: AccessKind;
  /**
   * The judge's verdict when it ran. Its reason is not kept: it is free text
   * that may quote the command, and it would bypass redaction.
   */
  judge?: { verdict: RailDecision };
  /** Block reason (deterministic text naming the rule and path). Reviews keep none, for the judge-reason rationale above. */
  reason?: string;
  /**
   * Set when anything was redacted. Replay treats a redacted record's labels
   * and screen verdict as a floor and never re-runs the namer on it, so the
   * marker must be exact: present iff `redactions` is non-empty.
   */
  redacted?: true;
  /** Distinct redaction kinds applied, in the content screen's pattern order, then the entropy kinds. */
  redactions?: string[];
}

// ---------------------------------------------------------------------------
// Redaction (pure)
// ---------------------------------------------------------------------------

/**
 * One shell word, typed, with no whitespace or shell metacharacters: replacing
 * a secret with it leaves the command's segments and argv words exactly as
 * they were, so template matching in replay sees the same shape — a blanked
 * secret must not turn `curl -H "Authorization: …" x` into something that
 * parses differently (and maybe looks safer).
 */
export function redactionPlaceholder(kind: string): string {
  return `‹redacted:${kind}›`;
}

export interface RedactionResult {
  text: string;
  kinds: string[];
}

/** Characters that continue a token past where a screen pattern stopped matching (the patterns match prefixes, e.g. a JWT's header and payload but not its signature). */
const TOKEN_TAIL = /[A-Za-z0-9_\-]/;
const BASE64_CHAR = /[A-Za-z0-9+/=]/;

function extendWhile(text: string, end: number, chars: RegExp): number {
  while (end < text.length && chars.test(text[end]!)) end++;
  return end;
}

/**
 * The span one screen-pattern hit covers, widened to the whole secret. The
 * screen only needs to know a shape is present; the redactor must cover all of
 * it, so a PEM block runs to its END line and an SSH key to the end of its
 * base64 body (keeping the `ssh-ed25519` word, which is structure).
 */
function credentialSpan(kind: string, text: string, start: number, matched: string): [number, number] {
  if (kind === "private-key") {
    const end = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
    end.lastIndex = start + matched.length;
    const footer = end.exec(text);
    return [start, footer ? footer.index + footer[0].length : start + matched.length];
  }
  if (kind === "ssh-key") {
    const body = start + matched.lastIndexOf("AAAA");
    return [body, extendWhile(text, start + matched.length, BASE64_CHAR)];
  }
  return [start, extendWhile(text, start + matched.length, TOKEN_TAIL)];
}

/**
 * `KEY=` / `--token=` in front of a candidate run is structure, not secret:
 * the run's character class includes `=`, so without peeling it a
 * `TOKEN=<secret>` assignment would be replaced whole and stop parsing as an
 * assignment. Only peeled when something follows, since base64 padding is a
 * trailing `=` too.
 */
const KEY_PREFIX = /^-{0,2}[A-Za-z_][A-Za-z0-9_\-]*=(?=.)/;

/**
 * The entropy pass. Absolute-path-shaped runs (starting with `/`, or following
 * a `.` as a URL path does after its host) are tested per segment, so one
 * UUID-named directory does not blank a whole path — paths are structure the
 * rules need. Everything else is tested as one token, which is what catches
 * a 40-char AWS secret key with `/` in it.
 */
function redactHighEntropy(text: string, kinds: Set<string>): string {
  let out = text.replace(BASE64_BLOB_PATTERN, () => {
    kinds.add("base64-blob");
    return redactionPlaceholder("base64-blob");
  });
  out = out.replace(HIGH_ENTROPY_RUN_PATTERN, (run: string, offset: number, whole: string) => {
    const pathLike = run.startsWith("/") || whole[offset - 1] === ".";
    if (pathLike) {
      let changed = false;
      const segments = run.split("/").map((segment) => {
        if (!isHighEntropyToken(segment)) return segment;
        changed = true;
        return redactionPlaceholder("high-entropy");
      });
      if (changed) kinds.add("high-entropy");
      return segments.join("/");
    }
    const prefix = KEY_PREFIX.exec(run)?.[0] ?? "";
    const value = run.slice(prefix.length);
    if (!isHighEntropyToken(value)) return run;
    kinds.add("high-entropy");
    return `${prefix}${redactionPlaceholder("high-entropy")}`;
  });
  return out;
}

type QuoteContext = "" | "'" | '"';

/**
 * The shell quote enclosing each character: "" outside quotes, or the quote
 * character of the string it sits in. A quote character carries the context
 * before it opens and inside it as it closes, so `ctx[i] === text[i]` means
 * "this quote closes the enclosing string". Escaped characters share their
 * backslash's context. Deliberately lenient: an unbalanced quote just leaves
 * the rest of the text "inside", which only makes the value scanner stop
 * earlier.
 */
function quoteContexts(text: string): QuoteContext[] {
  const ctx: QuoteContext[] = new Array(text.length);
  let quote: QuoteContext = "";
  for (let i = 0; i < text.length; i++) {
    ctx[i] = quote;
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = "";
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < text.length) ctx[i + 1] = quote;
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
  }
  return ctx;
}

const PLACEHOLDER_PREFIX = "‹redacted:";
const SHELL_METACHARS = new Set([";", "|", "<", ">", "(", ")"]);
/** Ends an unquoted value inside a string or a JSON-ish/query pair: the next field, the closing brace, or an escape. */
const PAIR_TERMINATORS = new Set(["&", ",", "}", "\\"]);

/**
 * The span of the secret value starting at `p`, or undefined when there is
 * nothing to redact there. The one rule every branch keeps: the span never
 * includes a quote that closes the enclosing shell string, and never covers
 * an expansion, so the command parses into the same words — and the same
 * literal/expansion parts — afterwards.
 *
 * - `\"value\"` inside a double-quoted string (escaped JSON) → the inner text.
 * - `"value"` / `'value'` opening a string (shell-level, or a JSON string inside
 *   the other kind of quote) → the text up to its close.
 * - otherwise an unquoted run, ending at whitespace, any quote, a pair
 *   terminator, or (outside quotes) a shell metacharacter.
 *
 * Where `$` and backticks are live (anywhere but single quotes) the value also
 * ends at one: `PASS=$PW` is a reference, not a secret, and turning it into a
 * literal would change what the parser sees.
 */
function secretValueSpan(text: string, ctx: QuoteContext[], p: number): [number, number] | undefined {
  if (p >= text.length) return undefined;
  const enclosing = ctx[p]!;
  const ch = text[p]!;
  let start: number;
  let end: number;
  if (ch === "\\" && text[p + 1] === '"' && enclosing === '"') {
    start = p + 2;
    end = text.indexOf('\\"', start);
    if (end === -1) return undefined;
  } else if (ch === '"' || ch === "'") {
    if (enclosing === ch) return undefined; // closes the enclosing string: an empty value
    start = p + 1;
    end = start;
    // A shell-level string closes where the scanner says it does; a JSON
    // string inside the other kind of quote closes at its next same quote
    // that still sits inside the host string.
    const closes = enclosing === "" ? ch : enclosing;
    while (end < text.length && !(text[end] === ch && ctx[end] === closes)) end++;
    if (end >= text.length) return undefined;
    // A JSON string inside the other kind of quote must close before its host does.
    if (enclosing !== "" && text.slice(start, end).includes(enclosing)) return undefined;
  } else {
    start = p;
    end = p;
    while (end < text.length) {
      const c = text[end]!;
      if (/\s/.test(c) || c === '"' || c === "'" || PAIR_TERMINATORS.has(c)) break;
      if (enclosing === "" && SHELL_METACHARS.has(c)) break;
      end++;
    }
  }
  if (ctx[start] !== "'") {
    const live = text.slice(start, end).search(/[$`]/);
    if (live !== -1) end = start + live;
  }
  const value = text.slice(start, end);
  if (!value || value.startsWith(PLACEHOLDER_PREFIX) || value.startsWith("$") || value.startsWith("`")) return undefined;
  return [start, end];
}

/** `KEY=` / `"key":` / `password: ` — a credential-named key, an optional closing quote (JSON keys), and its separator. */
const NAMED_SECRET_PATTERN = new RegExp(`${CREDENTIAL_KEY_PATTERN.source}(?:\\\\?["'])?(?:=|[ \\t]*:[ \\t]*)`, "gi");
/** An HTTP authorization scheme word followed by its credential. */
const AUTH_SCHEME_PATTERN = /(?<=^|[\s"':=])(?:Bearer|Basic)[ \t]+/gi;

/**
 * Replaces the value after each match of `pattern` (key and separator kept).
 * `accept` can veto a value. Left-to-right, so a value never re-enters as a
 * key; spliced right-to-left, so the spans stay valid.
 */
function redactValuesAfter(text: string, pattern: RegExp, kind: string, kinds: Set<string>, accept: (value: string) => boolean = () => true): string {
  const ctx = quoteContexts(text);
  const spans: Array<[number, number]> = [];
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index < consumed) continue;
    const span = secretValueSpan(text, ctx, match.index + match[0].length);
    if (!span || !accept(text.slice(span[0], span[1]))) continue;
    spans.push(span);
    consumed = span[1];
  }
  if (spans.length === 0) return text;
  kinds.add(kind);
  let out = text;
  for (const [start, end] of spans.reverse()) out = `${out.slice(0, start)}${redactionPlaceholder(kind)}${out.slice(end)}`;
  return out;
}

/**
 * Redacts credential shapes in free text (a command, a block reason) using the
 * content screen's own credential patterns, credential-named keys, and
 * entropy bar, plus authorization schemes. Credential-store
 * *references* (`~/.aws/credentials`, `id_rsa`) are deliberately left alone:
 * they are the structure the credentials rules match on, and naming a secret's
 * location is not the secret.
 */
export function redactCredentials(text: string): RedactionResult {
  const kinds = new Set<string>();
  let out = text;
  for (const entry of CREDENTIAL_CONTENT_PATTERNS) {
    const pattern = new RegExp(entry.pattern.source, entry.pattern.flags.includes("g") ? entry.pattern.flags : `${entry.pattern.flags}g`);
    const spans: Array<[number, number]> = [];
    for (const match of out.matchAll(pattern)) {
      const span = credentialSpan(entry.redaction, out, match.index, match[0]);
      const last = spans.at(-1);
      if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
      else spans.push(span);
    }
    if (spans.length === 0) continue;
    kinds.add(entry.redaction);
    for (const [start, end] of spans.reverse()) out = `${out.slice(0, start)}${redactionPlaceholder(entry.redaction)}${out.slice(end)}`;
  }
  // Low-entropy secrets the shape patterns cannot see, found by their
  // context instead: the value of a credential-named key, and the credential
  // after an authorization scheme. Before the entropy pass, so a high-entropy
  // value there is typed by where it sat rather than by how it looked.
  out = redactValuesAfter(out, NAMED_SECRET_PATTERN, "named-secret", kinds);
  // An all-lowercase word after "basic"/"bearer" is prose ("a basic setup"),
  // not a credential: base64 and token alphabets almost never avoid capitals,
  // digits, and symbols together.
  out = redactValuesAfter(out, AUTH_SCHEME_PATTERN, "auth-token", kinds, (value) => !/^[a-z]+$/.test(value));
  out = redactHighEntropy(out, kinds);
  return { text: out, kinds: [...kinds] };
}

// ---------------------------------------------------------------------------
// Record construction (pure)
// ---------------------------------------------------------------------------

/** What a call site knows about one decision; the builder turns it into a record. */
export interface CorpusDecision {
  kind: CorpusRecord["kind"];
  tool: string;
  cwd: string;
  /** The raw, un-truncated tool input. */
  input: Record<string, unknown>;
  labels?: CapabilityId[];
  /** The namer's labels when it ran; undefined when the labels were purely deterministic. */
  namerLabels?: CapabilityId[];
  screenTripped?: boolean;
  resolvedDisposition?: Disposition;
  decidedBy?: CapabilityId;
  grant?: string;
  outcome: CorpusRecord["outcome"];
  userAnswer?: UserAnswer;
  forwarded?: boolean;
  remembered?: boolean;
  access?: AccessKind;
  judgeVerdict?: RailDecision;
  reason?: string;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/** The replayable part of a tool input, with commands redacted and content reduced to its hash. */
export function corpusInput(tool: string, input: Record<string, unknown>): { input: CorpusInput; kinds: string[] } {
  const out: CorpusInput = {};
  let kinds: string[] = [];
  if (typeof input.command === "string") {
    const redacted = redactCredentials(input.command);
    out.command = redacted.text;
    kinds = redacted.kinds;
  }
  // Paths are never redacted: they are structure, and the credential paths
  // among them are exactly what the credentials rules match.
  if (typeof input.path === "string") out.path = input.path;
  const content = writtenContentOf(tool, input);
  if (content !== undefined) out.content = { sha256: sha256(content), bytes: Buffer.byteLength(content, "utf-8") };
  if (tool === "edit") out.editCount = Array.isArray(input.edits) ? input.edits.length : 0;
  return { input: out, kinds };
}

export function buildCorpusRecord(decision: CorpusDecision, at: Date): CorpusRecord {
  const { input, kinds } = corpusInput(decision.tool, decision.input);
  const allKinds = new Set(kinds);
  let reason: string | undefined;
  if (decision.reason !== undefined) {
    const redacted = redactCredentials(decision.reason);
    reason = redacted.text;
    for (const kind of redacted.kinds) allKinds.add(kind);
  }
  const named = decision.namerLabels !== undefined;
  const hasLabels = decision.labels !== undefined;
  return {
    v: CORPUS_VERSION,
    at: at.toISOString(),
    cwd: decision.cwd,
    tool: decision.tool,
    kind: decision.kind,
    input,
    ...(hasLabels ? { labels: [...decision.labels!], named } : {}),
    ...(named ? { namerLabels: [...decision.namerLabels!] } : {}),
    ...(decision.screenTripped !== undefined ? { screenTripped: decision.screenTripped } : {}),
    ...(decision.resolvedDisposition !== undefined ? { resolvedDisposition: decision.resolvedDisposition } : {}),
    ...(decision.decidedBy !== undefined ? { decidedBy: decision.decidedBy } : {}),
    ...(decision.grant !== undefined ? { grant: decision.grant } : {}),
    outcome: decision.outcome,
    ...(decision.userAnswer !== undefined ? { userAnswer: decision.userAnswer } : {}),
    ...(decision.forwarded ? { forwarded: true as const } : {}),
    ...(decision.remembered ? { remembered: true as const } : {}),
    ...(decision.access !== undefined ? { access: decision.access } : {}),
    ...(decision.judgeVerdict !== undefined ? { judge: { verdict: decision.judgeVerdict } } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(allKinds.size > 0 ? { redacted: true as const, redactions: [...allKinds] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** `2026-11.jsonl` for any instant in November 2026, UTC. */
export function corpusFileName(at: Date): string {
  return `${at.toISOString().slice(0, 7)}.jsonl`;
}

export interface CorpusFileInfo {
  name: string;
  bytes: number;
}

export interface CorpusCaps {
  maxBytes: number;
  maxAgeMonths: number;
}

function monthIndex(name: string): number | undefined {
  const match = MONTH_FILE_RE.exec(name);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : undefined;
}

/**
 * Which month files to delete. Whole files only — a month file is the unit of
 * age, and trimming lines would make the store something other than
 * append-only. Files older than the age cap go first; then, newest first,
 * files past the size cap. The size cap never takes the newest file: it is the
 * one being written, and deleting it to honour the cap would discard the
 * present to keep the past. Anything not named like a month file is not ours and is left alone.
 */
export function selectPrunable(files: CorpusFileInfo[], now: Date, caps: CorpusCaps): string[] {
  const current = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const months = files
    .map((file) => ({ ...file, month: monthIndex(file.name) }))
    .filter((file): file is CorpusFileInfo & { month: number } => file.month !== undefined)
    .sort((a, b) => b.month - a.month);
  const prune: string[] = [];
  let total = 0;
  months.forEach((file, index) => {
    if (file.month <= current - caps.maxAgeMonths) {
      prune.push(file.name);
      return;
    }
    total += file.bytes;
    if (index > 0 && total > caps.maxBytes) prune.push(file.name);
  });
  return prune;
}

/** Applies selectPrunable to a directory. Never throws. */
export function pruneCorpus(dir: string, now: Date, caps: CorpusCaps): string[] {
  try {
    const files: CorpusFileInfo[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!MONTH_FILE_RE.test(name)) continue;
      try {
        files.push({ name, bytes: fs.statSync(path.join(dir, name)).size });
      } catch {
        // Raced with another process's prune: nothing to count.
      }
    }
    const prune = selectPrunable(files, now, caps);
    for (const name of prune) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        // Best-effort; the next process tries again.
      }
    }
    return prune;
  } catch {
    return [];
  }
}

export interface CorpusWriter {
  readonly dir: string;
  /** Appends one record. Never throws. */
  append(record: CorpusRecord): void;
}

export interface CorpusWriterOptions {
  dir: string;
  maxBytes?: number;
  maxAgeMonths?: number;
  /** Test seam for the prune clock. */
  now?: () => Date;
}

export function defaultCorpusDir(): string {
  return path.join(getAgentDir(), CORPUS_DIR_NAME);
}

/**
 * A writer bound to one directory. The prune runs once, on the first append of
 * the process (index.ts creates one writer per process), so steady-state cost
 * per decision is one synchronous appendFileSync of one line — the same order
 * as the session entry written beside it. Parent and headless child processes
 * share the files; O_APPEND keeps each single-line write whole.
 */
export function createCorpusWriter(options: CorpusWriterOptions): CorpusWriter {
  const caps: CorpusCaps = { maxBytes: options.maxBytes ?? CORPUS_MAX_BYTES, maxAgeMonths: options.maxAgeMonths ?? CORPUS_MAX_AGE_MONTHS };
  const now = options.now ?? (() => new Date());
  let prepared = false;
  return {
    dir: options.dir,
    append(record) {
      try {
        if (!prepared) {
          fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 });
          // mkdir's mode only applies to a directory it creates; tighten an
          // existing one too, since the store holds full commands.
          fs.chmodSync(options.dir, 0o700);
          pruneCorpus(options.dir, now(), caps);
          prepared = true;
        }
        const file = path.join(options.dir, corpusFileName(new Date(record.at)));
        fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      } catch {
        // Best-effort: the corpus is analysis material, never enforcement.
      }
    },
  };
}

/**
 * The call-site hook: builds and appends one record when the corpus is wired
 * and enabled. Placed beside appendRailTelemetry at each decision; takes the
 * raw tool input because the telemetry records carry truncated targets.
 * Never throws — building the record (redaction, hashing) is inside the guard
 * too, so nothing about the corpus can reach the tool call.
 */
export function appendCorpusDecision(state: RuntimeState, decision: CorpusDecision): void {
  const writer = state.corpus;
  const config = state.config;
  if (!writer || !config || !config.enabled || !state.enabled || !config.corpus.enabled) return;
  try {
    writer.append(buildCorpusRecord(decision, new Date()));
  } catch {
    // Best-effort, as above.
  }
}

// ---------------------------------------------------------------------------
// Reader (the grant gates and the grants view replay and count from it)
// ---------------------------------------------------------------------------

function isCorpusRecord(value: unknown): value is CorpusRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === CORPUS_VERSION &&
    typeof record.at === "string" &&
    typeof record.tool === "string" &&
    (record.kind === "review" || record.kind === "approval" || record.kind === "block") &&
    typeof record.input === "object" &&
    record.input !== null &&
    typeof record.outcome === "string"
  );
}

/** Every well-formed record in the store, oldest month first; malformed or foreign-version lines are skipped. */
export function readCorpus(dir: string): CorpusRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => MONTH_FILE_RE.test(name)).sort();
  } catch {
    return [];
  }
  const records: CorpusRecord[] = [];
  for (const name of names) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, name), "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isCorpusRecord(parsed)) records.push(parsed);
      } catch {
        // A torn or hand-edited line: skip it, keep the rest.
      }
    }
  }
  return records;
}
