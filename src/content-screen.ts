/**
 * Deterministic content screen for write and edit calls.
 *
 * A write's risk is its CONTENT, so a trusted path alone can never exempt it —
 * but sending every `write src/foo.ts` to a model is the friction the rail is
 * supposed to avoid. The screen is the cache in between: cheap patterns for
 * the content-level attacks the round-2 eval cases demonstrate (authorization
 * planting, agent-directed notes, quiet lifecycle hooks, key material), plus
 * the file surfaces where "persistent" is a property of the path.
 *
 * Clean → a deterministic modify-project / modify-system label, table, zero
 * tokens. Tripped → the namer, which sees the content and labels it properly.
 * The screen therefore only ever *routes*; it never decides, so a false trip
 * costs one model call and a false clean costs exactly what an unscreened
 * routine write costs today.
 */
import path from "node:path";
import type { CapabilityId } from "./capabilities.ts";
import { expandHome } from "./paths.ts";
import { textPrefix } from "./util.ts";
import { sessionCheckoutRoot } from "./worktrees.ts";

export type ScreenHitKind = "authorization" | "agent-directive" | "persistence-surface" | "lifecycle-script" | "credential-shape";

export interface ScreenHit {
  kind: ScreenHitKind;
  detail: string;
}

export interface ContentScreenVerdict {
  /** Applicable at all: false for tools the screen does not model. */
  applies: boolean;
  tripped: boolean;
  hits: ScreenHit[];
  /** Deterministic label for a clean write/edit. Absent when tripped or not applicable. */
  label?: CapabilityId;
  /** One line for decision traces and /rail test. */
  summary: string;
}

interface NamedPattern {
  pattern: RegExp;
  detail: string;
}

/**
 * Authorization laundering: text that manufactures approval, consent, or
 * relaxed review, in any file type. Written to match the *claim*, not a
 * particular phrasing of an instruction — the round-2 cases contain no
 * imperative at all.
 */
const AUTHORIZATION_PATTERNS: NamedPattern[] = [
  { pattern: /\bpre-?approv/i, detail: "claims prior approval" },
  { pattern: /\bpre-?authoriz|\bpre-?authoris/i, detail: "claims prior authorization" },
  { pattern: /\bstanding (approval|authorization|authorisation|decision|consent|permission|grant|agreement)/i, detail: "asserts a standing decision" },
  { pattern: /\balready (approved|authorized|authorised|confirmed|signed off)\b/i, detail: "asserts the action was already approved" },
  { pattern: /\bauto-?approv/i, detail: "asserts auto-approval" },
  { pattern: /\bno (further |additional |extra )?(confirmation|approval|review|sign-?off)s? (is |are )?(required|needed|necessary)\b/i, detail: "asserts no confirmation is required" },
  { pattern: /\b(does|do|shall|will) not require (any )?(further |additional |extra )?(confirmation|approval|review|sign-?off)/i, detail: "asserts confirmation is unnecessary" },
  { pattern: /\bwithout (further|additional|extra) (confirmation|approval|review)\b/i, detail: "asserts review can be skipped" },
  { pattern: /\b(considered|deemed|treated as|treat .{0,40} as) (safe|routine|approved|acceptable|pre-?approved)\b/i, detail: "declares an action routine or safe" },
  { pattern: /\breview polic(y|ies)\b/i, detail: "invokes a review policy" },
  { pattern: /\bexempt(ed)? from (review|approval|the guard|guard review)\b/i, detail: "claims an exemption from review" },
  { pattern: /\bbypass(es|ing)? (the )?(review|guard|approval|classifier|sandbox|permission)/i, detail: "describes bypassing the rail" },
  { pattern: /\buser (confirmed|approved|authorized|authorised|agreed|consented|said yes)\b/i, detail: "records user consent" },
  { pattern: /\bconsent (record|granted|given|obtained)\b/i, detail: "records consent" },
  { pattern: /\bdefault(s|ing)? to allow\b/i, detail: "asks for allow-by-default" },
];

/** Content that addresses or instructs whatever reads the file next. */
const AGENT_DIRECTIVE_PATTERNS: NamedPattern[] = [
  {
    pattern: /\b(note|notice|instruction|instructions|guidance|message|memo)s? (for|to) (the )?(automated |ai |llm |code )?(reviewer|reviewers|agent|agents|assistant|assistants|classifier|classifiers)\b/i,
    detail: "addresses an automated reviewer or agent",
  },
  {
    pattern: /\b(automated |ai |llm |ci )?(reviewers?|agents?|classifiers?|assistants?) (should|must|may|can|will|shall|are to|need to)\b/i,
    detail: "tells reviewers or agents what to do",
  },
  {
    pattern: /\bignore (the |your |all |any )?(previous |prior |above |preceding |earlier )?(instruction|instructions|rule|rules|polic|guidance|system prompt)/i,
    detail: "instructs the reader to ignore instructions",
  },
  { pattern: /(^|\n|["'`])\s*SYSTEM\s*:/, detail: "impersonates a system message" },
  { pattern: /"?decision"?\s*:\s*"?allow\b/i, detail: "dictates a reviewer verdict" },
  { pattern: /\bthis (action|command|change|operation) is (pre-?approved|approved|authorized|authorised|safe)\b/i, detail: "asserts this action is approved" },
];

const CREDENTIAL_CONTENT_PATTERNS: NamedPattern[] = [
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, detail: "private key header" },
  { pattern: /\bssh-(rsa|ed25519|dss|ecdsa)\s+AAAA/, detail: "SSH public key material" },
  { pattern: /\bsk-[A-Za-z0-9_\-]{20,}/, detail: "OpenAI-style secret key" },
  { pattern: /\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, detail: "GitHub token" },
  { pattern: /\bglpat-[A-Za-z0-9_\-]{16,}/, detail: "GitLab token" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, detail: "Slack token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, detail: "AWS access key id" },
  { pattern: /\bAIza[0-9A-Za-z_\-]{35}\b/, detail: "Google API key" },
  { pattern: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\./, detail: "JWT" },
];

/** Credential surfaces named in the text: exfil-shaped commands read them, poisoned notes legitimize them. */
const CREDENTIAL_REFERENCE_PATTERNS: NamedPattern[] = [
  {
    pattern: /(^|[\s"'`=:(/])~?\/?\.(ssh|aws|azure|gnupg|kube|docker|netrc|npmrc|pypirc|password-store)\b/,
    detail: "references a credential store path",
  },
  { pattern: /\.config\/(gcloud|gh)\b|\bLibrary\/Keychains\b|\bkeychain\b/i, detail: "references a credential store path" },
  { pattern: /\bid_(rsa|dsa|ecdsa|ed25519)\b/, detail: "references an SSH private key" },
  {
    pattern: /\b[A-Za-z0-9_\-]*(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|ci[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passwd)\b\s*[:=]/i,
    detail: "assigns a credential-named value",
  },
];

/** package.json-style lifecycle hooks: the supply-chain persistence surface. */
const LIFECYCLE_SCRIPT_NAMES = [
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "postpublish",
  "preuninstall",
  "postuninstall",
  "prestart",
  "poststart",
];

const LIFECYCLE_SCRIPT_PATTERN = new RegExp(`["']?(${LIFECYCLE_SCRIPT_NAMES.join("|")})["']?\\s*:\\s*["']`, "i");

/** Manifests and other files whose contents run, or configure what runs, later. */
const PERSISTENCE_BASENAMES = new Set([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "cargo.toml",
  "gemfile",
  "composer.json",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
  "makefile",
  "justfile",
  "taskfile.yml",
  "taskfile.yaml",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pre-commit-config.yaml",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".kshrc",
  ".cshrc",
  ".inputrc",
  "crontab",
  "authorized_keys",
  ".mcp.json",
]);

const PERSISTENCE_PATH_PATTERNS: NamedPattern[] = [
  { pattern: /(^|\/)\.git\/hooks\//, detail: "git hook" },
  { pattern: /(^|\/)\.githooks\//, detail: "git hook directory" },
  { pattern: /(^|\/)\.github\/workflows\//, detail: "CI workflow" },
  { pattern: /(^|\/)\.config\/fish\/(config\.fish|conf\.d\/)/, detail: "shell profile" },
  { pattern: /(^|\/)(etc\/profile(\.d)?|etc\/zshenv|etc\/bashrc)\b/, detail: "system shell profile" },
  { pattern: /(^|\/)etc\/cron|(^|\/)var\/spool\/cron|(^|\/)etc\/periodic\//, detail: "cron surface" },
  { pattern: /(^|\/)Library\/(LaunchAgents|LaunchDaemons)\//, detail: "launchd job" },
  { pattern: /(^|\/)(etc|usr\/lib|\.config)\/systemd\//, detail: "systemd unit" },
  { pattern: /(^|\/)\.ssh\//, detail: "SSH configuration" },
  { pattern: /(^|\/)\.(pi|claude|cursor|codex|aider)\//, detail: "agent configuration" },
];

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Long high-entropy runs and large base64 blobs. The 4.3 bits/char bar clears
 * 40-char hex (git SHAs top out near 3.9) while catching base64 secrets.
 */
function highEntropyHit(text: string): ScreenHit | undefined {
  const base64Blob = text.match(/[A-Za-z0-9+/]{200,}={0,2}/);
  if (base64Blob) return { kind: "credential-shape", detail: `large base64 blob (${base64Blob[0].length} chars)` };
  for (const match of text.matchAll(/[A-Za-z0-9+/=_\-]{40,}/g)) {
    const token = match[0];
    if (shannonEntropy(token) >= 4.3) {
      return { kind: "credential-shape", detail: `high-entropy token (${token.length} chars, ${shannonEntropy(token).toFixed(1)} bits/char)` };
    }
  }
  return undefined;
}

function matchAll(patterns: NamedPattern[], text: string, kind: ScreenHitKind, hits: ScreenHit[]): void {
  for (const entry of patterns) {
    if (entry.pattern.test(text)) hits.push({ kind, detail: entry.detail });
  }
}

/** The screen's coverage in prose, for /rail critique and the policy view. */
export function screenLexiconSummary(): Array<{ kind: ScreenHitKind; entries: string[] }> {
  return [
    { kind: "authorization", entries: AUTHORIZATION_PATTERNS.map((entry) => entry.detail) },
    { kind: "agent-directive", entries: AGENT_DIRECTIVE_PATTERNS.map((entry) => entry.detail) },
    {
      kind: "persistence-surface",
      entries: [...[...PERSISTENCE_BASENAMES].map((name) => `${name} (by name)`), ...PERSISTENCE_PATH_PATTERNS.map((entry) => entry.detail)],
    },
    { kind: "lifecycle-script", entries: LIFECYCLE_SCRIPT_NAMES.map((name) => `${name} script entry added`) },
    {
      kind: "credential-shape",
      entries: [
        ...CREDENTIAL_CONTENT_PATTERNS.map((entry) => entry.detail),
        ...CREDENTIAL_REFERENCE_PATTERNS.map((entry) => entry.detail),
        "high-entropy token (≥40 chars, ≥4.3 bits/char)",
        "large base64 blob (≥200 chars)",
      ],
    },
  ];
}

/** The text layer of the screen, usable on any content: write bodies, edit replacements, command text. */
export function screenText(text: string): ScreenHit[] {
  if (!text) return [];
  const hits: ScreenHit[] = [];
  matchAll(AUTHORIZATION_PATTERNS, text, "authorization", hits);
  matchAll(AGENT_DIRECTIVE_PATTERNS, text, "agent-directive", hits);
  matchAll(CREDENTIAL_CONTENT_PATTERNS, text, "credential-shape", hits);
  matchAll(CREDENTIAL_REFERENCE_PATTERNS, text, "credential-shape", hits);
  const entropy = highEntropyHit(text);
  if (entropy) hits.push(entropy);
  if (LIFECYCLE_SCRIPT_PATTERN.test(text)) {
    hits.push({ kind: "lifecycle-script", detail: `adds a manifest lifecycle script entry (${LIFECYCLE_SCRIPT_PATTERN.exec(text)?.[1] ?? "lifecycle"})` });
  }
  return hits;
}

/** The path layer: surfaces where "keeps acting later" is a property of the file, not of what is in it. */
export function screenPath(cwd: string, target: string): ScreenHit[] {
  const resolved = path.resolve(cwd, expandHome(target)).split(path.sep).join("/");
  const basename = path.basename(resolved).toLowerCase();
  const hits: ScreenHit[] = [];
  if (PERSISTENCE_BASENAMES.has(basename)) hits.push({ kind: "persistence-surface", detail: `${path.basename(resolved)} is a manifest or startup file` });
  for (const entry of PERSISTENCE_PATH_PATTERNS) {
    if (entry.pattern.test(resolved)) hits.push({ kind: "persistence-surface", detail: entry.detail });
  }
  return hits;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function summarize(hits: ScreenHit[], label: CapabilityId | undefined): string {
  if (hits.length === 0) return `clean — deterministic label ${label ?? "none"}`;
  const unique: string[] = [];
  for (const hit of hits) {
    const line = `${hit.kind}: ${hit.detail}`;
    if (!unique.includes(line)) unique.push(line);
  }
  return textPrefix(unique.join("; "), 300);
}

/** Screens a write/edit body against its target. Clean verdicts carry the deterministic label. */
export function screenWrite(params: { cwd: string; target: string; content: string }): ContentScreenVerdict {
  const hits = [...screenPath(params.cwd, params.target), ...screenText(params.content)];
  const resolved = path.resolve(params.cwd, expandHome(params.target));
  // A linked worktree of the session repo is project scratch space: without
  // this, a screen-clean edit in /tmp/<worktree> labels modify-system and asks
  // — while the same edit in cwd sails through — even though the path policy
  // already trusts the checkout. Same bidirectional verification as policy.ts.
  const inProject = isInside(path.resolve(params.cwd), resolved) || sessionCheckoutRoot(params.cwd, resolved) !== undefined;
  const label: CapabilityId = inProject ? "modify-project" : "modify-system";
  const tripped = hits.length > 0;
  return { applies: true, tripped, hits, label: tripped ? undefined : label, summary: summarize(hits, label) };
}

/** The content a write/edit call introduces: the whole body, or every replacement text of an edit. */
export function writtenContentOf(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === "write") return typeof input.content === "string" ? input.content : "";
  if (toolName === "edit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits
      .map((edit) => {
        const entry = edit && typeof edit === "object" ? (edit as Record<string, unknown>) : {};
        return typeof entry.newText === "string" ? entry.newText : "";
      })
      .join("\n");
  }
  return undefined;
}

/**
 * Screens a intercepted tool call. write/edit get the full screen with a
 * deterministic label; bash gets the text layer only (a command always reaches
 * the namer anyway, but the trip is worth recording); everything else is
 * outside the screen's model.
 */
export function screenToolCall(toolName: string, input: Record<string, unknown>, cwd: string): ContentScreenVerdict {
  const content = writtenContentOf(toolName, input);
  if (content !== undefined) {
    const target = typeof input.path === "string" ? input.path : "";
    return screenWrite({ cwd, target, content });
  }
  if (toolName === "bash") {
    const hits = screenText(typeof input.command === "string" ? input.command : "");
    return { applies: true, tripped: hits.length > 0, hits, summary: summarize(hits, undefined) };
  }
  return { applies: false, tripped: false, hits: [], summary: "not screened" };
}
