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

import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core';
import { promptRecordDir } from './prompt-record.js';

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
 * Same fence, same constant, same reason as `deadline.ts`'s `runEpochMs`: the
 * ledger keys on the plan path, which is stable per PR, but every FRESH run
 * rewrites the plan — so entries older than the plan's mtime belong to a
 * previous review of the same PR and must be invisible. A resumed run
 * deliberately does not rewrite the plan, which is exactly what keeps the
 * first attempt's entries inside the fence.
 */
const RUN_EPOCH_SLACK_MS = 2000;

function runEpochMs(planPath: string): number {
  try {
    return statSync(planPath).mtimeMs - RUN_EPOCH_SLACK_MS;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

interface SessionEntry {
  sessionId: string;
  atMs: number;
}

/** Where the session ledger lives — derived from the plan path, never passed. */
export function runSessionsPath(planPath: string): string {
  return join(promptRecordDir(planPath), SESSIONS_FILE);
}

/**
 * This run's session entries, oldest first. Unreadable or malformed → empty:
 * the failure direction is "earlier evidence invisible", which coverage answers
 * by requiring the work again — never the reverse.
 */
function readSessions(planPath: string): SessionEntry[] {
  try {
    const parsed = JSON.parse(
      readFileSync(runSessionsPath(planPath), 'utf8'),
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    const epoch = runEpochMs(planPath);
    return parsed.filter(
      (e): e is SessionEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as SessionEntry).sessionId === 'string' &&
        SESSION_ID_RE.test((e as SessionEntry).sessionId) &&
        typeof (e as SessionEntry).atMs === 'number' &&
        (e as SessionEntry).atMs >= epoch,
    );
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
    entries.push({ sessionId: id, atMs: nowMs });
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
  const current = env['QWEN_CODE_SESSION_ID']?.trim();
  return readSessions(planPath)
    .map((e) => e.sessionId)
    .filter((id) => id !== current);
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
    const parsed = JSON.parse(
      readFileSync(resumeMarkerPath(planPath), 'utf8'),
    ) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as ResumeMarker).schemaVersion !== 1
    ) {
      return emptyMarker();
    }
    const epoch = runEpochMs(planPath);
    const raw = parsed as ResumeMarker;
    const resumes = Array.isArray(raw.resumes)
      ? raw.resumes.filter(
          (e) =>
            typeof e === 'object' &&
            e !== null &&
            typeof e.sessionId === 'string' &&
            typeof e.atMs === 'number' &&
            e.atMs >= epoch,
        )
      : [];
    const restarts = Array.isArray(raw.restarts)
      ? raw.restarts.filter(
          (e) =>
            typeof e === 'object' &&
            e !== null &&
            typeof e.reason === 'string' &&
            typeof e.atMs === 'number' &&
            e.atMs >= epoch,
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
