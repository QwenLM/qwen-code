/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The session ledger and resume marker, in isolation. The properties under
// test are the failure directions: an entry the ledger cannot vouch for
// (malformed, stale, traversal-shaped) must read as ABSENT — invisible
// evidence re-runs work, fabricated evidence must never mint credit — and a
// fresh run of the same PR (plan rewritten, epoch advanced) must start with
// an empty history.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRunSession,
  priorSessionEntries,
  priorSessionIds,
  runSessionsPath,
  readResumeMarker,
  recordResume,
  recordRestart,
  resumeMarkerPath,
  RESUME_MAX,
} from './run-ledger.js';

let root: string;
let plan: string;

const envOf = (sessionId: string): NodeJS.ProcessEnv => ({
  QWEN_CODE_PROJECT_DIR: root,
  QWEN_CODE_SESSION_ID: sessionId,
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'run-ledger-')));
  plan = join(root, 'qwen-review-pr-7-fetch.json');
  writeFileSync(plan, JSON.stringify({ diffLines: 1, chunks: [] }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('appendRunSession / priorSessionIds', () => {
  it('records a session and surfaces it to a LATER session as prior', () => {
    appendRunSession(plan, envOf('S1'));
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('excludes the current session from its own priors', () => {
    appendRunSession(plan, envOf('S1'));
    expect(priorSessionIds(plan, envOf('S1'))).toEqual([]);
  });

  it('appends each session once, preserving order', () => {
    appendRunSession(plan, envOf('S1'));
    appendRunSession(plan, envOf('S1'));
    appendRunSession(plan, envOf('S2'));
    expect(priorSessionIds(plan, envOf('S3'))).toEqual(['S1', 'S2']);
  });

  it('refuses a session id that could traverse out of subagents/', () => {
    appendRunSession(plan, envOf('../evil'));
    appendRunSession(plan, envOf('a/b'));
    appendRunSession(plan, envOf(''));
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('drops a traversal-shaped id on READ even when the file carries it', () => {
    // The ledger file itself is inside the record dir the orchestrator can
    // reach; a hand-written entry must still fail the character-set gate.
    appendRunSession(plan, envOf('S1'));
    const raw = JSON.parse(
      readFileSync(runSessionsPath(plan), 'utf8'),
    ) as Array<Record<string, unknown>>;
    raw.push({ sessionId: '../../etc', atMs: Date.now() });
    writeFileSync(runSessionsPath(plan), JSON.stringify(raw));
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('drops entries older than the plan — a previous review of the same PR', () => {
    appendRunSession(plan, envOf('S0'), Date.now() - 60_000);
    // Rewriting the plan advances the run epoch past the stale entry.
    writeFileSync(plan, JSON.stringify({ diffLines: 2, chunks: [] }));
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('keeps entries when the plan is untouched — the resume case', () => {
    // A resume does not rewrite the plan, so the entry's recorded plan mtime
    // still matches. (Backdating the plan here would be a DIFFERENT plan
    // state, which the exact fresh-run boundary is right to reject — the
    // rewrite case has its own test below.)
    appendRunSession(plan, envOf('S1'));
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('drops an entry written against a DIFFERENT plan state', () => {
    // The window's slack is inexact by construction: a previous run that
    // appended within it survives the fence. The recorded plan mtime is the
    // exact boundary — a fresh run rewrites the plan, a resume does not.
    appendRunSession(plan, envOf('S0'));
    const later = new Date(Date.now() + 1000);
    utimesSync(plan, later, later);
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('reads a case-variant of the current session as the SAME session', () => {
    // These ids become path segments; on APFS/Windows `s1` and `S1` are one
    // directory, so treating a variant as a prior session double-reads every
    // record this run wrote and mints a resume that never happened.
    appendRunSession(plan, envOf('s1'));
    expect(priorSessionIds(plan, envOf('S1'))).toEqual([]);
  });

  it('reads a corrupt ledger as empty', () => {
    appendRunSession(plan, envOf('S1'));
    writeFileSync(runSessionsPath(plan), '{not json');
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('reads a non-array ledger as empty', () => {
    appendRunSession(plan, envOf('S1'));
    writeFileSync(runSessionsPath(plan), JSON.stringify({ sessionId: 'S1' }));
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('reads a missing ledger as empty', () => {
    expect(priorSessionIds(plan, envOf('S1'))).toEqual([]);
  });

  it('swallows an unwritable record dir', () => {
    // The record dir path collides with an existing FILE: mkdir fails. The
    // append must not throw — bookkeeping never takes the review down.
    writeFileSync(join(root, 'qwen-review-pr-7-fetch-prompts'), 'a file');
    expect(() => appendRunSession(plan, envOf('S1'))).not.toThrow();
  });
});

describe('resume marker', () => {
  it('reads an absent marker as the empty history', () => {
    expect(readResumeMarker(plan)).toEqual({
      schemaVersion: 1,
      resumes: [],
      restarts: [],
    });
  });

  it('round-trips resumes and restarts', () => {
    recordResume(plan, envOf('S2'));
    recordRestart(plan, 'head-moved abc1234->def5678');
    const marker = readResumeMarker(plan);
    expect(marker.resumes.map((r) => r.sessionId)).toEqual(['S2']);
    expect(marker.restarts.map((r) => r.reason)).toEqual([
      'head-moved abc1234->def5678',
    ]);
  });

  it('counts multiple resumes in order', () => {
    recordResume(plan, envOf('S2'));
    recordResume(plan, envOf('S3'));
    expect(readResumeMarker(plan).resumes.map((r) => r.sessionId)).toEqual([
      'S2',
      'S3',
    ]);
  });

  it('refuses a resume under an invalid session id', () => {
    recordResume(plan, envOf('a/b'));
    expect(readResumeMarker(plan).resumes).toEqual([]);
  });

  it('reads a corrupt marker as the empty history', () => {
    recordResume(plan, envOf('S2'));
    writeFileSync(resumeMarkerPath(plan), '][');
    expect(readResumeMarker(plan)).toEqual({
      schemaVersion: 1,
      resumes: [],
      restarts: [],
    });
  });

  it('reads an unknown schemaVersion as the empty history', () => {
    mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
      recursive: true,
    });
    writeFileSync(
      resumeMarkerPath(plan),
      JSON.stringify({ schemaVersion: 2, resumes: [], restarts: [] }),
    );
    expect(readResumeMarker(plan)).toEqual({
      schemaVersion: 1,
      resumes: [],
      restarts: [],
    });
  });

  it('drops marker entries older than the plan — a fresh run starts at zero', () => {
    recordResume(plan, envOf('S2'), Date.now() - 60_000);
    recordRestart(plan, 'head-moved', Date.now() - 60_000);
    writeFileSync(plan, JSON.stringify({ diffLines: 2, chunks: [] }));
    const marker = readResumeMarker(plan);
    expect(marker.resumes).toEqual([]);
    expect(marker.restarts).toEqual([]);
  });

  it('exports the resume cap', () => {
    expect(RESUME_MAX).toBe(2);
  });
});

describe('marker dedup — a caller retry must not double-count', () => {
  it('records one resume per session', () => {
    recordResume(plan, envOf('S2'));
    recordResume(plan, envOf('S2'));
    expect(readResumeMarker(plan).resumes).toHaveLength(1);
  });

  it('records one restart per reason', () => {
    recordRestart(plan, 'head-moved abc1234->def5678');
    recordRestart(plan, 'head-moved abc1234->def5678');
    expect(readResumeMarker(plan).restarts).toHaveLength(1);
  });

  it('still records distinct restarts', () => {
    recordRestart(plan, 'head-moved abc1234->def5678');
    recordRestart(plan, 'head-moved def5678->0123abc');
    expect(readResumeMarker(plan).restarts).toHaveLength(2);
  });
});

describe('the properties the threat model rests on', () => {
  it('refuses the bare traversal ids `..` and `.`', () => {
    // Today only the leading-alphanumeric rule stops these; pinning them
    // means a regex refactor cannot quietly hand them to the path assembler.
    for (const id of ['..', '.', './x', '..\\evil']) {
      appendRunSession(plan, envOf(id));
    }
    expect(priorSessionIds(plan, envOf('S9'))).toEqual([]);
  });

  it('applies the same charset gate to the resume marker on read', () => {
    recordResume(plan, envOf('S2'));
    const marker = JSON.parse(readFileSync(resumeMarkerPath(plan), 'utf8'));
    marker.resumes.push({ sessionId: '../../etc', atMs: Date.now() });
    writeFileSync(resumeMarkerPath(plan), JSON.stringify(marker));
    expect(readResumeMarker(plan).resumes.map((r) => r.sessionId)).toEqual([
      'S2',
    ]);
  });

  it('deduplicates on READ, not only on append', () => {
    // The file sits in a directory the orchestrator can reach; a duplicated
    // entry would make the cost ledger bill one session twice.
    appendRunSession(plan, envOf('S1'));
    const raw = JSON.parse(readFileSync(runSessionsPath(plan), 'utf8'));
    writeFileSync(runSessionsPath(plan), JSON.stringify([...raw, ...raw]));
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('keeps a same-millisecond append inside the epoch fence', () => {
    // fetch-pr writes the plan and appends two statements later: Date.now()
    // floors to integer ms while mtimeMs is fractional, so without the slack
    // a same-millisecond entry would read as older than its own run.
    const mtimeMs = statSync(plan).mtimeMs;
    appendRunSession(plan, envOf('S1'), Math.floor(mtimeMs));
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('drops a FUTURE-dated entry, which would outlive every rewrite', () => {
    // One-sided fences let a hand-written far-future entry read as belonging
    // to every later run of the same PR.
    appendRunSession(plan, envOf('S1'), Date.now() + 3_600_000);
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('orders the cost clamp by time, not by file order', () => {
    const past = new Date(Date.now() - 300_000);
    utimesSync(plan, past, past);
    const base = Math.floor(statSync(plan).mtimeMs);
    // Written out of order, as a hand-edited ledger or a backwards clock
    // step between attempts would leave it.
    appendRunSession(plan, envOf('S1'), base + 60_000);
    appendRunSession(plan, envOf('S0'), base);
    expect(priorSessionEntries(plan, envOf('S2'))).toEqual([
      { sessionId: 'S0', atMs: base, endsAtMs: base + 60_000 },
      { sessionId: 'S1', atMs: base + 60_000, endsAtMs: null },
    ]);
  });

  it('refuses a ledger path that is not a regular file', () => {
    // A planted FIFO blocks readFileSync forever — a hang, not an error.
    mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
      recursive: true,
    });
    const target = join(root, 'elsewhere.json');
    writeFileSync(
      target,
      JSON.stringify([{ sessionId: 'X', atMs: Date.now() }]),
    );
    symlinkSync(target, runSessionsPath(plan));
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('drops an entry older than the slack window', () => {
    const mtimeMs = statSync(plan).mtimeMs;
    appendRunSession(plan, envOf('S1'), Math.floor(mtimeMs) - 3000);
    expect(priorSessionIds(plan, envOf('S2'))).toEqual([]);
  });

  it('writes through a planted symlink without following it', () => {
    // `noFollow: true` on both ledger writes: without it atomicWriteFileSync
    // resolves the chain and the rename lands on the TARGET.
    mkdirSync(join(root, 'qwen-review-pr-7-fetch-prompts'), {
      recursive: true,
    });
    const target = join(root, 'outside.json');
    writeFileSync(target, '"untouched"');
    symlinkSync(target, runSessionsPath(plan));
    appendRunSession(plan, envOf('S1'));
    expect(readFileSync(target, 'utf8')).toBe('"untouched"');
    expect(lstatSync(runSessionsPath(plan)).isSymbolicLink()).toBe(false);
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
  });

  it('bounds each prior session by the next attempt start', () => {
    // Inside BOTH halves of the fence: at or after the plan's capture, and
    // not in the future. Backdate the plan so a later entry is still past.
    const past = new Date(Date.now() - 300_000);
    utimesSync(plan, past, past);
    const base = Math.floor(statSync(plan).mtimeMs);
    appendRunSession(plan, envOf('S0'), base);
    appendRunSession(plan, envOf('S1'), base + 60_000);
    expect(priorSessionEntries(plan, envOf('S2'))).toEqual([
      { sessionId: 'S0', atMs: base, endsAtMs: base + 60_000 },
      { sessionId: 'S1', atMs: base + 60_000, endsAtMs: null },
    ]);
  });
});
