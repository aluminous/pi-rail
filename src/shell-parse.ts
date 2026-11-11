/**
 * Minimal POSIX-ish shell parser: a quote-aware tokenizer plus a recursive
 * descent parser producing a small AST of chains, pipelines, and simple
 * commands. Word content is tracked as literal vs expansion parts so callers
 * can tell exactly which argv words are fixed text. The parser FAILS on
 * anything outside its grammar — heredocs, process substitution, `$'…'`
 * quoting, `|&`, function definitions, unbalanced quotes — rather than
 * guessing at semantics it does not model.
 */

/** A run of fixed text, or an expansion ($VAR, ${…}, $(…), `…`) whose value is unknowable statically. */
export type WordPart = { kind: "literal"; text: string } | { kind: "expansion"; text: string };

export interface ShellWord {
  parts: WordPart[];
  /**
   * Set when the word holds an UNQUOTED glob or brace character (`*`, `?`,
   * `[`, `{`): the shell may expand it into words this parser never saw — a
   * file named `--force`, say. Quoted and backslash-escaped ones do not count.
   */
  glob?: true;
}

export type RedirectOp = ">" | ">>" | "<" | "<>" | ">&" | "<&" | "&>" | "&>>";

export interface Redirect {
  fd?: number;
  op: RedirectOp;
  target: ShellWord;
}

/** A leading NAME=value word, recognized only before the first argv word. */
export interface Assignment {
  name: string;
  value: ShellWord;
}

export interface SimpleCommand {
  kind: "command";
  assignments: Assignment[];
  argv: ShellWord[];
  redirects: Redirect[];
}

export interface Subshell {
  kind: "subshell";
  body: ShellScript;
  redirects: Redirect[];
}

export type ShellCommand = SimpleCommand | Subshell;

/** Commands connected by `|`. */
export interface Pipeline {
  commands: ShellCommand[];
}

/** Pipelines joined by && / ||, terminated by `;`, `&`, a newline, or the end of input. */
export interface AndOrChain {
  pipelines: Pipeline[];
  /** operators[i] joins pipelines[i] and pipelines[i + 1]. */
  operators: ("&&" | "||")[];
  background: boolean;
}

export interface ShellScript {
  chains: AndOrChain[];
}

export type ShellParseResult = { ok: true; script: ShellScript } | { ok: false; error: string };

/** The word's fixed text after quote removal, or undefined when any part is an expansion. */
export function literalWordText(word: ShellWord): string | undefined {
  let text = "";
  for (const part of word.parts) {
    if (part.kind !== "literal") return undefined;
    text += part.text;
  }
  return text;
}

class ParseError extends Error {}

type ChainOp = "&&" | "||" | ";" | "|" | "&" | "\n" | "(" | ")";
type Token =
  | { kind: "op"; op: ChainOp }
  | { kind: "redirect"; fd?: number; op: RedirectOp }
  | { kind: "word"; parts: WordPart[]; assignment?: Assignment; glob?: true };

const ASSIGNMENT_PREFIX = /^([A-Za-z_][A-Za-z0-9_]*)=/;
/** Parameter expansions of the $X form: names, positionals, and special parameters. */
const DOLLAR_NAME_START = /[A-Za-z_]/;
const DOLLAR_SPECIAL = /[0-9@*#?$!-]/;

/** Skips a double-quoted region starting at its opening quote; returns the index just past the close. */
function skipDoubleQuoted(input: string, start: number): number {
  let i = start + 1;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  throw new ParseError("unterminated double quote");
}

/**
 * Scans a balanced `$(…)` or `${…}` region starting at the opening bracket,
 * treating quoted stretches as opaque so brackets inside them do not count.
 * Returns the index just past the matching close.
 */
function scanBalanced(input: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw new ParseError("unterminated single quote");
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i = skipDoubleQuoted(input, i);
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new ParseError(`unterminated ${open === "(" ? "$(" : "${"}`);
}

/** Scans a backtick substitution starting at the opening backtick; returns the index just past the close. */
function scanBacktick(input: string, start: number): number {
  let i = start + 1;
  while (i < input.length) {
    if (input[i] === "\\") {
      i += 2;
      continue;
    }
    if (input[i] === "`") return i + 1;
    i++;
  }
  throw new ParseError("unterminated backtick");
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let parts: WordPart[] = [];
  let building = false;
  /** Unquoted literal text since word start, frozen at the first quote/escape/expansion; used to recognize NAME= assignments. */
  let unquotedPrefix = "";
  let prefixFrozen = false;
  /** An unquoted glob/brace character in this word (see ShellWord.glob). */
  let glob = false;

  const appendLiteral = (text: string, quoted: boolean) => {
    building = true;
    if (!quoted && /[*?[{]/.test(text)) glob = true;
    if (quoted) prefixFrozen = true;
    else if (!prefixFrozen) unquotedPrefix += text;
    const last = parts.at(-1);
    if (last?.kind === "literal") last.text += text;
    else parts.push({ kind: "literal", text });
  };
  const appendExpansion = (text: string) => {
    building = true;
    prefixFrozen = true;
    parts.push({ kind: "expansion", text });
  };
  const endWord = () => {
    if (building) {
      const match = ASSIGNMENT_PREFIX.exec(unquotedPrefix);
      const token: Token = { kind: "word", parts, ...(glob ? { glob: true as const } : {}) };
      if (match) token.assignment = { name: match[1]!, value: { parts: stripLiteralPrefix(parts, match[0].length) } };
      tokens.push(token);
    }
    parts = [];
    building = false;
    unquotedPrefix = "";
    prefixFrozen = false;
    glob = false;
  };
  const pushOp = (op: ChainOp, width: number) => {
    endWord();
    tokens.push({ kind: "op", op });
    i += width;
  };
  const pushRedirect = (op: RedirectOp, width: number, fd?: number) => {
    endWord();
    tokens.push({ kind: "redirect", fd, op });
    i += width;
  };
  /** Handles `$…` at index i, inside or outside double quotes; returns true when it consumed input. */
  const scanDollar = (inDoubleQuotes: boolean): void => {
    const next = input[i + 1];
    if (next === "(") {
      const end = scanBalanced(input, i + 1, "(", ")");
      appendExpansion(input.slice(i, end));
      i = end;
      return;
    }
    if (next === "{") {
      const end = scanBalanced(input, i + 1, "{", "}");
      appendExpansion(input.slice(i, end));
      i = end;
      return;
    }
    if (!inDoubleQuotes && (next === "'" || next === '"')) throw new ParseError(`$${next}…${next} quoting is not supported`);
    if (next !== undefined && DOLLAR_NAME_START.test(next)) {
      let end = i + 1;
      while (end < input.length && /[A-Za-z0-9_]/.test(input[end]!)) end++;
      appendExpansion(input.slice(i, end));
      i = end;
      return;
    }
    if (next !== undefined && DOLLAR_SPECIAL.test(next)) {
      appendExpansion(input.slice(i, i + 2));
      i += 2;
      return;
    }
    appendLiteral("$", false);
    i++;
  };

  while (i < input.length) {
    const ch = input[i]!;
    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      i++;
      continue;
    }
    if (ch === "#" && !building) {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "\n") {
      pushOp("\n", 1);
      continue;
    }
    if (ch === "'") {
      const close = input.indexOf("'", i + 1);
      if (close === -1) throw new ParseError("unterminated single quote");
      appendLiteral(input.slice(i + 1, close), true);
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      building = true;
      prefixFrozen = true;
      i++;
      let closed = false;
      while (i < input.length) {
        const dq = input[i]!;
        if (dq === '"') {
          closed = true;
          i++;
          break;
        }
        if (dq === "$") {
          scanDollar(true);
          continue;
        }
        if (dq === "`") {
          const end = scanBacktick(input, i);
          appendExpansion(input.slice(i, end));
          i = end;
          continue;
        }
        if (dq === "\\") {
          const next = input[i + 1];
          if (next === undefined) throw new ParseError("unterminated double quote");
          if (next === "\\" || next === '"' || next === "$" || next === "`") {
            appendLiteral(next, true);
            i += 2;
          } else if (next === "\n") {
            i += 2; // line continuation
          } else {
            appendLiteral(dq, true); // backslash stays literal before other characters
            i++;
          }
          continue;
        }
        appendLiteral(dq, true);
        i++;
      }
      if (!closed) throw new ParseError("unterminated double quote");
      continue;
    }
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === undefined) throw new ParseError("trailing backslash");
      if (next === "\n") {
        i += 2; // line continuation joins lines without delimiting a word
        continue;
      }
      appendLiteral(next, true);
      i += 2;
      continue;
    }
    if (ch === "$") {
      scanDollar(false);
      continue;
    }
    if (ch === "`") {
      const end = scanBacktick(input, i);
      appendExpansion(input.slice(i, end));
      i = end;
      continue;
    }
    if (/[0-9]/.test(ch) && !building) {
      let end = i;
      while (end < input.length && /[0-9]/.test(input[end]!)) end++;
      if (input[end] === "<" || input[end] === ">") {
        const fd = Number(input.slice(i, end));
        i = end;
        scanRedirect(fd);
        continue;
      }
      appendLiteral(input.slice(i, end), false);
      i = end;
      continue;
    }
    if (ch === "<" || ch === ">") {
      scanRedirect(undefined);
      continue;
    }
    if (ch === "&") {
      const next = input[i + 1];
      if (next === "&") {
        pushOp("&&", 2);
        continue;
      }
      if (next === ">") {
        if (input[i + 2] === ">") pushRedirect("&>>", 3);
        else pushRedirect("&>", 2);
        continue;
      }
      pushOp("&", 1);
      continue;
    }
    if (ch === "|") {
      if (input[i + 1] === "|") {
        pushOp("||", 2);
        continue;
      }
      if (input[i + 1] === "&") throw new ParseError("|& is not supported");
      pushOp("|", 1);
      continue;
    }
    if (ch === ";") {
      pushOp(";", 1);
      continue;
    }
    if (ch === "(" || ch === ")") {
      pushOp(ch, 1);
      continue;
    }
    appendLiteral(ch, false);
    i++;
  }
  endWord();
  return tokens;

  function scanRedirect(fd: number | undefined): void {
    const ch = input[i]!;
    const next = input[i + 1];
    if (next === "(") throw new ParseError("process substitution is not supported");
    if (ch === "<") {
      if (next === "<") throw new ParseError("heredocs are not supported");
      if (next === "&") pushRedirect("<&", 2, fd);
      else if (next === ">") pushRedirect("<>", 2, fd);
      else pushRedirect("<", 1, fd);
      return;
    }
    if (next === ">") {
      if (input[i + 2] === "(") throw new ParseError("process substitution is not supported");
      pushRedirect(">>", 2, fd);
    } else if (next === "&") pushRedirect(">&", 2, fd);
    else pushRedirect(">", 1, fd);
  }
}

/** Removes the first `count` characters of leading literal text (the NAME= prefix of an assignment word). */
function stripLiteralPrefix(parts: WordPart[], count: number): WordPart[] {
  const result: WordPart[] = [];
  let remaining = count;
  for (const part of parts) {
    if (remaining > 0 && part.kind === "literal") {
      if (part.text.length <= remaining) {
        remaining -= part.text.length;
        continue;
      }
      result.push({ kind: "literal", text: part.text.slice(remaining) });
      remaining = 0;
      continue;
    }
    result.push(part);
  }
  return result;
}

function parseScript(tokens: Token[]): ShellScript {
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (op: ChainOp) => {
    const token = peek();
    return token?.kind === "op" && token.op === op;
  };
  const skipNewlines = () => {
    while (isOp("\n")) pos++;
  };

  const parseRedirect = (): Redirect => {
    const token = tokens[pos]!;
    if (token.kind !== "redirect") throw new ParseError("expected a redirect");
    pos++;
    const target = peek();
    if (target?.kind !== "word") throw new ParseError(`redirect ${token.op} is missing its target`);
    pos++;
    return { fd: token.fd, op: token.op, target: { parts: target.parts } };
  };

  const parseCommand = (): ShellCommand => {
    if (isOp("(")) {
      pos++;
      const body = parseList(true);
      if (!isOp(")")) throw new ParseError("unterminated subshell");
      if (body.chains.length === 0) throw new ParseError("empty subshell");
      pos++;
      const redirects: Redirect[] = [];
      while (peek()?.kind === "redirect") redirects.push(parseRedirect());
      return { kind: "subshell", body, redirects };
    }
    const assignments: Assignment[] = [];
    const argv: ShellWord[] = [];
    const redirects: Redirect[] = [];
    let sawAny = false;
    for (;;) {
      const token = peek();
      if (token?.kind === "redirect") {
        redirects.push(parseRedirect());
        sawAny = true;
        continue;
      }
      if (token?.kind === "word") {
        pos++;
        if (argv.length === 0 && token.assignment) assignments.push(token.assignment);
        else argv.push({ parts: token.parts, ...(token.glob ? { glob: true as const } : {}) });
        sawAny = true;
        continue;
      }
      break;
    }
    if (!sawAny) throw new ParseError("expected a command");
    return { kind: "command", assignments, argv, redirects };
  };

  const parsePipeline = (): Pipeline => {
    const commands = [parseCommand()];
    while (isOp("|")) {
      pos++;
      skipNewlines();
      commands.push(parseCommand());
    }
    return { commands };
  };

  const parseAndOr = (): AndOrChain => {
    const pipelines = [parsePipeline()];
    const operators: ("&&" | "||")[] = [];
    while (isOp("&&") || isOp("||")) {
      operators.push(isOp("&&") ? "&&" : "||");
      pos++;
      skipNewlines();
      pipelines.push(parsePipeline());
    }
    return { pipelines, operators, background: false };
  };

  const parseList = (inSubshell: boolean): ShellScript => {
    const chains: AndOrChain[] = [];
    skipNewlines();
    while (pos < tokens.length && !(inSubshell && isOp(")"))) {
      const chain = parseAndOr();
      if (isOp("&")) {
        chain.background = true;
        pos++;
      } else if (isOp(";")) {
        pos++;
      } else if (peek() !== undefined && !isOp("\n") && !(inSubshell && isOp(")"))) {
        throw new ParseError("unexpected token after command");
      }
      chains.push(chain);
      skipNewlines();
    }
    return { chains };
  };

  return parseList(false);
}

/** Parses a command line into a ShellScript, or reports why it falls outside the minimal grammar. */
export function parseShellCommand(command: string): ShellParseResult {
  try {
    return { ok: true, script: parseScript(tokenize(command)) };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, error: error.message };
    throw error;
  }
}
