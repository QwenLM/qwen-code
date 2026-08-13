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
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRunSession,
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
    appendRunSession(plan, envOf('S1'));
    // Simulate time passing without a plan rewrite: entries stay visible.
    const past = new Date(Date.now() - 3600_000);
    utimesSync(plan, past, past);
    expect(priorSessionIds(plan, envOf('S2'))).toEqual(['S1']);
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
