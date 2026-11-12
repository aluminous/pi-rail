// The `/rail eval` history: `<agentDir>/rail-evals.jsonl`, one RailEvalRecord
// per line, newest last. Private to the user like the replay corpus (file
// 0600; a directory this creates is 0700) and, like it, best-effort — a
// history that cannot be written must never turn a finished run into an
// error. Unlike the corpus it holds nothing sensitive (numbers and model ids),
// so it is one small file with a line cap rather than a pruned monthly store.
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RailEvalRecord, RailEvalSeatStats } from "./rail-eval.ts";

export const EVAL_HISTORY_FILE = "rail-evals.jsonl";
/** Newest runs kept: years of daily checks, and still a file read in one go. */
export const EVAL_HISTORY_LIMIT = 300;

export function defaultEvalHistoryPath(): string {
  return path.join(getAgentDir(), EVAL_HISTORY_FILE);
}

function isSeatStats(value: unknown): value is RailEvalSeatStats {
  if (!value || typeof value !== "object") return false;
  const stats = value as Record<string, unknown>;
  return ["decided", "correct", "medianMs", "maxMs", "tokensIn", "tokensOut"].every((key) => typeof stats[key] === "number");
}

export function isEvalRecord(value: unknown): value is RailEvalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.at === "string" &&
    Number.isFinite(Date.parse(record.at)) &&
    typeof record.suite === "string" &&
    typeof record.namer === "string" &&
    typeof record.judge === "string" &&
    typeof record.cases === "number" &&
    typeof record.passed === "number" &&
    typeof record.criticalMisses === "number" &&
    typeof record.wallMs === "number" &&
    isSeatStats(record.namerStats) &&
    isSeatStats(record.judgeStats)
  );
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

/** Every well-formed record, oldest first; torn, hand-edited, or foreign-version lines are skipped. */
export function readEvalHistory(file: string = defaultEvalHistoryPath()): RailEvalRecord[] {
  const records: RailEvalRecord[] = [];
  for (const line of readLines(file)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEvalRecord(parsed)) records.push(parsed);
    } catch {
      // Skip it, keep the rest.
    }
  }
  return records;
}

/**
 * Appends one record, keeping the newest `limit` lines. Under the cap it is a
 * single O_APPEND write; at the cap the trimmed file is written beside the
 * original and renamed over it, so a crash mid-trim leaves the old history
 * whole rather than half a file. Returns whether the record was written.
 * Single-writer by assumption (one person runs one eval at a time): two
 * processes trimming at once can drop the other's line, never corrupt one.
 */
export function appendEvalRecord(record: RailEvalRecord, file: string = defaultEvalHistoryPath(), limit = EVAL_HISTORY_LIMIT): boolean {
  try {
    // mode applies only to directories this creates: the agent dir itself is
    // pi's, and re-permissioning it is not the eval's call.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const line = JSON.stringify(record);
    const existing = readLines(file);
    if (existing.length + 1 <= limit) {
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      return true;
    }
    // The rewrite is also where torn or foreign lines go: they cannot be read
    // back, so they should not hold places a real run could.
    const readable = existing.filter((entry) => {
      try {
        return isEvalRecord(JSON.parse(entry));
      } catch {
        return false;
      }
    });
    const kept = [...readable, line].slice(-limit);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, `${kept.join("\n")}\n`, { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
    fs.chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}
