/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Which CLI sessions this review ran under, written by the thing that ran them.
//
// A review interrupted mid-run and resumed (`--resume`) continues in a NEW CLI
// session: the harness keys its subagent transcripts on `QWEN_CODE_SESSION_ID`,
// so the first attempt's evidence sits in a directory the second attempt's
// environment no longer names. The readers that certify agent work (coverage,
// retirement, the recovery command) need the earlier directory's name — and the
// orchestrator must not be the one to supply it, for the same reason it is never
// given the prompt-record path: a path the model can choose is a path the model
// can point somewhere flattering.
//
// So `fetch-pr` appends its own session id here, read back later from disk. The
// entry is only ever an ADDRESS, never a verdict: a fabricated id can at most
// point a reader at a directory inside the harness's own `subagents/` tree,
// where credit still requires the content-shaped pairing (verbatim-delivered
// prompt, opened brief, diff reads) that fabrication cannot satisfy.
//
// The same file's sibling, `resume.json`, is the resume/restart bookkeeping the
// skill used to hold only in transcript memory: how many times this review has
// resumed, and whether it already restarted once for head movement.

import { readFileSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core';
import { promptRecordDir, runEpochMs } from './prompt-record.js';

const SESSIONS_FILE = 'run-sessions.json';
const RESUME_FILE = 'resume.json';

/**
 * Hard cap on resumes of one review. The workflow's own retry loop allows a
 * single retry (MAX_ATTEMPTS=2), so 2 leaves headroom for a manual rerun
 * without permitting an unbounded resume chain on a review that keeps dying.
 */
export const RESUME_MAX = 2;

/**
 * Session ids are used to BUILD A PATH under the harness's `subagents/` dir, so
 * the character set is closed: anything that could traverse (`/`, `\`, `..`) or
 * smuggle separators fails the whole entry. Mirrors the shape the harness
 * actually generates (UUIDs) with room for prefixed variants.
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * How far ahead of NOW an entry may be stamped. The epoch fence's lower half
 * keeps a previous review's entries out; without an upper half, one
 * hand-written far-future entry survives every future rewrite of the same
 * plan and is read as belonging to every later run.
 */
const FUTURE_SLACK_MS = 2000;

/**
 * The plan mtime an entry was written against — the EXACT fresh-run boundary.
 *
 * The epoch window alone is inexact by its own slack: a previous run that
 * appended within the slack of this run's plan write survives it, and one of
 * its late transcripts would then be credited here. An entry carries the
 * mtime it saw, and a reader keeps only entries that saw THIS plan — which a
 * fresh run necessarily rewrote and a resumed run deliberately did not.
 * Entries without the field never exist in the wild — it shipped in the same
 * change as the ledger itself — so there is no fallback: an entry that cannot
 * say which plan it saw is dropped. (An earlier revision degraded to the
 * window instead; the fallback was removed as unsound and this paragraph
 * outlived it by one round.)
 */
function planMtimeMs(planPath: string): number | null {
  try {
    return statSync(planPath).mtimeMs;
  } catch {
    return null;
  }
}

/** Entries stamped past this are not this run's; nothing writes the future. */
function runCeilingMs(nowMs: number = Date.now()): number {
  return nowMs + FUTURE_SLACK_MS;
}

interface SessionEntry {
  sessionId: string;
  atMs: number;
  /** The plan mtime this entry was written against. Required on read. */
  planMtimeMs?: number;
}

/** Where the session ledger lives — derived from the plan path, never passed. */
export function runSessionsPath(planPath: string): string {
  return join(promptRecordDir(planPath), SESSIONS_FILE);
}

/**
 * Read one ledger file, refusing anything that is not a regular file.
 *
 * The write side is hardened with `noFollow`; the read side must match, or a
 * planted symlink redirects the read and a planted FIFO blocks it forever —
 * a hang, not an error, in a command a review is waiting on.
 */
const MAX_LEDGER_BYTES = 256 * 1024;
const MAX_LEDGER_ENTRIES = 64;

function readLedgerFile(path: string): string | null {
  try {
    const st = lstatSync(path);
    // Not a regular file: a symlink would redirect the read and a FIFO would
    // block it forever — a hang, not an error, in a command a review waits on.
    if (!st.isFile()) return null;
    // Bounded before the read: these files are bookkeeping (a handful of
    // small entries), and a planted multi-gigabyte one would otherwise stall
    // or exhaust every command that touches them.
    if (st.size > MAX_LEDGER_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * This run's session entries, oldest first. Unreadable or malformed → empty:
 * the failure direction is "earlier evidence invisible", which coverage answers
 * by requiring the work again — never the reverse.
 */
function readSessions(planPath: string): SessionEntry[] {
  try {
    const raw = readLedgerFile(runSessionsPath(planPath));
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const epoch = runEpochMs(planPath);
    const ceiling = runCeilingMs();
    const planMtime = planMtimeMs(planPath);
    // Cap the entry count too: the byte bound alone still admits tens of
    // thousands of tiny entries, each of which costs a directory read.
    const kept = parsed.slice(0, MAX_LEDGER_ENTRIES).filter(
      (e): e is SessionEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as SessionEntry).sessionId === 'string' &&
        SESSION_ID_RE.test((e as SessionEntry).sessionId) &&
        typeof (e as SessionEntry).atMs === 'number' &&
        (e as SessionEntry).atMs >= epoch &&
        (e as SessionEntry).atMs <= ceiling &&
        // The exact boundary, with no fallback: an entry written against a
        // DIFFERENT plan belongs to a different run, whatever the window
        // says, and an entry that cannot say which plan it saw cannot be
        // placed at all. The window alone is inexact by construction — a
        // previous run that appended within its slack survives it — and the
        // field ships in the same change as the ledger itself, so there are
        // no older files to be lenient toward.
        typeof (e as SessionEntry).planMtimeMs === 'number' &&
        planMtime !== null &&
        (e as SessionEntry).planMtimeMs === planMtime,
    );
    // Deduplicate on READ, not only on append: the file lives in a directory
    // the orchestrator can reach, and a hand-written duplicate would make a
    // consumer that iterates entries (the cost ledger) bill one session
    // twice. First occurrence wins — it carries the session's real start.
    // Case-insensitively, because these ids become PATH segments: on APFS or
    // Windows `s1` and `S1` are the same directory, so a case-variant entry
    // would otherwise read as a second session and double-count everything
    // inside it.
    const seen = new Set<string>();
    return kept.filter((e) => {
      const k = e.sessionId.toLowerCase();
      return seen.has(k) ? false : (seen.add(k), true);
    });
  } catch {
    return [];
  }
}

/**
 * Record the current session against this plan. Id comes from the environment
 * the CLI itself exported, never from an argument. Write errors are swallowed
 * for the same reason `stampRound` swallows them — a read-only tmp dir must
 * not stop a review being built; it only costs a later resume its evidence.
 */
export function appendRunSession(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): void {
  try {
    const id = env['QWEN_CODE_SESSION_ID']?.trim();
    if (!id || !SESSION_ID_RE.test(id)) return;
    const entries = readSessions(planPath);
    if (entries.some((e) => e.sessionId === id)) return;
    const mtime = planMtimeMs(planPath);
    entries.push({
      sessionId: id,
      atMs: nowMs,
      ...(mtime === null ? {} : { planMtimeMs: mtime }),
    });
    const dir = promptRecordDir(planPath);
    mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(runSessionsPath(planPath), JSON.stringify(entries), {
      noFollow: true,
    });
  } catch {
    // Bookkeeping only; the review itself must not fail on it.
  }
}

/**
 * Session ids of EARLIER attempts of this same run — the current session
 * excluded, order preserved, deduplicated by the ledger's own append guard.
 * These are addresses for `subagents/<id>` lookups, nothing more.
 */
export function priorSessionIds(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return priorSessionEntries(planPath, env).map((e) => e.sessionId);
}

/**
 * This session's own ledger entry, if it wrote one.
 *
 * Needed for the cost floor: a review that starts inside an EXISTING CLI
 * session must not bill that session's earlier, unrelated turns, and the
 * plan floor alone cannot tell them apart. No authorization gate here — a
 * session reading its own entry is not reading anyone else's evidence.
 */
export function currentSessionEntry(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { sessionId: string; atMs: number } | null {
  const current = env['QWEN_CODE_SESSION_ID']?.trim().toLowerCase();
  if (!current) return null;
  return (
    readSessions(planPath).find((e) => e.sessionId.toLowerCase() === current) ??
    null
  );
}

/**
 * Did the CURRENT session actually earn the right to read prior evidence?
 *
 * The ledger is an address book; it does not say a resume was authorized.
 * Without this gate any session that points at an old plan unions the
 * ledgered attempts' transcripts and inherits their coverage — after head
 * drift, stale evidence could certify code nobody reviewed. `fetch-pr
 * --resume` records the resume only after every probe passed (worktree at
 * the fetched SHA and clean, diff bytes unchanged, live head unmoved), so
 * the marker naming this session IS that proof, written by the CLI.
 */
function resumeAuthorized(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const current = env['QWEN_CODE_SESSION_ID']?.trim().toLowerCase();
  if (!current) return false;
  return readResumeMarker(planPath).resumes.some(
    (r) => r.sessionId.toLowerCase() === current,
  );
}

/**
 * The same prior sessions, with the timestamps that bound them.
 *
 * `endsAtMs` is the NEXT ledger entry's `atMs` — the moment the following
 * attempt started, which is the only end boundary this run records. The cost
 * ledger clamps a prior session's chat usage to it: an interrupted session
 * whose CLI kept being used for unrelated turns afterwards would otherwise
 * bill that activity as review cost, the mirror of the omission the ledger
 * exists to prevent. `null` when nothing followed it (it is the newest prior
 * entry and the current session's own start is not recorded here).
 */
export function priorSessionEntries(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ sessionId: string; atMs: number; endsAtMs: number | null }> {
  // Case-insensitive for the same reason the dedup is: a case-variant of the
  // CURRENT session id resolves to the current session's own directory, so
  // reading it as a prior session double-reads every record this run wrote —
  // minting `recoveredAgents` and a resumed disclosure on a run that never
  // resumed, and folding the current chat into the prior totals.
  if (!resumeAuthorized(planPath, env)) return [];
  const current = env['QWEN_CODE_SESSION_ID']?.trim().toLowerCase();
  // Sort by time, not file order: `endsAtMs` is a COST CLAMP, and an
  // out-of-order (hand-written) ledger or a backwards wall-clock step
  // between attempts would otherwise invert it — a null or negative window
  // silently unbounds or empties a prior session's bill.
  const all = [...readSessions(planPath)].sort((a, b) => a.atMs - b.atMs);
  return all
    .map((e, i) => ({
      sessionId: e.sessionId,
      atMs: e.atMs,
      endsAtMs: i + 1 < all.length ? all[i + 1].atMs : null,
    }))
    .filter((e) => e.sessionId.toLowerCase() !== current);
}

/** Resume/restart bookkeeping for one review run. */
export interface ResumeMarker {
  schemaVersion: 1;
  /** Each successful `--resume` continuation, in order. */
  resumes: Array<{ sessionId: string; atMs: number }>;
  /** Each restart-for-head-movement, in order. The skill's cap is one. */
  restarts: Array<{ atMs: number; reason: string }>;
}

// A fresh object every time: callers mutate the arrays (`recordResume`
// pushes into them), so a shared constant would accumulate history across
// reads.
const emptyMarker = (): ResumeMarker => ({
  schemaVersion: 1,
  resumes: [],
  restarts: [],
});

/** Where the resume marker lives — derived from the plan path, never passed. */
export function resumeMarkerPath(planPath: string): string {
  return join(promptRecordDir(planPath), RESUME_FILE);
}

/**
 * The marker, epoch-fenced like the session ledger: entries from a previous
 * review of the same PR are dropped, so a fresh run always starts at zero
 * resumes and zero restarts. Malformed → the empty marker (fail toward "no
 * history", which the caps then treat most permissively — the hard bound on
 * abuse is the session ledger's entry count and the workflow's MAX_ATTEMPTS).
 */
export function readResumeMarker(planPath: string): ResumeMarker {
  try {
    const text = readLedgerFile(resumeMarkerPath(planPath));
    if (text === null) return emptyMarker();
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as ResumeMarker).schemaVersion !== 1
    ) {
      return emptyMarker();
    }
    const epoch = runEpochMs(planPath);
    const ceiling = runCeilingMs();
    const raw = parsed as ResumeMarker;
    const seenResume = new Set<string>();
    const resumes = Array.isArray(raw.resumes)
      ? raw.resumes.slice(0, MAX_LEDGER_ENTRIES).filter(
          (e) =>
            typeof e === 'object' &&
            e !== null &&
            typeof e.sessionId === 'string' &&
            // Same closed charset as the session ledger: these ids have the
            // same address semantics, and one read path applying the gate
            // while the other does not is how a threat model rots.
            SESSION_ID_RE.test(e.sessionId) &&
            typeof e.atMs === 'number' &&
            e.atMs >= epoch &&
            e.atMs <= ceiling &&
            // Duplicates would each consume a RESUME_MAX slot and refuse a
            // legitimate continuation.
            !seenResume.has(e.sessionId.toLowerCase()) &&
            (seenResume.add(e.sessionId.toLowerCase()), true),
        )
      : [];
    const restarts = Array.isArray(raw.restarts)
      ? raw.restarts
          .slice(0, MAX_LEDGER_ENTRIES)
          .filter(
            (e) =>
              typeof e === 'object' &&
              e !== null &&
              typeof e.reason === 'string' &&
              typeof e.atMs === 'number' &&
              e.atMs >= epoch &&
              e.atMs <= ceiling,
          )
      : [];
    return { schemaVersion: 1, resumes, restarts };
  } catch {
    return emptyMarker();
  }
}

function writeMarker(planPath: string, marker: ResumeMarker): void {
  try {
    const dir = promptRecordDir(planPath);
    mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(resumeMarkerPath(planPath), JSON.stringify(marker), {
      noFollow: true,
    });
  } catch {
    // Bookkeeping only.
  }
}

/**
 * Record a successful `--resume` continuation under the current session.
 * One entry per session, like the session ledger's own guard: a session
 * resumes a run at most once, so a repeated call is a caller-side retry and
 * must not spend the resume cap twice.
 */
export function recordResume(
  planPath: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): void {
  const id = env['QWEN_CODE_SESSION_ID']?.trim();
  if (!id || !SESSION_ID_RE.test(id)) return;
  const marker = readResumeMarker(planPath);
  if (marker.resumes.some((r) => r.sessionId === id)) return;
  marker.resumes.push({ sessionId: id, atMs: nowMs });
  writeMarker(planPath, marker);
}

/**
 * Record a restart-for-head-movement (the skill's once-per-review event).
 * Deduplicated by reason: the event is at-most-once by rule, so a repeated
 * identical call is a caller-side retry, not a second restart.
 */
export function recordRestart(
  planPath: string,
  reason: string,
  nowMs: number = Date.now(),
): void {
  const marker = readResumeMarker(planPath);
  if (marker.restarts.some((r) => r.reason === reason)) return;
  marker.restarts.push({ atMs: nowMs, reason });
  writeMarker(planPath, marker);
}
